/**
 * Per-mode resume dispatch handlers. Extracted from resume.ts to keep each
 * file focused: resume.ts owns the Phase 1/2/3 entry point + rollback, while
 * this module owns the 12 mode-specific re-dispatch functions and their shared
 * helpers.
 */

import type { PluginContext } from "../../core/context.js";
import type { ActiveTask } from "../../core/types.js";
import { type Team, saveTeamState } from "../../state/store.js";
import { advanceToStage } from "../modes/stages.js";
import { dispatchToMember } from "../control/dispatch.js";
import { handleParallelIdle } from "../modes/parallel.js";
import { handleConsensusIdle } from "../modes/consensus.js";
import { handlePipelineIdle } from "../modes/pipeline.js";
import { handleLoopIdle } from "../modes/loop.js";
import { buildRecursePrompt } from "../modes/recurse.js";
import {
    advanceToGatedStage,
    handleTollgateIdle,
    startVerification,
} from "../modes/tollgate.js";
import { advanceWorkflowStep, redispatchWorkflowStep } from "../workflow/engine.js";
import { handleWorkflowIdle } from "../workflow/handler.js";
import { handleWorkflowDispatchUnavailable } from "../workflow/fanout.js";
import {
    buildArbiterPrompt,
    buildDebatePrompt,
    handleArbitrateIdle,
} from "../modes/arbitrate.js";
import { buildRouterPrompt, handleRouteIdle } from "../modes/route.js";
import { buildSummary } from "../records/summary.js";
import { finishRun } from "../control/completion.js";
import { buildArenaEvaluatorPrompt, handleArenaIdle } from "../modes/arena.js";
import { buildReducePrompt, handleReduceIdle } from "../modes/reduce.js";
import { handleQuorumIdle } from "../modes/quorum.js";
import { buildSignoffReviewPrompt, evaluateSignoffQuorum, handleSignoffIdle } from "../control/signoff.js";
import { listAllTasks, reapStaleClaims, updateTask } from "../../state/tasks.js";
import { buildPrematureIdleReprompt } from "./idle.js";
import {
    getActiveWorkflowStepIndices,
    readyWorkflowStepIndices,
    workflowStepActor,
} from "../workflow/dag.js";

export type TeamMember = Team["members"][number];


/**
 * Shared concurrent re-dispatch pattern: for each non-master non-running
 * member passing the mode-specific `shouldDispatch` predicate, dispatch with
 * the mode-specific `text`, count real dispatches, and re-drive `barrier` when
 * zero members were dispatched (prevents a no-op resume from stalling the run).
 *
 * Used by parallel, consensus, route Phase B, arbitrate Phase A, and arena
 * implement phase. Modes with fundamentally different shapes (sequential stage
 * advance, delegate/recurse unconditional fan-out, tollgate multi-phase,
 * workflow multi-step) keep their own handlers.
 */
export async function resumeConcurrentDispatch(
    ctx: PluginContext,
    team: Team,
    members: readonly TeamMember[],
    shouldDispatch: (m: TeamMember) => boolean,
    text: (m: TeamMember) => string,
    barrier: () => Promise<void>,
): Promise<void> {
    let dispatched = 0;
    for (const m of members) {
        if (m.isMaster || m.status === "running") continue;
        if (shouldDispatch(m)) {
            await dispatchToMember(ctx, m, text(m), m.worktreePath ?? ctx.directory, team);
            dispatched++;
        }
    }
    if (dispatched === 0) await barrier();
}

/**
 * Reset interrupted task claims: reap stale locks + reset any claimed/in_progress
 * tasks back to pending so idle members can re-claim them. Shared by the
 * delegate and recurse resume paths.
 */
export async function resetInterruptedClaims(team: Team): Promise<void> {
    await reapStaleClaims(team.directory);
    for (const t of await listAllTasks(team.directory)) {
        if (t.status === "claimed" || t.status === "in_progress") {
            // #15: do NOT reset a task whose owner is still running. Pre-fix
            // code reset ALL claimed/in_progress tasks unconditionally — if
            // the owner's session was still alive (e.g. cross-process resume
            // where the member was dispatched by another process), the reset
            // would orphan the in-flight work and the task would be re-claimed
            // by another member, producing duplicate output.
            if (t.owner) {
                const ownerMember = team.members.find(m => m.name === t.owner);
                if (ownerMember?.sessionId && ownerMember.status === "running") {
                    continue;
                }
            }
            await updateTask(team.directory, t.id, {
                status: "pending",
                owner: undefined,
            });
        }
    }
}

/**
 * Signoff/reduce sub-stage recovery. Returns true if the resume was handled
 * (caller must return); false to proceed with per-mode dispatch.
 */
export async function resumeSignoffReduceStage(
    ctx: PluginContext,
    team: Team,
    task: ActiveTask,
): Promise<boolean> {
    // Mirrors processIdle priority ordering. A crash can occur while these
    // special stages are in flight. On resume, restore the reviewers/reducer
    // by re-triggering the same maybeTrigger* idempotent entry points the
    // live path uses, then bail — the type switch below is for the per-mode
    // MAP work, not these sub-stages.
    if (task.reduceStage) {
        const reducer = team.members.find(
            (m) => m.name === task.reducerMember && !m.isMaster,
        );
        if (reducer === undefined) {
            await finishRun(ctx, team, `parallel_failed:reducer_missing:${task.reducerMember ?? "undefined"}`, "failed");
            return true;
        }
        if (task.responses[reducer.name] === undefined) {
            const body = await buildSummary(team, task, "pending_reduce");
            const prompt = buildReducePrompt(body);
            await dispatchToMember(
                ctx,
                reducer,
                prompt,
                reducer.worktreePath ?? ctx.directory,
                team,
            );
        } else {
            await handleReduceIdle(ctx, team, reducer);
        }
        return true;
    }
    if (task.signoffStage) {
        // Re-dispatch reviewers who haven't responded yet, branching on policy
        // exactly like maybeTriggerSignoff (signoff.ts).
        const summary = await buildSummary(team, task, "pending_signoff");
        const reviewPrompt = buildSignoffReviewPrompt(summary);
        let reviewers: typeof team.members = [];
        if (task.signoffPolicy === "decider") {
            const decider = team.members.find(
                (m) => m.name === task.signoffDecider && !m.isMaster,
            );
            reviewers = decider ? [decider] : [];
        } else if (task.signoffPolicy === "peer-quorum") {
            const reviewerRoster = task.signoffReviewers
                ?? team.members.filter((m) => !m.isMaster && m.sessionId).map((m) => m.name);
            reviewers = reviewerRoster
                .map((name) => team.members.find((m) => m.name === name))
                .filter((m): m is TeamMember => m !== undefined && !m.isMaster && !!m.sessionId && m.status !== "errored");
        }
        let dispatched = 0;
        for (const m of reviewers) {
            // Skip reviewers who already have a recorded approval.
            if (task.signoffApprovals?.[m.name] !== undefined) continue;
            // HIGH: only use signoffRawOutputs for resume — task.responses
            // holds the reviewer's PRIMARY task output, not their signoff
            // verdict. Pre-fix code treated primary output as signoff output,
            // which could contain a <signoff> example that was miscounted.
            if (task.signoffRawOutputs?.[m.name] !== undefined) {
                await handleSignoffIdle(ctx, team, m);
                if (!team.activeTask) return true; // run terminated
                continue;
            }
            await dispatchToMember(
                ctx,
                m,
                reviewPrompt,
                m.worktreePath ?? ctx.directory,
                team,
            );
            dispatched++;
        }
        if (dispatched === 0 && task.signoffPolicy === "decider" && task.signoffDecider) {
            const approved = task.signoffApprovals?.[task.signoffDecider];
            if (approved !== undefined) {
                await finishRun(
                    ctx,
                    team,
                    approved ? "signoff_approved" : "signoff_rejected",
                    approved ? "idle" : "failed",
                );
            }
        } else if (dispatched === 0 && task.signoffPolicy === "peer-quorum") {
            await evaluateSignoffQuorum(ctx, team);
        }
        return true;
    }
    return false;
}

/**
 * Parallel resume: re-dispatch members that have not yet responded (or have
 * not acked under require_done_ack); a zero-dispatch re-drives the barrier so
 * an all-complete crash edge does not stall the run.
 */
export async function resumeParallelMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "parallel" }>,
): Promise<void> {
    // Completion criterion depends on require_done_ack; a zero-dispatch re-drives the barrier.
    await resumeConcurrentDispatch(
        ctx, team, team.members,
        (m) => task.requireDoneAck ? !m.declaredDone : task.responses[m.name] === undefined,
        (m) => task.requireDoneAck && task.responses[m.name] !== undefined
            ? buildPrematureIdleReprompt(team.teamName)
            : task.tasks?.[m.name] ?? task.task ?? "",
        () => handleParallelIdle(ctx, team),
    );
}

/**
 * Consensus resume: if max rounds is already reached, re-drive the barrier to
 * settle the round; otherwise re-dispatch members without responses for the
 * current round.
 */
export async function resumeConsensusMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "consensus" }>,
): Promise<void> {
    if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
        await handleConsensusIdle(ctx, team);
        return;
    }
    await resumeConcurrentDispatch(
        ctx, team, team.members,
        (m) => task.responses[m.name] === undefined,
        () =>
            `[Consensus Round ${task.currentRound ?? 0}] ${task.topic}\n\n` +
            'Respond, then emit <consensus>{"agreed": true|false}</consensus>.',
        () => handleConsensusIdle(ctx, team),
    );
}

/**
 * Pipeline/loop resume: re-dispatch the current stage (advanceToStage reads
 * responses[] internally); an all-complete index means the crash happened
 * before delivery, so finish the run.
 */
export async function resumeSequentialMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "pipeline" | "loop" }>,
): Promise<void> {
    if (task.currentStageIndex >= task.stages.length) {
        // All-complete edge (crash before delivery).
        await finishRun(ctx, team, `${task.type}_complete`, "idle");
        return;
    }
    const stage = task.stages[task.currentStageIndex];
    if (!stage) {
        await finishRun(ctx, team, `${task.type}_failed:missing_stage`, "failed");
        return;
    }
    // If the current stage's member already has a captured response, the
    // crash happened after the member responded but before the idle handler
    // processed it. Re-dispatching would duplicate the turn. Instead, drive
    // the mode's idle handler directly so the response is processed and the
    // stage advances naturally.
    const stageMember = team.members.find(m => m.name === stage.member && !m.isMaster);
    if (stageMember && task.responses[stage.member] !== undefined) {
        // The idle handler reads responses[] and advances internally.
        if (task.type === "pipeline") {
            await handlePipelineIdle(ctx, team, stageMember);
        } else {
            await handleLoopIdle(ctx, team, stageMember);
        }
        return;
    }
    // No response yet: re-dispatch the stage normally.
    await advanceToStage(ctx, team, stage);
}

/**
 * Delegate resume: reset interrupted task claims back to pending, then
 * re-dispatch every idle member to pull fresh work from the shared tasklist.
 */
export async function resumeDelegateMode(
    ctx: PluginContext,
    team: Team,
): Promise<void> {
    // Reset claimed AND in_progress -> pending (claiming member's
    // turn was interrupted). reapStaleClaims handles stale locks;
    // fresh claimed locks linger up to CLAIM_TTL_MS (documented).
    await resetInterruptedClaims(team);
    for (const m of team.members) {
        if (m.isMaster || m.status === "running") continue;
        await dispatchToMember(
            ctx,
            m,
            "Resume: pull tasks from the shared tasklist.",
            m.worktreePath ?? ctx.directory,
            team,
        );
    }
}

/**
 * Route resume. Phase A: if the router's output is captured, re-run the
 * routing decision; otherwise re-dispatch the router. Phase B: re-dispatch
 * targets without responses; a zero-dispatch re-drives the barrier.
 */
export async function resumeRouteMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "route" }>,
): Promise<void> {
    if (!task.routeStage) {
        // Phase A: router hadn't transitioned to targets. If its
        // output is captured, re-run Phase A (parse -> dispatch
        // targets); else re-dispatch the router.
        if (task.routerMember && task.responses[task.routerMember]) {
            await handleRouteIdle(ctx, team);
        } else {
            const router = team.members.find(
                (m) => m.name === task.routerMember && !m.isMaster,
            );
            if (!router?.sessionId || router.status === "errored") {
                await finishRun(ctx, team, "route_resume_missing_router", "failed");
                return;
            }
            const prompt = buildRouterPrompt(
                team.teamName,
                task.task ?? "",
                task.routeBranches ?? [],
            );
            await dispatchToMember(
                ctx,
                router,
                prompt,
                router.worktreePath ?? ctx.directory,
                team,
            );
        }
        return;
    }
    // Phase B: re-dispatch targets without responses; else re-drive the barrier.
    const routeTargets = new Set(task.routeTargets ?? []);
    await resumeConcurrentDispatch(
        ctx, team, team.members,
        (m) => routeTargets.has(m.name) && task.responses[m.name] === undefined,
        (m) => task.routeBranches?.find((b) => b.member === m.name)?.task ?? task.task ?? "",
        () => handleRouteIdle(ctx, team),
    );
}

/**
 * Arbitrate resume. Phase A (debate): re-dispatch debaters without responses;
 * a zero-dispatch re-drives the barrier. Phase B (ruling): if the arbiter
 * responded, re-run the ruling parse; otherwise re-dispatch the arbiter.
 */
export async function resumeArbitrateMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "arbitrate" }>,
): Promise<void> {
    if (!task.arbitrationStage) {
        // Phase A: re-dispatch debaters without responses; else re-drive the barrier.
        const debaters = (task.disputants ?? [])
            .map((name) => team.members.find((m) => m.name === name && !m.isMaster))
            .filter((m): m is TeamMember => m !== undefined);
        await resumeConcurrentDispatch(
            ctx, team, debaters,
            (m) => task.responses[m.name] === undefined,
            () => buildDebatePrompt(task),
            () => handleArbitrateIdle(ctx, team),
        );
        return;
    }
    // Phase B: if the arbiter responded, re-run the ruling (parse -> deliver); else re-dispatch the arbiter.
    if (task.arbiterMember && task.responses[task.arbiterMember]) {
        await handleArbitrateIdle(ctx, team);
    } else {
        const arbiter = team.members.find(
            (m) => m.name === task.arbiterMember && !m.isMaster,
        );
        if (!arbiter?.sessionId || arbiter.status === "errored") {
            await finishRun(ctx, team, "arbitrate_resume_missing_arbiter", "failed");
            return;
        }
        await dispatchToMember(
            ctx,
            arbiter,
            buildArbiterPrompt(task),
            arbiter.worktreePath ?? ctx.directory,
            team,
        );
    }
}

/**
 * Recurse resume: reset interrupted task claims, then re-dispatch every idle
 * member with the recursive contract (same recovery shape as delegate).
 */
export async function resumeRecurseMode(
    ctx: PluginContext,
    team: Team,
): Promise<void> {
    // Same task recovery as delegate: reset interrupted claims/in_progress -> pending,
    // then re-dispatch idle members with the recursive contract.
    await resetInterruptedClaims(team);
    for (const m of team.members) {
        if (m.isMaster || m.status === "running") continue;
        await dispatchToMember(
            ctx,
            m,
            buildRecursePrompt(),
            m.worktreePath ?? ctx.directory,
            team,
        );
    }
}

/**
 * Tollgate resume across its three phases. verify: replay the verdict parse if
 * the verifier's output is captured, else re-dispatch the verifier.
 * escalate: re-dispatch the escalation handler. produce: re-dispatch the
 * current gate's producer.
 */
export async function resumeTollgateMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "tollgate" }>,
): Promise<void> {
    const stage = task.gatedStages?.[task.currentStageIndex];
    if (!stage) {
        // H-7: missing required stage means the checkpoint is corrupt or
        // incomplete. Pre-fix code returned silently, leaving the team busy
        // with no members dispatched. Now: fail the run explicitly.
        await finishRun(ctx, team, "tollgate_resume_missing_stage: checkpoint has no stage at currentStageIndex", "failed");
        return;
    }
    const phase = task.tollgatePhase ?? "produce";
    if (phase === "verify") {
        const verifier = team.members.find(
            (m) => m.name === stage.verifier && !m.isMaster,
        );
        if (!verifier) {
            await finishRun(ctx, team, "tollgate_resume_missing_verifier", "failed");
            return;
        }
        // Verifier output already captured -> re-run the verdict parse; else re-dispatch the verifier.
        if (task.responses[stage.verifier]) {
            await handleTollgateIdle(ctx, team, verifier);
        } else {
            await startVerification(ctx, team, stage);
        }
    } else if (phase === "escalate") {
        const handler = task.escalateTo
            ? team.members.find((m) => m.name === task.escalateTo && !m.isMaster)
            : undefined;
        if (!handler?.sessionId || handler.status === "errored") {
            await finishRun(ctx, team, "tollgate_resume_missing_escalation_actor", "failed");
            return;
        }
        // MEDIUM: if the escalation handler's output was already captured
        // pre-crash, replay it instead of re-dispatching.
        if (task.responses[handler.name]) {
            await handleTollgateIdle(ctx, team, handler);
        } else {
            await dispatchToMember(
                ctx,
                handler,
                "Resume: fix the verifier/reference, then report done.",
                handler.worktreePath ?? ctx.directory,
                team,
            );
        }
    } else {
        // produce phase: check if the producer's output was already captured.
        const producer = team.members.find(
            (m) => m.name === stage.member && !m.isMaster,
        );
        if (producer && task.responses[producer.name]) {
            await handleTollgateIdle(ctx, team, producer);
        } else {
            await advanceToGatedStage(ctx, team, stage);
        }
    }
}

/**
 * Re-drive the workflow after a crash. If the current step's actor already
 * produced output pre-crash, re-run the handler to process it (parse verdict /
 * mark complete + advance); otherwise dispatch the first incomplete step, or
 * deliver if all steps are already complete (all-complete crash edge).
 */
export async function resumeWorkflowMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "workflow" }>,
): Promise<void> {
    const steps = task.steps ?? [];
    if (task.activeStepIndices !== undefined) {
        const originalActive = getActiveWorkflowStepIndices(task);
        const originalActiveSet = new Set(originalActive);
        // Snapshot which steps had dispatchedAt BEFORE the handleWorkflowIdle
        // replay loop. Steps dispatched DURING replay (by advanceWorkflowStep)
        // must NOT be re-dispatched by the redispatch loop below.
        const dispatchedBefore = new Set<number>();
        for (const index of originalActive) {
            if (steps[index]?.dispatchedAt !== undefined) dispatchedBefore.add(index);
        }

        for (const index of originalActive) {
            const activeStep = steps[index];
            // A waiting reduce-join's reducer response slot is ambiguous (it may hold
            // a stale value from an earlier step), so joins never replay via the
            // member-response shortcut; the redispatch loop below clears and
            // re-dispatches them.
            if (activeStep?.kind === "join") continue;
            // HIGH #7: for ensemble gates, replay each verifier that has a
            // pending response. workflowStepActor returns null for ensemble
            // gates (no single verifier field), so pre-fix code skipped them.
            if (activeStep?.kind === "gate" && activeStep.verifiers !== undefined) {
                let replayedAny = false;
                for (const vName of activeStep.verifiers) {
                    if (task.responses[vName] !== undefined
                        && activeStep.ensembleResults?.[vName] === undefined) {
                        const vMember = team.members.find(m => m.name === vName && !m.isMaster);
                        if (vMember) {
                            await handleWorkflowIdle(ctx, team, vMember);
                            replayedAny = true;
                            if (team.activeTask !== task || task.approvalStage || task.signoffStage) return;
                        }
                    }
                }
                if (replayedAny) continue;
            }
            const actorName = workflowStepActor(activeStep);
            if (actorName === null || task.responses[actorName] === undefined) continue;
            const actor = team.members.find(
                (m) => m.name === actorName && !m.isMaster,
            );
            if (actor === undefined) continue;
            await handleWorkflowIdle(ctx, team, actor);
            if (
                team.activeTask !== task ||
                task.approvalStage ||
                task.signoffStage
            )
                return;
        }

        let dispatched = 0;
        let degraded = false;
        for (const index of readyWorkflowStepIndices(task)) {
            if (!originalActiveSet.has(index)) continue;
            const step = steps[index];
            if (step === undefined || step.completed) continue;
            // Skip steps dispatched during the handleWorkflowIdle replay
            // above — advanceWorkflowStep already dispatched them.
            if (step.dispatchedAt !== undefined && !dispatchedBefore.has(index)) continue;
            if (step.kind === "join") {
                if (!(await redispatchWorkflowStep(ctx, team, index))) {
                    await handleWorkflowDispatchUnavailable(ctx, team, task, step);
                    return;
                }
                dispatched++;
                continue;
            }
            const actorName = workflowStepActor(step);
            if (actorName === null || task.responses[actorName]) continue;
            if (!(await redispatchWorkflowStep(ctx, team, index))) {
                const unavailability = await handleWorkflowDispatchUnavailable(
                    ctx,
                    team,
                    task,
                    step,
                );
                if (unavailability === "failed") return;
                degraded = true;
                continue;
            }
            dispatched++;
        }

        if (degraded || dispatched === 0) await advanceWorkflowStep(ctx, team);
        return;
    }

    const step = steps[task.currentStageIndex];
    if (step) {
        const actorName = step.kind === "task"
            ? step.member
            : step.kind === "gate"
                ? step.verifier
                : null;
        if (actorName && task.responses[actorName]) {
            const actor = team.members.find(
                (m) => m.name === actorName && !m.isMaster,
            );
            if (actor) {
                await handleWorkflowIdle(ctx, team, actor);
                return;
            }
        }
    }
    // No captured response to process -> dispatch the next incomplete step, or
    // deliver workflow_complete if every step is already done.
    await advanceWorkflowStep(ctx, team);
}

/**
 * Arena resume for BOTH phases. Implement/undefined: re-dispatch only
 * unfinished LIVE candidates (skip running/errored/no-session/already-
 * responded); a no-op dispatch is NOT counted, so a zero real dispatch
 * re-drives the barrier via handleArenaIdle with the FIRST candidate
 * regardless of status — errored candidates count as terminal-ready in
 * maybeAdvanceBarrier, so checkTermination delivers arena_failed:no_survivors
 * instead of hanging to wall-clock. Evaluate: an errored evaluator fails
 * closed; a missing evaluator response is re-dispatched; an already-present
 * response is parsed exactly once (handleArenaIdle deletes and re-dispatches
 * bad output, so a second resume cannot re-consume it).
 */
export async function resumeArenaMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "arena" }>,
): Promise<void> {
    // M-1: validate required arena fields before resuming.
    if (!task.evaluatorMember) {
        await finishRun(ctx, team, "arena_resume_missing_evaluator", "failed");
        return;
    }
    if ((task.arenaPhase ?? "implement") === "evaluate") {
        const evaluator = team.members.find(
            (m) => m.name === task.evaluatorMember && !m.isMaster,
        );
        // An errored evaluator fails closed; NEVER revive/re-dispatch it.
        if (evaluator?.status === "errored") {
            await finishRun(ctx, team, "arena_failed:evaluator_error", "failed");
            return;
        }
        if (evaluator?.sessionId === undefined) {
            await finishRun(ctx, team, "arena_resume_missing_evaluator", "failed");
            return;
        }
        if (
            evaluator.status !== "running" &&
            task.responses[task.evaluatorMember] === undefined
        ) {
            // No captured evaluator output -> re-dispatch the scoreboard prompt.
            await dispatchToMember(
                ctx,
                evaluator,
                buildArenaEvaluatorPrompt(task, team),
                evaluator.worktreePath ?? ctx.directory,
                team,
            );
            await saveTeamState(team);
        } else if (
            task.responses[task.evaluatorMember] &&
            !task.winner &&
            !task.scoreboard
        ) {
            // A response exists but no winner/scoreboard yet -> parse it once.
            await handleArenaIdle(ctx, team, evaluator);
        }
        return;
    }

    // implement/undefined phase: re-dispatch only unfinished LIVE candidates.
    // dispatchToMember is a silent no-op for errored/no-session members, so
    // those are filtered out BEFORE the count — a counted no-op would suppress
    // the zero-dispatch barrier re-drive and hang the run.
    const candidateSet = new Set(task.candidates);
    await resumeConcurrentDispatch(
        ctx, team, team.members,
        (m) => candidateSet.has(m.name)
            && m.status !== "errored"
            && !!m.sessionId
            && task.responses[m.name] === undefined,
        () => task.task,
        async () => {
            // Zero real dispatch -> re-drive the barrier with the FIRST candidate
            // regardless of status (when all errored there is no live one, but the
            // barrier counts errored as terminal-ready).
            const first = team.members.find((m) => task.candidates.includes(m.name));
            if (first) await handleArenaIdle(ctx, team, first);
        },
    );
}

/**
 * Quorum resume: re-dispatch participants without a captured response; a
 * zero-dispatch re-drive settles the barrier (e.g. all participants already
 * idled but the process crashed before the tally ran).
 *
 * Errored/no-session participants are filtered out of the dispatch predicate
 * (mirrors resumeArenaMode, NOT resumeParallelMode): without this guard, a
 * counted no-op to an errored participant would suppress the zero-dispatch
 * barrier re-drive and hang the run. Quorum is more exposed to this than
 * parallel because errored participants are a designed-for condition
 * (default maxErroredMembers = N-1).
 */
export async function resumeQuorumMode(
    ctx: PluginContext,
    team: Team,
    task: Extract<ActiveTask, { type: "quorum" }>,
): Promise<void> {
    const participantSet = new Set(task.participants);
    await resumeConcurrentDispatch(
        ctx, team, team.members,
        (m) => participantSet.has(m.name)
            && m.status !== "errored"
            && !!m.sessionId
            && task.responses[m.name] === undefined,
        () => `[Quorum vote — resumed]\n${task.task}`,
        async () => {
            // Zero real dispatch -> re-drive the barrier with the FIRST
            // participant regardless of status (errored counts as terminal-ready).
            const first = team.members.find((m) => task.participants.includes(m.name));
            if (first) await handleQuorumIdle(ctx, team);
        },
    );
}
