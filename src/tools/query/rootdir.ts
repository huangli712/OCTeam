/**
 * team_root_dir tool -- return the filesystem path to a team's root directory.
 *
 * Pure read-only query. Returns the absolute path of the team's root
 * directory (the one containing config.json, state.json, mailbox/, runs/,
 * tasks/, worktrees/). Unlike team_run_dir, this does NOT depend on
 * record.json -- the team directory exists from team_create time, so it is
 * available regardless of whether an orchestration is in progress, has
 * finished, or has never run. Use this when you need the team's own
 * directory rather than a specific run's output directory.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { loadTeamState } from "../../state/store.js"

/** Return the filesystem path to a team's root directory. */
export function teamRootDirTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Return the absolute filesystem path to a team's root directory " +
            "(contains config.json, state.json, mailbox/, runs/, tasks/, worktrees/). " +
            "Read-only; master-only. Available from team_create onwards, including " +
            "during a busy orchestration. Use this instead of team_run_dir when you " +
            "need the team's own directory rather than a specific run's output directory.",
        args: {
            team_id: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(
                ctx.storageRoot,
                context.sessionID,
                args.team_id,
                { requireActive: false },
            )
            if (!caller) return "Error: caller is not a member of this team"

            // Restrict access to the master because the control root contains
            // state.json, sentinel, mailbox, tasks, and locks that must
            // not be exposed to regular members.
            try {
                await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
            } catch (err) {
                logSwallowed(ctx, "team_root_dir: team state unreadable", err, { team: args.team_id })
                return "Error: team could not be loaded (state file unreadable)"
            }
            // Use caller.isMaster (from session index) instead of
            // the tamperable team.leadSessionId from state.json.
            const isMaster = caller.isMaster === true
            if (!isMaster) {
                return `Error: team_root_dir is restricted to the team leader (master session).`
            }

            const absPath = path.resolve(caller.directory)

            // Best-effort entry listing. Distinguish ENOENT (directory gone)
            // from other read errors so callers can tell a missing dir apart
            // from a transient IO problem; both still surface the resolved path.
            let entries: string[] = []
            let missing = false
            try {
                entries = (await fs.readdir(absPath)).sort()
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "ENOENT") missing = true
                else {
                    logSwallowed(ctx, "readdir failed (rootdir)", err, { path: absPath })
                    return `Error: team root directory could not be read: ${err instanceof Error ? err.message : String(err)}`
                }
            }

            const lines = [`team_root_dir: ${absPath}`]
            if (missing) {
                lines.push("warning: directory does not exist on disk")
            } else if (entries.length > 0) {
                lines.push(`entries: ${entries.join(", ")}`)
            }
            return lines.join("\n")
        },
    })
}
