/**
 * Member output capture: persists each turn's deliverable to runs/<runId>/<member>.md
 * (accumulative, not overwrite) and truncates for state.json / prompt injection.
 *
 * Capture IO lives independently from the idle state machine.
 */

import crypto from "node:crypto"

import type { Team } from "../../state/store.js"
import { isEnoent } from "../../core/utils.js"
import { extractOutputFromParts, truncateOutput } from "../protocol/output.js"
import { safeReadFile, atomicWrite } from "../../state/locks.js"
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
 * The pure accumulation logic is unit-testable without ctx/team plumbing and
 * has no IO or side effects.
 */
export function appendTurnBlock(prev: string, turnOutput: string, capturedIso: string): string {
    const block = `--- captured ${capturedIso} (${Buffer.byteLength(turnOutput, "utf8")} bytes) ---\n\n${turnOutput}`
    return prev === "" ? block : `${prev}\n\n${block}`
}

/** Indicates whether a member turn produced fresh output or why it did not. */
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
    // Do not capture output for a member whose workflow step has been
    // skipped (e.g. any_success cancelled their branch). Late idle events
    // from such members would pollute task.responses with output from a
    // cancelled branch. Check both workflow step status and member status.
    if (member.status === "errored") return { fresh: false, reason: "stale" }
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
    const full = outputs.join("\n\n")
    const outputHash = crypto.createHash("sha256").update(full).digest("hex")

    // Idempotency: message count alone is insufficient because compaction can
    // preserve the count while replacing the turn contents.
    const sameCapturedTurn = member.lastCapturedTurnCount === member.turnCount
        || (member.lastCapturedTurnCount === undefined
            && member.lastCapturedOutputHash === undefined
            && member.lastCapturedOutput === undefined)
    if (
        member.lastCapturedMsgCount !== undefined
        && messages.length === member.lastCapturedMsgCount
        && sameCapturedTurn
    ) {
        if (member.lastCapturedOutputHash !== undefined) {
            if (outputHash === member.lastCapturedOutputHash) {
                return { fresh: false, reason: "stale" }
            }
        } else if (member.lastCapturedOutput !== undefined) {
            // Legacy snapshots are only trusted when they contain the full turn.
            if (full === member.lastCapturedOutput) {
                return { fresh: false, reason: "stale" }
            }
        } else {
            return { fresh: false, reason: "stale" }
        }
    }
    if (outputs.length === 0) {
        member.lastCapturedMsgCount = messages.length
        member.lastCapturedTurnCount = member.turnCount
        member.lastCapturedOutput = undefined
        member.lastCapturedOutputHash = undefined
        return { fresh: false, reason: "empty" }
    }
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
        && (
            // For peer-quorum, only accept output from dispatched
            // reviewers. If signoffReviewers is unset (not yet dispatched),
            // accept any non-master member (first-idle fallback).
            (task.signoffPolicy === "peer-quorum"
                && (task.signoffReviewers === undefined
                    || task.signoffReviewers.includes(member.name)))
            || (task.signoffPolicy === "decider"
                && member.name === task.signoffDecider)
        )
    const outPath = isReduceTurn
        ? runReduceOutputPath(team.directory, runId)
        : isSignoffTurn
        ? runSignoffOutputPath(team.directory, runId, member.name)
        : runMemberOutputPath(team.directory, runId, member.name)
    const captureKey = `${messages.length}:${member.turnCount}:${outputHash}`
    const captureMarker = `\n\n<!-- octeam-capture ${captureKey} -->`
    const applyCaptureState = (): void => {
        if (isSignoffTurn) {
            if (!task.signoffRawOutputs) task.signoffRawOutputs = {}
            task.signoffRawOutputs[member.name] = captured
        } else {
            task.responses[member.name] = captured
        }
        member.lastCapturedMsgCount = messages.length
        member.lastCapturedTurnCount = member.turnCount
        member.lastCapturedOutput = undefined
        member.lastCapturedOutputHash = outputHash
    }

    // Accumulate: read whatever was previously captured for this target, append
    // the current turn with a separator, and write back atomically.
    // Assert no symlink traversal before readFile. atomicWrite already
    // refuses a leaf symlink via refuseSymlink, but a symlinked intermediate
    // ancestor (e.g. <team>/runs/<runId> redirected) would silently follow
    // without a trustedRoot-bearing check. Reading attacker-controlled content
    // into the accumulator is itself the leak (it gets mixed into the next
    // atomicWrite payload), so guard the read as well as the write.
    // Use an fd-based safe read with a size cap to narrow the TOCTOU window and
    // prevent OOM from a crafted oversized file.
    let prev = ""
    try {
        const prevContent = await safeReadFile(team.directory, outPath, { maxBytes: ACCUMULATED_OUTPUT_CAP })
        if (prevContent !== undefined) prev = prevContent
    } catch (err) {
        if (!isEnoent(err)) throw err
    }
    // The output file carries the capture watermark in the same atomic write.
    // If state persistence was interrupted, restore memory without appending.
    if (prev.endsWith(captureMarker)) {
        applyCaptureState()
        return { fresh: true, output: captured }
    }

    const accumulated = appendTurnBlock(prev, full, new Date().toISOString())
    const captureMarkerBytes = Buffer.byteLength(captureMarker, "utf8")
    const accumulatedBytes = Buffer.byteLength(accumulated, "utf8") + captureMarkerBytes
    const wasTruncated = accumulatedBytes > ACCUMULATED_OUTPUT_CAP
    const truncationMarker = wasTruncated
        ? `\n[...output truncated: original ${accumulatedBytes} bytes]`
        : ""
    const reservedBytes = Buffer.byteLength(truncationMarker, "utf8") + captureMarkerBytes
    const cappedBody = wasTruncated
        ? truncateOutput(accumulated, ACCUMULATED_OUTPUT_CAP - reservedBytes) + truncationMarker
        : accumulated
    const capped = cappedBody + captureMarker

    // Persist to disk FIRST. The in-memory response slot and watermarks are
    // updated only after a successful write.
    await atomicWrite(outPath, capped, team.directory)
    applyCaptureState()
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "captured",
        member: member.name,
        bytes: Buffer.byteLength(captured, "utf8"),
    })
    return { fresh: true, output: captured }
}
