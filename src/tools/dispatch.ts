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
import { advanceWorkflowStep, handleWorkflowIdle } from "../orchestration/workflow.js"
import { handleRouteIdle } from "../orchestration/route.js"
import { buildArbiterPrompt, buildDebatePrompt, handleArbitrateIdle } from "../orchestration/arbitrate.js"
import { buildRouterPrompt } from "./router.js"
import { buildSummary, finishRun } from "../orchestration/summary.js"
import { buildReducePrompt, buildSignoffReviewPrompt, handleReduceIdle } from "../orchestration/signoff.js"
import { resumeApprovalStage } from "../orchestration/hitl.js"
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

/**
 * Signoff/reduce sub-stage recovery. Returns true if the resume was handled
 * (caller must return); false to proceed with per-mode dispatch.
 */
async function resumeSignoffReduceStage(ctx: PluginContext, team: Team, task: ActiveTask): Promise<boolean> {
    // Mirrors processIdle priority ordering in handlers.ts:176-186. A crash
    // can occur while these special stages are in flight. On resume, restore
    // the reviewers/reducer by re-triggering the same maybeTrigger* idempotent
    // entry points the live path uses, then bail — the type switch below is
    // for the per-mode MAP work, not these sub-stages.
    if (task.reduceStage) {
        const reducer = team.members.find(m => m.name === task.reducerMember && !m.isMaster)
        if (reducer && !task.responses[reducer.name]) {
            const body = await buildSummary(team, task, "pending_reduce")
            const prompt = buildReducePrompt(body)
            await dispatchToMember(ctx, reducer, prompt, reducer.worktreePath ?? ctx.directory, team)
        } else if (reducer) {
            await handleReduceIdle(ctx, team, reducer)
        }
        return true
    }
    if (task.signoffStage) {
        // Re-dispatch reviewers who haven't responded yet, branching on policy
        // exactly like maybeTriggerSignoff (signoff.ts).
        const summary = await buildSummary(team, task, "pending_signoff")
        const reviewPrompt = buildSignoffReviewPrompt(summary)
        let reviewers: typeof team.members = []
        if (task.signoffPolicy === "decider") {
            const decider = team.members.find(m => m.name === task.signoffDecider && !m.isMaster)
            reviewers = decider ? [decider] : []
        } else if (task.signoffPolicy === "peer-quorum") {
            reviewers = team.members.filter(m => !m.isMaster && m.sessionId && m.status !== "errored")
        }
        for (const m of reviewers) {
            if (task.signoffApprovals?.[m.name] !== undefined) continue
            await dispatchToMember(ctx, m, reviewPrompt, m.worktreePath ?? ctx.directory, team)
        }
        return true
    }
    return false
}

async function resumeParallelMode(ctx: PluginContext, team: Team, task: Extract<ActiveTask, { type: "parallel" }>): Promise<void> {
    let dispatched = 0
    for (const m of team.members) {
        if (m.isMaster || m.status === "running") continue
        // MAJOR-C: mode-dependent completion criterion.
        const incomplete = task.requireDoneAck
            ? !m.declaredDone
            : !task.responses[m.name]
        if (incomplete) {
            const text = task.tasks?.[m.name] ?? task.task ?? ""
            await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
            dispatched++
        }
    }
    // MAJOR-A: zero-dispatch -> re-drive barrier immediately.
    if (dispatched === 0) await handleParallelIdle(ctx, team)
}

async function resumeConsensusMode(ctx: PluginContext, team: Team, task: Extract<ActiveTask, { type: "consensus" }>): Promise<void> {
    let dispatched = 0
    if ((task.currentRound ?? 0) < (task.maxRounds ?? 0)) {
        for (const m of team.members) {
            if (m.isMaster || m.status === "running") continue
            if (!task.responses[m.name]) {
                const text =
                    `[Consensus Round ${task.currentRound ?? 0}] ${task.topic}\n\n`
                    + "Respond, then emit "
                    + "<consensus>{\"agreed\": true|false}</consensus>."
                await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                dispatched++
            }
        }
    }
    if (dispatched === 0) await handleConsensusIdle(ctx, team)
}

async function resumeSequentialMode(ctx: PluginContext, team: Team, task: Extract<ActiveTask, { type: "pipeline" | "loop" }>): Promise<void> {
    if (task.currentStageIndex >= task.stages.length) {
        // All-complete edge (crash before delivery).
        await finishRun(ctx, team, `${task.type}_complete`, "idle")
    } else {
        // O3: advanceToStage uses responses[] internally;
        // pass the Stage OBJECT (stages[idx]), NOT the index.
        await advanceToStage(ctx, team, task.stages[task.currentStageIndex])
    }
}

async function resumeDelegateMode(ctx: PluginContext, team: Team): Promise<void> {
    // O8: reset claimed AND in_progress -> pending (claiming member's
    // turn was interrupted). reapStaleClaims handles stale locks;
    // fresh claimed locks linger up to CLAIM_TTL_MS (documented).
    await resetInterruptedClaims(team)
    for (const m of team.members) {
        if (m.isMaster || m.status === "running") continue
        await dispatchToMember(ctx, m, "Resume: pull tasks from the shared tasklist.", m.worktreePath ?? ctx.directory, team)
    }
}

async function resumeRouteMode(ctx: PluginContext, team: Team, task: Extract<ActiveTask, { type: "route" }>): Promise<void> {
    let dispatched = 0
    if (!task.routeStage) {
        // Phase A: router hadn't transitioned to targets. If its
        // output is captured, re-run Phase A (parse -> dispatch
        // targets); else re-dispatch the router.
        if (task.routerMember && task.responses[task.routerMember]) {
            await handleRouteIdle(ctx, team)
        } else {
            const router = team.members.find(m => m.name === task.routerMember && !m.isMaster)
            if (router) {
                const prompt = buildRouterPrompt(team.teamName, task.task ?? "", task.routeBranches ?? [])
                await dispatchToMember(ctx, router, prompt, router.worktreePath ?? ctx.directory, team)
                dispatched++
            }
        }
    } else {
        // Phase B: re-dispatch targets without responses; else re-drive the barrier.
        for (const m of team.members) {
            if (m.isMaster || m.status === "running") continue
            const isTarget = task.routeTargets?.includes(m.name) ?? false
            if (isTarget && !task.responses[m.name]) {
                const branch = task.routeBranches?.find(b => b.member === m.name)
                const text = branch?.task ?? task.task ?? ""
                await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                dispatched++
            }
        }
        if (dispatched === 0) await handleRouteIdle(ctx, team)
    }
}

async function resumeArbitrateMode(ctx: PluginContext, team: Team, task: Extract<ActiveTask, { type: "arbitrate" }>): Promise<void> {
    let dispatched = 0
    if (!task.arbitrationStage) {
        // Phase A: re-dispatch debaters without responses; else re-drive the barrier.
        for (const name of (task.disputants ?? [])) {
            const m = team.members.find(x => x.name === name && !x.isMaster)
            if (!m || m.status === "running") continue
            if (!task.responses[name]) {
                await dispatchToMember(ctx, m, buildDebatePrompt(task), m.worktreePath ?? ctx.directory, team)
                dispatched++
            }
        }
        if (dispatched === 0) await handleArbitrateIdle(ctx, team)
    } else {
        // Phase B: if the arbiter responded, re-run the ruling (parse -> deliver); else re-dispatch the arbiter.
        if (task.arbiterMember && task.responses[task.arbiterMember]) {
            await handleArbitrateIdle(ctx, team)
        } else {
            const arbiter = team.members.find(m => m.name === task.arbiterMember && !m.isMaster)
            if (arbiter) {
                await dispatchToMember(ctx, arbiter, buildArbiterPrompt(task), arbiter.worktreePath ?? ctx.directory, team)
                dispatched++
            }
        }
    }
}

async function resumeRecurseMode(ctx: PluginContext, team: Team): Promise<void> {
    // Same task recovery as delegate: reset interrupted claims/in_progress -> pending,
    // then re-dispatch idle members with the recursive contract.
    await resetInterruptedClaims(team)
    for (const m of team.members) {
        if (m.isMaster || m.status === "running") continue
        await dispatchToMember(ctx, m, buildRecursePrompt(), m.worktreePath ?? ctx.directory, team)
    }
}

async function resumeTollgateMode(ctx: PluginContext, team: Team, task: Extract<ActiveTask, { type: "tollgate" }>): Promise<void> {
    const stage = task.gatedStages?.[task.currentStageIndex]
    if (!stage) return
    const phase = task.tollgatePhase ?? "produce"
    if (phase === "verify") {
        // Verifier output already captured -> re-run the verdict parse; else re-dispatch the verifier.
        if (task.responses[stage.verifier]) {
            const verifier = team.members.find(m => m.name === stage.verifier && !m.isMaster)
            if (verifier) await handleTollgateIdle(ctx, team, verifier)
        } else {
            await startVerification(ctx, team, stage)
        }
    } else if (phase === "escalate" && task.escalateTo) {
        const h = team.members.find(m => m.name === task.escalateTo && !m.isMaster)
        if (h) {
            await dispatchToMember(ctx, h, "Resume: fix the verifier/reference, then report done.", h.worktreePath ?? ctx.directory, team)
        }
    } else {
        // produce phase: re-dispatch the current gate's producer.
        await advanceToGatedStage(ctx, team, stage)
    }
}

// Re-drives the workflow after a crash. If the current step's actor already
// produced output pre-crash, re-run the handler to process it (parse verdict /
// mark complete + advance); otherwise dispatch the first incomplete step, or
// deliver if all steps are already complete (all-complete crash edge).
async function resumeWorkflowMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "workflow" }>,
): Promise<void> {
    const steps = task.steps ?? []
    const step = steps[task.currentStageIndex]
    if (step) {
        const actorName = step.kind === "gate" ? step.verifier : step.member
        if (actorName && task.responses[actorName]) {
            const actor = team.members.find(m => m.name === actorName && !m.isMaster)
            if (actor) {
                await handleWorkflowIdle(ctx, team, actor)
                return
            }
        }
    }
    // No captured response to process -> dispatch the next incomplete step, or
    // deliver workflow_complete if every step is already done.
    await advanceWorkflowStep(ctx, team)
}

export async function resumeDispatch(
    ctx: PluginContext,
    team: Team,
    task: ActiveTask,
): Promise<void> {
    if (await resumeApprovalStage(ctx, team)) return
    // Signoff/reduce sub-stage recovery (returns early if in progress).
    if (await resumeSignoffReduceStage(ctx, team, task)) return

    switch (task.type) {
        case "parallel": return await resumeParallelMode(ctx, team, task)
        case "consensus": return await resumeConsensusMode(ctx, team, task)
        case "pipeline":
        case "loop": return await resumeSequentialMode(ctx, team, task)
        case "delegate": return await resumeDelegateMode(ctx, team)
        case "route": return await resumeRouteMode(ctx, team, task)
        case "arbitrate": return await resumeArbitrateMode(ctx, team, task)
        case "recurse": return await resumeRecurseMode(ctx, team)
        case "tollgate": return await resumeTollgateMode(ctx, team, task)
        case "workflow": return await resumeWorkflowMode(ctx, team, task)
        default: {
            // Exhaustiveness guard: every OrchestrationType is handled above, so
            // task.type narrows to `never` here. A new type added without a
            // matching case fails this assignment at compile time; at runtime it
            // throws instead of letting resumeDispatch return and stall the run.
            const _exhaustive: never = task
            void _exhaustive
            throw new Error(`Unhandled task type: ${(task as { type: string }).type}`)
        }
    }
}
