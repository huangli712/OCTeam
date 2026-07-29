/**
 * On-disk team state persistence: load, save, create, delete, and the
 * in-memory Team registry.
 */

import fs from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"

import { logger } from '../core/log.js';
import type { TeamState, TeamSpec } from "../core/types.js"
import { isOCTeamAgent } from "../core/role.js"
import { isEnoent } from '../core/utils.js';
import { assertNoSymlinkTraversal, atomicWrite, AsyncMutex, withLock } from "./locks.js"
import {
    configPath,
    isSafePathSegment,
    stateLockPath,
    statePath,
    teamDir,
    teamsDir,
    worktreesDir,
} from "./paths.js"
// C9: indexMasterTeam is called from initTeamState so the in-memory master
// index is populated for ALL init paths (not just team_create). This forms
// a module cycle (resolve.ts imports listAllTeams/loadTeamState from store.ts,
// store.ts imports indexMasterTeam from resolve.ts), which is safe in ESM
// because indexMasterTeam is only called at runtime (inside initTeamState),
// never at module-load time — by then resolve.ts has fully loaded.
import { indexMasterTeam } from "./resolve.js"
/**
 * Runtime team object: TeamState plus non-persisted handles.
 *
 * `mutex` is a per-teamName process-level singleton (see teamRegistry) — it
 * serializes event-handler state mutations. `directory` is the resolved team
 * working directory on disk. `deleted` is the runtime tombstone set by
 * team_delete inside the mutex: once true, processIdle/saveTeamState skip
 * persistence so a racing handler holding the same in-memory reference cannot
 * recreate the just-removed directory via atomicWrite's mkdir({recursive:true}).
 * None of these fields is written to state.json (see stripRuntimeFields).
 *
 * `spawning` is a runtime guard set by startOrchestration between Phase 1
 * (busy pre-check) and Phase 3 (activeTask commit). It prevents a second
 * concurrent caller from entering Phase 2 (ensureMembersReady) and
 * duplicating member-session spawns while the first has released the mutex.
 */
export type Team = TeamState & {
    mutex: AsyncMutex
    directory: string
    deleted?: boolean
    spawning?: boolean
    _diskSnapshot?: TeamState  // last known on-disk state (for three-way merge in saveTeamState)
}

// Process-level registry: resolved teamDir (absolute path) -> Team (with its
// singleton mutex). Keying by the RESOLVED directory — not teamName — is what
// keeps team "aaa" under session ses_x distinct from "aaa" under ses_y, and
// project-scope "aaa" distinct from user-scope "aaa". Rebuilt lazily on plugin
// restart; first access creates the entry, later accesses keep the mutex.
const teamRegistry = new Map<string, Team>()

// In-flight first-load promises keyed by directory, preventing two concurrent
// first-accesses from creating separate Team objects (and separate mutexes)
// for the same directory — which would break per-team serialization.
const inflightLoads = new Map<string, Promise<Team>>()

/**
 * Clear the active task while preserving its mode in `lastMode` for sidebar
 * display. Called at every orchestration completion/termination site.
 *
 * Token snapshot: tokensByMember is otherwise only reachable via
 * runs/<runId>/record.json (the activeTask itself is discarded here). Copy the
 * final tally into lastMode so sidebar/progress can keep displaying per-member
 * tokens after completion without an extra file read per refresh.
 */
export function clearActiveTask(team: Team): void {
    if (team.activeTask) {
        team.lastMode = {
            type: team.activeTask.type,
            mode: team.activeTask.mode,
            finishedAt: Date.now(),
            tokensUsed: team.activeTask.tokensUsed,
            tokensByMember: { ...team.activeTask.tokensByMember },
            runId: team.activeTask.runId,
        }
    }
    team.activeTask = undefined
}

/** Strip the non-persisted runtime fields, leaving the pure TeamState. */
function stripRuntimeFields(team: Team): TeamState {
    const {
        mutex: _mutex,
        directory: _directory,
        deleted: _deleted,
        spawning: _spawning,
        _diskSnapshot: _snap,
        ...state
    } = team
    // H3: proactively strip isMaster from every member before serialization.
    // isMaster is a RUNTIME-ONLY flag on the synthetic master pseudo-member
    // (resolve.ts syntheticMaster), never on regular team.members. If a bug
    // or future code change accidentally sets it on a regular member,
    // isValidTeamState would reject the next load (defense-in-depth), but
    // the write would succeed first — causing a confusing "save works, load
    // fails" cycle. Stripping here prevents the bad write entirely.
    if (state.members) {
        state.members = state.members.map(m => {
            if (m.isMaster === undefined) return m
            const { isMaster: _im, ...rest } = m
            return rest
        })
    }
    return state
}

/**
 * Minimal top-level schema check for a persisted TeamState. The `as TeamState`
 * cast is compile-time only; a corrupt, truncated, or hand-edited state.json can
 * deserialize to an arbitrary shape. Validate just the identity fields every
 * load path immediately dereferences so bad data is rejected at the boundary
 * instead of propagating undefined access. Nested optional fields (activeTask,
 * bounds) are intentionally not checked.
 *
 * Agent hardening: each member's `agent` field MUST name one of OCTeam's
 * hardened oct-* agents (role.ts). A tampered state.json that wrote a bare
 * host agent (e.g. "build") into a member would otherwise let that member run
 * with unhardened host permissions on the next dispatch — a privilege
 * escalation across the .octeam/ trust boundary. An unknown agent fails the
 * check, the load is rejected, and safeMemberAgent() would have clamped it to
 * the read-only fallback (oct-oracle) anyway at dispatch time.
 */
export function isValidTeamState(value: unknown, teamDirectory: string): value is TeamState {
    if (typeof value !== "object" || value === null) return false
    const s = value as Record<string, unknown>
    if (
        typeof s.teamName !== "string"
        || !Array.isArray(s.members)
        || typeof s.status !== "string"
        || typeof s.version !== "number"
    ) {
        return false
    }
    // M12: verify teamName matches the directory's last path segment.
    // A tampered state.json moved to another team's directory would otherwise
    // load and bind the session to the wrong team.
    const expectedName = teamDirectory.split(/[\/]/).pop()
    if (expectedName && s.teamName !== expectedName) return false
    // M-8: validate status is a known enum value. Pre-fix code accepted any
    // string, so a tampered state.json with status:"HACKED" would load and
    // propagate to handlers that switch on status.
    const VALID_STATUSES = new Set(["idle", "busy", "failed", "live"])
    if (!VALID_STATUSES.has(s.status)) return false
    // M-8: validate version is a positive integer.
    if (!Number.isInteger(s.version) || s.version < 1) return false
    // leadSessionId is a directory locator (used to construct the team path),
    // NOT an authorization credential. Authorization is derived from the
    // session index (rebuilt from disk structure at startup). When present,
    // validate it is a non-empty string so a tampered state.json cannot inject
    // a non-string value that could break path operations. Absent is allowed
    // for legacy fixtures/tests that predate the field.
    if (s.leadSessionId !== undefined && (typeof s.leadSessionId !== "string" || s.leadSessionId.length === 0)) return false
    // Reject any member whose agent is present but not in the oct-* allowlist.
    // A missing agent is allowed here (legacy/old state) — safeMemberAgent at
    // dispatch falls back to oct-oracle (read-only) in that case.
    for (const m of s.members) {
            if (typeof m !== "object" || m === null) return false
            // Reject ANY truthy isMaster on persisted members, not just
            // boolean true. isMaster is a runtime-only flag on the synthetic
            // master record. A tampered state.json could write isMaster:"true",
            // isMaster:1, or isMaster:{} to bypass an === true check and gain
            // master privileges. undefined (absent) is the only safe persisted
            // value; any other value is tampering.
            const isMasterVal = (m as { isMaster?: unknown }).isMaster
            if (isMasterVal !== undefined && isMasterVal !== false && isMasterVal !== null) return false
        // Validate required per-member fields: name (used as a path segment in
        // mailbox/reserved dir operations) must be a safe segment, and status
        // must be a string. A tampered state.json with a missing/unsafe name
        // or missing status would otherwise propagate and crash downstream
        // path operations (reservedDir → assertSafeSegment in the sweep loop).
        const name = (m as { name?: unknown }).name
        if (typeof name !== "string" || !isSafePathSegment(name)) return false
        const status = (m as { status?: unknown }).status
        if (typeof status !== "string") return false
        const agent = (m as { agent?: unknown }).agent
        if (agent !== undefined && (typeof agent !== "string" || !isOCTeamAgent(agent))) {
            return false
        }
            const wt = (m as { worktreePath?: unknown }).worktreePath
            if (wt !== undefined) {
                if (typeof wt !== "string") return false
                // C-3: path.resolve is lexical — it does not follow symlinks.
                // A worktreePath that is a symlink pointing outside the worktrees/
                // dir would pass the lexical containment check but actually
                // redirect member operations to an external directory.
                //
                // When the path exists, use realpathSync to resolve symlinks and
                // re-check containment. If the path does not yet exist (worktree
                // not created at save time) or realpath fails for other reasons,
                // fall back to the lexical check; the spawn-time check is the
                // final guard for that case.
                const wtRoot = worktreesDir(teamDirectory)
                const resolved = path.resolve(teamDirectory, wt)
                if (resolved !== wtRoot && !resolved.startsWith(wtRoot + path.sep)) {
                    return false
                }
                try {
                    const real = realpathSync(resolved)
                    if (real !== wtRoot && !real.startsWith(wtRoot + path.sep)) {
                        return false
                    }
                } catch {
                    // ENOENT or other realpath failure: worktree may not exist
                    // yet. Lexical check above already gated it; let it pass.
                }
            }
    }
    return true
}

/**
 * Read and parse a JSON file, returning null on ENOENT or schema failure.
 *
 * @param filePath    path to the JSON file
 * @param validate    optional schema guard; null returned on mismatch
 */

async function readJsonOrNull<T>(
    filePath: string,
    validate?: (value: unknown) => value is T,
): Promise<T | null> {
    try {
        // H11: cap file size before reading. A symlinked or tampered state
        // file can be unbounded (/dev/zero, FIFO, huge sparse file). 1 MiB
        // is far above any legitimate state.json/config.json.
        const stat = await fs.lstat(filePath)
        if (stat.isSymbolicLink()) return null
        if (!stat.isFile()) return null
        if (stat.size > 1_048_576) {
            logger.warn("readJsonOrNull: file exceeds 1 MiB cap", { file: filePath, size: stat.size })
            return null
        }
        const raw = await fs.readFile(filePath, "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (validate && !validate(parsed)) {
            // Structurally valid JSON but wrong shape (corrupt / tampered).
            // Reject rather than trusting the cast; the caller takes its
            // not-found path instead of propagating garbage.
            logger.warn("readJsonOrNull: schema validation failed", { file: filePath })
            return null
        }
        return parsed as T
    } catch (err: unknown) {
        if (isEnoent(err)) return null
        throw err
    }
}

/**
 * Load (or refresh) a team's runtime state, preserving the singleton mutex
 * across calls.
 *
 * First access for a resolved teamDir creates the Team entry with a fresh mutex
 * and registers it (keyed by the absolute directory). Subsequent accesses return
 * the same in-memory Team (mutex + directory preserved). This is what makes
 * per-team serialization actually work under concurrent idle events.
 *
 * @param storageRoot   resolved .octeam root (project or user scope)
 * @param teamName      team directory name under the resolved teams dir
 * @param leadSessionId project scope: lead session segment (<root>/<sid>/teams);
 *                      omit for user scope (flat <root>/teams)
 */
export async function loadTeamState(
    storageRoot: string,
    teamName: string,
    leadSessionId?: string,
): Promise<Team> {
    const dir = teamDir(storageRoot, teamName, leadSessionId)
    const cached = teamRegistry.get(dir)
    if (cached) return cached
    // Deduplicate concurrent first-loads: if another caller is already
    // loading this directory, await their result instead of creating a
    // second Team object with a separate mutex.
    let inflight = inflightLoads.get(dir)
    if (!inflight) {
        inflight = loadTeamFromDisk(dir, teamName)
        inflightLoads.set(dir, inflight)
    }
    return inflight
}

/**
 * Perform the actual disk read + Team construction for a first load.
 * Extracted so loadTeamState can store the in-flight promise synchronously
 * before the first await, closing the registry-race window.
 */
async function loadTeamFromDisk(dir: string, teamName: string): Promise<Team> {
    try {
        const state = await readJsonOrNull<TeamState>(
            statePath(dir),
            (v): v is TeamState => isValidTeamState(v, dir),
        )
        if (!state) {
            const err = new Error(`loadTeamState: no state.json for team "${teamName}"`) as NodeJS.ErrnoException
            err.code = "ENOENT"
            throw err
        }
        const team: Team = { ...state, mutex: new AsyncMutex(), directory: dir, _diskSnapshot: deepClone(state) }
        teamRegistry.set(dir, team)
        return team
    } finally {
        inflightLoads.delete(dir)
    }
}

/** Deep-clone a JSON-serializable value (all TeamState fields are JSON-safe). */
function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
}

/** Structural equality for JSON-serializable values. */
function jsonEqual<T>(a: T, b: T): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Three-way merge of TeamState: start with `disk`, apply fields the caller
 * changed (current ≠ ancestor → caller mutated), preserve fields the caller
 * did NOT touch (current == ancestor → another process may have changed disk).
 */
function mergeTeamState(disk: TeamState, ancestor: TeamState, current: TeamState): TeamState {
    const merged: TeamState = { ...disk }
    // Scalar fields (except members/activeTask): caller wins only if changed.
    for (const key of Object.keys(current) as (keyof TeamState)[]) {
        if (key === "members" || key === "activeTask") continue
        if (!jsonEqual(current[key], ancestor[key])) {
            ;(merged as Record<string, unknown>)[key] = current[key]
        }
    }
    merged.members = mergeMembers(disk.members ?? [], ancestor.members ?? [], current.members ?? [])
    // activeTask is a nested mutable object (responses, tokensByMember,
    // messagesSent, stages, ...). A top-level comparison would let one
    // process's change to any sub-field clobber another's concurrent sub-field
    // update. Field-level three-way merge preserves both processes' changes.
    if (current.activeTask !== undefined || ancestor.activeTask !== undefined || disk.activeTask !== undefined) {
        merged.activeTask = mergeObjects(
            disk.activeTask, ancestor.activeTask, current.activeTask,
        ) as TeamState["activeTask"]
    }
    return merged
}

/**
 * Recursive three-way merge for plain JSON values. For each key: if
 * current != ancestor the caller changed it (current wins); otherwise the
 * caller didn't touch it (disk wins, preserving another process's change).
 * Plain objects recurse key-by-key; equal-length arrays recurse
 * index-by-index; unequal-length arrays (append/splice) and non-plain values
 * fall back to the top-level rule.
 */
function mergeObjects(
    disk: unknown,
    ancestor: unknown,
    current: unknown,
): unknown {
    // Equal-length arrays on all three sides: merge element-by-element so
    // concurrent per-index field changes both survive (e.g. pipeline stages[],
    // workflow steps[] — initialized once then mutated by index). Unequal
    // lengths (structural change: append/splice) fall through to the
    // top-level rule below; append-only arrays (decisionHistory,
    // approvalHistory) are single-writer in practice, so whole-array
    // replacement is safe there.
    if (Array.isArray(disk) && Array.isArray(ancestor) && Array.isArray(current)) {
        if (disk.length === ancestor.length && disk.length === current.length) {
            const merged: unknown[] = []
            for (let i = 0; i < disk.length; i++) {
                merged.push(mergeObjects(disk[i], ancestor[i], current[i]))
            }
            return merged
        }
        return jsonEqual(current, ancestor) ? disk : current
    }
    // Non-plain-object (undefined, null, primitive, partial-array, type
    // mismatch): fall back to top-level rule.
    if (
        disk === undefined || ancestor === undefined || current === undefined
        || typeof disk !== "object" || typeof ancestor !== "object" || typeof current !== "object"
        || Array.isArray(disk) || Array.isArray(ancestor) || Array.isArray(current)
        || disk === null || ancestor === null || current === null
    ) {
        return jsonEqual(current, ancestor) ? disk : current
    }
    const d = disk as Record<string, unknown>
    const a = ancestor as Record<string, unknown>
    const c = current as Record<string, unknown>
    const result: Record<string, unknown> = { ...d }
    const keys = new Set([...Object.keys(d), ...Object.keys(c)])
    for (const key of keys) {
        if (jsonEqual(c[key], a[key])) continue  // caller didn't touch -> keep disk
        result[key] = mergeObjects(d[key], a[key], c[key])
    }
    return result
}

/** Three-way merge of members[] by name. */
function mergeMembers(
    disk: TeamState["members"],
    ancestor: TeamState["members"],
    current: TeamState["members"],
): TeamState["members"] {
    const ancestorByName = new Map(ancestor.map(m => [m.name, m]))
    const currentByName = new Map(current.map(m => [m.name, m]))
    // Iterate names from disk + current. A name present on disk but absent
    // from BOTH current and ancestor means another process added it after our
    // last load — preserve it. A name in ancestor but absent from current
    // means the caller explicitly removed it — honor the removal (do NOT
    // restore from disk).
    const allNames = new Set<string>([
        ...disk.map(m => m.name),
        ...current.map(m => m.name),
    ])
    const result: TeamState["members"] = []
    for (const name of allNames) {
        const c = currentByName.get(name)
        if (!c) {
            // Caller does not have this member. Two sub-cases:
            //   - It was in ancestor → caller explicitly removed it → drop it.
            //   - It was NOT in ancestor → another process added it since our
            //     load → preserve from disk.
            if (ancestorByName.has(name)) continue  // caller removed: honor it
            const d = disk.find(m => m.name === name)
            if (d) result.push(d)  // concurrent add: preserve
            continue
        }
        const d = disk.find(m => m.name === name)
        if (!d) {
            // Member absent from disk: either the caller added it (not in
            // ancestor) or another process removed it (in ancestor). Without
            // the ancestor check, a stale snapshot from a process that still
            // holds the member would resurrect it on disk.
            if (ancestorByName.has(name)) continue  // concurrent removal: honor
            result.push(c)  // caller added it
            continue
        }
        const a = ancestorByName.get(name)
        if (!a) {
            // No ancestor for this member — use caller's.
            result.push(c)
            continue
        }
        // Field-level three-way merge: start with disk, apply caller's changed fields.
        const mergedMember = { ...d }
        for (const key of Object.keys(c) as (keyof typeof c)[]) {
            if (!jsonEqual(c[key], a[key])) {
                ;(mergedMember as Record<string, unknown>)[key] = c[key]
            }
        }
        result.push(mergedMember)
    }
    return result
}

/**
 * Persist the TeamState portion of a team to state.json via a cross-process
 * file lock + atomic write. The mutex/directory fields are NOT persisted.
 *
 * The caller is expected to already hold team.mutex.runExclusive for in-process
 * serialization.
 *
 * Lock scope: `withLock(stateLockPath())` provides cross-process serialization.
 * Inside the lock, this performs a READ-MERGE-WRITE: it re-reads state.json
 * and three-way-merges (disk, caller's last-known disk snapshot, caller's
 * current state) so a stale snapshot from another process does not clobber
 * concurrent mutations. Fields the caller did not touch (current == ancestor)
 * are taken from disk; fields the caller explicitly changed (current !=
 * ancestor) override disk.
 */
export async function saveTeamState(team: Team): Promise<void> {
    if (team.deleted) return  // tombstone: do not resurrect deleted team
    const dir = team.directory
    const currentState = stripRuntimeFields(team)
    await withLock(stateLockPath(dir), async () => {
        const ancestor = team._diskSnapshot
        let toWrite: TeamState
        if (ancestor) {
            const diskState = await readJsonOrNull<TeamState>(statePath(dir))
            if (diskState && !isValidTeamState(diskState, dir)) {
                // Disk state is corrupt or tampered. Do NOT merge it into the
                // three-way merge — that would re-persist the corrupt data.
                // Fall back to a blind write of the current state.
                logger.warn("saveTeamState: disk state failed validation; skipping merge to avoid persisting corrupt data", { dir })
                toWrite = currentState
            } else {
                toWrite = diskState
                    ? mergeTeamState(diskState, ancestor, currentState)
                    : currentState
            }
        } else {
            // No ancestor snapshot (first save / legacy) — blind write.
            toWrite = currentState
        }
        await atomicWrite(statePath(dir), JSON.stringify(toWrite, null, 2), dir)
        team._diskSnapshot = deepClone(toWrite)
        // Sync concurrent changes from the merged result back into the live
        // team. Without this, the live Team diverges from disk after a
        // cross-process mutation (e.g. another process changed status to
        // "busy" — the merge writes it to disk correctly, but the live Team
        // still has "live", so the next in-process operation uses stale data).
        //
        // Scalar fields: adopt the merged value for fields the caller did NOT
        // change (merge already took disk's value for those). For fields the
        // caller DID change, the merged value == caller's value, so the sync
        // is a no-op. Skip identity fields (teamName, leadSessionId, teamRunId)
        // that must not change via merge — they are set at creation/rename.
        const scalarsToSync: Array<keyof TeamState> = [
            "status", "activatedAt", "startedAt", "createdAt",
            "lastInterruptedTask", "lastMode", "bounds",
        ]
        for (const key of scalarsToSync) {
            const merged = toWrite[key]
            if (merged !== undefined && !jsonEqual(team[key], merged)) {
                ;(team as Record<string, unknown>)[key] = deepClone(merged)
            }
        }
        // Members: only PUSH missing members — never replace existing objects
        // or the array reference, which would break in-flight callers holding
        // references to the current members/steps.
        if (team.members) {
            const liveNames = new Set(team.members.map(m => m.name))
            for (const m of toWrite.members ?? []) {
                if (!liveNames.has(m.name)) team.members.push(m)
            }
        }

    })
}

/** Read the immutable TeamSpec (config.json) for a team, or null if absent. */
export async function readTeamSpec(
    storageRoot: string,
    teamName: string,
    leadSessionId?: string,
): Promise<TeamSpec | null> {
    return readJsonOrNull<TeamSpec>(configPath(teamDir(storageRoot, teamName, leadSessionId)))
}

/** Read TeamSpec from a known team directory (scope-independent). */
export async function readTeamSpecFromDir(teamDirectory: string): Promise<TeamSpec | null> {
    return readJsonOrNull<TeamSpec>(configPath(teamDirectory))
}

/** Write the immutable TeamSpec (config.json) atomically. Used at team_create.
 *
 * `trustedRoot` (optional, recommended) is forwarded to atomicWrite's ancestor
 * chain check (assertNoSymlinkTraversal) so an intermediate-dir symlink cannot
 * redirect config.json outside the storage root. team_create always supplies it.
 */
export async function writeTeamSpec(
    storageRoot: string,
    spec: TeamSpec,
    leadSessionId?: string,
    trustedRoot?: string,
): Promise<void> {
    await atomicWrite(
        configPath(teamDir(storageRoot, spec.name, leadSessionId)),
        JSON.stringify(spec, null, 2),
        trustedRoot,
    )
}

/**
 * Write an initial state.json for a brand-new team, then load it into the
 * registry (creating the Team with a fresh mutex). Used at team_create.
 *
 * `leadSessionId` governs the storage scope for BOTH the write and the registry
 * self-call: present → <root>/<sid>/teams/<name> (project), omitted → flat
 * <root>/teams/<name> (user). state.leadSessionId is always populated, but the
 * param is what selects flat vs segmented placement, so write and read agree.
 *
 * `trustedRoot` (optional, recommended) is forwarded to atomicWrite's ancestor
 * chain check (assertNoSymlinkTraversal) so an intermediate-dir symlink cannot
 * redirect state.json outside the storage root.
 */
export async function initTeamState(
    storageRoot: string,
    state: TeamState,
    leadSessionId?: string,
    trustedRoot?: string,
): Promise<Team> {
    const dir = teamDir(storageRoot, state.teamName, leadSessionId)
    await atomicWrite(statePath(dir), JSON.stringify(state, null, 2), trustedRoot)
    // Register a fresh Team entry; loadTeamState will read what we just wrote.
    const team = await loadTeamState(storageRoot, state.teamName, leadSessionId)
    // C9: register the master session in the in-memory index so tools that
    // verify master authorization via isIndexedMasterOf find the team.
    // Production callers (team_create) already call indexMasterTeam after
    // initTeamState, and startup calls rebuildSessionIndex; doing it here
    // too makes the index consistent for ALL init paths (including tests
    // and any future caller) without relying on each caller remembering it.
    if (state.leadSessionId) {
        indexMasterTeam(
            state.leadSessionId,
            state.teamName,
            leadSessionId,
            storageRoot,
            dir,
        )
    }
    return team
}

/** Recursively remove a team's on-disk directory. Used at team_delete(force).
 *
 * C14: asserts no symlink traversal BEFORE the recursive remove. Without
 * this, an attacker who replaces the team directory (or an intermediate
 * ancestor) with a symlink could redirect fs.rm to an arbitrary location
 * outside the storage root.
 */
export async function deleteTeamStorage(
    storageRoot: string,
    teamName: string,
    leadSessionId?: string,
): Promise<void> {
    const dir = teamDir(storageRoot, teamName, leadSessionId)
    await assertNoSymlinkTraversal(storageRoot, dir)
    await fs.rm(dir, {
        recursive: true,
        force: true, // force:true already swallows ENOENT (dir already gone).
    })
}

/**
 * List team names present on disk under the resolved teams dir.
 * Returns [] if the teams directory does not exist yet.
 */
export async function listTeamNames(storageRoot: string, leadSessionId?: string): Promise<string[]> {
    const root = teamsDir(storageRoot, leadSessionId)
    try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch (err: unknown) {
        if (isEnoent(err)) return []
        throw err
    }
}

/**
 * Enumerate every team across a scope.
 *
 * - segmented=true  (project scope): top-level entries of <storageRoot> are lead
 *   session ids; recurse each <storageRoot>/<sid>/teams/* and tag the sid.
 * - segmented=false (user scope): flat <storageRoot>/teams/* with no sid.
 *
 * Returns [] when the root does not exist. Used by rebuildSessionIndex.
 */
export async function listAllTeams(
    storageRoot: string,
    segmented: boolean,
): Promise<{ leadSessionId?: string; teamName: string }[]> {
    if (!segmented) {
        const names = await listTeamNames(storageRoot)
        return names.map(teamName => ({ teamName }))
    }
    let sids: string[]
    try {
        const entries = await fs.readdir(storageRoot, { withFileTypes: true })
        sids = entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch (err: unknown) {
        if (isEnoent(err)) return []
        throw err
    }
    const out: { leadSessionId?: string; teamName: string }[] = []
    for (const sid of sids) {
        const names = await listTeamNames(storageRoot, sid)
        for (const teamName of names) out.push({ leadSessionId: sid, teamName })
    }
    return out
}

/**
 * Remove a team from the in-memory registry (e.g. on team_delete), keyed by its
 * resolved teamDir (absolute path). Subsequent loadTeamState calls rebuild the
 * entry fresh — but in practice teams are only invalidated when their on-disk
 * state is also removed.
 */
export function invalidateTeam(teamDirectory: string): void {
    teamRegistry.delete(teamDirectory)
}

/**
 * Snapshot of registry teams that currently have an active orchestration. Used
 * by the sweep timer (it only needs to babysit busy teams) without scanning disk.
 */
export function activeTeams(): Team[] {
    return Array.from(teamRegistry.values()).filter(t => t.activeTask)
}
