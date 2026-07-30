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
import type { ActiveTask, MemberStatus } from "../../core/types.js"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"
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
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed (resume)", err, { team: team_id })
                return `Error: team "${team_id}" could not be loaded (state file unreadable)`
            }
            const actErr = activationError(team_id, team.activatedAt)
            if (actErr) return actErr
            if (team.status !== "failed" || !team.lastInterruptedTask) {
                return "Error: no interrupted task to resume (team must be 'failed' with a preserved checkpoint)"
            }

            let restored: ActiveTask | undefined
            let resumeRaced = false
            // Snapshot of errored members reset in Phase 1, for rollback if Phase 2/3 fails.
            // H-31: contains EVERY member (errored and idle), so the catch-block
            // rollback can find Phase-2-dispatched idle members too.
            const memberSnapshot: Array<{ name: string; error?: string; declaredDone?: boolean; retryingSince?: number; turnCount?: number; status?: string }> = []

            try {
                // --- Phase 1 (mutex): snapshot + reset, DO NOT commit activeTask. ---
                // H-4: set spawning=true inside the mutex so a concurrent resume
                // cannot pass Phase 1 and duplicate Phase 2's session spawns.
                // Pre-fix code had no lease between Phase 1 and Phase 3 — two
                // concurrent resumes could both reset errored→idle and both run
                // ensureMembersReady, creating duplicate sessions.
                await team.mutex.runExclusive(async () => {
                    if (team.status !== "failed" || !team.lastInterruptedTask || team.spawning) {
                        resumeRaced = true
                        return
                    }
                    team.spawning = true
                    restored = structuredClone(team.lastInterruptedTask)
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
                    // H-31: snapshot EVERY member (not just errored ones). Phase 2
                    // dispatches idle members to running; if Phase 2/3 then throws,
                    // those running members are not in the pre-fix snapshot (which
                    // only contained errored→idle resets), so the catch-block
                    // rollback loop skipped them — they kept running with no
                    // activeTask to process their idle, silently dropping output.
                    for (const m of team.members) {
                        memberSnapshot.push({ name: m.name, error: m.error, declaredDone: m.declaredDone, retryingSince: m.retryingSince, turnCount: m.turnCount, status: m.status })
                        if (m.status === "errored") {
                            if (
                                arenaTask
                                && (arenaTask.candidates.includes(m.name)
                                    || m.name === arenaTask.evaluatorMember)
                            ) {
                                continue
                            }
                            // (snapshot already pushed above)
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
                    // Double-resume guard: a concurrent resume can't have run
                    // (Phase 1 never cleared lastInterruptedTask, and Phase 3
                    // is the only place that clears it). Since `task` is now a
                    // structuredClone snapshot, check status + presence instead
                    // of reference equality.
                    if (team.status !== "failed" || !team.lastInterruptedTask) {
                        resumeRaced = true
                        return
                    }
                    // Commit atomically with dispatch.
                    team.activeTask = task
                    team.status = "busy"
                    // H38#2: update runnerPid so the reconciler knows THIS
                    // process now owns the resumed task. Pre-fix code left
                    // the old crashed PID, causing reconcile to re-fail it.
                    team.runnerPid = process.pid
                    task.startedAt = Date.now() // full timeout re-granted
                    if (timeout_ms) {
                        // MEDIUM: clamp override to team's wall-clock max.
                        const maxMs = (team.bounds.maxWallClockMinutes ?? Infinity) * 60_000
                        task.wallClockTimeoutMs = Math.min(timeout_ms, maxMs)
                    }
                    if (token_budget) task.tokenBudget = token_budget

                    await resumeDispatch(ctx, team, task)

                    // Clear checkpoint on success. (For parallel/consensus zero-dispatch,
                    // handleXxxIdle already cleared activeTask + set status; this only
                    // clears lastInterruptedTask, which is idempotent-safe.)
                    team.lastInterruptedTask = undefined
                    // H-4: clear the resume lease set in Phase 1.
                    team.spawning = false
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
                // H-31: mark already-dispatched members (status="running",
                // turnCount>0) as errored. Pre-fix code restored them to their
                // pre-resume errored/idle state but did NOT account for members
                // that were successfully dispatched during the partial resume —
                // those kept running with no activeTask to process their idle,
                // silently dropping their output.
                await team.mutex.runExclusive(async () => {
                    team.activeTask = undefined
                    team.status = "failed"
                    // H-4: clear the resume lease so a retry can proceed.
                    team.spawning = false
                    if (restored) team.lastInterruptedTask = restored
                    // Restore member states that were reset in Phase 1 (errored→idle).
                    for (const saved of memberSnapshot) {
                        const m = team.members.find(mm => mm.name === saved.name)
                        if (m) {
                            // H-31: if this member was dispatched during the
                            // partial resume (status is now "running" or
                            // turnCount increased), abort its session and mark
                            // it errored. H21 fix: pre-fix code only marked it
                            // errored without aborting — the session kept running,
                            // consuming tokens and producing output that would be
                            // dropped (activeTask was cleared).
                            if (m.status === "running" || (m.turnCount ?? 0) > (saved.turnCount ?? 0)) {
                                // H21: best-effort abort the still-running session.
                                if (m.sessionId) {
                                    try {
                                        await ctx.client.session.abort({
                                            path: { id: m.sessionId },
                                            query: { directory: m.worktreePath ?? ctx.directory },
                                        })
                                    } catch (abortErr) {
                                        logSwallowed(ctx, "resume rollback: session.abort failed (best-effort)", abortErr, { member: m.name })
                                    }
                                }
                                m.status = "errored"
                                m.error = `resume dispatch failed: ${e instanceof Error ? e.message : String(e)}`
                            } else {
                                // M16: restore the member's original status. Pre-fix
                                // code unconditionally set errored — even for
                                // members that were NOT dispatched during the
                                // partial resume. Those members should go back to
                                // their pre-resume state (typically idle).
                                m.status = saved.status as MemberStatus
                                m.error = saved.error
                            }
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
