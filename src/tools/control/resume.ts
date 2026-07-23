/**
 * team_resume tool — recover a crashed (failed-after-crash) orchestration
 * from its preserved checkpoint (TeamState.lastInterruptedTask, set by
 * reconcileOne on host restart). Master-only. Requires explicit prior
 * team_activate.
 *
 * 3-phase lock order (mirrors startOrchestration in orchestration/lifecycle/startup.ts, NOT
 * team_cancel which is single-phase):
 *   Phase 1 (mutex): snapshot lastInterruptedTask → local, reset errored→idle,
 *                    save. DO NOT commit activeTask (a stray session.idle
 *                    during Phase 2 must hit processIdle's
 *                    `!activeTask` early-return, not a premature barrier).
 *   Phase 2 (outside mutex): ensureMembersReady (spawn missing sessions).
 *   Phase 3 (mutex): commit activeTask, dispatch per mode, clear checkpoint.
 * Phase 2+3 wrapped in try/catch: on failure ACTIVELY reset to
 * failed + restore checkpoint for retry.
 *
 * Per mode:
 *   parallel/consensus: re-dispatch incomplete members; if zero dispatched,
 *                       re-drive the barrier immediately (prevents the
 *                       "all-complete pre-delivery crash" stall to wall-clock).
 *   pipeline/loop: advanceToStage(stages[idx]) — uses responses[] internally,
 *                  NO runs/<runId>/<member>.md read.
 *   delegate: reap stale claims + reset claimed/in_progress→pending.
 *
 * parallel incomplete = requireDoneAck ? !declaredDone : !responses.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import type { ActiveTask } from "../../core/types.js"
import { activationError } from "../../state/activation.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { ensureMembersReady } from "../../orchestration/control/members.js"
import { loadTeamState, saveTeamState } from "../../state/store.js"
import { resumeDispatch } from "../../orchestration/lifecycle/resume.js"

/** Resume an interrupted orchestration from its preserved checkpoint. */
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
            let team
            try {
                team = await loadTeamState(caller.storageRoot, team_id, caller.leadSessionId)
            } catch {
                return `Error: team "${team_id}" not found`
            }
            const actErr = activationError(team_id, team.activatedAt)
            if (actErr) return actErr
            if (team.status !== "failed" || !team.lastInterruptedTask) {
                return "Error: no interrupted task to resume (team must be 'failed' with a preserved checkpoint)"
            }

            let restored: ActiveTask | undefined
            let resumeRaced = false
            // Snapshot of errored members reset in Phase 1, for rollback if Phase 2/3 fails.
            let memberSnapshot: Array<{ name: string; error?: string; declaredDone?: boolean; retryingSince?: number }> = []

            try {
                // --- Phase 1 (mutex): snapshot + reset, DO NOT commit activeTask. ---
                await team.mutex.runExclusive(async () => {
                    if (team.status !== "failed" || !team.lastInterruptedTask) {
                        resumeRaced = true
                        return
                    }
                    restored = team.lastInterruptedTask
                    // DO NOT clear lastInterruptedTask here — defer to Phase 3 success
                    // (clearing here loses the checkpoint if Phase 2/3 throws).
                    // Reset errored members → idle (errored-is-terminal broken ONLY in
                    // this resume path, intentionally — they were interrupted mid-work).
                    // Arena carve-out (4d): reviving an arena candidate or evaluator
                    // destroys arena's terminal-error semantics — a tolerated errored
                    // candidate would be re-dispatched (reviving a competitor changes the
                    // field, breaking failure isolation) and an errored evaluator would be
                    // re-dispatched instead of failing closed. Keep those members errored
                    // in ALL phases so resumeArenaMode / the start-evaluate live-check act
                    // on the preserved state. Every other member, and ALL non-arena tasks,
                    // keep the blanket reset unchanged.
                    const arenaTask = team.lastInterruptedTask.type === "arena"
                        ? team.lastInterruptedTask
                        : undefined
                    for (const m of team.members) {
                        if (m.status === "errored") {
                            if (
                                arenaTask
                                && (arenaTask.candidates.includes(m.name)
                                    || m.name === arenaTask.evaluatorMember)
                            ) {
                                continue
                            }
                            // Snapshot before reset so Phase 2/3 failure can rollback.
                            memberSnapshot.push({ name: m.name, error: m.error, declaredDone: m.declaredDone, retryingSince: m.retryingSince })
                            m.status = "idle"
                            m.error = undefined
                            m.declaredDone = false
                            m.retryingSince = undefined
                        }
                    }
                    await saveTeamState(team)
                    // DO NOT set team.activeTask (Phase 2 window safety).
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
                const workflowHint = restored.type === "workflow"
                    ? " Use team_progress to inspect the frontier and team_fix_workflow to repair a stuck step."
                    : ""
                return `Resumed ${restored.type} orchestration for team "${team_id}".${workflowHint}`
            } catch (e) {
                // --- Rollback (ACTIVE reset, not passive). ---
                // A post-commit throw (e.g. dispatchToMember rejecting on a dead
                // session) leaves activeTask set + status busy. Actively reset.
                await team.mutex.runExclusive(async () => {
                    team.activeTask = undefined
                    team.status = "failed"
                    if (restored) team.lastInterruptedTask = restored
                    // Restore member states that were reset in Phase 1 (errored→idle).
                    for (const saved of memberSnapshot) {
                        const m = team.members.find(mm => mm.name === saved.name)
                        if (m) {
                            m.status = "errored"
                            m.error = saved.error
                            m.declaredDone = saved.declaredDone
                            m.retryingSince = saved.retryingSince
                        }
                    }
                    await saveTeamState(team)
                })
                const msg = e instanceof Error ? e.message : String(e)
                return `Error: resume failed (${msg}), checkpoint preserved for retry`
            }
        },
    })
}
