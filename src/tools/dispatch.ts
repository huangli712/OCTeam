/**
 * Per-mode re-dispatch for team_resume's Phase 3. Extracted from resume.ts so
 * the 9-way switch + its orchestration imports live in one focused module;
 * resume.ts no longer reaches into the handlers facade directly.
 *
 * Semantics (mirrors resume.ts's contract, NOT processIdle):
 *   parallel/consensus: re-dispatch incomplete members; zero-dispatch re-drives
 *                       the barrier (MAJOR-A).
 *   pipeline/loop: advanceToStage(stages[idx]); all-complete → deliver + clear.
 *   delegate/recurse: reap stale claims + reset claimed/in_progress→pending.
 *   route/arbitrate: Phase A re-dispatch or Phase B re-drive barrier.
 *   tollgate: verify/escalate/produce three-phase recovery.
 *
 * Called inside team.mutex.runExclusive AFTER activeTask is committed. Mutates
 * team/task freely; does NOT save state (caller owns persistence).
 */

import type { PluginContext } from "../core/context.js"
import type { ActiveTask } from "../core/types.js"
import { type Team } from "../state/store.js"
import { advanceToStage, dispatchToMember } from "../orchestration/dispatch.js"
import { handleParallelIdle } from "../orchestration/parallel.js"
import { handleConsensusIdle } from "../orchestration/consensus.js"
import { buildRecursePrompt } from "../orchestration/recurse.js"
import { advanceToGatedStage, handleTollgateIdle, startVerification } from "../orchestration/tollgate.js"
import { handleRouteIdle } from "../orchestration/route.js"
import { buildArbiterPrompt, buildDebatePrompt, handleArbitrateIdle } from "../orchestration/arbitrate.js"
import { buildRouterPrompt } from "./router.js"
import { buildSummary, finishRun } from "../orchestration/summary.js"
import { buildReducePrompt, buildSignoffReviewPrompt, handleReduceIdle, handleSignoffIdle } from "../orchestration/signoff.js"
import { listAllTasks, reapStaleClaims, updateTask } from "../state/tasks.js"

/**
 * Reset interrupted task claims: reap stale locks + reset any claimed/in_progress
 * tasks back to pending so idle members can re-claim them. Shared by the
 * delegate and recurse resume paths (O8).
 */
async function resetInterruptedClaims(team: Team): Promise<void> {
    await reapStaleClaims(team.directory)
    for (const t of await listAllTasks(team.directory)) {
        if (t.status === "claimed" || t.status === "in_progress") {
            await updateTask(team.directory, t.id, {
                status: "pending",
                owner: undefined,
            })
        }
    }
}

export async function resumeDispatch(
    ctx: PluginContext,
    team: Team,
    task: ActiveTask,
): Promise<void> {
    let dispatched = 0

    // Signoff/reduce sub-stage recovery (mirrors processIdle priority ordering
    // in handlers.ts:176-186). A crash can occur while these special stages
    // are in flight (signoffStage/reduceStage flags set on the active task).
    // On resume, restore the reviewers/reducer by re-triggering the same
    // maybeTrigger* idempotent entry points the live path uses, then bail —
    // the type switch below is for the per-mode MAP work, not these sub-stages.
    // Without this, a crash during signoff leaves reviewers idle and
    // handleSignoffIdle never re-fires (no fresh idle event arrives), so the
    // run stalls to the wall-clock timeout instead of completing.
    if (task.reduceStage) {
        // Reduce stage: re-dispatch the reducer if it hasn't produced output,
        // else re-drive handleReduceIdle to capture and continue.
        const reducer = team.members.find(m => m.name === task.reducerMember && !m.isMaster)
        if (reducer && !task.responses[reducer.name]) {
            const body = await buildSummary(team, task, "pending_reduce")
            const prompt = buildReducePrompt(body)
            await dispatchToMember(ctx, reducer, prompt, reducer.worktreePath ?? ctx.directory, team)
            dispatched = 1
        } else if (reducer) {
            await handleReduceIdle(ctx, team, reducer)
        }
        return
    }
    if (task.signoffStage) {
        // Signoff stage: re-dispatch reviewers who haven't responded yet,
        // branching on policy exactly like maybeTriggerSignoff (signoff.ts):
        //   - decider:     only the named decider
        //   - peer-quorum: all non-master, non-errored members with a session
        // Reviewers with a recorded approval are skipped. If none are incomplete,
        // the caller's sweep/checkTermination eventually re-drives
        // handleSignoffIdle via the missed-idle path.
        const summary = await buildSummary(team, task, "pending_signoff")
        const reviewPrompt = buildSignoffReviewPrompt(summary)
        let reviewers: typeof team.members = []
        if (task.signoffPolicy === "decider") {
            const decider = team.members.find(m => m.name === task.signoffDecider && !m.isMaster)
            reviewers = decider ? [decider] : []
        } else if (task.signoffPolicy === "peer-quorum") {
            reviewers = team.members.filter(m => !m.isMaster && m.status !== "errored" && m.sessionId)
        }
        for (const m of reviewers) {
            // Skip reviewers who already recorded an approval.
            if (task.signoffApprovals?.[m.name] !== undefined) continue
            await dispatchToMember(ctx, m, reviewPrompt, m.worktreePath ?? ctx.directory, team)
            dispatched++
        }
        return
    }

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
                await finishRun(ctx, team, `${task.type}_complete`, "idle")
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
            await resetInterruptedClaims(team)
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
            await resetInterruptedClaims(team)
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
        case "tollgate": {
            const stage = task.gatedStages?.[task.currentStageIndex]
            if (!stage) break
            const phase = task.tollgatePhase ?? "produce"
            if (phase === "verify") {
                // Verifier output already captured -> re-run the
                // verdict parse; else re-dispatch the verifier.
                if (task.responses[stage.verifier]) {
                    const verifier = team.members.find(
                        m => m.name === stage.verifier && !m.isMaster,
                    )
                    if (verifier) await handleTollgateIdle(ctx, team, verifier)
                } else {
                    await startVerification(ctx, team, stage)
                    dispatched = 1
                }
            } else if (phase === "escalate" && task.escalateTo) {
                const h = team.members.find(
                    m => m.name === task.escalateTo && !m.isMaster,
                )
                if (h) {
                    await dispatchToMember(
                        ctx,
                        h,
                        "Resume: fix the verifier/reference, then report done.",
                        h.worktreePath ?? ctx.directory,
                        team,
                    )
                    dispatched = 1
                }
            } else {
                // produce phase: re-dispatch the current gate's producer.
                await advanceToGatedStage(ctx, team, stage)
                dispatched = 1
            }
            break
        }
        default: {
            // Exhaustiveness guard: every OrchestrationType is handled above, so
            // task.type narrows to `never` here. A new type added without a
            // matching case fails this assignment at compile time; at runtime it
            // throws instead of letting resumeDispatch return and stall the run.
            const _exhaustive: never = task
            throw new Error(`Unhandled task type: ${(task as { type: string }).type}`)
        }
    }
}
