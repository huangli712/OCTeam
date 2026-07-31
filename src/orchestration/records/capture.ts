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
import { assertNoSymlinkTraversal, atomicWrite } from "../../state/locks.js"
import { runMemberOutputPath, runReduceOutputPath, runSignoffOutputPath } from "../../state/paths.js"
import { recordEvent } from "./events.js"
import type { MemberState, SdkMessage } from "../../core/types.js"

/** Hard byte cap on the accumulated per-member output file to prevent unbounded
 * growth from multi-turn members (reducer role, re-prompt cycles). */
const ACCUMULATED_OUTPUT_CAP = 262_144 // 256 KiB
/**
 * Build the accumulated run-member output by appending the current turn's
 * output to whatever was captured previously.
 *
 * Extracted from captureMemberOutput so the accumulation logic is unit-testable
 * independent of ctx/team plumbing. Pure: no IO, no side effects.
 */
export function appendTurnBlock(prev: string, turnOutput: string, capturedIso: string): string {
    const block = `--- captured ${capturedIso} (${Buffer.byteLength(turnOutput, "utf8")} bytes) ---\n\n${turnOutput}`
    return prev === "" ? block : `${prev}\n\n${block}`
}

export type CaptureMemberOutputResult =
    | { fresh: true; output: string }
    | { fresh: false; reason: "stale" | "empty" }

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
 * Returns a fresh result when assistant output was captured, otherwise an
 * explicit stale/empty reason. Empty advances the message-history watermark so
 * a duplicate idle for the same empty turn is classified as stale.
 * The freshness signal gates signoff-stage advancement: a decider's stale
 * pre-signoff idle (re-firing after the signoff dispatch) must not read the
 * stale pre-signoff response and falsely reject the run.
 */
export async function captureMemberOutput(
    team: Team,
    member: MemberState,
    messages: SdkMessage[],
): Promise<CaptureMemberOutputResult> {
    const task = team.activeTask
    if (!task) return { fresh: false, reason: "empty" }
    // #18: do not capture output for a member whose workflow step has been
    // skipped (e.g. any_success cancelled their branch). Late idle events
    // from such members would pollute task.responses with output from a
    // cancelled branch. Check both workflow step status and member status.
    if (member.status === "errored") return { fresh: false, reason: "stale" }
    // Idempotency: a member whose message history hasn't grown since its last
    // classified turn has no new turn to persist. This guards the delegate
    // completion sweep (which re-captures every member, including ones already
    // captured via their own idle path) and stale pre-signoff idle events.
    if (member.lastCapturedMsgCount !== undefined && messages.length === member.lastCapturedMsgCount) {
        // HIGH #3: message count alone is not a reliable turn identity —
        // compaction can produce the same count with different content.
        // Only trust the stale verdict if we ALSO have a stored output
        // snapshot to compare against. If lastCapturedOutput is unset
        // (legacy member), fall back to count-only dedup.
        if (member.lastCapturedOutput !== undefined) {
            // HIGH: compute the FULL turn output for comparison, not just
            // the last assistant message. Pre-fix code compared different
            // strings (last message vs full turn), causing false negatives.
            let turnStart = 0
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i]?.info?.role === "user") { turnStart = i + 1; break }
            }
            const turnOutputs: string[] = []
            for (let i = turnStart; i < messages.length; i++) {
                if (messages[i]?.info?.role === "assistant") {
                    const text = extractOutputFromParts(messages[i]?.parts) || ""
                    if (text) turnOutputs.push(text)
                }
            }
            const fullTurnText = turnOutputs.join("\n\n")
            if (fullTurnText.slice(0, 256) === member.lastCapturedOutput) {
                return { fresh: false, reason: "stale" }
            }
            // Content differs despite same count — fall through to capture.
        } else {
            return { fresh: false, reason: "stale" }
        }
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
    if (outputs.length === 0) {
        member.lastCapturedMsgCount = messages.length
        return { fresh: false, reason: "empty" }
    }
    const full = outputs.join("\n\n")
    const captured = truncateOutput(full)
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
        ? runSignoffOutputPath(team.directory, runId, member.name)
        : runMemberOutputPath(team.directory, runId, member.name)

    // Accumulate: read whatever was previously captured for this target, append
    // the current turn with a separator, and write back atomically.
    // C-2: assert no symlink traversal before readFile. atomicWrite already
    // refuses a leaf symlink via refuseSymlink, but a symlinked intermediate
    // ancestor (e.g. <team>/runs/<runId> redirected) would silently follow
    // without a trustedRoot-bearing check. Reading attacker-controlled content
    // into the accumulator is itself the leak (it gets mixed into the next
    // atomicWrite payload), so guard the read as well as the write.
    await assertNoSymlinkTraversal(team.directory, outPath)
    let prev = ""
    try {
        prev = await readFile(outPath, "utf8")
    } catch (err) {
        if (!isEnoent(err)) throw err
    }
    const accumulated = appendTurnBlock(prev, full, new Date().toISOString())
    const accumulatedBytes = Buffer.byteLength(accumulated, "utf8")
    const wasTruncated = accumulatedBytes > ACCUMULATED_OUTPUT_CAP
    // MEDIUM: include truncation metadata so consumers know the output is partial.
    const capped = wasTruncated
        ? truncateOutput(accumulated, ACCUMULATED_OUTPUT_CAP) + `\n[...output truncated: original ${accumulatedBytes} bytes, kept ${ACCUMULATED_OUTPUT_CAP} bytes]`
        : accumulated

    // Persist to disk FIRST. The in-memory response slot and the capture
    // watermark are updated only after a successful write, so a write failure
    // (which propagates to the caller) leaves no phantom "captured" entry that
    // was never persisted.
    await atomicWrite(outPath, capped, team.directory)
    // For signoff/reduce turns, store the output in a side-channel so the
    // member's work output in task.responses is preserved for the final
    // summary. The mode handler reads from the side-channel instead.
    if (isSignoffTurn) {
        if (!task.signoffRawOutputs) task.signoffRawOutputs = {}
        task.signoffRawOutputs[member.name] = captured
    } else {
        task.responses[member.name] = captured
    }
    // Record the message-history watermark so a re-entry whose history hasn't
    // grown is skipped (idempotency guard at the top).
    member.lastCapturedMsgCount = messages.length
    member.lastCapturedOutput = captured.slice(0, 256)
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "captured",
        member: member.name,
        bytes: Buffer.byteLength(captured, "utf8"),
    })
    return { fresh: true, output: captured }
}
