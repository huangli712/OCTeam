/**
 * team_run_dir tool -- return the filesystem path to a run's output directory.
 *
 * Pure read-only query: resolves the caller to a team, picks the latest run
 * (or a caller-supplied run_id), and returns the absolute path to
 * `<teamDirectory>/runs/<runId>/`. Covers the "locate <run_dir>" step of
 * external check scripts without an out-of-band `find`.
 */

import path from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import { runDir, isSafePathSegment } from "../../state/paths.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { listRunRecords, readRunRecord } from "../../orchestration/records/runs.js"

/** Return the filesystem path to a run's output directory. */
export function teamRunDirTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Return the absolute filesystem path to a run's output directory " +
            "(contains <member>.md, record.json, events.jsonl). " +
            "Omit run_id for the most recent run. Read-only; any-member.",
        args: {
            team_id: tool.schema.string().min(1),
            run_id: tool.schema.string().optional().describe("run id; omit for the most recent run"),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, {
                requireActive: false,
            })
            if (!caller) return "Error: caller is not a member of this team"

            // Path-safety: run_id is interpolated into a runs/<...> path.
            if (args.run_id !== undefined && !isSafePathSegment(args.run_id)) {
                return `Error: invalid run_id "${args.run_id}"`
            }

            let runId: string
            if (args.run_id) {
                let record
                try {
                    record = await readRunRecord(caller.directory, args.run_id)
                } catch (err) {
                    logSwallowed(ctx, "team_run_dir failed to read run record", err, { team: args.team_id, runId: args.run_id })
                    return `Error: run "${args.run_id}" for team "${args.team_id}" could not be read: ${err instanceof Error ? err.message : String(err)}`
                }
                if (!record) return `Error: run "${args.run_id}" not found for team "${args.team_id}"`
                runId = record.runId
            } else {
                let records
                try {
                    records = await listRunRecords(caller.directory)
                } catch (err) {
                    logSwallowed(ctx, "team_run_dir failed to read run records", err, { team: args.team_id })
                    return `Error: run records for team "${args.team_id}" could not be read: ${err instanceof Error ? err.message : String(err)}`
                }
                if (records.length === 0) return `No run records for team "${args.team_id}" yet.`
                runId = records[0].runId
            }

            const absPath = path.resolve(runDir(caller.directory, runId))
            return `run_id: ${runId}\nrun_dir: ${absPath}`
        },
    })
}
