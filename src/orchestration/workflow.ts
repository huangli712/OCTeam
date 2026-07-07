/**
 * Workflow handler -- deterministic linear step engine (GAP-2).
 *
 * STATE MACHINE (MVP: linear + gate-driven retry):
 *   steps[i]_dispatch -> steps[i]_idle -> steps[i+1]_dispatch -> ... -> all_complete
 *   - task step: dispatch the actor with upstream (prior completed TASK-step
 *     outputs) prefixed; on its idle, mark completed and advance.
 *   - gate step: dispatch the verifier with the preceding task's output +
 *     criteria; on its idle, parse <verdict>:
 *       PASS   -> mark the gate complete; advance.
 *       FAIL   -> if onFail="retry" and attempts <= maxRetries, reset and
 *                 re-dispatch the preceding task's actor with a diff diagnostic;
 *                 else fail the run (workflow_failed).
 *       INVALID / parse-failure -> fail the run as workflow_invalid. This is
 *                 producer-neutral: the target task is not retried.
 *   - All steps complete -> maybeTriggerSignoff -> deliver (idle: workflow_complete)
 *
 * Reuses dispatchToMember (canonical member dispatch), parseVerdict (tollgate's
 * three-valued verdict parser), maybeTriggerSignoff, and finishRun. Does NOT
 * reuse buildUpstreamContext because gate-step actors differ from task-step
 * actors and gate verdicts are control-flow, not work product; a dedicated
 * buildWorkflowUpstream includes only completed task-step outputs.
 */

import type { PluginContext } from "../core/context.js"
import { type Team, saveTeamState } from "../state/store.js"
import type { MemberState, WorkflowStep, WorkflowTask } from "../core/types.js"
import { dispatchToMember } from "./dispatch.js"
import { finishRun } from "./summary.js"
import { recordEvent } from "./events.js"
import { truncateOutput } from "../core/utils.js"
import { parseVerdict } from "./decisions.js"
import { maybeTriggerSignoff } from "./signoff.js"
import { forceApprovalRequest, maybeRequestApproval } from "./hitl.js"

// Total byte budget for injected upstream context (mirrors dispatch.ts). Caps
// prompt growth so a long workflow does not bloat the actor's prompt linearly.
const UPSTREAM_TOTAL_CAP = 65_536

/**
 * Build the upstream-context prefix for a workflow task step: ALL completed
 * prior TASK-step outputs (gate steps are skipped -- their verdicts are
 * control-flow, not work product), each labelled by member and individually
 * truncated, then capped at UPSTREAM_TOTAL_CAP total bytes. Returns "" when
 * there is no completed task-step upstream.
 */
function buildWorkflowUpstream(
    steps: WorkflowStep[],
    uptoIndex: number,
): string {
    const blocks: string[] = []
    let used = 0
    for (let i = 0; i < uptoIndex; i++) {
        const s = steps[i]
        if (!s?.completed || s.kind !== "task" || !s.member) continue
        const out = s.output
        if (!out) continue
        const block = `[Output from ${s.member}]\n${truncateOutput(out)}`
        if (used + block.length > UPSTREAM_TOTAL_CAP) {
            blocks.push(`[…upstream context truncated at ${UPSTREAM_TOTAL_CAP} bytes]`)
            break
        }
        blocks.push(block)
        used += block.length
    }
    return blocks.join("\n\n")
}

/**
 * Build the verifier's dispatch prompt: the preceding task's output, the
 * criteria, and the exact <verdict> block the verifier must emit. PASS = the
 * output meets the criteria, FAIL = it does not (rationale + diff).
 */
function buildGateVerifierPrompt(step: WorkflowStep, producerOutput: string, targetStep: number): string {
    return (
        `[Verification gate] Verify workflow step ${targetStep} output below against the criteria.\n`
        + `Criteria: ${step.criteria ?? ""}\n\n`
        + `Producer output:\n${producerOutput}\n\n`
        + `Emit EXACTLY one:\n`
        + `<verdict>{"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."}</verdict>\n`
        + `PASS = the output meets the criteria. FAIL = it does not (give rationale + diff). `
        + `INVALID = you cannot evaluate the output or criteria; this is not a producer failure.`
    )
}

/**
 * Find the nearest preceding TASK step index for a gate (for retry and for the
 * gate's producer output). Returns -1 when there is none (a gate-first
 * workflow is rejected at the tool layer; the handler guards defensively).
 */
function precedingTaskIndex(steps: WorkflowStep[], gateIndex: number): number {
    for (let i = gateIndex - 1; i >= 0; i--) {
        if (steps[i]?.kind === "task") return i
    }
    return -1
}

function gateTargetIndex(steps: WorkflowStep[], gateIndex: number): number {
    const gate = steps[gateIndex]
    if (gate?.kind === "gate" && gate.targetStepIndex !== undefined) return gate.targetStepIndex
    return precedingTaskIndex(steps, gateIndex)
}

function hasLiveSession(member: MemberState | undefined): member is MemberState & { sessionId: string } {
    return member?.sessionId !== undefined && member.status !== "errored"
}

function describeStep(step: WorkflowStep | undefined, index: number): string {
    if (!step) return `step ${index + 1}`
    const idTag = step.id ? ` (${step.id})` : ""
    if (step.kind === "task") return `step ${index + 1}${idTag} (task) by ${step.member ?? "?"}`
    const target = step.targetStepIndex === undefined ? "nearest task" : `step ${step.targetStepIndex + 1}`
    return `step ${index + 1}${idTag} (gate) by ${step.verifier ?? "?"}, verifying ${target}`
}

/** Dispatch a task step's actor with upstream context prefixed. */
async function dispatchTaskStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
): Promise<boolean> {
    const step = task.steps?.[index]
    if (!step || step.kind !== "task" || !step.member || !step.task) return false
    const member = team.members.find(m => m.name === step.member && !m.isMaster)
    if (!hasLiveSession(member)) return false
    const upstream = buildWorkflowUpstream(task.steps ?? [], index)
    const text = upstream ? `${upstream}\n\n[Your task]\n${step.task}` : step.task
    await dispatchToMember(ctx, member, text, member.worktreePath ?? ctx.directory, team)
    return true
}

/** Dispatch a gate step's verifier with the preceding task's output + criteria. */
async function dispatchGateStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
): Promise<boolean> {
    const step = task.steps?.[index]
    if (!step || step.kind !== "gate" || !step.verifier) return false
    const verifier = team.members.find(m => m.name === step.verifier && !m.isMaster)
    if (!hasLiveSession(verifier)) return false
    const producerIdx = gateTargetIndex(task.steps ?? [], index)
    if (producerIdx < 0) return false
    const producerStep = producerIdx >= 0 ? task.steps?.[producerIdx] : undefined
    const producerOutput = producerStep?.kind === "task" ? truncateOutput(producerStep.output ?? "") : ""
    await dispatchToMember(
        ctx,
        verifier,
        buildGateVerifierPrompt(step, producerOutput, producerIdx + 1),
        verifier.worktreePath ?? ctx.directory,
        team,
    )
    return true
}

/**
 * Advance the workflow: find the next incomplete step, dispatch it (task or
 * gate), or -- if all steps are complete -- trigger signoff then deliver
 * (workflow_complete). Shared by the task-step completion path and the
 * gate-PASS path, and by resumeWorkflowMode / approval resume.
 */
export async function advanceWorkflowStep(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "workflow") return
    const steps = task.steps ?? []

    const nextIndex = steps.findIndex(s => !s.completed)
    if (nextIndex === -1) {
        if (await maybeTriggerSignoff(ctx, team)) return
        await finishRun(ctx, team, "workflow_complete", "idle")
        return
    }
    task.currentStageIndex = nextIndex
    const step = steps[nextIndex]
    if (!step) return
    const dispatched = step.kind === "task"
        ? await dispatchTaskStep(ctx, team, task, nextIndex)
        : await dispatchGateStep(ctx, team, task, nextIndex)
    if (!dispatched) {
        const actor = step.kind === "task" ? step.member : step.verifier
        await finishRun(ctx, team, `workflow_failed:no_session:${actor ?? "unknown"}`, "failed")
        return
    }
    await saveTeamState(team)
}

/**
 * Workflow core state machine. processIdle has already validated the idle
 * member's identity (getExpectedMember returns the current step's actor) and
 * captured its output into task.responses, so this function only advances the
 * state machine.
 */
export async function handleWorkflowIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "workflow") return
    const steps = task.steps ?? []
    const step = steps[task.currentStageIndex]
    if (!step) return

    if (step.kind === "task") {
        if (member.name !== step.member) return              // stray idle
        step.output = task.responses[member.name] ?? ""
        step.completed = true
        const nextIndex = steps.findIndex(s => !s.completed)
        if (nextIndex !== -1 && await maybeRequestApproval(ctx, team, {
            kind: "workflow_step",
            stage: task.currentStageIndex,
            summary: `Completed ${describeStep(step, task.currentStageIndex)}. Next: ${describeStep(steps[nextIndex], nextIndex)}. Review before continuing.`,
        })) {
            return
        }
        await advanceWorkflowStep(ctx, team)
        return
    }

    // gate step
    if (member.name !== step.verifier) return                // stray idle
    const v = parseVerdict(task.responses[step.verifier] ?? "")
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "verdict",
        member: step.verifier,
        stage: task.currentStageIndex,
        detail: v.verdict ?? "parse_fail",
    })

    if (v.parseFailed || !v.verdict) {
        await handleInvalidVerdict(ctx, team, step, "parse_failure", v.rationale, v.diff)
        return
    }
    step.verdict = v.verdict

    if (v.verdict === "INVALID") {
        await handleInvalidVerdict(ctx, team, step, "INVALID", v.rationale, v.diff)
        return
    }

    if (v.verdict === "PASS") {
        step.completed = true
        const nextIndex = steps.findIndex(s => !s.completed)
        if (nextIndex !== -1 && await maybeRequestApproval(ctx, team, {
            kind: "workflow_step",
            stage: task.currentStageIndex,
            summary: `Completed ${describeStep(step, task.currentStageIndex)} with PASS from ${step.verifier}. Rationale: ${v.rationale}. Next: ${describeStep(steps[nextIndex], nextIndex)}. Review before continuing.`,
        })) {
            return
        }
        await advanceWorkflowStep(ctx, team)
        return
    }

    // v.verdict === "FAIL"
    const onFail = step.onFail ?? "fail"
    if (onFail === "fail") {
        await finishRun(ctx, team, `workflow_failed:${step.verifier}`, "failed")
        return
    }
    // onFail === "retry": bounded retry of the preceding task.
    step.attempts = (step.attempts ?? 0) + 1
    const maxR = step.maxRetries ?? 0
    if (step.attempts > maxR) {
        await finishRun(ctx, team, `workflow_failed:${step.verifier}`, "failed")
        return
    }
    const gateIndex = task.currentStageIndex
    const producerIdx = gateTargetIndex(steps, gateIndex)
    if (producerIdx === -1) {
        // No preceding task to retry -> fail (defensive; tool layer rejects gate-first).
        await finishRun(ctx, team, `workflow_failed:${step.verifier}`, "failed")
        return
    }
    for (let i = producerIdx; i <= gateIndex; i++) {
        const retryStep = steps[i]
        if (!retryStep) continue
        retryStep.completed = false
        if (retryStep.kind === "task") retryStep.output = undefined
        if (retryStep.kind === "gate") {
            retryStep.verdict = undefined
            if (i !== gateIndex) retryStep.attempts = 0
        }
    }
    const producerStep = steps[producerIdx]
    if (!producerStep || producerStep.kind !== "task") {
        await finishRun(ctx, team, `workflow_failed:${step.verifier}`, "failed")
        return
    }
    task.currentStageIndex = producerIdx
    const producer = team.members.find(m => m.name === producerStep.member && !m.isMaster)
    if (!hasLiveSession(producer)) {
        await finishRun(ctx, team, `workflow_failed:no_session:${producerStep.member ?? "unknown"}`, "failed")
        return
    }
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "retry",
        member: producerStep.member,
        stage: gateIndex,
        detail: `workflow step ${gateIndex + 1} attempt ${step.attempts}/${maxR}; retry target step ${producerIdx + 1}; verifier ${step.verifier}; diff: ${v.diff}`,
    })
    const feedback =
        `[Gate FAILED - attempt ${step.attempts}/${maxR}]\n`
        + `Rationale: ${v.rationale}\nDiff: ${v.diff}\nFix and resubmit.`
    await dispatchToMember(
        ctx,
        producer,
        `${feedback}\n\n[Your task]\n${producerStep.task ?? ""}`,
        producer.worktreePath ?? ctx.directory,
        team,
    )
    await saveTeamState(team)
}

/**
 * Handle an unevaluable gate verdict (INVALID or parse failure) according to
 * the gate's onInvalid policy. Producer-neutral in all cases: the target task
 * is never retried on INVALID (only the verifier may be re-dispatched).
 *   fail          -> terminate as workflow_invalid:<reason>:<verifier>
 *   retry_verifier-> re-dispatch THIS gate's verifier (bounded by
 *                    maxInvalidRetries), then on exhaust terminate.
 *   escalate      -> force a human-approval pause; approve marks the gate
 *                    complete and advances, reject terminates.
 */
async function handleInvalidVerdict(
    ctx: PluginContext,
    team: Team,
    step: WorkflowStep,
    reason: "INVALID" | "parse_failure",
    rationale: string,
    diff: string,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "workflow") return
    const gateIndex = task.currentStageIndex
    const policy = step.onInvalid ?? "fail"

    if (policy === "retry_verifier") {
        step.invalidAttempts = (step.invalidAttempts ?? 0) + 1
        const maxIR = step.maxInvalidRetries ?? 0
        if (step.invalidAttempts > maxIR) {
            await finishRun(ctx, team, `workflow_invalid:${reason}:${step.verifier}`, "failed")
            return
        }
        const verifier = team.members.find(m => m.name === step.verifier && !m.isMaster)
        if (!hasLiveSession(verifier)) {
            await finishRun(ctx, team, `workflow_failed:no_session:${step.verifier ?? "unknown"}`, "failed")
            return
        }
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "retry",
            member: step.verifier,
            stage: gateIndex,
            detail: `workflow step ${gateIndex + 1} invalid retry ${step.invalidAttempts}/${maxIR}; verifier ${step.verifier}; reason ${reason}: ${rationale}`,
        })
        const nudge =
            `[Verification could not be evaluated — invalid attempt ${step.invalidAttempts}/${maxIR}]\n`
            + `Reason: ${reason}. Rationale: ${rationale}. Diff: ${diff}.\n`
            + `Re-evaluate the target output and emit a fresh verdict.`
        await dispatchToMember(
            ctx,
            verifier,
            `${nudge}\n\n${buildGateVerifierPrompt(step, "", gateIndex + 1)}`,
            verifier.worktreePath ?? ctx.directory,
            team,
        )
        await saveTeamState(team)
        return
    }

    if (policy === "escalate") {
        const nextIndex = (task.steps ?? []).findIndex(s => !s.completed)
        const escalated = await forceApprovalRequest(ctx, team, {
            kind: "workflow_step",
            stage: gateIndex,
            summary: `Step ${gateIndex + 1} (gate) by ${step.verifier ?? "?"} could not be evaluated (${reason}). Rationale: ${rationale}. Approve to override and continue${nextIndex !== -1 ? ` to ${describeStep((task.steps ?? [])[nextIndex], nextIndex)}` : ""}; reject to fail as workflow_invalid.`,
        })
        if (escalated) {
            // Mark the gate complete so that on team_approve (which calls
            // advanceWorkflowStep) the workflow proceeds past this gate.
            step.completed = true
            await saveTeamState(team)
            return
        }
        // No escalation handler available -> fall through to terminal fail.
    }

    await finishRun(ctx, team, `workflow_invalid:${reason}:${step.verifier}`, "failed")
}
