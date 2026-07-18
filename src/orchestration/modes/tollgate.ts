/**
 * Tollgate handler and its three-phase verification gate (produce → verify →
 * escalate-on-INVALID). All gate-flow helpers live here together because they
 * are tightly coupled: startVerification is shared by the produce→verify and
 * escalate→verify transitions; escalateInvalid is shared by the verifier-
 * unavailable path and the INVALID-verdict path; buildVerifierPrompt is private
 * to startVerification.
 *
 * STATE MACHINE (per gate, see handleTollgateIdle for full detail):
 *   produce → verify → [PASS→next_gate | FAIL→retry_produce | INVALID→escalate]
 *   escalate → re-verify (handler reports verifier fixed)
 *   - All gates pass → check signoff → deliver (idle: tollgate_complete)
 *   - Gate FAIL retries exhausted → deliver (failed: tollgate_failed:<producer>)
 *   - INVALID cycles exhausted → deliver (failed: tollgate_invalid:exhausted)
 *   - INVALID without escalateTo → deliver (failed: tollgate_invalid:<producer>:<reason>)
 */

import type { PluginContext } from "../../core/context.js"
import { type Team, saveTeamState } from "../../state/store.js"
import type { ActiveTask, GatedStage, MemberState } from "../../core/types.js"
import { buildUpstreamContext } from "./stages.js"
import { dispatchToMember } from "../control/dispatch.js"
import { finishRun } from "../control/completion.js"
import { recordEvent } from "../records/events.js"
import { truncateOutput } from "../protocol/output.js"
import { parseVerdict } from "../protocol/decisions.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { maybeRequestApproval } from "../control/approval.js"

/**
 * Build the verifier's dispatch prompt: the producer's output, the criteria,
 * an optional golden reference (Compare-style numerical verdict), and the
 * exact <verdict> block the verifier must emit. PASS = correct within
 * tolerance, FAIL = wrong (with diff magnitude/location), INVALID = the
 * verifier cannot evaluate (broken reference/build/alignment) — NOT the
 * producer's fault.
 */
function buildVerifierPrompt(task: ActiveTask, stage: GatedStage): string {
    const output = truncateOutput(task.responses[stage.member] ?? "")
    const ref = stage.reference ? `\n\nGolden reference: ${stage.reference}` : ""
    return (
        `[Verification gate]\n` 
        + `Verify the producer's output below against the criteria.\n`
        + `Criteria: ${stage.criteria}${ref}\n\n`
        + `Producer output:\n${output}\n\n`
        + `If a reference is given, ALIGN by declared dimensions (grid points / time steps / `
        + `quantities), compute per-point differences, and judge within tolerance.\n`
        + `Emit EXACTLY one:\n`
        + `<verdict>{"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."}</verdict>\n`
        + `PASS = correct within tolerance. FAIL = wrong (give diff magnitude + location). `
        + `INVALID = you CANNOT evaluate (broken reference/build/alignment) — NOT the producer's fault.`
    )
}

/**
 * Start a gate's verification phase: set phase = verify and dispatch the
 * verifier with buildVerifierPrompt. Shared by the produce->verify and
 * escalate->verify transitions so both set the same phase. A verifier with no
 * live session is an INVALID condition (escalated, not the producer's fault).
 */
export async function startVerification(
    ctx: PluginContext,
    team: Team,
    stage: GatedStage,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "tollgate") return
    const verifier = team.members.find(m => m.name === stage.verifier && !m.isMaster)
    if (!verifier?.sessionId) {
        // Verifier unavailable -> INVALID escalation (does not penalize producer).
        await escalateInvalid(ctx, team, stage, "verifier_unavailable")
        return
    }
    task.tollgatePhase = "verify"
    await dispatchToMember(
        ctx,
        verifier,
        buildVerifierPrompt(task, stage),
        verifier.worktreePath ?? ctx.directory,
        team,
    )
    await saveTeamState(team)
}

/**
 * Advance to a gated stage's produce phase: dispatch the producer with the
 * upstream (completed-gate) output prefixed via buildUpstreamContext. Used for
 * the initial stage-0 dispatch and on PASS-advance to the next gate.
 */
export async function advanceToGatedStage(
    ctx: PluginContext,
    team: Team,
    stage: GatedStage,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "tollgate") return
    const producer = team.members.find(m => m.name === stage.member)
    if (!producer?.sessionId) return
    const upstream = buildUpstreamContext(
        task.gatedStages ?? [], task.responses, task.currentStageIndex)
    const text = upstream ? `${upstream}\n\n[Your task]\n${stage.task}` : stage.task
    await dispatchToMember(ctx, producer, text, producer.worktreePath ?? ctx.directory, team)
}

/** Advance to the next gated stage after a PASS verdict, or deliver if all stages are complete. */
export async function advanceTollgateAfterPass(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "tollgate" || !task.gatedStages) return
    const next = task.gatedStages.findIndex(s => !s.completed)
    if (next === -1) {
        if (await maybeTriggerSignoff(ctx, team)) return
        await finishRun(ctx, team, "tollgate_complete", "idle")
        return
    }
    task.currentStageIndex = next
    task.tollgatePhase = "produce"
    const nextStage = task.gatedStages[next]
    if (!nextStage) return
    await advanceToGatedStage(ctx, team, nextStage)
    await saveTeamState(team)
}

/**
 * Isolate a stage on INVALID and escalate the verifier side (not the producer).
 * If an escalation handler is configured and live, enter the escalate phase and
 * dispatch it to fix the verifier/reference; its idle re-enters verify via the
 * escalate branch of handleTollgateIdle (getExpectedMember returns escalateTo
 * in that phase, so it is not treated as stray). With no handler, escalate to
 * the leader for a human decision (the producer's output stays unimpugned).
 */
async function escalateInvalid(
    ctx: PluginContext,
    team: Team,
    stage: GatedStage,
    reason: string,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "tollgate") return
    stage.verdict = "INVALID"
    stage.invalidAttempts++
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "verdict",
        member: stage.verifier,
        stage: task.currentStageIndex,
        detail: `INVALID:${reason}`,
    })
    // Cap INVALID/escalate ping-pong: a persistently-INVALID verifier with an
    // escalateTo handler would otherwise loop verify→escalate→verify until the
    // wall-clock/turn budget is spent. Fail with a clear reason past the cap.
    const maxI = task.maxInvalidCycles ?? 3
    if (stage.invalidAttempts > maxI) {
        await finishRun(ctx, team, `tollgate_invalid:exhausted:${stage.member}`, "failed")
        return
    }
    const handler = team.members.find(m => m.name === task.escalateTo && !m.isMaster)
    if (handler?.sessionId) {
        task.tollgatePhase = "escalate"
        await dispatchToMember(
            ctx,
            handler,
            `[Gate INVALID] The verifier could not render a verdict for stage "${stage.member}". `
            + `Reason: ${reason}. Fix the verifier/reference/build, then report done. `
            + `The producer's output is NOT in question.`,
            handler.worktreePath ?? ctx.directory,
            team,
        )
        await saveTeamState(team)
        return
    }
    // No escalation handler -> hand to the leader (does not penalize producer).
    await finishRun(ctx, team, `tollgate_invalid:${stage.member}:${reason}`, "failed")
}

/**
 * tollgate core state machine (three phases per gate):
 *   produce  — the producer's idle transitions to the verify phase.
 *   verify   — the verifier's idle is parsed for a <verdict>:
 *                PASS    -> mark the gate complete; advance to the next gate or deliver.
 *                FAIL    -> attempts++; if within maxGateRetries, return the producer with a
 *                           diff diagnostic; else fail the run.
 *                INVALID -> isolate + escalate the verifier side.
 *   escalate — the escalation handler's idle re-enters verify (it reports the
 *              verifier fixed). getExpectedMember returns escalateTo here so the
 *              handler's idle is not treated as stray (the original deadlock).
 * parse-failure is treated as INVALID (the verifier could not evaluate).
 */
export async function handleTollgateIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "tollgate" || !task.gatedStages) return
    const stage = task.gatedStages[task.currentStageIndex]
    if (!stage) return
    const phase = task.tollgatePhase ?? "produce"

    // produce phase: producer done -> HITL pause before verifier dispatch.
    if (phase === "produce") {
        if (member.name !== stage.member) return            // stray idle
        if (await maybeRequestApproval(ctx, team, {
            kind: "tollgate_gate",
            stage: task.currentStageIndex,
            summary: `Tollgate stage ${task.currentStageIndex} producer output ready. Review before verification dispatch.`,
        })) {
            return
        }
        await startVerification(ctx, team, stage)
        return
    }

    // escalate phase: handler fixed the verifier/reference -> re-verify.
    if (phase === "escalate") {
        if (member.name !== task.escalateTo) return          // stray idle
        stage.verdict = undefined                            // clear stale verdict, re-evaluate
        await startVerification(ctx, team, stage)
        return
    }

    // verify phase: verifier done -> parse the verdict.
    if (member.name !== stage.verifier) return               // stray idle
    const v = parseVerdict(task.responses[stage.verifier] ?? "")
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "verdict",
        member: stage.verifier,
        stage: task.currentStageIndex,
        detail: v.verdict ?? "parse_fail",
    })

    if (v.parseFailed) {
        // Verifier output unparseable -> treat as INVALID (cannot evaluate).
        await escalateInvalid(ctx, team, stage, "verdict_parse_failure")
        return
    }
    stage.verdict = v.verdict

    if (v.verdict === "PASS") {
        stage.completed = true
        const next = task.gatedStages.findIndex(s => !s.completed)
        if (next === -1) {
            // All gates passed -> maybe signoff, then deliver.
            if (await maybeTriggerSignoff(ctx, team)) return
            await finishRun(ctx, team, "tollgate_complete", "idle")
            return
        }
        if (await maybeRequestApproval(ctx, team, {
            kind: "tollgate_gate",
            stage: task.currentStageIndex,
            summary: `Tollgate stage ${task.currentStageIndex} passed verification. Review before stage ${next} starts.`,
        })) {
            return
        }
        await advanceTollgateAfterPass(ctx, team)
        return
    }

    if (v.verdict === "FAIL") {
        stage.attempts++
        const maxR = task.maxGateRetries ?? 0                // distinct from provider-retry maxRetries
        if (stage.attempts > maxR) {
            // Retries exhausted -> fail the run.
            await finishRun(ctx, team, `tollgate_failed:${stage.member}`, "failed")
            return
        }
        // Within retries -> return to produce with the diff diagnostic.
        task.tollgatePhase = "produce"
        const producer = team.members.find(m => m.name === stage.member)
        if (producer?.sessionId) {
            const feedback =
                `[Gate FAILED — attempt ${stage.attempts}/${maxR}]\n`
                + `Rationale: ${v.rationale}\nDiff: ${v.diff}\nFix and resubmit.`
            await dispatchToMember(
                ctx,
                producer,
                `${feedback}\n\n[Your task]\n${stage.task}`,
                producer.worktreePath ?? ctx.directory,
                team,
            )
        }
        await saveTeamState(team)
        return
    }

    // v.verdict === "INVALID" -> isolate + escalate the verifier side.
    await escalateInvalid(ctx, team, stage, v.rationale)
}
