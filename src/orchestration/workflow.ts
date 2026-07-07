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
import type { MemberState, Verdict, WorkflowCondition, WorkflowStep, WorkflowTask } from "../core/types.js"
import { formatWorkflowCondition, matchesWorkflowCondition } from "../core/workflow-conditions.js"
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

type WorkflowJumpTransition = {
    reason: string
    verdict?: Verdict
    rationale?: string
    diff?: string
}

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
 *
 * When the gate carries a `where` threshold condition, the prompt additionally
 * asks the verifier to emit the structured fields that condition evaluates
 * against (score / confidence / issues), so the threshold can actually match
 * in practice.
 */
function buildGateVerifierPrompt(step: WorkflowStep, producerOutput: string, targetLabel: string): string {
    const structuredHint = buildStructuredVerdictHint(step.where)
    return (
        `[Verification gate] Verify ${targetLabel} output below against the criteria.\n`
        + `Criteria: ${step.criteria ?? ""}\n\n`
        + `Producer output:\n${producerOutput}\n\n`
        + (structuredHint ? `${structuredHint}\n\n` : "")
        + `Emit EXACTLY one:\n`
        + `<verdict>${buildVerdictSchemaExample(step.where)}</verdict>\n`
        + `PASS = the output meets the criteria. FAIL = it does not (give rationale + diff). `
        + `INVALID = you cannot evaluate the output or criteria; this is not a producer failure.`
    )
}

/**
 * Describe the structured fields a `where` condition needs, and emit a matching
 * `<verdict>` JSON example. A gate without `where` requests only the base
 * result/rationale/diff triple, keeping prompts minimal for gates that do not
 * gate on thresholds.
 */
function buildStructuredVerdictHint(where: WorkflowCondition | undefined): string {
    if (where === undefined) return ""
    const fields: string[] = []
    switch (where.kind) {
        case "score_gte":
        case "score_lt":
            fields.push("score: a numeric quality score on a 0-10 scale")
            fields.push("confidence: a 0-1 confidence in your verdict")
            break
        case "confidence_gte":
            fields.push("confidence: a 0-1 confidence in your verdict")
            break
        case "has_issue_severity":
            fields.push("issues: an array of { severity: low|medium|high|critical, message?: string } for every issue you found, ordered by severity")
            break
        default:
            return assertNeverWorkflowCondition(where)
    }
    return `This gate gates a downstream step on a threshold condition (${formatWorkflowCondition(where)}). Also emit structured fields so the condition can be evaluated:\n- ${fields.join("\n- ")}`
}

function buildVerdictSchemaExample(where: WorkflowCondition | undefined): string {
    const base = `"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."`
    if (where === undefined) return `{${base}}`
    const extras: string[] = []
    switch (where.kind) {
        case "score_gte":
        case "score_lt":
            extras.push(`"score":8`)
            extras.push(`"confidence":0.9`)
            break
        case "confidence_gte":
            extras.push(`"confidence":0.9`)
            break
        case "has_issue_severity":
            extras.push(`"issues":[{"severity":"high","message":"..."}]`)
            break
        default:
            return assertNeverWorkflowCondition(where)
    }
    return `{${base},${extras.join(",")}}`
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
    const targets = gateTargetIndices(steps, gateIndex)
    return targets[0] ?? -1
}

function gateTargetIndices(steps: WorkflowStep[], gateIndex: number): number[] {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return []
    if (gate.targetStepIndices !== undefined && gate.targetStepIndices.length > 0) {
        return [...gate.targetStepIndices].sort((a, b) => a - b)
    }
    if (gate.targetStepIndex !== undefined) return [gate.targetStepIndex]
    const nearest = precedingTaskIndex(steps, gateIndex)
    return nearest < 0 ? [] : [nearest]
}

function stepIndicesLabel(indices: number[]): string {
    if (indices.length === 0) return "nearest task"
    const labels = indices.map(index => String(index + 1))
    const first = labels[0]
    if (first === undefined) return "nearest task"
    return labels.length === 1 ? `step ${first}` : `steps ${labels.join(", ")}`
}

function workflowTargetLabel(indices: number[]): string {
    return `workflow ${stepIndicesLabel(indices)}`
}

function buildGateProducerOutput(steps: WorkflowStep[], targetIndices: number[]): string {
    const blocks: string[] = []
    for (const targetIndex of targetIndices) {
        const producerStep = steps[targetIndex]
        if (!producerStep || producerStep.kind !== "task") continue
        blocks.push(`[Step ${targetIndex + 1} output from ${producerStep.member ?? "?"}]\n${truncateOutput(producerStep.output ?? "")}`)
    }
    return blocks.join("\n\n")
}

function buildJumpContext(transition: WorkflowJumpTransition): string {
    const lines = [`[Workflow jump: ${transition.reason}]`]
    if (transition.verdict !== undefined) lines.push(`Verdict: ${transition.verdict}`)
    if (transition.rationale !== undefined) lines.push(`Rationale: ${transition.rationale}`)
    if (transition.diff !== undefined) lines.push(`Diff: ${transition.diff}`)
    return lines.join("\n")
}

function gatedGotoIndex(step: WorkflowStep, gotoIndex: number | undefined): number {
    if (gotoIndex === undefined || gotoIndex < 0) return -1
    if (step.where === undefined) return gotoIndex
    return matchesWorkflowCondition(step.where, {
        score: step.score,
        confidence: step.confidence,
        issues: step.issues,
    }) ? gotoIndex : -1
}

function whereReason(step: WorkflowStep, fallback: string): string {
    return step.where === undefined ? fallback : `when:${step.where.kind}`
}

/** Local exhaustive guard for WorkflowCondition, mirroring workflow-conditions.ts. */
function assertNeverWorkflowCondition(value: never): never {
    throw new Error(`unhandled workflow condition: ${String(value)}`)
}

function hasLiveSession(member: MemberState | undefined): member is MemberState & { sessionId: string } {
    return member?.sessionId !== undefined && member.status !== "errored"
}

function describeStep(step: WorkflowStep | undefined, index: number): string {
    if (!step) return `step ${index + 1}`
    const idTag = step.id ? ` (${step.id})` : ""
    if (step.kind === "task") return `step ${index + 1}${idTag} (task) by ${step.member ?? "?"}`
    const target = step.targetStepIndices !== undefined && step.targetStepIndices.length > 0
        ? stepIndicesLabel(step.targetStepIndices)
        : step.targetStepIndex === undefined ? "nearest task" : `step ${step.targetStepIndex + 1}`
    return `step ${index + 1}${idTag} (gate) by ${step.verifier ?? "?"}, verifying ${target}`
}

/** Dispatch a task step's actor with upstream context prefixed. */
async function dispatchTaskStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
    contextPrefix?: string,
): Promise<boolean> {
    const step = task.steps?.[index]
    if (!step || step.kind !== "task" || !step.member || !step.task) return false
    const member = team.members.find(m => m.name === step.member && !m.isMaster)
    if (!hasLiveSession(member)) return false
    // Consume the per-step approval_before grant now that dispatch is actually
    // happening (re-entry via retry/goto re-requests approval because the reset
    // loops clear approvalBeforeGranted).
    step.approvalBeforeGranted = undefined
    const upstream = buildWorkflowUpstream(task.steps ?? [], index)
    const text = upstream ? `${upstream}\n\n[Your task]\n${step.task}` : step.task
    await dispatchToMember(ctx, member, contextPrefix ? `${contextPrefix}\n\n${text}` : text, member.worktreePath ?? ctx.directory, team)
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
    const targetIndices = gateTargetIndices(task.steps ?? [], index)
    if (targetIndices.length === 0) return false
    step.approvalBeforeGranted = undefined
    const producerOutput = buildGateProducerOutput(task.steps ?? [], targetIndices)
    await dispatchToMember(
        ctx,
        verifier,
        buildGateVerifierPrompt(step, producerOutput, workflowTargetLabel(targetIndices)),
        verifier.worktreePath ?? ctx.directory,
        team,
    )
    return true
}

/**
 * Per-step approval_before: if the step declares it and the current instance
 * has not yet been granted, force an HITL pause (bypassing the task-global
 * humanApproval flag). Sets approvalBeforeGranted so the post-approve
 * advanceWorkflowStep dispatches instead of re-pausing. Returns true when the
 * step is paused (caller must NOT dispatch).
 */
export async function maybePauseBeforeWorkflowStep(
    ctx: PluginContext,
    team: Team,
    index: number,
): Promise<boolean> {
    const task = team.activeTask
    if (!task || task.type !== "workflow") return false
    const step = task.steps?.[index]
    if (!step || !step.approvalBefore || step.approvalBeforeGranted) return false
    step.approvalBeforeGranted = true
    const paused = await forceApprovalRequest(ctx, team, {
        kind: "workflow_step",
        stage: index,
        summary: `Before ${describeStep(step, index)}. Approve to dispatch this step; reject to fail the run as workflow_human_rejected.`,
    })
    if (paused) {
        await saveTeamState(team)
        return true
    }
    // No escalation handler available -> clear the grant and fall through to dispatch.
    step.approvalBeforeGranted = undefined
    return false
}

/**
 * Per-step approval_after: if the just-completed step declares it, force an
 * HITL pause before the workflow advances. team_approve resumes via
 * advanceWorkflowStep. Returns true when paused (caller must NOT advance).
 */
async function maybePauseAfterWorkflowStep(
    ctx: PluginContext,
    team: Team,
    index: number,
): Promise<boolean> {
    const task = team.activeTask
    if (!task || task.type !== "workflow") return false
    const step = task.steps?.[index]
    if (!step || !step.approvalAfter) return false
    const paused = await forceApprovalRequest(ctx, team, {
        kind: "workflow_step",
        stage: index,
        summary: `After ${describeStep(step, index)}. Approve to continue; reject to fail the run as workflow_human_rejected.`,
    })
    if (paused) {
        await saveTeamState(team)
        return true
    }
    return false
}

/**
 * Execute a verdict-driven conditional jump to `targetIndex`. Bounds the state
 * machine via the per-gate max_jumps cap (default 3). Forward jumps mark the
 * intermediate steps as skipped (completed + skipped); backward jumps reset
 * steps[targetIndex..gateIndex] (mirroring FAIL-retry semantics) so the path
 * re-runs. The triggering gate's attempts/invalidAttempts/jumpCount are NEVER
 * reset by the range reset, so retry + jump bounds compose safely.
 *
 * Returns true when the jump dispatched (caller must not also advance), false
 * when the jump cap was exceeded and the run terminated.
 */
async function gotoWorkflowStep(
    ctx: PluginContext,
    team: Team,
    gateIndex: number,
    targetIndex: number,
    transition: WorkflowJumpTransition,
): Promise<boolean> {
    const task = team.activeTask
    if (!task || task.type !== "workflow") return false
    const steps = task.steps ?? []
    const gate = steps[gateIndex]
    const target = steps[targetIndex]
    if (!gate || gate.kind !== "gate" || !target) return false

    gate.jumpCount = (gate.jumpCount ?? 0) + 1
    const maxJ = gate.maxJumps ?? 3
    if (gate.jumpCount > maxJ) {
        await finishRun(ctx, team, `workflow_failed:jump_limit:${gate.verifier ?? "unknown"}`, "failed")
        return false
    }

    if (targetIndex > gateIndex) {
        // Forward jump: mark intermediate steps as skipped.
        for (let i = gateIndex + 1; i < targetIndex; i++) {
            const s = steps[i]
            if (!s) continue
            if (!s.completed) {
                s.completed = true
                s.skipped = true
            }
        }
    } else if (targetIndex < gateIndex) {
        // Backward jump: reset steps[target..gate] so the path re-runs.
        for (let i = targetIndex; i <= gateIndex; i++) {
            const s = steps[i]
            if (!s) continue
            s.completed = false
            s.skipped = false
            s.approvalBeforeGranted = undefined
            if (s.kind === "task") s.output = undefined
            if (s.kind === "gate") {
                s.verdict = undefined
                if (i !== gateIndex) {
                    s.attempts = 0
                    s.invalidAttempts = 0
                }
            }
        }
    }
    // Mark the triggering gate complete so find-next-incomplete does not loop
    // back to it after a forward jump, and so approval resume advances past it.
    gate.completed = true

    recordEvent(team, {
        timestamp: Date.now(),
        kind: "stage_advanced",
        stage: targetIndex,
        detail: `workflow jump: step ${gateIndex + 1} -> step ${targetIndex + 1} (${transition.reason}${transition.verdict ? ` ${transition.verdict}` : ""}); jump ${gate.jumpCount}/${maxJ}`,
    })

    task.currentStageIndex = targetIndex
    if (await maybePauseBeforeWorkflowStep(ctx, team, targetIndex)) return true
    const dispatched = target.kind === "task"
        ? await dispatchTaskStep(ctx, team, task, targetIndex, buildJumpContext(transition))
        : await dispatchGateStep(ctx, team, task, targetIndex)
    if (!dispatched) {
        const actor = target.kind === "task" ? target.member : target.verifier
        await finishRun(ctx, team, `workflow_failed:no_session:${actor ?? "unknown"}`, "failed")
        return false
    }
    await saveTeamState(team)
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
    if (await maybePauseBeforeWorkflowStep(ctx, team, nextIndex)) return
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
        const raw = task.responses[member.name] ?? ""
        // Per-step output cap on the captured snapshot only — the full output
        // is still persisted to runs/<runId>/<member>.md by captureMemberOutput.
        step.output = step.maxOutputBytes !== undefined ? truncateOutput(raw, step.maxOutputBytes) : raw
        step.completed = true
        if (await maybePauseAfterWorkflowStep(ctx, team, task.currentStageIndex)) return
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
    step.score = v.score
    step.confidence = v.confidence
    step.issues = v.issues

    if (v.verdict === "INVALID") {
        await handleInvalidVerdict(ctx, team, step, "INVALID", v.rationale, v.diff)
        return
    }

    if (v.verdict === "PASS") {
        step.completed = true
        // approval_after on a gate is validator-guaranteed incompatible with
        // on_*_goto, so pausing here cannot be bypassed by a goto jump.
        if (await maybePauseAfterWorkflowStep(ctx, team, task.currentStageIndex)) return
        const gotoIdx = gatedGotoIndex(step, step.onPassGoto)
        const nextIndex = gotoIdx >= 0 ? gotoIdx : steps.findIndex(s => !s.completed)
        if (nextIndex !== -1 && await maybeRequestApproval(ctx, team, {
            kind: "workflow_step",
            stage: task.currentStageIndex,
            summary: `Completed ${describeStep(step, task.currentStageIndex)} with PASS from ${step.verifier}. Rationale: ${v.rationale}. Next: ${describeStep(steps[nextIndex], nextIndex)}. Review before continuing.`,
        })) {
            return
        }
        if (gotoIdx >= 0) {
            await gotoWorkflowStep(ctx, team, task.currentStageIndex, gotoIdx, { reason: whereReason(step, "on_pass"), verdict: "PASS", rationale: v.rationale, diff: v.diff })
            return
        }
        await advanceWorkflowStep(ctx, team)
        return
    }

    // v.verdict === "FAIL"
    const onFail = step.onFail ?? "fail"
    if (onFail === "fail") {
        const failGoto = gatedGotoIndex(step, step.onFailGoto)
        if (failGoto >= 0) {
            await gotoWorkflowStep(ctx, team, task.currentStageIndex, failGoto, { reason: whereReason(step, "on_fail"), verdict: "FAIL", rationale: v.rationale, diff: v.diff })
            return
        }
        await finishRun(ctx, team, `workflow_failed:${step.verifier}`, "failed")
        return
    }
    // onFail === "retry": bounded retry of the preceding task.
    step.attempts = (step.attempts ?? 0) + 1
    const maxR = step.maxRetries ?? 0
    if (step.attempts > maxR) {
        const failGoto = gatedGotoIndex(step, step.onFailGoto)
        if (failGoto >= 0) {
            await gotoWorkflowStep(ctx, team, task.currentStageIndex, failGoto, { reason: whereReason(step, "on_fail_retry_exhausted"), verdict: "FAIL", rationale: v.rationale, diff: v.diff })
            return
        }
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
        retryStep.approvalBeforeGranted = undefined
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
    // Honor producer approval_before on retry re-dispatch (parity with goto
    // backward jump and the initial advance path). Without this, a FAIL retry
    // silently bypassed the leader gate that the step declared.
    if (await maybePauseBeforeWorkflowStep(ctx, team, producerIdx)) return
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
        detail: `workflow step ${gateIndex + 1} attempt ${step.attempts}/${maxR}; retry target ${stepIndicesLabel(gateTargetIndices(steps, gateIndex))}; retry anchor step ${producerIdx + 1}; verifier ${step.verifier}; diff: ${v.diff}`,
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
            const invGoto = step.onInvalidGoto ?? -1
            if (invGoto >= 0) {
                await gotoWorkflowStep(ctx, team, gateIndex, invGoto, { reason: "on_invalid_retry_exhausted", verdict: reason === "INVALID" ? "INVALID" : undefined, rationale, diff })
                return
            }
            await finishRun(ctx, team, `workflow_invalid:${reason}:${step.verifier}`, "failed")
            return
        }
        const verifier = team.members.find(m => m.name === step.verifier && !m.isMaster)
        if (!hasLiveSession(verifier)) {
            await finishRun(ctx, team, `workflow_failed:no_session:${step.verifier ?? "unknown"}`, "failed")
            return
        }
        // Honor gate approval_before on invalid-verifier retry re-dispatch
        // (parity with FAIL retry and the initial advance path).
        if (await maybePauseBeforeWorkflowStep(ctx, team, gateIndex)) return
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
        const targetIndices = gateTargetIndices(task.steps ?? [], gateIndex)
        const producerOutput = buildGateProducerOutput(task.steps ?? [], targetIndices)
        await dispatchToMember(
            ctx,
            verifier,
            `${nudge}\n\n${buildGateVerifierPrompt(step, producerOutput, workflowTargetLabel(targetIndices))}`,
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

    // on_invalid_goto (incompatible with escalate per validator) jumps instead
    // of terminating at the INVALID terminal point.
    if (policy !== "escalate") {
        const invGoto = step.onInvalidGoto ?? -1
        if (invGoto >= 0) {
            await gotoWorkflowStep(ctx, team, gateIndex, invGoto, { reason: `on_invalid:${reason}`, verdict: reason === "INVALID" ? "INVALID" : undefined, rationale, diff })
            return
        }
    }
    await finishRun(ctx, team, `workflow_invalid:${reason}:${step.verifier}`, "failed")
}
