/**
 * Orchestration domain helpers: member output extraction, truncation, token
 * accounting, and the role-setup prompt builder. These carry team-orchestration
 * domain knowledge (prompt conventions, work-tool classification, role presets)
 * and are not general-purpose primitives.
 */

import type { Message, Part, TextPart } from "@opencode-ai/sdk"

import type { MemberSpec } from "../../core/types.js"
import { rolePreset } from "../../core/role.js"

/** Tools whose invocations represent member work product (code, commands).
 * Excludes team-* coordination tools (send_message, task_*, workflow tools). */
const WORK_TOOLS = new Set([
    "write", "edit", "bash",
    "aft_write", "aft_edit", "aft_bash", "aft_apply_patch",
    "aft_delete", "aft_move", "aft_refactor", "aft_import", "aft_ast_replace",
])

/**
 * Severity ordering for workflow gate issue display: critical > high > medium > low.
 * Shared by records/ledger.ts (live WorkflowStep) and tools/query/results.ts
 * (read-only WorkflowRunStep) to avoid duplicated sort + format logic.
 */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/** Minimal issue shape accepted by workflow record formatters. */
export interface WorkflowIssueLike {
    severity?: string
    message?: string
}

/**
 * Extract concatenated text from message parts (filters type === "text").
 * Skips synthetic parts (injected role prompts / mailbox injections) so they
 * are never mistaken for member-produced text.
 *
 * @internal Exported only for use by tests/output-capture.test.ts (baseline
 * regression for the text-only extraction contract). Production callers use
 * `extractOutputFromParts`, which carries its own inline text filtering plus
 * output-shape handling.
 */
export function extractTextFromParts(parts: unknown): string {
    if (!Array.isArray(parts)) return ""
    return (parts as Part[])
        .filter((p): p is TextPart => !!p && p.type === "text" && typeof p.text === "string")
        .filter(p => !p.synthetic)
        .map(p => p.text)
        .join("\n")
}

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
            // Skip tool calls that did not complete successfully so failed work
            // cannot flow into pipeline, reduce, or signoff as a deliverable.
            const toolStatus = p.state?.status
            // Only accept completed tool calls as work output.
            if (toolStatus !== "completed") continue
            const input = (p.state?.input ?? {}) as Record<string, unknown>
            let primaryInput: string | undefined
            switch (p.tool) {
                case "aft_delete":
                    if (Array.isArray(input.files)) {
                        primaryInput = input.files.filter((file): file is string => typeof file === "string").join(" ")
                    }
                    break
                case "aft_move":
                    if (typeof input.path === "string" && typeof input.destination === "string") {
                        primaryInput = `${input.path}→${input.destination}`
                    }
                    break
                case "aft_refactor":
                    if (typeof input.symbol === "string") primaryInput = input.symbol
                    break
                case "aft_import":
                    if (typeof input.module === "string") primaryInput = input.module
                    break
                case "aft_ast_replace":
                    if (typeof input.pattern === "string") primaryInput = input.pattern
                    break
            }
            if (primaryInput?.trim()) {
                segments.push(primaryInput)
            } else if (typeof input.content === "string" && input.content.trim()) {
                const fp = typeof input.filePath === "string" ? input.filePath : ""
                segments.push(fp ? `[File: ${fp}]\n${input.content}` : input.content)
            } else if (typeof input.command === "string" && input.command.trim()) {
                segments.push(`$ ${input.command}`)
            } else if (typeof input.patchText === "string" && input.patchText.trim()) {
                segments.push(`[Patch]\n${input.patchText}`)
            } else if (p.tool !== "edit" && p.tool !== "aft_edit") {
                // For tool-only turns with no recognized input field,
                // produce a non-empty summary so the turn isn't treated as
                // empty (which would trigger re-dispatch or stalling).
                const query = typeof input.query === "string" ? input.query.slice(0, 200)
                    : typeof input.pattern === "string" ? input.pattern.slice(0, 200)
                    : typeof input.prompt === "string" ? input.prompt.slice(0, 200)
                    : typeof input.body === "string" ? input.body.slice(0, 200)
                    : typeof input.subject === "string" ? input.subject.slice(0, 200)
                    : typeof input.description === "string" ? input.description.slice(0, 200)
                    : ""
                if (query) segments.push(`[${p.tool}] ${query}`)
                else segments.push(`[${p.tool}]`)
            }
            if (typeof input.newString === "string" && input.newString.trim()) {
                // Capture the edit tool's oldString→newString format.
                const fp = typeof input.filePath === "string" ? input.filePath : ""
                const oldStr = typeof input.oldString === "string" ? input.oldString : ""
                segments.push(fp
                    ? `[Edit: ${fp}]\n- ${oldStr}\n+ ${input.newString}`
                    : `[Edit]\n- ${oldStr}\n+ ${input.newString}`)
            } else if (typeof input.oldString === "string" && input.oldString.trim() && input.newString === "") {
                // Capture deletion-only edits when newString is empty.
                const fp = typeof input.filePath === "string" ? input.filePath : ""
                segments.push(fp
                    ? `[Delete: ${fp}]\n- ${input.oldString}`
                    : `[Delete]\n- ${input.oldString}`)
            } else if (Array.isArray(input.edits) && input.edits.length > 0) {
                // Capture batch edits and guard against null or non-object entries
                // that would otherwise abort output capture.
                const fp = typeof input.filePath === "string" ? input.filePath : ""
                const summary = input.edits.map((e: unknown) => {
                    if (typeof e !== "object" || e === null) return "[invalid edit]"
                    const ed = e as Record<string, unknown>
                    const o = typeof ed.oldString === "string" ? ed.oldString : ""
                    const n = typeof ed.newString === "string" ? ed.newString : ""
                    // Also capture line-range edits from the content field.
                    if (!o && !n && typeof ed.content === "string") {
                        const sl = typeof ed.startLine === "number" ? ed.startLine : "?"
                        const el = typeof ed.endLine === "number" ? ed.endLine : "?"
                        return `L${sl}-${el}: ${ed.content}`
                    }
                    return `- ${o}\n+ ${n}`
                }).join("\n")
                segments.push(fp ? `[Batch Edit: ${fp}]\n${summary}` : `[Batch Edit]\n${summary}`)
            } else if (typeof input.appendContent === "string" && input.appendContent.trim()) {
                // Capture appendContent tool calls. These produce no
                // oldString/newString — just a content append. Without this,
                // an append-only turn is captured as "no new output".
                const fp = typeof input.filePath === "string" ? input.filePath : ""
                segments.push(fp
                    ? `[Append: ${fp}]\n+ ${input.appendContent}`
                    : `[Append]\n+ ${input.appendContent}`)
            }
        }
    }
    return segments.join("\n\n")
}

/**
 * Type-safe extraction of a session's status entry from the SDK's
 * session.status({}) response. The SDK types `data` loosely; this helper
 * narrows it to the shape we rely on without an unsafe `as` cast at every
 * call site.
 *
 * Returns undefined when the data shape does not match or the sessionID
 * has no entry.
 */
export function extractSessionStatusEntry(
    data: unknown,
    sessionID: string,
): { type: string; message?: string } | undefined {
    if (typeof data !== "object" || data === null) return undefined
    const entry = (data as Record<string, unknown>)[sessionID]
    if (typeof entry !== "object" || entry === null) return undefined
    const e = entry as Record<string, unknown>
    if (typeof e.type !== "string") return undefined
    return { type: e.type, message: typeof e.message === "string" ? e.message : undefined }
}

/**
 * Truncate output to maxBytes (default 64 KiB) of UTF-8 to prevent context-window
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
export function truncateOutput(text: string, maxBytes: number = 65536): string {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
    // For small budgets, return as much text as fits without the elision marker.
    const sepOverhead = 48
    if (maxBytes <= sepOverhead) {
        const buf = Buffer.from(text, "utf8")
        if (buf.length <= maxBytes) return text
        const ellipsis = "…"
        const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8")
        const appendEllipsis = maxBytes >= ellipsisBytes
        let cut = appendEllipsis ? maxBytes - ellipsisBytes : maxBytes
        while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--
        return buf.toString("utf8", 0, cut) + (appendEllipsis ? ellipsis : "")
    }
    const buf = Buffer.from(text, "utf8")
    // Reserve a fixed overhead for the elision marker and split the rest evenly
    // between head and tail. 48 bytes covers "\n...[truncated <digits> middle
    // bytes]...\n" for any realistic omitted count.
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

    // If the head boundary cuts inside a structured <tag>...</tag>
    // pair, move headEnd backward to before the opening tag so the
    // truncated output doesn't contain a half-open tag that corrupts
    // downstream JSON parsing.
    const headText = buf.toString("utf8", 0, headEnd)
    // 1. Check for unclosed tag name: `<sco` (no `>` yet).
    const lastOpenInHead = headText.lastIndexOf("<")
    if (lastOpenInHead >= 0) {
        const afterOpen = headText.slice(lastOpenInHead)
        if (!afterOpen.includes(">")) {
            headEnd = lastOpenInHead
            while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--
        }
    }
    // 2. Check for complete opening <tag> without matching </tag> in head.
    //    This means the tag pair spans head+tail — JSON inside is corrupted.
    //    Find the last complete <tag>...</tag> pair and truncate before
    //    any orphaned opening tag.
    const updatedHeadText = buf.toString("utf8", 0, headEnd)
    const tagPairRegex = /<([a-zA-Z_][\w]*)>([\s\S]*?)<\/\1>/g
    let lastCompleteTagEnd = 0
    let lastOrphanOpenEnd = -1
    let match: RegExpExecArray | null
    while ((match = tagPairRegex.exec(updatedHeadText)) !== null) {
        lastCompleteTagEnd = match.index + match[0].length
    }
    // Find opening tags after the last complete pair.
    const afterComplete = updatedHeadText.slice(lastCompleteTagEnd)
    const orphanMatch = afterComplete.match(/<[a-zA-Z_][\w]*>/)
    if (orphanMatch && orphanMatch.index !== undefined) {
        lastOrphanOpenEnd = lastCompleteTagEnd + orphanMatch.index
    }
    if (lastOrphanOpenEnd >= 0 && lastOrphanOpenEnd < headEnd) {
        // Truncate before the orphaned opening tag.
        headEnd = lastOrphanOpenEnd
        while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--
    }
    // Same for tail: if the tail starts mid-tag (before the first `>`),
    // advance tailStart past the first `>`.
    const tailText = buf.toString("utf8", tailStart)
    const firstCloseInTail = tailText.indexOf(">")
    const firstOpenInTail = tailText.indexOf("<")
    if (firstOpenInTail === -1 || (firstCloseInTail >= 0 && firstCloseInTail < firstOpenInTail)) {
        // Tail starts with `...>` — a fragment of a broken tag. Advance past it.
        if (firstCloseInTail >= 0 && (firstOpenInTail === -1 || firstCloseInTail < firstOpenInTail)) {
            tailStart += firstCloseInTail + 1
            while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) tailStart++
        }
    }

    const omitted = buf.length - headEnd - (buf.length - tailStart)
    const sep = `\n...[truncated ${omitted} middle bytes]...\n`
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
        // Validate each token field as a finite non-negative integer before summing.
        const input = typeof t.input === "number" && Number.isSafeInteger(t.input) && t.input >= 0 ? t.input : 0
        const output = typeof t.output === "number" && Number.isSafeInteger(t.output) && t.output >= 0 ? t.output : 0
        const reasoning = typeof t.reasoning === "number" && Number.isSafeInteger(t.reasoning) && t.reasoning >= 0 ? t.reasoning : 0
        total += input + output + reasoning
    }
    return total
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
        `[Team Orchestrator]`,
        `You are now a member of team "${teamName}".`,
        "",
        "<basic-instruction>",
        `Your name: ${spec.name}`,
        `Your role: ${spec.role}`,
    ]
    if (spec.model) lines.push(`Your model: ${spec.model}`)
    if (peers.length > 0) lines.push(`Your teammates: ${peers.join(", ")}`)
    lines.push("</basic-instruction>")
    // Preset role guidance (by role label), injected before the user's task
    // instruction. Every role resolves to an instruction (reviewer fallback).
    lines.push("", "<role-instruction>", rolePreset(spec.role), "</role-instruction>")
    // NOTE: spec.prompt is intentionally delivered as <member-instruction> on
    // the first real task dispatch (see prependStandingInstruction in dispatch.ts).
    // Embedding it here makes members execute the task during the role-setup
    // barrier, blowing ROLE_SETUP_BARRIER_TIMEOUT_MS and letting the later task
    // turn overwrite the deliverable with an ack. Role setup is identity-only.
    lines.push(
        "",
        "<tools-instruction>",
        "You collaborate via the team tools available to you:",
        "- team_send_message: send a message to a teammate (point-to-point).",
        "- team_task_create / team_task_list / team_task_update / team_task_get: coordinate shared work.",
        "Messages from teammates and the orchestrator are injected automatically each turn — you do not need to read them manually.",
        "</tools-instruction>",
        "",
        "When you have no work, you will idle and be re-prompted when needed.",
        "Acknowledge your role in one sentence, then stop.",
    )
    return lines.join("\n")
}

/**
 * Type-safe cast of unknown SDK data to SdkMessage[] with a runtime Array
 * guard. Use this instead of `data as SdkMessage[]` at every session.messages
 * call site so an unexpected SDK response shape degrades to empty rather than
 * propagating as a wrongly-typed reference.
 */
export function asSdkMessages(data: unknown): import("../../core/types.js").SdkMessage[] {
    if (!Array.isArray(data)) return []
    // Validate each element as a non-null object so malformed SDK data cannot
    // propagate as a wrongly typed reference.
    return data.filter((m): m is import("../../core/types.js").SdkMessage =>
        typeof m === "object" && m !== null && !Array.isArray(m),
    )
}

/**
 * Format a gate step's structured issues as severity-sorted detail lines.
 * Works for both WorkflowStep (live) and WorkflowRunStep (read-only) —
 * both carry `issues?: WorkflowIssue[]`.
 */
export function formatWorkflowIssueDetail(issues: WorkflowIssueLike[] | undefined): string {
    if (!issues || issues.length === 0) return ""
    const sorted = [...issues].sort((a, b) => (SEVERITY_ORDER[a.severity ?? ""] ?? 99) - (SEVERITY_ORDER[b.severity ?? ""] ?? 99))
    const lines = sorted.map(issue => {
        const msg = issue.message && issue.message.trim() !== "" ? `: ${truncateOutput(issue.message, 1024)}` : ""
        return `    - [${issue.severity ?? "unknown"}]${msg}`
    })
    return "\n" + lines.join("\n")
}
