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
 * Directive priority: messages with kind === "directive" are rendered FIRST,
 * each prefixed with a [DIRECTIVE] marker, so they take visual precedence in
 * the injected prompt. Regular messages follow after, preserving their order.
 *
 * SECURITY: `kind` and `from` are taken verbatim from the stored line (no
 * authenticity check — see mailbox.ts "TRUST BOUNDARY" header). Only the
 * legitimate write path (writeMailboxMessage, called by team_send_message
 * and team_intervene) sets these fields; the only legitimate directive source
 * is team_intervene, which writes `from: "master"`. A `kind:"directive"` line
 * with any other `from` is a forgery (a member with FS write to .octeam/
 * impersonating control traffic) and is downgraded to a regular message here.
 */
export function formatMailboxInjection(msgs: Message[]): string {
    const render = (m: Message, prefix: string): string =>
        `<team_message from="${escapeXmlAttr(m.from)}"${m.correlationId ? ` correlationId="${escapeXmlAttr(m.correlationId)}"` : ""}>\n`
        + `${prefix}${escapeXmlText(m.body)}\n</team_message>`
    // Directives first (with marker), then regular messages in original order.
    // Authentication: only directives whose (id, from, body) match a
    // legitimate writeMailboxMessage registration are honored. A forged line
    // — whether unregistered id OR a replayed id with different content — is
    // downgraded to a regular message (no [DIRECTIVE] prefix, no priority).
    const directives = msgs.filter(m => isAuthenticatedDirective(m))
    const regular = msgs.filter(m => !isAuthenticatedDirective(m))
    return [
        ...directives.map(m => render(m, "[DIRECTIVE] ")),
        ...regular.map(m => render(m, "")),
    ].join("\n\n")
}
