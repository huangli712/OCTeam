/**
 * XML escaping (injection hardening) and mailbox message injection formatting.
 *
 * Shared by the Transform hook (member delivery) and the master drain path so
 * both routes present identical formatting.
 */

import type { Message } from "../core/types.js"
import { isAuthenticatedDirective } from "./auth.js"

// Escape XML text content (message body). `&` MUST be replaced first so the
// ampersands introduced for the other entities are not double-escaped.
function escapeXmlText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

// Escape an XML attribute value (from, correlationId). Builds on text escaping
// and additionally neutralizes the quotes that could close the attribute.
function escapeXmlAttr(value: string): string {
    return escapeXmlText(value)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/**
 * Format messages for injection as a synthetic user message.
 *
 * Directive priority: authenticated directives are rendered FIRST inside a
 * distinct <team_directive> element with a [DIRECTIVE] marker, so they take
 * visual precedence in the injected prompt AND so no regular-message body
 * content can mimic the directive's wrapping structure. Regular messages
 * follow after inside <team_message>, preserving their order.
 *
 * SECURITY: `kind` and `from` are taken verbatim from the stored line (no
 * authenticity check — see mailbox.ts "TRUST BOUNDARY" header). Only the
 * legitimate write path (writeMailboxMessage, called by team_send_message
 * and team_intervene) sets these fields; the only legitimate directive source
 * is team_intervene, which writes `from: "master"`. A `kind:"directive"` line
 * with any other `from` is a forgery (a member with FS write to .octeam/
 * impersonating control traffic) and is downgraded to a regular message here.
 *
 * Rendering-layer forgery defense (C5): a forged REGULAR message whose body
 * literally starts with "[DIRECTIVE] " would render byte-identical to an
 * authenticated directive if both shared the same wrapping element. Using
 * <team_directive> for authenticated directives and <team_message> for
 * everything else guarantees the LLM can structurally distinguish them
 * regardless of body content.
 */
export function formatMailboxInjection(msgs: Message[], activeRunId?: string, teamName?: string): string {
    const renderCorrelationId = (m: Message): string =>
        m.correlationId ? ` correlationId="${escapeXmlAttr(m.correlationId)}"` : ""
    const renderDirective = (m: Message): string =>
        `<team_directive from="${escapeXmlAttr(m.from)}"${renderCorrelationId(m)}>\n`
        + `[DIRECTIVE] ${escapeXmlText(m.body)}\n</team_directive>`
    const renderRegular = (m: Message): string =>
        `<team_message from="${escapeXmlAttr(m.from)}"${renderCorrelationId(m)}>\n`
        + `${escapeXmlText(m.body)}\n</team_message>`
    // Directives first (with marker), then regular messages in original order.
    // Authentication: only directives whose (id, from, body) match a
    // legitimate writeMailboxMessage registration AND whose runId (if bound)
    // matches the active run are honored. A forged line — whether unregistered
    // id, a replayed id with different content, or a cross-run replay — is
    // downgraded to a regular message (no [DIRECTIVE] prefix, no priority).
    const directives = msgs.filter(m => isAuthenticatedDirective(m, activeRunId, teamName))
    const regular = msgs.filter(m => !isAuthenticatedDirective(m, activeRunId, teamName))
    // Note: two filters over the same array is intentional for clarity; a
    // single reduce would be less readable for this small partition.
    return [
        ...directives.map(renderDirective),
        ...regular.map(renderRegular),
    ].join("\n\n")
}
