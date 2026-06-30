/**
 * team_resume tool — recover a crashed (failed-after-crash) orchestration
 * from its preserved checkpoint (TeamState.lastInterruptedTask, set by
 * reconcileOne on host restart). Master-only. Requires explicit prior
 * team_activate.
 *
 * 3-phase lock order (mirrors workflow.ts, NOT team_cancel which is single-phase):
 *   Phase 1 (mutex): snapshot lastInterruptedTask → local, reset errored→idle,
 *                    save. DO NOT commit activeTask (O1: Phase 2 window safety —
 *                    a stray session.idle during Phase 2 must hit processIdle's
 *                    `!activeTask` early-return, not a premature barrier).
 *   Phase 2 (outside mutex): ensureMembersReady (spawn missing sessions).
 *   Phase 3 (mutex): commit activeTask, dispatch per mode, clear checkpoint.
 * Phase 2+3 wrapped in try/catch (MAJOR-B): on failure ACTIVELY reset to
 * failed + restore checkpoint for retry (passive "stays" is wrong post-commit).
 *
 * Per mode:
 *   parallel/consensus: re-dispatch incomplete members; if zero dispatched,
 *                       re-drive the barrier immediately (MAJOR-A: prevents the
 *                       "all-complete pre-delivery crash" stall to wall-clock).
 *   pipeline/loop: advanceToStage(stages[idx]) — uses responses[] internally,
 *                  NO runs/<runId>/<member>.md read (O3).
 *   delegate: reap stale claims + reset claimed/in_progress→pending (O8).
 *
 * parallel incomplete = requireDoneAck ? !declaredDone : !responses (MAJOR-C).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import type { ActiveTask } from "../core/types.js"
import { activationError } from "../core/utils.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import { ensureMembersReady } from "../orchestration/dispatch.js"
import { loadTeamState, saveTeamState } from "../state/store.js"
import { resumeDispatch } from "./dispatch.js"

export function teamResumeTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Resume an interrupted (failed-after-crash) orchestration from its preserved checkpoint. "
            + "Master-only. Requires prior team_activate. Re-dispatches incomplete members; "
            + "for parallel/consensus, if nothing remains to dispatch, re-drives the barrier "
            + "immediately to avoid stalling to wall-clock timeout.",
        args: {
            team_id: tool.schema.string().min(1),
            timeout_ms: tool.schema.number().int().min(1000).optional(),
            token_budget: tool.schema.number().int().min(1).optional(),
        },
        async execute(args, context) {
            const { team_id, timeout_ms, token_budget } = args
            // Pre-check (outside mutex).
            const caller = await resolveCallerInTeam(
                ctx.storageRoot,
                context.sessionID,
                team_id,
                { requireActive: false },
            )
            if (!caller) return "Error: caller is not a member of this team"
            if (!caller.isMaster) return "Error: team_resume is master-only"
            const team = await loadTeamState(caller.storageRoot, team_id, caller.leadSessionId)
            const actErr = activationError(team_id, team.activatedAt)
            if (actErr) return actErr
            if (team.status !== "failed" || !team.lastInterruptedTask) {
                return "Error: no interrupted task to resume (team must be 'failed' with a preserved checkpoint)"
            }

            let restored: ActiveTask | undefined
            let resumeRaced = false

            try {
                // --- Phase 1 (mutex): snapshot + reset, DO NOT commit activeTask. ---
                await team.mutex.runExclusive(async () => {
                    if (team.status !== "failed" || !team.lastInterruptedTask) {
                        resumeRaced = true
                        return
                    }
                    restored = team.lastInterruptedTask
                    // DO NOT clear lastInterruptedTask here — defer to Phase 3 success
                    // (MAJOR-B: clearing here loses the checkpoint if Phase 2/3 throws).
                    // Reset errored members → idle (errored-is-terminal broken ONLY in
                    // this resume path, intentionally — they were interrupted mid-work).
                    for (const m of team.members) {
                        if (m.status === "errored") {
                            m.status = "idle"
                            m.error = undefined
                            m.declaredDone = false
                            m.retryingSince = undefined
                        }
                    }
                    await saveTeamState(team)
                    // DO NOT set team.activeTask (O1 BLOCKER: Phase 2 window safety).
                })
                if (resumeRaced || !restored) {
                    return "Error: team state changed during resume"
                }
                const task = restored

                // --- Phase 2 (outside mutex): ensure members ready. ---
                // NOTE: ensureMembersReady only checks !sessionId field, NOT session
                // reachability. A dead persisted session is NOT re-spawned; Phase 3
                // dispatch to it hangs until wall-clock timeout. Host limitation.
                await ensureMembersReady(ctx, team)

                // --- Phase 3 (mutex): commit + dispatch. ---
                await team.mutex.runExclusive(async () => {
                    // Double-resume guard: a concurrent resume can't have run (Phase 1
                    // never cleared lastInterruptedTask), so the reference must match.
                    if (team.status !== "failed" || team.lastInterruptedTask !== task) {
                        resumeRaced = true
                        return
                    }
                    // Commit atomically with dispatch.
                    team.activeTask = task
                    team.status = "busy"
                    task.startedAt = Date.now() // full timeout re-granted
                    if (timeout_ms) task.wallClockTimeoutMs = timeout_ms
                    if (token_budget) task.tokenBudget = token_budget

                    await resumeDispatch(ctx, team, task)

                    // Clear checkpoint on success. (For parallel/consensus zero-dispatch,
                    // handleXxxIdle already cleared activeTask + set status; this only
                    // clears lastInterruptedTask, which is idempotent-safe.)
                    team.lastInterruptedTask = undefined
                    await saveTeamState(team)
                })
                if (resumeRaced) return "Error: team already resumed or state changed"
                return `Resumed ${restored.type} orchestration for team "${team_id}".`
            } catch (e) {
                // --- Rollback (MAJOR-B: ACTIVE reset, not passive). ---
                // A post-commit throw (e.g. dispatchToMember rejecting on a dead
                // session) leaves activeTask set + status busy. Actively reset.
                await team.mutex.runExclusive(async () => {
                    team.activeTask = undefined
                    team.status = "failed"
                    if (restored) team.lastInterruptedTask = restored
                    await saveTeamState(team)
                })
                const msg = e instanceof Error ? e.message : String(e)
                return `Error: resume failed (${msg}), checkpoint preserved for retry`
            }
        },
    })
}
