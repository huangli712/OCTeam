/**
 * Member output capture: persists each turn's deliverable to runs/<runId>/<member>.md
 * (accumulative, not overwrite) and truncates for state.json / prompt injection.
 *
 * Extracted from handlers.ts so capture IO lives independently from the idle
 * state machine.
 */

import crypto from "node:crypto"
import { readFile } from "node:fs/promises"

import type { Team } from "../../state/store.js"
import { isEnoent } from "../../core/utils.js"
import { extractOutputFromParts, truncateOutput } from "../protocol/output.js"
import { atomicWrite } from "../../state/locks.js"
import { runMemberOutputPath, runReduceOutputPath, runSignoffOutputPath } from "../../state/paths.js"
import { recordEvent } from "./events.js"
import type { MemberState, SdkMessage } from "../../core/types.js"

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
 *
 * Returns true when new assistant output was captured this turn, false when no
 * task is active or the current turn produced no extractable assistant content
 * (a stale/redundant idle whose dispatch landed but whose turn hasn't replied).
 * The freshness signal gates signoff-stage advancement: a decider's stale
 * pre-signoff idle (re-firing after the signoff dispatch) must not read the
 * stale pre-signoff response and falsely reject the run.
 */
export async function captureMemberOutput(
    team: Team,
    member: MemberState,
    messages: SdkMessage[],
): Promise<boolean> {
    const task = team.activeTask
    if (!task) return false
    // Idempotency: a member whose message history hasn't grown since its last
    // successful capture has no new turn to persist. This guards the delegate
    // completion sweep (which re-captures every member, including ones already
    // captured via their own idle path) and stale pre-signoff idle events.
    if (member.lastCapturedMsgCount !== undefined && messages.length === member.lastCapturedMsgCount) {
        return false
    }
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
    if (outputs.length === 0) return false
    const full = outputs.join("\n\n")
    const captured = truncateOutput(full)
    task.responses[member.name] = captured
    const runId = (task.runId ??= crypto.randomUUID())

    // Reduce-stage reducer output is a run-level artifact, not the reducer's own
    // deliverable. Route it to runs/<runId>/reduce.md so it never overwrites the
    // reducer's <member>.md (which holds that member's primary task output).
    const isReduceTurn =
        task.type === "parallel" && !!task.reduceStage && member.name === task.reducerMember
    // Signoff-stage reviewer output is a run-level artifact too: route it to
    // runs/<runId>/signoff.md so a reviewer's verdict never overwrites (nor
    // mixes into) the reviewer's own <member>.md primary deliverable. Mirrors
    // the reduce-stage routing above.
    //   - decider policy: only the configured decider's verdict turn is routed;
    //     a non-decoder idling during signoffStage still writes <member>.md.
    //   - peer-quorum policy: every non-master member is dispatched as a
    //     reviewer, so any non-master idle during signoffStage is a verdict turn.
    const isSignoffTurn =
        !!task.signoffStage
        && !member.isMaster
        && (task.signoffPolicy === "peer-quorum"
            || member.name === task.signoffDecider)
    const outPath = isReduceTurn
        ? runReduceOutputPath(team.directory, runId)
        : isSignoffTurn
        ? runSignoffOutputPath(team.directory, runId)
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
    // Record the message-history watermark so a re-entry whose history hasn't
    // grown is skipped (idempotency guard at the top).
    member.lastCapturedMsgCount = messages.length
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "captured",
        member: member.name,
        bytes: full.length,
    })
    return true
}
