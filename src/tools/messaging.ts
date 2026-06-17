/**
 * team_send_message tool (design §4.6). Writes a message to the recipient's
 * mailbox file (Layer 1) and sends a best-effort wake hint if the recipient is
 * idle (Layer 2). The Transform hook (Layer 3) injects the actual content on
 * the recipient's next turn — the wake hint is only a reminder, never content.
 *
 * Broadcast (to: "*") is master-only. Members may send point-to-point only.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../context.js"
import { resolveTeamMember } from "../utils.js"
import { writeMailboxMessage } from "../mailbox.js"
import { sendWakeHint } from "../wake-hint.js"
import { countUnreadMessages } from "../mailbox.js"
import type { Message } from "../types.js"

export function teamSendMessageTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Send a message to a teammate's mailbox (point-to-point), or broadcast to all members (to: \"*\", master-only). The recipient sees the message injected automatically on its next turn.",
        args: {
            team_id: tool.schema.string().min(1),
            to: tool.schema.string().min(1).describe("member name, or \"*\" for broadcast (master-only)"),
            body: tool.schema.string().min(1).max(32768),
            summary: tool.schema.string().max(200).optional(),
            correlation_id: tool.schema.string().optional(),
        },
        async execute(args, context) {
            const sender = await resolveTeamMember(ctx.storageRoot, context.sessionID)
            if (!sender) return "Error: caller is not a team member of this team"

            const { loadTeamState } = await import("../state/store.js")
            const team = await loadTeamState(ctx.storageRoot, args.team_id)

            // Broadcast is master-only; members send point-to-point only.
            if (args.to === "*" && !sender.isMaster) {
                return "Error: broadcast (to: \"*\") is master-only"
            }
            const recipients: string[] =
                args.to === "*"
                    ? team.members.filter(m => !m.isMaster).map(m => m.name)
                    : [args.to]
            // Validate recipient exists.
            for (const r of recipients) {
                if (!team.members.some(m => m.name === r) && r !== "master") {
                    return `Error: unknown recipient "${r}"`
                }
            }

            // Backpressure: enforce unread mailbox cap per recipient.
            for (const r of recipients) {
                const unread = await countUnreadMessages(team.directory, r)
                if (unread > 0 && unread * 1024 > team.bounds.messageUnreadMaxBytes) {
                    return `Error: recipient "${r}" mailbox is full (backpressure). Try later.`
                }
            }

            const base: Message = {
                version: 1,
                id: crypto.randomUUID(),
                from: sender.name,
                to: args.to,
                kind: "message",
                body: args.body,
                summary: args.summary,
                timestamp: Date.now(),
                correlationId: args.correlation_id,
                deliveryStatus: "pending",
            }
            for (const r of recipients) {
                await writeMailboxMessage(team.directory, r, { ...base, to: r })
                // Best-effort wake hint if idle (Layer 2).
                const member = team.members.find(m => m.name === r)
                if (member?.sessionId && member.status === "idle") {
                    const n = await countUnreadMessages(team.directory, r)
                    await sendWakeHint(ctx, member.sessionId, n)
                }
            }
            return `Message delivered to ${recipients.length === 1 ? recipients[0] : `${recipients.length} members`}.`
        },
    })
}
