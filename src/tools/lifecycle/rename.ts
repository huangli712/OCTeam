/**
 * team_rename tool -- rename an existing team (live status only). Renames the
 * on-disk directory and updates all indexes.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import { isEnoent } from "../../core/utils.js"
import {
    listTeamNames, loadTeamState, readTeamSpec, rekeyTeamRegistry, saveTeamState, writeTeamSpec,
} from "../../state/store.js"
import { indexMasterTeam, isIndexedMasterOf, setActiveTeam, unindexMasterTeam } from "../../state/resolve.js"
import { teamDir } from "../../state/paths.js"
import type { TeamSpec } from "../../core/types.js"

/** Rename a live team, updating its directory and all stored references. */
export function teamRenameTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Rename an existing team. Only allowed when team status is \"live\" " +
            "(sessions not yet spawned) and only by the master session. The new name " +
            "must follow the same format as team creation (lowercase letters, digits, hyphens) " +
            "and must not collide with another team owned by this session.",
        args: {
            team_id: tool.schema.string().min(1),
            new_name: tool.schema
                .string()
                .min(1)
                .max(64)
                .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens only"),
        },
        async execute(args, context) {
            const pathLeadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id, pathLeadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            if (team.leadSessionId !== context.sessionID || !isIndexedMasterOf(context.sessionID, team.directory)) {
                return "Error: team_rename is master-only (only the team's leader can rename it)"
            }
            if (team.status !== "live") {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". `
                    + `Teams can only be renamed before sessions are spawned.`
            }
            if (args.team_id === args.new_name) {
                return `Team "${args.team_id}" is already named "${args.new_name}".`
            }
            for (const other of await listTeamNames(ctx.storageRoot, pathLeadSessionId)) {
                if (other === args.new_name) {
                    return `Error: a team named "${args.new_name}" already exists under this session`
                }
            }

            const oldDir = team.directory
            const newDir = teamDir(ctx.storageRoot, args.new_name, pathLeadSessionId)

            const wasActive = team.activatedAt !== undefined

            let staleState = false
            let collision = false
            let specError: string | undefined = undefined
            await team.mutex.runExclusive(async () => {
                // Revalidate inside the mutex: a concurrent
                // startOrchestration may have flipped status live→busy since
                // the outside-mutex check at line 42. Refuse rather than
                // renaming during an active run.
                if (team.status !== "live" || team.spawning) {
                    staleState = true
                    return
                }
                // Re-check name collision: use O_CREAT|O_EXCL to atomically
                // claim the new dir name. This is TOCTOU-safe because mkdir
                // is atomic — if it succeeds, we are the sole creator.
                // The placeholder is removed just before fs.rename below.
                // CRIT #5: do NOT use mkdir+rmdir (which reopens the window).
                // Instead, keep the empty dir as the rename destination —
                // fs.rename on Linux replaces an empty dir atomically.
                try {
                    await fs.mkdir(newDir, { recursive: false })
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                        collision = true
                        return
                    }
                    if (!isEnoent(err)) throw err
                    // Parent dirs missing — this shouldn't happen for a valid
                    // storage root, but create them and retry.
                    await fs.mkdir(path.dirname(newDir), { recursive: true }).catch(() => {})
                    try {
                        await fs.mkdir(newDir, { recursive: false })
                    } catch (retryErr) {
                        if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
                            collision = true
                            return
                        }
                        throw retryErr
                    }
                }
                // Re-read spec INSIDE the mutex so concurrent mutators
                // (e.g. a parallel add/remove) don't clobber each other's
                // spec changes. Reading outside the lock would produce a
                // stale snapshot whose writeTeamSpec overwrites another op.
                let spec: TeamSpec | null = null
                try {
                    spec = await readTeamSpec(ctx.storageRoot, args.team_id, pathLeadSessionId)
                } catch (err) {
                    // HIGH-A: do not silently swallow spec read errors. A
                    // corrupt config.json would lead to a rename that loses
                    // the spec entirely (spec=null branch skips writeTeamSpec
                    // in the new directory, so the renamed team has no config).
                    // Treat as a fatal precondition and refuse the rename.
                    // H57: set a flag instead of returning a string — the outer
                    // code checks flags, not the callback return value, so a
                    // returned string was silently dropped.
                    specError = `Error: team "${args.team_id}" config is unreadable — refusing to rename (${err instanceof Error ? err.message : String(err)})`
                    return
                }
                if (!spec) {
                    specError = `Error: team "${args.team_id}" config is missing — refusing to rename`
                    return
                }
                // Capture the original spec name so the rollback can restore it.
                const originalSpecName = spec.name
                // Rename directory on disk.
                await fs.rename(oldDir, newDir)

                try {
                    // Update in-memory state references.
                    team.teamName = args.new_name
                    team.directory = newDir

                    // Write spec and state to the new directory FIRST, before
                    // touching any indexes. If persistence fails, the rollback
                    // only needs to restore the directory and in-memory state
                    // — no index/registry cleanup needed.
                    if (spec) {
                        spec = { ...spec, name: args.new_name }
                        await writeTeamSpec(ctx.storageRoot, spec, pathLeadSessionId, ctx.storageRoot)
                    }
                    await saveTeamState(team)

                    // Only after persistence succeeds: update registry, master
                    // index, and active-team pointer. These are in-memory only
                    // and cannot fail in a way that requires disk rollback.
                    rekeyTeamRegistry(oldDir, newDir, team)
                    unindexMasterTeam(context.sessionID, oldDir)
                    indexMasterTeam(context.sessionID, args.new_name, pathLeadSessionId, ctx.storageRoot, newDir)
                    if (wasActive) {
                        setActiveTeam(context.sessionID, newDir)
                    }
                } catch (writeErr) {
                    // Rollback: restore the old directory and in-memory state.
                    team.teamName = args.team_id
                    team.directory = oldDir
                    // HIGH-A: if the spec was written to the new directory with
                    // the new name, restore the original spec.name and re-write
                    // it BEFORE moving the directory back. Without this, the
                    // moved-back directory's config.json would still carry the
                    // new name, leaving an inconsistent state.json (name=A) /
                    // config.json (name=B) pair.
                    if (spec && originalSpecName !== undefined && spec.name !== originalSpecName) {
                        // H-T5: rename FIRST, then write the restored spec. Pre-fix
                        // code called writeTeamSpec before rename — writeTeamSpec
                        // writes to the path based on spec.name (now restored to
                        // the original), which recreates oldDir, causing the
                        // subsequent fs.rename(newDir, oldDir) to fail with EEXIST.
                        // The result was a split team: oldDir had only config.json,
                        // newDir retained state.json, and the index pointed to the
                        // corrupt oldDir.
                    }
                    await fs.rename(newDir, oldDir).catch((rollbackErr) => {
                        logSwallowed(ctx, "rename rollback: fs.rename failed", rollbackErr, { oldDir, newDir })
                    })
                    // Write restored spec AFTER rename so it goes into the
                    // correct (now-moved-back) directory.
                    if (spec && originalSpecName !== undefined && spec.name !== originalSpecName) {
                        try {
                            const restoredSpec = { ...spec, name: originalSpecName }
                            await writeTeamSpec(ctx.storageRoot, restoredSpec, pathLeadSessionId, ctx.storageRoot)
                        } catch (specRollbackErr) {
                            logSwallowed(ctx, "rename rollback: writeTeamSpec restore failed", specRollbackErr, { oldDir, newDir })
                        }
                    }
                    throw writeErr
                }
            })


            if (specError) {
                return specError
            }
            if (staleState) {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". `
                    + `Teams can only be renamed before sessions are spawned.`
            }
            if (collision) {
                return `Error: a team named "${args.new_name}" already exists under this session`
            }

            return `Team "${args.team_id}" renamed to "${args.new_name}".`
        },
    })
}
