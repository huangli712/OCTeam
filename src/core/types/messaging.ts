/**
 * File mailbox entry (Message) and SDK message runtime shape (SdkMessage).
 *
 * Layer 0 in the types decomposition — no imports from other type files.
 * Both types are JSON-serializable. Message is persisted to mailbox/*.jsonl;
 * SdkMessage is a runtime-only shape used at SDK boundaries.
 */

/**
 * Runtime shape of an OpenCode SDK chat message (session.messages /
 * experimental.chat.messages.transform). The SDK types these as `{}`, so
 * callers cast to this loose shape to read info.sessionID / info.role and
 * inspect parts. Defining it once here avoids the duplicated
 * `{ info?: any; parts?: any }` casts that previously appeared at every
 * SDK boundary call site.
 *
 * `info` is the SDK's Message type (UserMessage | AssistantMessage) so
 * sumMemberTokens (which reads info.tokens) stays type-safe; `parts` stays
 * loose because capture/transform only filter by type/text fields.
 */
export type SdkMessage = {
    info?: import("@opencode-ai/sdk").Message
    parts?: unknown[]
}

/** A file mailbox entry — a message, announcement, or directive between members. */
export type Message = {
    version: 1
    id: string                         // UUID
    from: string                       // sender member name, or "master"
    to: string                         // recipient member name, or "*" for broadcast
    kind: "message" | "announcement" | "directive"
    body: string                       // max 32KB
    summary?: string                   // one-line summary for status display
    timestamp: number
    correlationId?: string             // UUID for request-response pairing
    runId?: string                     // per-orchestration run id for directive messages
    deliveryStatus: "pending" | "delivered" | "processed"
}
