/**
 * Shared validation and utility helpers for all team tools (lifecycle +
 * workflow). Pure functions only — no dispatch/worktree dependencies.
 *
 * Orchestration startup logic (startOrchestration, baseTaskFields, schema
 * fields, etc.) lives in start-orchestration.ts so that tools importing these
 * validators do NOT transitively pull in the dispatch/worktree subsystem.
 */

import type { PluginContext } from "../core/context.js"
import { OCTEAM_AGENTS, isOCTeamAgent } from "../core/role.js"
import type { Team } from "../state/store.js"
import { MEMBER_NAME_POOL } from "../state/naming.js"
import type { Bounds, SignoffPolicy } from "../core/types.js"

// ============================================================
// Bounds + member validation (used by create, add, planner, and orchestration tools)
// ============================================================

/**

/**
 * Abort every running non-master member session and reset all non-master
 * members to a clean idle state (clears declaredDone / retryingSince). Shared
 * by team_cancel and team_delete (busy-team teardown), which previously
 * duplicated this ~12-line block. Best-effort on abort: a failed abort must
 * not block cancel/delete. Caller MUST already hold team.mutex.
 */
export async function abortAndResetMembers(ctx: PluginContext, team: Team): Promise<void> {
    // Abort running member turns (best-effort).
    for (const m of team.members) {
        if (!m.isMaster && m.sessionId && m.status === "running") {
            await ctx.client.session
                .abort({
                    path: { id: m.sessionId },
                    query: { directory: m.worktreePath ?? ctx.directory },
                })
                .catch(() => {
                    // best-effort: a failed abort must not block teardown
                })
        }
    }
    // Reset every non-master member to a clean idle state.
    for (const m of team.members) {
        if (m.isMaster) continue
        m.status = "idle"
        m.declaredDone = false
        m.retryingSince = undefined
    }
}
