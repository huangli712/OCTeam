/**
 * Shared core helpers: text/token utilities, polling primitives, the role-setup
 * prompt builder, and pure interaction-gate predicates. No state-layer
 * dependencies — the session index + member resolution live in state/resolve.ts.
 */

import type { Message, Part, TextPart } from "@opencode-ai/sdk"
import type { MemberSpec } from "./types.js"
import { rolePreset } from "./role.js"

/**
 * Master-only activation gate (pure predicate). Members always pass — a member's
 * team is necessarily active while it is busy (busy ⟹ active), so the gate would
 * never legitimately block a member. A master may only interact with its active
 * team, so an inactive target (activatedAt === undefined) is forbidden.
 */
export function isInteractionForbidden(
    callerIsMaster: boolean,
    targetTeamActivatedAt: number | undefined,
): boolean {
    if (!callerIsMaster) return false
    return targetTeamActivatedAt === undefined
}

/**
 * Actionable error string for a master interacting with an inactive team, or
 * null when the team is active. Centralizes the message used by master-only
 * mutating tools (workflow / team_fix_member).
 */
export function activationError(
    teamName: string,
    activatedAt: number | undefined,
): string | null {
    return activatedAt === undefined
        ? `Error: team "${teamName}" is not the active team. Call team_activate(team_id="${teamName}") first.`
        : null
}

// --- text / token helpers ---

/**
 * Extract concatenated text from message parts (filters type === "text").
 * Skips synthetic parts (injected role prompts / mailbox injections) so they
 * are never mistaken for member-produced text.
 *
 * @internal Exported only for use by tests/output_capture.test.ts (baseline
 * regression for the text-only extraction contract). Production callers use
 * `extractOutputFromParts` (which composes this with output-shape handling).
 */
export function extractTextFromParts(parts: unknown): string {
    if (!Array.isArray(parts)) return ""
    return (parts as Part[])
        .filter((p): p is TextPart => !!p && p.type === "text" && typeof p.text === "string")
        .filter(p => !p.synthetic)
        .map(p => p.text)
        .join("\n")
}

/** Tools whose invocations represent member work product (code, commands).
 * Excludes team-* coordination tools (send_message, task_*, workflow tools). */
const WORK_TOOLS = new Set([
    "write", "edit", "bash",
    "aft_write", "aft_edit", "aft_bash", "aft_apply_patch",
])

/**
 * Extract member output from an assistant message's parts: text + work-tool
 * invocations (write/edit content, bash commands, patches). Excludes team-*
 * tools (coordination, not deliverables) so that summaries reflect actual
 * work product rather than just conversation text.
 */
export function extractOutputFromParts(parts: unknown): string {
    if (!Array.isArray(parts)) return ""
    const segments: string[] = []
    for (const p of parts as Part[]) {
        if (!p) continue
        if (p.type === "text" && typeof p.text === "string") {
            // Skip synthetic parts (injected role prompts / mailbox injections):
            // they are not member-produced deliverables.
            if (p.synthetic) continue
            if (p.text.trim()) segments.push(p.text)
        } else if (p.type === "tool" && WORK_TOOLS.has(p.tool)) {
            const input = (p.state?.input ?? {}) as Record<string, unknown>
            if (typeof input.content === "string" && input.content.trim()) {
                const fp = typeof input.filePath === "string" ? input.filePath : ""
                segments.push(fp ? `[File: ${fp}]\n${input.content}` : input.content)
            } else if (typeof input.command === "string" && input.command.trim()) {
                segments.push(`$ ${input.command}`)
            } else if (typeof input.patchText === "string" && input.patchText.trim()) {
                segments.push(`[Patch]\n${input.patchText}`)
            }
        }
    }
    return segments.join("\n\n")
}

/**
 * Truncate output to maxBytes (default 8KB) of UTF-8 to prevent context-window
 * blowups. Counts and cuts on UTF-8 byte length (not UTF-16 code units), and
 * backs each cut up to a complete-character boundary so a multibyte sequence is
 * never split (CJK / emoji safe).
 *
 * Preserves BOTH the head and the tail: when truncation is required, the first
 * and last ~maxBytes/2 bytes are kept with an elision marker between them. This
 * is essential because the project's prompt convention places deliverable
 * markers (e.g. `<!-- SORT_OK: true -->`) at the END of member output ("Your
 * output MUST end with..."). A head-only cut silently drops those end-markers
 * for any turn exceeding maxBytes, which breaks every reduce / select / merge /
 * rubric summary path — the reducer receives the truncated head and honestly
 * reports the member's result as "unavailable / truncated before final markers"
 * even though the full output (with markers) was persisted losslessly to the
 * run's <member>.md file. Head+tail at the same byte budget is strictly more
 * informative than head-only, so no caller regresses.
 */
export function truncateOutput(text: string, maxBytes: number = 8192): string {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
    const buf = Buffer.from(text, "utf8")
    // Reserve a fixed overhead for the elision marker and split the rest evenly
    // between head and tail. 48 bytes covers "\n…[truncated <digits> middle
    // bytes]…\n" for any realistic omitted count (each … is 3 UTF-8 bytes).
    const sepOverhead = 48
    const usable = Math.max(0, maxBytes - sepOverhead)
    const half = Math.floor(usable / 2)

    // Head: first `half` bytes, backed up over UTF-8 continuation bytes
    // (0b10xxxxxx) to a lead-byte boundary so no character is split.
    let headEnd = half
    while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--
    // Tail: last `half` bytes, advanced over continuation bytes to a lead-byte
    // boundary. buf.length > maxBytes guarantees tailStart > headEnd (no overlap).
    let tailStart = buf.length - half
    while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) tailStart++

    const omitted = buf.length - headEnd - (buf.length - tailStart)
    const sep = `\n…[truncated ${omitted} middle bytes]…\n`
    return buf.toString("utf8", 0, headEnd) + sep + buf.toString("utf8", tailStart)
}

/**
 * Sum a single session's assistant-message tokens (input+output+reasoning),
 * recomputed from full history. cache.read/write are intentionally NOT counted
 * (cached reads are typically discounted by providers). Recompute-per-idle
 * semantics — never incrementally += — to avoid double counting.
 */
export function sumMemberTokens(messages: Array<{ info?: Message }> | undefined): number {
    let total = 0
    for (const m of messages ?? []) {
        if (m.info?.role !== "assistant") continue
        const t = m.info.tokens
        if (!t) continue
        total += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0)
    }
    return total
}

// --- polling primitive ---

/** Resolve when predicate is true; reject on timeout. Polls every pollMs. */
export function waitUntil(
    predicate: () => boolean,
    opts: { timeoutMs: number; pollMs?: number },
): Promise<void> {
    const pollMs = opts.pollMs ?? 250
    return new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const tick = () => {
            try {
                if (predicate()) {
                    resolve()
                    return
                }
            } catch (err) {
                reject(err)
                return
            }
            if (Date.now() - start >= opts.timeoutMs) {
                reject(new Error(`waitUntil: timed out after ${opts.timeoutMs}ms`))
                return
            }
            setTimeout(tick, pollMs)
        }
        tick()
    })
}

/** Split an array into batches of size n. */
export function chunk<T>(arr: T[], n: number): T[][] {
    if (n <= 0) return [arr]
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
    return out
}

/**
 * Build the role-setup prompt sent to a freshly spawned member session. The
 * role label and the member's instructions (prompt) come from the MemberSpec
 * (config.json), since MemberState does not persist them.
 */
export function buildRolePrompt(
    spec: MemberSpec,
    teamName: string,
    peerNames: string[],
): string {
    const peers = peerNames.filter(n => n !== spec.name)
    const lines: string[] = [
        `[Team Orchestrator] You are now a member of team "${teamName}".`,
        "",
        `Your name: ${spec.name}`,
        `Your role: ${spec.role}`,
    ]
    if (spec.model) lines.push(`Your model: ${spec.model}`)
    if (peers.length > 0) lines.push(`Your teammates: ${peers.join(", ")}`)
    // Preset role guidance (by role label), injected before the user's task
    // instruction. Every role resolves to an instruction (reviewer fallback).
    lines.push("", "<role-instruction>", rolePreset(spec.role), "</role-instruction>")
    // NOTE: spec.prompt (the member's standing task) is intentionally NOT embedded
    // here. It is delivered as <standing-instruction> on the member's FIRST real
    // task dispatch (see prependStandingInstruction in dispatch.ts). Embedding it
    // in role-setup caused members to execute the full task during the role-setup
    // barrier window, blowing the 120s timeout for any task heavier than ~2 min
    // (and producing the memory-378 capture-gotcha where the deliverable lands in
    // the role-setup turn and the later redundant task turn overwrites it with an
    // ack). Role-setup is now identity-only: members ack and idle in seconds.
    lines.push(
        "",
        "You collaborate via the team tools available to you:",
        "- team_send_message: send a message to a teammate (point-to-point).",
        "- team_task_create / team_task_list / team_task_update / team_task_get: coordinate shared work.",
        "Messages from teammates and the orchestrator are injected automatically each turn — you do not need to read them manually.",
        "",
        "When you have no work, you will idle and be re-prompted when needed. Acknowledge your role in one sentence, then stop.",
    )
    return lines.join("\n")
}
