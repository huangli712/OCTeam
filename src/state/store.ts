import fs from "node:fs/promises"
import path from "node:path"

import type { RuntimeState, TeamSpec } from "../types.js"
import { atomicWrite, AsyncMutex, withLock } from "./locks.js"
import {
    configPath,
    stateLockPath,
    statePath,
    teamDir,
} from "./paths.js"

/**
 * Runtime team object: RuntimeState plus non-persisted handles.
 *
 * `mutex` is a per-teamName process-level singleton (see teamRegistry) — it
 * serializes event-handler state mutations. `directory` is the resolved team
 * working directory on disk. Neither field is written to state.json.
 */
export type Team = RuntimeState & {
    mutex: AsyncMutex
    directory: string
}

// Process-level registry: teamName -> Team (with its singleton mutex).
// Rebuilt lazily on plugin restart; first access for each team creates the
// entry, subsequent accesses refresh persisted fields and KEEP the mutex.
const teamRegistry = new Map<string, Team>()

/** Strip the non-persisted runtime fields, leaving the pure RuntimeState. */
function stripRuntimeFields(team: Team): RuntimeState {
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
 * First access for a teamName creates the Team entry with a fresh mutex and
 * registers it. Subsequent accesses refresh persisted fields via Object.assign
 * (mutex + directory are preserved). This is what makes per-team
 * serialization actually work under concurrent idle events.
 *
 * @param storageRoot resolved .octeam root (project or user scope)
 * @param teamName    team directory name under <storageRoot>/teams/
 */
export async function loadTeamState(
    storageRoot: string,
    teamName: string,
): Promise<Team> {
    const dir = teamDir(storageRoot, teamName)
    let team = teamRegistry.get(teamName)
    if (!team) {
        const state = await readJsonOrNull<RuntimeState>(statePath(dir))
        if (!state) {
            throw new Error(`loadTeamState: no state.json for team "${teamName}"`)
        }
        team = { ...state, mutex: new AsyncMutex(), directory: dir }
        teamRegistry.set(teamName, team)
    } else {
        const state = await readJsonOrNull<RuntimeState>(statePath(dir))
        if (state) {
            // Refresh persisted fields; keep the original mutex + directory.
            Object.assign(team, state)
        }
        team.directory = dir
    }
    return team
}

/**
 * Persist the RuntimeState portion of a team to state.json via a cross-process
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
): Promise<TeamSpec | null> {
    return readJsonOrNull<TeamSpec>(configPath(teamDir(storageRoot, teamName)))
}

/**
 * List team names present on disk (directories under <storageRoot>/teams).
 * Returns [] if the teams directory does not exist yet.
 */
export async function listTeamNames(storageRoot: string): Promise<string[]> {
    const root = path.join(storageRoot, "teams")
    try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
        throw err
    }
}

/**
 * Remove a team from the in-memory registry (e.g. on team_delete). Subsequent
 * loadTeamState calls will rebuild the entry fresh — but in practice teams are
 * only invalidated when their on-disk state is also removed.
 */
export function invalidateTeam(teamName: string): void {
    teamRegistry.delete(teamName)
}
