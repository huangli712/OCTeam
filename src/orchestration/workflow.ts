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
 *       parse-failure -> fail the run (workflow_failed). MVP has no INVALID
 *                 escalation (unlike tollgate); an unevaluable verdict fails.
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
import { maybeRequestApproval } from "./hitl.js"

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
    responses: Record<string, string>,
    uptoIndex: number,
): string {
    const blocks: string[] = []
    let used = 0
    for (let i = 0; i < uptoIndex; i++) {
        const s = steps[i]
        if (!s?.completed || s.kind !== "task" || !s.member) continue
        const out = responses[s.member]
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
function buildGateVerifierPrompt(step: WorkflowStep, producerOutput: string): string {
    return (
        `[Verification gate] Verify the producer's output below against the criteria.\n`
        + `Criteria: ${step.criteria ?? ""}\n\n`
        + `Producer output:\n${producerOutput}\n\n`
        + `Emit EXACTLY one:\n`
        + `<verdict>{"result":"PASS|FAIL","rationale":"...","diff":"..."}</verdict>\n`
        + `PASS = the output meets the criteria. FAIL = it does not (give rationale + diff).`
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

/** Dispatch a task step's actor with upstream context prefixed. */
async function dispatchTaskStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
): Promise<void> {
    const step = task.steps?.[index]
    if (!step || step.kind !== "task" || !step.member || !step.task) return
    const member = team.members.find(m => m.name === step.member && !m.isMaster)
    if (!member?.sessionId) return
    const upstream = buildWorkflowUpstream(task.steps ?? [], task.responses, index)
    const text = upstream ? `${upstream}\n\n[Your task]\n${step.task}` : step.task
    await dispatchToMember(ctx, member, text, member.worktreePath ?? ctx.directory, team)
}

/** Dispatch a gate step's verifier with the preceding task's output + criteria. */
async function dispatchGateStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
): Promise<void> {
    const step = task.steps?.[index]
    if (!step || step.kind !== "gate" || !step.verifier) return
    const verifier = team.members.find(m => m.name === step.verifier && !m.isMaster)
    if (!verifier?.sessionId) return
    const producerIdx = precedingTaskIndex(task.steps ?? [], index)
    const producerMember = producerIdx >= 0 ? task.steps?.[producerIdx]?.member : undefined
    const producerOutput = producerMember ? truncateOutput(task.responses[producerMember] ?? "") : ""
    await dispatchToMember(
        ctx,
        verifier,
        buildGateVerifierPrompt(step, producerOutput),
        verifier.worktreePath ?? ctx.directory,
        team,
    )
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
    if (step.kind === "task") {
        await dispatchTaskStep(ctx, team, task, nextIndex)
    } else {
        await dispatchGateStep(ctx, team, task, nextIndex)
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
            summary: `Workflow step ${task.currentStageIndex + 1} (task) completed by ${step.member}. Review before step ${nextIndex + 1} starts.`,
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
        // MVP: an unparseable verdict fails the run (no INVALID escalation).
        await finishRun(ctx, team, `workflow_failed:parse_failure:${step.verifier}`, "failed")
        return
    }
    step.verdict = v.verdict

    if (v.verdict === "PASS") {
        step.completed = true
        const nextIndex = steps.findIndex(s => !s.completed)
        if (nextIndex !== -1 && await maybeRequestApproval(ctx, team, {
            kind: "workflow_step",
            stage: task.currentStageIndex,
            summary: `Workflow gate ${task.currentStageIndex + 1} passed verification by ${step.verifier}. Review before step ${nextIndex + 1} starts.`,
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
    const producerIdx = precedingTaskIndex(steps, task.currentStageIndex)
    if (producerIdx === -1) {
        // No preceding task to retry -> fail (defensive; tool layer rejects gate-first).
        await finishRun(ctx, team, `workflow_failed:${step.verifier}`, "failed")
        return
    }
    const producerStep = steps[producerIdx]
    producerStep.completed = false
    producerStep.output = undefined
    task.currentStageIndex = producerIdx
    const producer = team.members.find(m => m.name === producerStep.member && !m.isMaster)
    if (producer?.sessionId) {
        const feedback =
            `[Gate FAILED — attempt ${step.attempts}/${maxR}]\n`
            + `Rationale: ${v.rationale}\nDiff: ${v.diff}\nFix and resubmit.`
        await dispatchToMember(
            ctx,
            producer,
            `${feedback}\n\n[Your task]\n${producerStep.task ?? ""}`,
            producer.worktreePath ?? ctx.directory,
            team,
        )
    }
    await saveTeamState(team)
}
