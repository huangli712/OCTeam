/**
 * Member output capture: persists each turn's deliverable to runs/<runId>/<member>.md
 * (accumulative, not overwrite) and truncates for state.json / prompt injection.
 *
 * Extracted from handlers.ts so the capture IO + workflow step routing lives
 * independently from the idle state machine.
 */

import crypto from "node:crypto"
import { readFile } from "node:fs/promises"

import type { Team } from "../state/store.js"
import { isEnoent } from "../core/utils.js"
import { extractOutputFromParts, truncateOutput } from "./output.js"
import { findActiveWorkflowStepIndexForMember } from "./dag.js"
import { atomicWrite } from "../state/locks.js"
import { runMemberOutputPath, runReduceOutputPath } from "../state/paths.js"
import { recordEvent } from "./events.js"
import type { MemberState, SdkMessage } from "../core/types.js"

/**
 * Build the accumulated run-member output by appending the current turn's
 * output to whatever was captured previously.
 *
 * Extracted from captureMemberOutput so the accumulation logic is unit-testable
 * independent of ctx/team plumbing. Pure: no IO, no side effects.
 */
export function appendTurnBlock(prev: string, turnOutput: string, capturedIso: string): string {
    const block = `--- captured ${capturedIso} (${turnOutput.length} bytes) ---\n\n${turnOutput}`
    return prev === "" ? block : `${prev}\n\n${block}`
}

/**
 * Step 4 of processIdle: capture the member's output from the current turn.
 *
 * Persistence is ACCUMULATIVE across turns (not last-turn overwrite): a member
 * may idle multiple times in one run (reducer role, re-prompt, multi-turn
 * incremental delivery). The file is read, the new turn is appended via
 * appendTurnBlock, and the result is written back atomically.
 *
 * Reduce-stage routing: when the parallel task is in its reduce stage and this
 * member is the reducer, the output is routed to runs/<runId>/reduce.md.
 */
export async function captureMemberOutput(
    team: Team,
    member: MemberState,
    messages: SdkMessage[],
): Promise<void> {
    const task = team.activeTask
    if (!task) return
    // Find the start of the current turn (last user message).
    let turnStart = 0
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.info?.role === "user") {
            turnStart = i + 1
            break
        }
    }
    // Collect all assistant messages in the current turn.
    const outputs: string[] = []
    for (let i = turnStart; i < messages.length; i++) {
        if (messages[i]?.info?.role === "assistant") {
            const text = extractOutputFromParts(messages[i]?.parts)
            if (text) outputs.push(text)
        }
    }
    if (outputs.length === 0) return
    const full = outputs.join("\n\n")
    const captured = truncateOutput(full)
    if (task.type === "workflow" && !task.signoffStage) {
        const activeStepIndex = findActiveWorkflowStepIndexForMember(task, member.name)
        if (activeStepIndex === null) return
        const activeStep = task.steps?.[activeStepIndex]
        if (activeStep?.kind === "task") {
            activeStep.output = activeStep.maxOutputBytes !== undefined
                ? truncateOutput(captured, activeStep.maxOutputBytes)
                : captured
        }
        if (activeStep?.kind === "gate") {
            activeStep.output = captured
        }
    }
    task.responses[member.name] = captured
    const runId = (task.runId ??= crypto.randomUUID())

    // Reduce-stage reducer output is a run-level artifact, not the reducer's own
    // deliverable. Route it to runs/<runId>/reduce.md so it never overwrites the
    // reducer's <member>.md (which holds that member's primary task output).
    const isReduceTurn =
        task.type === "parallel" && !!task.reduceStage && member.name === task.reducerMember
    const outPath = isReduceTurn
        ? runReduceOutputPath(team.directory, runId)
        : runMemberOutputPath(team.directory, runId, member.name)

    // Accumulate: read whatever was previously captured for this target, append
    // the current turn with a separator, and write back atomically.
    let prev = ""
    try {
        prev = await readFile(outPath, "utf8")
    } catch (err) {
        if (!isEnoent(err)) throw err
    }
    const accumulated = appendTurnBlock(prev, full, new Date().toISOString())

    await atomicWrite(outPath, accumulated)
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "captured",
        member: member.name,
        bytes: full.length,
    })
}
