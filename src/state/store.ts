import fs from "node:fs/promises"

import type { TeamState, TeamSpec } from "../core/types.js"
import { atomicWrite, AsyncMutex, withLock } from "./locks.js"
import {
    configPath,
    stateLockPath,
    statePath,
    teamDir,
    teamsDir,
} from "./paths.js"
/**
 * Runtime team object: TeamState plus non-persisted handles.
 *
 * `mutex` is a per-teamName process-level singleton (see teamRegistry) — it
 * serializes event-handler state mutations. `directory` is the resolved team
 * working directory on disk. Neither field is written to state.json.
 */
export type Team = TeamState & {
    mutex: AsyncMutex
    directory: string
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
    const { mutex: _mutex, directory: _directory, ...state } = team
    return state
}

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
    try {
        const raw = await fs.readFile(filePath, "utf8")
        return JSON.parse(raw) as T
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
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
        const state = await readJsonOrNull<TeamState>(statePath(dir))
        if (!state) {
            throw new Error(`loadTeamState: no state.json for team "${teamName}"`)
        }
        team = { ...state, mutex: new AsyncMutex(), directory: dir }
        teamRegistry.set(dir, team)
    }
    // M2: once registered, the in-memory Team is the authoritative copy — every
    // mutation goes through it under the per-team mutex, then saveTeamState writes
    // it to disk. Re-reading disk here would clobber an in-flight mutex holder's
    // unsaved mutations. The registry is rebuilt from disk only on first access or
    // after invalidateTeam (restart / delete).
    return team
}

/**
 * Persist the TeamState portion of a team to state.json via a cross-process
 * file lock + atomic write. The mutex/directory fields are NOT persisted.
 *
 * The caller is expected to already hold team.mutex.runExclusive for in-process
 * serialization; the file lock here guards against cross-process contention
 * and crash-recovery races.
 */
export async function saveTeamState(team: Team): Promise<void> {
    const dir = team.directory
    const state = stripRuntimeFields(team)
    const payload = JSON.stringify(state, null, 2)
    await withLock(stateLockPath(dir), async () => {
        await atomicWrite(statePath(dir), payload)
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
        force: true,
    }).catch(() => {
        // best effort
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
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
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
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
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
