/**
 * On-disk team state persistence: load, save, create, delete, and the
 * in-memory Team registry.
 */

import fs from "node:fs/promises"
import { realpathSync, constants as fsSyncConstants } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"

import type {
    TeamState,
    TeamSpec
} from "../core/types.js"
import { logger } from '../core/log.js';
import { isOCTeamAgent } from "../core/role.js"
import { isEnoent } from '../core/utils.js';
//
import {
    assertNoSymlinkTraversal,
    atomicWrite,
    AsyncMutex,
    safeReadFile,
    withLock
} from "./locks.js"
import {
    configPath,
    deletedMarkerPath,
    isSafePathSegment,
    stateLockPath,
    statePath,
    teamDir,
    teamsDir,
    worktreesDir,
} from "./paths.js"
import { indexMasterTeam } from "./resolve.js"

/** O_NOFOLLOW closes the TOCTOU window. Use fs.constants if available,
 *  falling back to the Linux numeric value for platforms where constants
 *  doesn't expose it. */
const O_NOFOLLOW = (fsSyncConstants as Record<string, number>).O_NOFOLLOW ?? 0x20000

/** Bounded-retry attempts for saveTeamStateBounded. */
const SAVE_RETRY_ATTEMPTS = 3

/** Backoff (ms) between saveTeamStateBounded retries. */
const SAVE_RETRY_BACKOFF_MS = 50

/**
 * Runtime team object: TeamState plus non-persisted handles.
 *
 * `mutex` is a per-team process-level singleton keyed by resolved directory
 * (see teamRegistry) — it serializes event-handler state mutations.
 * `directory` is the resolved team working directory on disk.
 * `deleted` is the runtime tombstone set by team_delete inside the mutex:
 * once true, processIdle/saveTeamState skip persistence so a racing handler
 * holding the same in-memory reference cannot recreate the just-removed
 * directory via atomicWrite's mkdir({recursive:true}).
 * None of these fields is written to state.json (see stripRuntimeFields),
 * except `spawning`/`spawningOwner`, which ARE persisted so a crashed spawn
 * lease survives restart and the reconciler can clear a dead owner's guard.
 *
 * `spawning` is a cross-process spawn guard set by startOrchestration between
 * Phase 1 (busy pre-check) and Phase 3 (activeTask commit). It prevents a
 * second concurrent caller from entering Phase 2 (ensureMembersReady) and
 * duplicating member-session spawns while the first has released the mutex.
 */
export type Team = TeamState & {
    mutex: AsyncMutex
    directory: string
    deleted?: boolean
    spawning?: boolean
    _diskSnapshot?: TeamState  // last known on-disk state (for three-way merge in saveTeamState)
    _diskMtime?: number  // mtimeMs of the last disk read (for cross-process cache invalidation)
    _lastCacheCheck?: number  // throttle: last time we stat'd the disk for staleness
    _persistDirty?: boolean
    _stateUnreadable?: boolean
}

/** Process-level registry: resolved teamDir (absolute path) -> Team (with
 *  its singleton mutex). Keying by the RESOLVED directory — not teamName —
 *  is what keeps team "aaa" under session ses_x distinct from "aaa" under
 *  ses_y, and project-scope "aaa" distinct from user-scope "aaa". Rebuilt
 *  lazily on plugin restart; first access creates the entry, later accesses
 *  keep the mutex. */
const teamRegistry = new Map<string, Team>()

/** In-flight first-load promises keyed by directory, preventing two
 *  concurrent first-accesses from creating separate Team objects (and
 *  separate mutexes) for the same directory — which would break per-team
 *  serialization. */
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
    team.runnerPid = undefined  // Clear the fencing token when the run ends
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
        _diskSnapshot: _snap,
        _diskMtime: _mtime,
        _lastCacheCheck: _cacheCheck,
        _persistDirty: _persistDirty,
        _stateUnreadable: _stateUnreadable,
        ...state
    } = team
    // Proactively strip isMaster from every member before serialization.
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
 * deserialize to an arbitrary shape. Validates the fields every load path
 * immediately dereferences (identity, status/version enums, concurrency-control
 * fields, bounds, and per-member shape including agent hardening) so bad data
 * is rejected at the boundary instead of propagating undefined access. Deeply
 * optional payloads like activeTask are not checked.
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
    // Verify teamName matches the directory's last path segment.
    // A tampered state.json moved to another team's directory would otherwise
    // load and bind the session to the wrong team.
    // path.basename handles platform-specific separators when deriving the name.
    const expectedName = path.basename(teamDirectory)
    if (expectedName && s.teamName !== expectedName) return false
    // Validate status as a known enum value so tampered values cannot reach
    // handlers that switch on status.
    const VALID_STATUSES = new Set(["idle", "busy", "failed", "live"])
    if (!VALID_STATUSES.has(s.status)) return false
    // Version must be exactly 1, the only defined schema. Reject unknown
    // versions so callers never apply version-1 semantics to another schema.
    if (s.version !== 1) return false
    // leadSessionId is a directory locator (used to construct the team path),
    // NOT an authorization credential. Authorization is derived from the
    // session index (rebuilt from disk structure at startup). When present,
    // validate it is a non-empty string so a tampered state.json cannot inject
    // a non-string value that could break path operations. Absent is allowed
    // for fixtures and tests that omit the field.
    if (s.leadSessionId !== undefined
        && (typeof s.leadSessionId !== "string" || s.leadSessionId.length === 0)) return false
    // Validate key fields that participate in concurrency control.
    // teamRunId must be a non-empty string when present (empty string
    // would fail runId comparisons and bypass deletion marker checks).
    if (s.teamRunId !== undefined
        && (typeof s.teamRunId !== "string" || s.teamRunId.length === 0)) return false
    if (s.spawning !== undefined && typeof s.spawning !== "boolean") return false
    if (s.spawningOwner !== undefined && typeof s.spawningOwner !== "string") return false
    // PID 0 and negative PIDs are never valid process IDs. A tampered
    // state.json with runnerPid:0 would bypass the cross-process ownership
    // guard (process.pid is always > 0).
    if (s.runnerPid !== undefined
        && (typeof s.runnerPid !== "number" || !Number.isFinite(s.runnerPid) || s.runnerPid <= 0)) return false
    // Validate timestamp fields as finite numbers when present.
    // Note: unset is represented by absence (undefined) — activatedAt is
    // cleared to undefined on deactivation, and createdAt is always set at
    // team creation. A 0 value is accepted here (only negative or
    // non-finite values are rejected).
    if (s.createdAt !== undefined
        && (typeof s.createdAt !== "number" || !Number.isFinite(s.createdAt) || s.createdAt < 0)) return false
    if (s.activatedAt !== undefined
        && (typeof s.activatedAt !== "number" || !Number.isFinite(s.activatedAt) || s.activatedAt < 0)) return false
    if (s.bounds !== undefined) {
        if (typeof s.bounds !== "object" || s.bounds === null) return false
        // All bounds values must be non-negative finite numbers.
        for (const v of Object.values(s.bounds as Record<string, unknown>)) {
            if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return false
        }
    }
    // member name uniqueness
    const memberNames = new Set<string>()
    for (const m of s.members) {
            if (typeof m !== "object" || m === null) return false
            // Reject ANY truthy isMaster on persisted members, not just
            // boolean true. isMaster is a runtime-only flag on the synthetic
            // master record. A tampered state.json could write isMaster:"true",
            // isMaster:1, or isMaster:{} to bypass an === true check and gain
            // master privileges. undefined (absent), false, and null are the
            // only safe persisted values; any other value is tampering.
            const isMasterVal = (m as { isMaster?: unknown }).isMaster
            if (isMasterVal !== undefined && isMasterVal !== false && isMasterVal !== null) return false
        // Validate required per-member fields: name (used as a path segment in
        // mailbox/reserved dir operations) must be a safe segment, and status
        // must be a string. A tampered state.json with a missing/unsafe name
        // or missing status would otherwise propagate and crash downstream
        // path operations (reservedDir → assertSafeSegment in the sweep loop).
        const name = (m as { name?: unknown }).name
        if (typeof name !== "string" || !isSafePathSegment(name)) return false
        // Reject the reserved name "master" because it would collide with the
        // synthetic master pseudo-member and let a tampered state.json inject
        // a member that polls and ACKs the master mailbox.
        if (name === "master") return false
        // Reject duplicate member names.
        if (memberNames.has(name)) return false
        memberNames.add(name)
        const status = (m as { status?: unknown }).status
        if (typeof status !== "string") return false
              // Reject out-of-enum member statuses. The state machine only
              // allows pending/running/idle/errored (MemberStatus union). A
              // tampered state.json with status:"paused" or status:"retrying"
              // would pass the string check
              // but be permanently skipped by the sweep (which only handles
              // "running"). "retrying" is not a valid MemberStatus and no code
              // path writes it.
              const VALID_MEMBER_STATUSES = new Set(["pending", "running", "idle", "errored"])
        if (!VALID_MEMBER_STATUSES.has(status)) return false
        const agent = (m as { agent?: unknown }).agent
        if (agent !== undefined && (typeof agent !== "string" || !isOCTeamAgent(agent))) {
            return false
        }
            const wt = (m as { worktreePath?: unknown }).worktreePath
            if (wt !== undefined) {
                if (typeof wt !== "string") return false
                // path.resolve is lexical and does not follow symlinks.
                // A worktreePath that is a symlink pointing outside the worktrees/
                // dir would pass the lexical containment check but actually
                // redirect member operations to an external directory.
                //
                // When the path exists, use realpathSync to resolve symlinks and
                // re-check containment. Only a not-yet-existing path (ENOENT —
                // worktree not created at save time) falls back to the lexical
                // check (the spawn-time check is the final guard for that case);
                // any other realpath error fails closed.
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
                } catch (err: unknown) {
                    // Only ENOENT (worktree not yet created) is a safe
                    // fallback to the lexical check above. Other realpath
                    // errors (EACCES, EIO, ELOOP) mean an attacker may have
                    // made an external symlink temporarily unresolvable to
                    // pass load, then restore permissions to run member
                    // tasks outside the worktrees root. Fail closed.
                    const code = (err as NodeJS.ErrnoException).code
                    if (code !== "ENOENT") return false
                }
            }
    }
    return true
}

/** Structural validation for TeamSpec. */
function isValidTeamSpec(value: unknown): value is TeamSpec {
    if (typeof value !== "object" || value === null) return false
    const s = value as Record<string, unknown>
    if (typeof s.name !== "string" || !s.name) return false
    if (s.version !== 1) return false
    if (typeof s.createdAt !== "number" || !Number.isFinite(s.createdAt)) return false
    if (!Array.isArray(s.members)) return false
    const seenNames = new Set<string>()
    for (const m of s.members) {
        if (typeof m !== "object" || m === null) return false
        const mb = m as Record<string, unknown>
        if (typeof mb.name !== "string" || !mb.name) return false
        // Reject duplicate member names.
        if (seenNames.has(mb.name)) return false
        seenNames.add(mb.name)
        if (typeof mb.role !== "string" || !mb.role) return false
        if (typeof mb.prompt !== "string") return false
    }
    return true
}

/**
 * Apply a freshly-read disk state onto a cached Team via three-way merge
 * (disk vs last-known disk snapshot vs current runtime fields): stale keys
 * and removed members are dropped, member fields the caller changed relative
 * to the ancestor snapshot win over disk, and runtime-only fields (mutex,
 * tombstone, spawn state, caches) survive.
 * `diskMtime` restamps the cache-invalidation watermark.
 */
function applyReloadedTeamState(cached: Team, state: TeamState, diskMtime: number): void {
    const currentState = stripRuntimeFields(cached)
    const mergedState = mergeTeamState(state, cached._diskSnapshot ?? state, currentState)
    const runtimeKeys = new Set([
        "mutex", "directory", "deleted", "spawning", "spawningOwner", "members", "activeTask",
        "_diskSnapshot", "_diskMtime", "_lastCacheCheck", "_persistDirty", "_stateUnreadable",
    ])
    const liveState = cached as Record<string, unknown>
    const diskKeys = new Set(Object.keys(mergedState))
    for (const key of Object.keys(cached)) {
        if (!runtimeKeys.has(key) && !diskKeys.has(key)) delete liveState[key]
    }

    const diskMembers = mergedState.members
    const diskMemberNames = new Set(diskMembers.map(member => member.name))
    for (let index = cached.members.length - 1; index >= 0; index--) {
        if (!diskMemberNames.has(cached.members[index].name)) cached.members.splice(index, 1)
    }
    const liveMembers = new Map(cached.members.map(member => [member.name, member] as const))
    for (const diskMember of diskMembers) {
        const liveMember = liveMembers.get(diskMember.name)
        if (liveMember) {
            const diskMemberKeys = new Set(Object.keys(diskMember))
            for (const key of Object.keys(liveMember)) {
                if (!diskMemberKeys.has(key)) delete (liveMember as Record<string, unknown>)[key]
            }
            Object.assign(liveMember, deepClone(diskMember))
        } else {
            cached.members.push(deepClone(diskMember))
        }
    }

    if (cached.activeTask && mergedState.activeTask) {
        const liveTask = cached.activeTask as unknown as Record<string, unknown>
        const diskTask = mergedState.activeTask as unknown as Record<string, unknown>
        const forcedDirectTaskIds = liveTask.forcedDirectTaskIds
        for (const key of Object.keys(liveTask)) {
            if (key !== "forcedDirectTaskIds" && !(key in diskTask)) delete liveTask[key]
        }
        Object.assign(liveTask, deepClone(diskTask))
        if (forcedDirectTaskIds !== undefined) liveTask.forcedDirectTaskIds = forcedDirectTaskIds
    } else {
        cached.activeTask = mergedState.activeTask === undefined ? undefined : deepClone(mergedState.activeTask)
    }

    const { members: _members, activeTask: _activeTask, ...restState } = mergedState
    Object.assign(cached, deepClone(restState))
    cached._diskSnapshot = deepClone(state)
    cached._diskMtime = diskMtime
    cached._stateUnreadable = false
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
    if (cached) {
        // Throttle disk stat to once per second per team to avoid
        // an fs.stat on every cached lookup (which happens very frequently
        // during orchestration).
        const now = Date.now()
        if (!cached._stateUnreadable && cached._lastCacheCheck !== undefined && now - cached._lastCacheCheck < 1000) {
            return cached
        }
        cached._lastCacheCheck = now
        const startingDiskSnapshot = cached._diskSnapshot
        // Refresh from disk when mtime is equal/newer, or when the
        // filesystem clock moved backwards. Update the cached Team in-place
        // so its mutex and live object references retain their identity.
        try {
            const diskStat = await fs.stat(statePath(dir))
            const previousMtime = cached._diskMtime
            const clockRolledBack = previousMtime !== undefined && diskStat.mtimeMs < previousMtime
            if (previousMtime === undefined || diskStat.mtimeMs >= previousMtime || clockRolledBack) {
                // Reload state from disk and update the cached Team in-place.
                const state = await readJsonOrNull<TeamState>(
                    statePath(dir),
                    (v): v is TeamState => isValidTeamState(v, dir),
                )
                if (!state) {
                    throw new Error(`loadTeamState: cached state.json for team "${teamName}" is unreadable or invalid`)
                }
                await cached.mutex.runExclusive(async () => {
                    if (cached._diskSnapshot !== startingDiskSnapshot) return
                    applyReloadedTeamState(cached, state, diskStat.mtimeMs)
                })
                return cached
            }
            return cached
        } catch (err) {
            if (isEnoent(err)) {
                teamRegistry.delete(dir)
                inflightLoads.delete(dir)
                throw err
            }
            await cached.mutex.runExclusive(async () => {
                cached._stateUnreadable = true
            })
            logger.error("loadTeamState: cached state is unreadable; returning flagged cache", {
                team: teamName,
                file: statePath(dir),
                error: err instanceof Error ? err.message : String(err),
            })
            return cached
        }
    }
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
        // Record the disk mtime so loadTeamState can detect
        // cross-process modifications on subsequent cached lookups.
        try {
            const st = await fs.stat(statePath(dir))
            team._diskMtime = st.mtimeMs
        } catch { /* best-effort */ }
        teamRegistry.set(dir, team)
        return team
    } finally {
        inflightLoads.delete(dir)
    }
}

/** Refresh a registered Team from disk. The caller must hold team.mutex. */
export async function reloadTeamStateLocked(team: Team): Promise<void> {
    const file = statePath(team.directory)
    try {
        const diskStat = await fs.stat(file)
        const state = await readJsonOrNull<TeamState>(
            file,
            (value): value is TeamState => isValidTeamState(value, team.directory),
        )
        if (!state) {
            throw new Error(`reloadTeamStateLocked: state.json for team "${team.teamName}" is unreadable or invalid`)
        }
        applyReloadedTeamState(team, state, diskStat.mtimeMs)
        team._lastCacheCheck = Date.now()
    } catch (error) {
        team._stateUnreadable = true
        throw error
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
            // runnerPid is a fencing token set by whichever process
            // starts/resumes a run. If current cleared it (undefined) but
            // disk changed it from ancestor (another process set it), clearing
            // would falsely mark the run as ownerless. Only protect disk when
            // it actually changed from ancestor; if disk == ancestor, the
            // current process legitimately cleared it.
            if (
                key === "runnerPid"
                && current[key] === undefined
                && disk[key] !== undefined
                && !jsonEqual(disk[key], ancestor[key])
            ) continue
            ;(merged as Record<string, unknown>)[key] = current[key]
        }
    }
    merged.members = mergeMembers(disk.members ?? [], ancestor.members ?? [], current.members ?? [])
    // activeTask is a nested mutable object (responses, tokensByMember,
    // messagesSent, stages, ...). A top-level comparison would let one
    // process's change to any sub-field clobber another's concurrent sub-field
    // update. Field-level three-way merge preserves both processes' changes.
    if (current.activeTask !== undefined || ancestor.activeTask !== undefined || disk.activeTask !== undefined) {
        // Fence activeTask by runId. If disk has a different runId
        // than current (or current is undefined while disk started a new run
        // not in ancestor), disk belongs to a NEW run. Merging would mix
        // fields from two different runs or clear the new run. Keep disk.
        const diskRunId = disk.activeTask?.runId
        const currentRunId = current.activeTask?.runId
        const ancestorRunId = ancestor.activeTask?.runId
        if (
            disk.activeTask !== undefined
            && diskRunId !== undefined
            && diskRunId !== currentRunId
            && diskRunId !== ancestorRunId
        ) {
            merged.activeTask = disk.activeTask
        } else {
            merged.activeTask = mergeObjects(
                disk.activeTask, ancestor.activeTask, current.activeTask,
            ) as TeamState["activeTask"]
            // Merge each writer's messagesSent delta onto the latest disk
            // value so concurrent increments from the same ancestor all survive.
            if (merged.activeTask && current.activeTask && disk.activeTask) {
                const da = disk.activeTask as unknown as Record<string, unknown>
                const ca = current.activeTask as unknown as Record<string, unknown>
                const ma = merged.activeTask as unknown as Record<string, unknown>
                if (typeof da.messagesSent === "number" && typeof ca.messagesSent === "number") {
                    // Use a signed delta because delivery failures can refund
                    // quota, then clamp the final result to non-negative.
                    ma.messagesSent = Math.max(
                        0,
                        da.messagesSent + (ca.messagesSent - (ancestor.activeTask?.messagesSent ?? 0)),
                    )
                }
                if (typeof da.tokensUsed === "number" && typeof ca.tokensUsed === "number") {
                    // Recompute from the merged tokensByMember map so concurrent
                    // writers tracking different members are all included.
                    if (ma.tokensByMember) {
                        ma.tokensUsed = Math.max(0, Object.values(ma.tokensByMember)
                            .reduce((a, b) => a + b, 0))
                    } else {
                        ma.tokensUsed = Math.max(da.tokensUsed as number, ca.tokensUsed as number)
                    }
                }
            }
        }
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
 * Save team state with bounded retries for transient disk failures.
 * Throws the final error so orchestration control code can handle it.
 */
export async function saveTeamStateBounded(team: Team): Promise<void> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= SAVE_RETRY_ATTEMPTS; attempt++) {
        try {
            await saveTeamState(team)
            return
        } catch (err) {
            lastErr = err
            if (attempt < SAVE_RETRY_ATTEMPTS) {
                await new Promise(r => setTimeout(r, SAVE_RETRY_BACKOFF_MS))
            }
        }
    }
    throw lastErr
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
    if (team.deleted) return  // tombstone: do not resurrect deleted team directory
    const dir = team.directory
    const currentState = stripRuntimeFields(team)
    await withLock(stateLockPath(dir), async () => {
        // Check for a cross-process deletion marker. Only a marker for this
        // team run is a tombstone; a replacement team removes the stale marker.
        const marker = deletedMarkerPath(dir)
        try {
            const deletedTeamRunId = await safeReadFile(path.dirname(dir), marker, { maxBytes: 1024 })
            if (deletedTeamRunId === team.teamRunId) {
                team.deleted = true
                return
            }
            await fs.unlink(marker)
        } catch (err) {
            if (!isEnoent(err)) throw err
        }
        const ancestor = team._diskSnapshot
        let toWrite: TeamState
        // Track whether disk changed since our last save (i.e. another
        // process wrote). Used to guard the activeTask sync — only sync when
        // concurrent changes exist, to avoid breaking nested references in
        // the single-process no-op-merge case.
        let diskChanged = false
        if (ancestor) {
            const diskState = await readJsonOrNull<TeamState>(statePath(dir))
            if (diskState && !isValidTeamState(diskState, dir)) {
                // Disk state is corrupt or tampered. Back it up for forensic
                // recovery before overwriting with the known-good in-memory
                // state, so the corrupt-but-potentially-recoverable data is
                // not silently destroyed.
                try {
                    // Use exclusive-create with a random suffix to prevent
                    // collisions and symlink following.
                    const backupPath = `${statePath(dir)}.corrupt-${randomUUID()}.json`
                    const backupFh = await fs.open(backupPath, "wx")
                    try {
                        await backupFh.writeFile(JSON.stringify(diskState, null, 2))
                    } finally {
                        await backupFh.close()
                    }
                    logger.warn(
                        "saveTeamState: disk state failed validation; backed up corrupt state before overwrite",
                        { dir, backupPath },
                    )
                } catch {
                    logger.warn(
                        "saveTeamState: disk state failed validation; backup failed, proceeding with overwrite",
                        { dir },
                    )
                }
                toWrite = currentState
            } else {
                diskChanged = diskState !== null && !jsonEqual(diskState, ancestor)
                // Fence across generations. If disk teamRunId differs
                // from the live team, the team was deleted and recreated.
                // Merging would mix old-generation members/tasks into the
                // new team. Refuse to merge stale state.
                if (diskState && diskState.teamRunId !== currentState.teamRunId) {
                    throw new Error(`saveTeamState: disk teamRunId (${diskState.teamRunId}) differs from live `
                        + `(${currentState.teamRunId}) — team was recreated; refusing to merge stale state`)
                }
                // The disk file vanished since the last save but cache still has
                // an ancestor snapshot. Another process may have deleted or
                // renamed the team. Log prominently so operators can detect
                // potential stale-state resurrection.
                if (!diskState) {
                    logger.warn(
                        "saveTeamState: team state file vanished since last save "
                        + "— team may have been deleted/renamed by another process",
                        { dir },
                    )
                }
                toWrite = diskState
                    ? mergeTeamState(diskState, ancestor, currentState)
                    : currentState
            }
        } else {
            // No ancestor snapshot on the first save, so write current state directly.
            toWrite = currentState
        }
        // Enforce the same 1 MiB size cap on writes that the reader
        // enforces. Without this, a legitimate run with large workflow steps,
        // responses, and histories could write a state.json that the loader
        // then refuses to read (>1 MiB cap), making the team appear to vanish
        // on restart.
        const serialized = JSON.stringify(toWrite, null, 2)
        const serializedBytes = Buffer.byteLength(serialized, "utf8")
        if (serializedBytes > 1_048_576) {
            // The writer must not produce a state that the reader rejects, so
            // truncate large response fields to fit under the cap.
            const trimmed = JSON.parse(serialized) as Record<string, unknown>
            if (trimmed.activeTask && typeof trimmed.activeTask === "object") {
                const at = trimmed.activeTask as Record<string, unknown>
                if (at.responses && typeof at.responses === "object") {
                    const responses = at.responses as Record<string, string>
                    for (const [k, v] of Object.entries(responses)) {
                        if (typeof v === "string" && Buffer.byteLength(v, "utf8") > 32_768) {
                            // Truncate by UTF-8 bytes, not UTF-16 code units.
                            const buf = Buffer.from(v, "utf8")
                            let end = 32_768
                            while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
                            responses[k] = buf.toString("utf8", 0, end) + "\n[...truncated by state size cap]"
                        }
                    }
                }
            }
            const reSerialized = JSON.stringify(trimmed, null, 2)
            if (Buffer.byteLength(reSerialized, "utf8") <= 1_048_576) {
                logger.warn(
                    "saveTeamState: state exceeded 1 MiB, truncated responses to fit",
                    {
                        dir,
                        original: serializedBytes,
                        trimmed: Buffer.byteLength(reSerialized, "utf8"),
                    },
                )
                await atomicWrite(statePath(dir), reSerialized, dir)
                toWrite = trimmed as unknown as TeamState
            } else {
                // Do NOT write a state that the reader will reject.
                logger.error(
                    "saveTeamState: state exceeds 1 MiB even after truncation, refusing to save",
                    {
                        dir,
                        size: Buffer.byteLength(reSerialized, "utf8"),
                    },
                )
                // Throw so callers know the save failed and cannot report
                // success while disk remains at the old state.
                throw new Error(`saveTeamState: state for team in ${dir} exceeds 1 MiB `
                    + `even after truncation (${Buffer.byteLength(reSerialized, "utf8")} bytes); `
                    + `refusing to save stale state`)
            }
        } else {
            await atomicWrite(statePath(dir), serialized, dir)
        }
        // Only set _diskSnapshot after a successful write so it
        // matches what's actually on disk.
        team._diskSnapshot = deepClone(toWrite)
        // Update mtime so our own writes don't trigger a stale-cache reload.
        try { team._diskMtime = (await fs.stat(statePath(dir))).mtimeMs } catch { /* best-effort */ }
        // Sync concurrent changes from the merged result back into the live
        // team. Without this, the live Team diverges from disk after a
        // cross-process mutation (e.g. another process changed status to
        // "busy" — the merge writes it to disk correctly, but the live Team
        // still has "live", so the next in-process operation uses stale data).
        //
        // Adopt every merged scalar while preserving immutable identity fields.
        const scalarKeys = new Set<keyof TeamState>([
            ...(Object.keys(currentState) as Array<keyof TeamState>),
            ...(Object.keys(toWrite) as Array<keyof TeamState>),
        ])
        const nonScalarKeys = new Set<keyof TeamState>([
            "version", "teamRunId", "teamName", "leadSessionId", "members", "activeTask",
        ])
        const liveState = team as Record<string, unknown>
        for (const key of scalarKeys) {
            if (nonScalarKeys.has(key)) continue
            const merged = toWrite[key]
            if (jsonEqual(team[key], merged)) continue
            if (merged === undefined) delete liveState[key]
            else liveState[key] = deepClone(merged)
        }
        // Synchronize membership in place to preserve the array reference.
        // Update existing members' fields from disk (e.g. concurrent
        // status/session changes by another process), not just add/remove.
        //
        // Guarded by diskChanged for the same reason as the activeTask sync
        // below: toWrite.members was frozen at merge time, so writing it back
        // when no other process touched disk reverts in-memory mutations made
        // during the await (disk write + stat). Concretely: spawn resets
        // member.initialized = false and saves; the member's idle
        // acknowledgement sets it back to true inside that window; an
        // unconditional write-back reverts it, and because that acknowledgement
        // never repeats, the member stays uninitialized until the role-setup
        // barrier times out.
        if (diskChanged && team.members) {
            const mergedMembers = toWrite.members ?? []
            const mergedMap = new Map(mergedMembers.map(m => [m.name, m] as const))
            const mergedNames = new Set(mergedMap.keys())
            for (let index = team.members.length - 1; index >= 0; index--) {
                if (!mergedNames.has(team.members[index].name)) team.members.splice(index, 1)
            }
            const liveMap = new Map(team.members.map(m => [m.name, m] as const))
            for (const m of mergedMembers) {
                const live = liveMap.get(m.name)
                if (live) {
                    // In-place field sync. Object.assign only ADDS/overwrites
                    // fields — it does NOT delete fields that exist in `live`
                    // but are absent in `merged`. This can resurrect revoked
                    // fields (e.g. sessionId cleared on disk but retained in
                    // the stale live object).
                    // Explicitly delete fields absent from the merged
                    // member but present in the live one.
                    const mergedKeys = new Set(Object.keys(m))
                    for (const key of Object.keys(live)) {
                        if (!mergedKeys.has(key)) delete (live as Record<string, unknown>)[key]
                    }
                    Object.assign(live, deepClone(m))
                } else {
                    team.members.push(deepClone(m))
                }
            }
        }
        // Sync activeTask from the merged result into the live team.
        // Only sync when disk changed since our last save (i.e. another process
        // wrote). In the single-process no-op case (disk == ancestor), the
        // merge produces a semantically-identical result that may differ in
        // JSON key order — syncing it would break nested object references
        // (engine holds step.fanout etc.) for no benefit.
        // Sync activeTask only when disk changed (another process wrote).
        if (diskChanged && toWrite.activeTask && team.activeTask
            && !jsonEqual(toWrite.activeTask, currentState.activeTask)) {
            const live = team.activeTask as unknown as Record<string, unknown>
            const merged = toWrite.activeTask as unknown as Record<string, unknown>
            const currentAt = (currentState.activeTask ?? {}) as unknown as Record<string, unknown>
            const activeTaskKeys = new Set([...Object.keys(currentAt), ...Object.keys(merged)])
            for (const key of activeTaskKeys) {
                if (jsonEqual(merged[key], currentAt[key])) continue // unchanged
                // Field changed by merge (disk won). Update in place.
                const liveVal = live[key]
                const mergedVal = merged[key]
                if (mergedVal === undefined) {
                    delete live[key]
                    continue
                }
                if (liveVal && mergedVal && typeof liveVal === "object" && typeof mergedVal === "object"
                    && !Array.isArray(liveVal) && !Array.isArray(mergedVal)) {
                    // Plain object map (responses, tokensByMember): synchronize in
                    // place to preserve the map reference.
                    const liveObject = liveVal as Record<string, unknown>
                    const mergedObject = mergedVal as Record<string, unknown>
                    for (const nestedKey of Object.keys(liveObject)) {
                        if (!(nestedKey in mergedObject)) delete liveObject[nestedKey]
                    }
                    Object.assign(liveObject, deepClone(mergedObject))
                } else {
                    live[key] = deepClone(mergedVal)
                }
            }
        } else if (diskChanged && toWrite.activeTask && !team.activeTask) {
            team.activeTask = deepClone(toWrite.activeTask)
        } else if (diskChanged && !toWrite.activeTask && team.activeTask
            && currentState.activeTask !== undefined) {
            // Merge cleared activeTask (disk had none, we had one, we didn't
            // change it). Only clear if we originally had one.
            team.activeTask = undefined
        }

    }, dir)
}

/** Read the TeamSpec (config.json) for a team, or null if absent. The spec is
 * written at team_create and rewritten by the lifecycle editors
 * (add/remove/rename/fixmember), so treat it as authoritative-but-mutable. */
export async function readTeamSpec(
    storageRoot: string,
    teamName: string,
    leadSessionId?: string,
): Promise<TeamSpec | null> {
    const spec = await readJsonOrNull<TeamSpec>(
        configPath(teamDir(storageRoot, teamName, leadSessionId)),
        isValidTeamSpec,
    )
    if (spec && spec.name !== teamName) {
        throw new Error(`TeamSpec name "${spec.name}" does not match requested team "${teamName}"`)
    }
    return spec
}

/** Read TeamSpec from a known team directory (scope-independent).
 * Validate via isValidTeamSpec so a corrupt or tampered config.json does not
 * reach callers that expect a well-formed spec.
 */
export async function readTeamSpecFromDir(teamDirectory: string): Promise<TeamSpec | null> {
    return readJsonOrNull<TeamSpec>(configPath(teamDirectory), isValidTeamSpec)
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
    let fh: fs.FileHandle | undefined
    try {
        // Open with O_NOFOLLOW so a leaf symlink is rejected atomically
        // (ELOOP), closing the lstat→readFile TOCTOU window.
        fh = await fs.open(filePath, fs.constants.O_RDONLY | O_NOFOLLOW)
        const stat = await fh.stat()
        if (!stat.isFile()) return null
        if (stat.size > 1_048_576) {
            logger.warn("readJsonOrNull: file exceeds 1 MiB cap", { file: filePath, size: stat.size })
            return null
        }
        const raw = await fh.readFile("utf8")
        const parsed: unknown = JSON.parse(raw)
        if (validate && !validate(parsed)) {
            logger.warn("readJsonOrNull: schema validation failed", { file: filePath })
            return null
        }
        return parsed as T
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ELOOP") return null
        throw err
    } finally {
        if (fh) await fh.close().catch(() => {})
    }
}

/** Write the TeamSpec (config.json) atomically. Used at team_create and by the
 * lifecycle editors (add/remove/rename/fixmember, including their compensating
 * rewrites on rollback).
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
    // Register the master session in the in-memory index so tools that
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

/**
 * Fence writes, mark a team deleted, and move its directory into quarantine.
 * Returns the quarantine directory path.
 */
export async function quarantineTeamStorage(
    storageRoot: string,
    teamName: string,
    leadSessionId: string | undefined,
    resolvedDir: string | undefined,
    teamRunId: string,
): Promise<string> {
    // Prefer resolvedDir (from the loaded Team object) over
    // reconstructing from teamName, which may be stale after a rename.
    const dir = resolvedDir ?? teamDir(storageRoot, teamName, leadSessionId)
    await assertNoSymlinkTraversal(storageRoot, dir)
    // Perform marker write and rename inside the state lock so a concurrent
    // saveTeamState cannot pass its lock check (no marker) and then atomicWrite
    // back into the renamed-away directory (resurrection race).
    const quarantineDirectory = await withLock(stateLockPath(dir), async () => {
        const marker = deletedMarkerPath(dir)
        await assertNoSymlinkTraversal(path.dirname(dir), marker)
        await fs.writeFile(marker, teamRunId, "utf8")

        const quarantineRoot = path.join(storageRoot, ".quarantine")
        await assertNoSymlinkTraversal(storageRoot, quarantineRoot)
        await fs.mkdir(quarantineRoot, { recursive: true })
        await assertNoSymlinkTraversal(storageRoot, quarantineRoot)
        const qd = path.join(quarantineRoot, randomUUID())
        await fs.rename(dir, qd)
        return qd
    }, dir)
    return quarantineDirectory
}

/** Permanently remove a quarantined team directory after validating its path. */
export async function deleteQuarantinedTeamStorage(
    storageRoot: string,
    quarantineDirectory: string,
): Promise<void> {
    const quarantineRoot = path.join(storageRoot, ".quarantine")
    await assertNoSymlinkTraversal(quarantineRoot, quarantineDirectory)
    await fs.rm(quarantineDirectory, {
        recursive: true,
        force: true,
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
        return entries.filter(e => e.isDirectory() && isSafePathSegment(e.name)).map(e => e.name)
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

/** Move a runtime team entry to a new directory key after a rename. */
export function rekeyTeamRegistry(oldDirectory: string, newDirectory: string, team: Team): void {
    teamRegistry.delete(oldDirectory)
    teamRegistry.set(newDirectory, team)
}

/**
 * Snapshot of registry teams that have an active orchestration or an unflushed
 * state mutation. Used by the sweep timer without scanning disk.
 */
export function activeTeams(): Team[] {
    return Array.from(teamRegistry.values()).filter(t => t.activeTask || t._persistDirty)
}
