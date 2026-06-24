/**
 * team_send_message tool (design §4.6). Writes a message to the recipient's
 * mailbox file (Layer 1) and sends a best-effort wake hint if the recipient is
 * idle (Layer 2). The Transform hook (Layer 3) injects the actual content on
 * the recipient's next turn — the wake hint is only a reminder, never content.
 *
 * Broadcast (to: "*") is master-only. Members may send point-to-point only.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { resolveCallerInTeam } from "../core/utils.js"
import { loadTeamState, saveTeamState } from "../state/store.js"
import { countUnreadMessages, writeMailboxMessage } from "../messaging/mailbox.js"
import { sendWakeHint } from "../messaging/wake-hint.js"
import type { Message, ParallelMode } from "../core/types.js"

/**
 * isolated-mode comms gate: in an isolated parallel run, members may not send
 * point-to-point messages to other members (lateral comms). member<->master in
 * both directions stays allowed. Returns true when the message must be rejected.
 */
export function isForbiddenLateralMessage(
    mode: ParallelMode | undefined,
    senderIsMaster: boolean,
    recipients: string[],
): boolean {
    if (mode !== "isolated") return false
    if (senderIsMaster) return false
    return recipients.some(r => r !== "master")
}

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
            const sender = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!sender) return "Error: caller is not a member of this team"

            let team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id, sender.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }

            // P1 (§8.1): enforce the configurable per-message payload cap. The
            // schema .max() is a static safety net; bounds.messagePayloadMaxBytes
            // is the team's actual limit and is measured in UTF-8 bytes.
            if (Buffer.byteLength(args.body, "utf8") > team.bounds.messagePayloadMaxBytes) {
                return `Error: message body exceeds payload limit (${team.bounds.messagePayloadMaxBytes} bytes).`
            }

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

            // isolated mode: forbid member<->member lateral comms. member<->master
            // (both directions) stays allowed so members can report up and the
            // master can coordinate down.
            if (isForbiddenLateralMessage(team.activeTask?.mode, sender.isMaster === true, recipients)) {
                return `Error: isolated mode forbids member-to-member messaging. You may message "master" only.`
            }

            // Backpressure: enforce unread mailbox cap per recipient.
            for (const r of recipients) {
                const unread = await countUnreadMessages(team.directory, r)
                if (unread > 0 && unread * 1024 > team.bounds.messageUnreadMaxBytes) {
                    return `Error: recipient "${r}" mailbox is full (backpressure). Try later.`
                }
            }

            // M1 (§8.1): enforce maxMessagesPerRun during an active orchestration.
            if (team.activeTask) {
                let overLimit = false
                await team.mutex.runExclusive(async () => {
                    const task = team.activeTask
                    if (!task) return
                    if (task.messagesSent + recipients.length > team.bounds.maxMessagesPerRun) {
                        overLimit = true
                        return
                    }
                    task.messagesSent += recipients.length
                    await saveTeamState(team)
                })
                if (overLimit) {
                    return `Error: per-run message limit reached (${team.bounds.maxMessagesPerRun}). Message not sent.`
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
