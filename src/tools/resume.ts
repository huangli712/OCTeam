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
import { activationError, resolveCallerInTeam } from "../core/utils.js"
import {
    advanceToStage,
    dispatchToMember,
    ensureMembersReady,
} from "../orchestration/dispatch.js"
import { buildArbiterPrompt, buildDebatePrompt, buildRecursePrompt, handleArbitrateIdle, handleConsensusIdle, handleParallelIdle, handleRouteIdle } from "../orchestration/handlers.js"
import { buildRouterPrompt } from "./workflow.js"
import { deliverSummaryToLeader } from "../orchestration/summary.js"
import { clearActiveTask, loadTeamState, saveTeamState } from "../state/store.js"
import { listAllTasks, reapStaleClaims, updateTask } from "../state/tasks.js"

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

                    let dispatched = 0
                    switch (task.type) {
                        case "parallel": {
                            for (const m of team.members) {
                                if (m.isMaster || m.status === "running") continue
                                // MAJOR-C: mode-dependent completion criterion.
                                const incomplete = task.requireDoneAck
                                    ? !m.declaredDone
                                    : !task.responses[m.name]
                                if (incomplete) {
                                    const text = task.tasks?.[m.name] ?? task.task ?? ""
                                    await dispatchToMember(
                                        ctx,
                                        m,
                                        text,
                                        m.worktreePath ?? ctx.directory,
                                        team,
                                    )
                                    dispatched++
                                }
                            }
                            // MAJOR-A: zero-dispatch → re-drive barrier immediately.
                            if (dispatched === 0) await handleParallelIdle(ctx, team)
                            break
                        }
                        case "consensus": {
                            if ((task.currentRound ?? 0) < (task.maxRounds ?? 0)) {
                                for (const m of team.members) {
                                    if (m.isMaster || m.status === "running") continue
                                    if (!task.responses[m.name]) {
                                        const text =
                                            `[Consensus Round ${task.currentRound ?? 0}] ${task.topic}\n\n`
                                            + "Respond, then emit "
                                            + "<consensus>{\"agreed\": true|false}</consensus>."
                                        await dispatchToMember(
                                            ctx,
                                            m,
                                            text,
                                            m.worktreePath ?? ctx.directory,
                                            team,
                                        )
                                        dispatched++
                                    }
                                }
                            }
                            if (dispatched === 0) await handleConsensusIdle(ctx, team)
                            break
                        }
                        case "pipeline":
                        case "loop": {
                            if (task.currentStageIndex >= task.stages.length) {
                                // All-complete edge (crash before delivery).
                                await deliverSummaryToLeader(ctx, team, `${task.type}_complete`)
                                clearActiveTask(team)
                                team.status = "idle"
                            } else {
                                // O3: advanceToStage uses responses[] internally;
                                // pass the Stage OBJECT (stages[idx]), NOT the index.
                                await advanceToStage(ctx, team, task.stages[task.currentStageIndex])
                                dispatched = 1
                            }
                            break
                        }
                        case "delegate": {
                            // O8: reset claimed AND in_progress → pending (claiming member's
                            // turn was interrupted). reapStaleClaims handles stale locks;
                            // fresh claimed locks linger up to CLAIM_TTL_MS (documented).
                            await reapStaleClaims(team.directory)
                            for (const t of await listAllTasks(team.directory)) {
                                if (t.status === "claimed" || t.status === "in_progress") {
                                    await updateTask(team.directory, t.id, {
                                        status: "pending",
                                        owner: undefined,
                                    })
                                }
                            }
                            for (const m of team.members) {
                                if (m.isMaster || m.status === "running") continue
                                await dispatchToMember(
                                    ctx,
                                    m,
                                    "Resume: pull tasks from the shared tasklist.",
                                    m.worktreePath ?? ctx.directory,
                                    team,
                                )
                                dispatched++
                            }
                            break
                        }
                        case "route": {
                            if (!task.routeStage) {
                                // Phase A: router hadn't transitioned to targets. If its
                                // output is captured, re-run Phase A (parse -> dispatch
                                // targets); else re-dispatch the router.
                                if (task.routerMember && task.responses[task.routerMember]) {
                                    await handleRouteIdle(ctx, team)
                                } else {
                                    const router = team.members.find(
                                        m => m.name === task.routerMember && !m.isMaster,
                                    )
                                    if (router) {
                                        const prompt = buildRouterPrompt(
                                            team.teamName,
                                            task.task ?? "",
                                            task.routeBranches ?? [],
                                        )
                                        await dispatchToMember(
                                            ctx,
                                            router,
                                            prompt,
                                            router.worktreePath ?? ctx.directory,
                                            team,
                                        )
                                        dispatched++
                                    }
                                }
                            } else {
                                // Phase B: re-dispatch targets without responses; else
                                // re-drive the barrier.
                                for (const m of team.members) {
                                    if (m.isMaster || m.status === "running") continue
                                    const isTarget = task.routeTargets?.includes(m.name) ?? false
                                    if (isTarget && !task.responses[m.name]) {
                                        const branch = task.routeBranches?.find(b => b.member === m.name)
                                        const text = branch?.task ?? task.task ?? ""
                                        await dispatchToMember(
                                            ctx,
                                            m,
                                            text,
                                            m.worktreePath ?? ctx.directory,
                                            team,
                                        )
                                        dispatched++
                                    }
                                }
                                if (dispatched === 0) await handleRouteIdle(ctx, team)
                            }
                            break
                        }
                        case "arbitrate": {
                            if (!task.arbitrationStage) {
                                // Phase A: re-dispatch debaters without responses;
                                // else re-drive the barrier.
                                for (const name of (task.disputants ?? [])) {
                                    const m = team.members.find(
                                        x => x.name === name && !x.isMaster,
                                    )
                                    if (!m || m.status === "running") continue
                                    if (!task.responses[name]) {
                                        await dispatchToMember(
                                            ctx,
                                            m,
                                            buildDebatePrompt(task),
                                            m.worktreePath ?? ctx.directory,
                                            team,
                                        )
                                        dispatched++
                                    }
                                }
                                if (dispatched === 0) await handleArbitrateIdle(ctx, team)
                            } else {
                                // Phase B: if the arbiter responded, re-run the ruling
                                // (parse -> deliver); else re-dispatch the arbiter.
                                if (task.arbiterMember && task.responses[task.arbiterMember]) {
                                    await handleArbitrateIdle(ctx, team)
                                } else {
                                    const arbiter = team.members.find(
                                        m => m.name === task.arbiterMember && !m.isMaster,
                                    )
                                    if (arbiter) {
                                        await dispatchToMember(
                                            ctx,
                                            arbiter,
                                            buildArbiterPrompt(task),
                                            arbiter.worktreePath ?? ctx.directory,
                                            team,
                                        )
                                        dispatched++
                                    }
                                }
                            }
                            break
                        }
                        case "recurse": {
                            // Same task recovery as delegate: reset interrupted
                            // claims/in_progress -> pending, then re-dispatch idle
                            // members with the recursive contract.
                            await reapStaleClaims(team.directory)
                            for (const t of await listAllTasks(team.directory)) {
                                if (t.status === "claimed" || t.status === "in_progress") {
                                    await updateTask(team.directory, t.id, {
                                        status: "pending",
                                        owner: undefined,
                                    })
                                }
                            }
                            for (const m of team.members) {
                                if (m.isMaster || m.status === "running") continue
                                await dispatchToMember(
                                    ctx,
                                    m,
                                    buildRecursePrompt(),
                                    m.worktreePath ?? ctx.directory,
                                    team,
                                )
                                dispatched++
                            }
                            break
                        }
                    }

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
