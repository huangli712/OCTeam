/**
 * team_metrics tool (read-only cross-run aggregation).
 *
 * Real-time aggregation of a team's historical run records
 * (runs/<runId>/record.json). On every call it reads listRunRecords, folds the
 * most recent runs (newest first, capped by `limit`) in-memory, and returns a
 * summary. NO new persistence, NO cache — the run records written at
 * termination time are the single source of truth.
 *
 * Any-member, read-only (requireActive: false) — mirrors team_results.
 *
 * Honesty: a run with tokensUsed === 0 carries no usable token data. This
 * conflates several genuinely-distinct causes (true zero / missing info.tokens /
 * delegate with no capture / pre-capture crash), so it is reported as
 * "(no token data)" per-run and counted in a summary line — never silently
 * summed as if it were a measured zero.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { resolveCallerInTeam } from "../core/utils.js"
import { listRunRecords } from "../orchestration/runs.js"
import type { RunRecord } from "../core/types.js"

/** One per-run detail line; flags zero-token runs as "(no token data)". */
function formatRunLine(r: RunRecord): string {
    const when = new Date(r.finishedAt).toISOString()
    const flag = r.tokensUsed === 0 ? "  (no token data)" : ""
    return `- ${r.runId}  [${r.type}] ${r.status}  tokens=${r.tokensUsed}${flag}  ${when}`
}

export function teamMetricsTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Aggregate token/message/success metrics across a team's recent run records (read-only, real-time). Sums tokens and messages, folds per-member token usage, groups by orchestration type, and reports the success rate. Token-only — no pricing.",
        args: {
            team_id: tool.schema.string().min(1),
            limit: tool.schema
                .number()
                .int()
                .min(1)
                .max(50)
                .optional()
                .describe("max runs to aggregate, newest first (default 20)"),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, {
                requireActive: false,
            })
            if (!caller) return "Error: caller is not a member of this team"

            const records = await listRunRecords(caller.directory)
            if (records.length === 0) return `No run records for team "${args.team_id}" yet.`

            const limit = args.limit ?? 20
            const total = records.length
            const slice = records.slice(0, limit)
            const shown = slice.length

            // --- aggregate over the (limit-capped) slice ---
            let totalTokensUsed = 0
            let totalMessagesSent = 0
            let noTokenDataRuns = 0
            let completed = 0
            let failed = 0
            const perMember: Record<string, number> = {}
            const perType: Record<string, { count: number; totalTokens: number }> = {}

            for (const r of slice) {
                totalTokensUsed += r.tokensUsed
                totalMessagesSent += r.messagesSent
                if (r.tokensUsed === 0) noTokenDataRuns++
                if (r.status === "completed") completed++
                else failed++

                for (const [member, tokens] of Object.entries(r.tokensByMember)) {
                    perMember[member] = (perMember[member] ?? 0) + tokens
                }

                const bucket = (perType[r.type] ??= { count: 0, totalTokens: 0 })
                bucket.count++
                bucket.totalTokens += r.tokensUsed
            }

            const successRate = Math.round((completed / shown) * 100)

            // --- format ---
            const lines: string[] = [
                `Metrics for team "${args.team_id}" (aggregated ${shown} of ${total} runs):`,
                "",
                `Runs: total=${shown}  completed=${completed}  failed=${failed}  success=${successRate}%`,
                `Tokens: total=${totalTokensUsed}  messages=${totalMessagesSent}`,
            ]

            const typeLines = Object.entries(perType)
                .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
                .map(([type, s]) => `- ${type}: count=${s.count}  tokens=${s.totalTokens}`)
            if (typeLines.length > 0) lines.push("", "Per-type:", ...typeLines)

            const memberLines = Object.entries(perMember)
                .sort((a, b) => b[1] - a[1])
                .map(([member, tokens]) => `- ${member}: ${tokens}`)
            if (memberLines.length > 0) lines.push("", "Per-member tokens:", ...memberLines)

            if (noTokenDataRuns > 0) {
                lines.push(
                    "",
                    `No-token-data runs: ${noTokenDataRuns} of ${shown} (flagged "(no token data)" below)`,
                )
            }

            lines.push("", "Per-run (newest first):", ...slice.map(formatRunLine))

            // Retention surface: when the limit hides retained runs, say so. The
            // on-disk pool is itself capped (DEFAULT_MAX_RUNS), so `total` is the
            // retained count, not the all-time count.
            if (shown < total) {
                lines.push("", `(showing ${shown} of ${total} retained — raise limit to aggregate more)`)
            }

            return lines.join("\n")
        },
    })
}
