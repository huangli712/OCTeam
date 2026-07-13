/**
 * On-disk team state persistence: load, save, create, delete, and the
 * in-memory Team registry.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { logger } from '../core/log.js';
import type { TeamState, TeamSpec } from "../core/types.js"
import { isOCTeamAgent } from "../core/role.js"
import { isEnoent } from '../core/utils.js';
import { atomicWrite, AsyncMutex, withLock } from "./locks.js"
import {
    configPath,
    isSafePathSegment,
    stateLockPath,
    statePath,
    teamDir,
    teamsDir,
    worktreesDir,
} from "./paths.js"
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

/**
 * Clear the active task while preserving its mode in `lastMode` for sidebar
 * display. Called at every orchestration completion/termination site.
 */
export function clearActiveTask(team: Team): void {
    if (team.activeTask) {
        team.lastMode = {
            type: team.activeTask.type,
            mode: team.activeTask.mode,
            finishedAt: Date.now(),
        }
    }
    team.activeTask = undefined
}

// Process-level registry: resolved teamDir (absolute path) -> Team (with its
// singleton mutex). Keying by the RESOLVED directory — not teamName — is what
// keeps team "aaa" under session ses_x distinct from "aaa" under ses_y, and
// project-scope "aaa" distinct from user-scope "aaa". Rebuilt lazily on plugin
// restart; first access creates the entry, later accesses keep the mutex.
const teamRegistry = new Map<string, Team>()

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
    // Reject any member whose agent is present but not in the oct-* allowlist.
    // A missing agent is allowed here (legacy/old state) — safeMemberAgent at
    // dispatch falls back to oct-oracle (read-only) in that case.
    // Worktree-path hardening: a persisted worktreePath is passed VERBATIM as
    // the child session's `directory` at spawn/dispatch time
    // (dispatch.ts: `member.worktreePath ?? ctx.directory`), so a tampered
    // state.json could otherwise make a member session run OUTSIDE the team
    // worktree. Reject any worktreePath that does not resolve strictly inside
    // the team's own worktrees/ directory. A missing worktreePath is allowed
    // (members without worktree: true).
    const wtRoot = worktreesDir(teamDirectory)
    for (const m of s.members) {
        if (typeof m !== "object" || m === null) return false
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
            const resolved = path.resolve(teamDirectory, wt)
            if (resolved !== wtRoot && !resolved.startsWith(wtRoot + path.sep)) {
                return false
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
    let team = teamRegistry.get(dir)
    if (!team) {
        const state = await readJsonOrNull<TeamState>(
            statePath(dir),
            (v): v is TeamState => isValidTeamState(v, dir),
        )
        if (!state) {
            throw new Error(`loadTeamState: no state.json for team "${teamName}"`)
        }
        team = { ...state, mutex: new AsyncMutex(), directory: dir, _diskSnapshot: deepClone(state) }
        teamRegistry.set(dir, team)
    }
    // Once registered, the in-memory Team is the authoritative copy — every
    // mutation goes through it under the per-team mutex, then saveTeamState writes
    // it to disk. Re-reading disk here would clobber an in-flight mutex holder's
    // unsaved mutations. The registry is rebuilt from disk only on first access or
    // after invalidateTeam (restart / delete).
    return team
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
            // Member added by caller — use caller's.
            result.push(c)
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
            toWrite = diskState
                ? mergeTeamState(diskState, ancestor, currentState)
                : currentState
        } else {
            // No ancestor snapshot (first save / legacy) — blind write.
            toWrite = currentState
        }
        await atomicWrite(statePath(dir), JSON.stringify(toWrite, null, 2))
        team._diskSnapshot = deepClone(toWrite)
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

/** Write the immutable TeamSpec (config.json) atomically. Used at team_create. */
export async function writeTeamSpec(
    storageRoot: string,
    spec: TeamSpec,
    leadSessionId?: string,
): Promise<void> {
    await atomicWrite(
        configPath(teamDir(storageRoot, spec.name, leadSessionId)),
        JSON.stringify(spec, null, 2),
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
 */
export async function initTeamState(
    storageRoot: string,
    state: TeamState,
    leadSessionId?: string,
): Promise<Team> {
    const dir = teamDir(storageRoot, state.teamName, leadSessionId)
    await atomicWrite(statePath(dir), JSON.stringify(state, null, 2))
    // Register a fresh Team entry; loadTeamState will read what we just wrote.
    return loadTeamState(storageRoot, state.teamName, leadSessionId)
}

/** Recursively remove a team's on-disk directory. Used at team_delete(force). */
export async function deleteTeamStorage(
    storageRoot: string,
    teamName: string,
    leadSessionId?: string,
): Promise<void> {
    await fs.rm(teamDir(storageRoot, teamName, leadSessionId), {
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
