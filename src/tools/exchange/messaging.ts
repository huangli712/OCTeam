/**
 * team_send_message tool. Writes a message to the recipient's
 * mailbox file (Layer 1) and sends a best-effort wake hint if the recipient is
 * idle (Layer 2). The Transform hook (Layer 3) injects the actual content on
 * the recipient's next turn — the wake hint is only a reminder, never content.
 *
 * Broadcast (to: "*") is master-only. Members may send point-to-point only.
 */

import crypto from "node:crypto"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import type {
    Message,
    ParallelMode
} from "../../core/types.js"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import {
    loadTeamState,
    saveTeamStateBounded
} from "../../state/store.js"
import { BackpressureError } from "../../messaging/mailbox.js"
import { deliverToRecipients } from "../../messaging/deliver.js"
//
import { nonMasterMembers } from "../support.js"

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

/** Send a message to teammate mailboxes, point-to-point or broadcast. */
export function teamSendMessageTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Send a message to a teammate's mailbox (point-to-point), or broadcast to all "
            + "members (to: \"*\", master-only). The recipient sees the message injected "
            + "automatically on its next turn.",
        args: {
            team_id: tool.schema.string().min(1),
            to: tool.schema.string().min(1).describe("member name, or \"*\" for broadcast (master-only)"),
            body: tool.schema.string().min(1).max(32768),
            summary: tool.schema.string().max(200).optional(),
            correlation_id: tool.schema.string().max(128).regex(
                /^[A-Za-z0-9_-]+$/,
                "correlation_id may contain only letters, digits, hyphen and underscore",
            ).optional(),
        },
        async execute(args, context) {
            const sender = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!sender) return "Error: caller is not a member of this team"

            let team
            try {
                // Use sender.storageRoot, the authoritative root, instead of
                // ctx.storageRoot so cross-scope teams resolve correctly.
                team = await loadTeamState(sender.storageRoot, args.team_id, sender.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }

            // Enforce the configurable per-message payload cap. The
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
                    ? nonMasterMembers(team).map(m => m.name)
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

            // Enforce maxMessagesPerRun during an active orchestration.
            if (team.activeTask) {
                let overLimit = false
                await team.mutex.runExclusive(async () => {
                    if (team.deleted) return
                    const task = team.activeTask
                    if (!task) return
                    if (task.messagesSent + recipients.length > team.bounds.maxMessagesPerRun) {
                        overLimit = true
                        return
                    }
                    task.messagesSent += recipients.length
                    try {
                        await saveTeamStateBounded(team)
                    } catch (err) {
                        // Roll back the in-memory increment so the next call
                        // re-reads from disk (which has the stale count).
                        task.messagesSent -= recipients.length
                        throw err
                    }
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
            // Capture the task reference after charging (before the failure
            // handler) so a refund debits the run that is active when the
            // failure is handled; because the reference is captured after the
            // charging critical section, a run switch between charge and
            // capture can mis-attribute the refund. Track delivered
            // recipients so partial success refunds only undelivered messages.
            const taskAtDispatch = team.activeTask
            let deliveredCount = 0
            // Enforce backpressure inside the mailbox lock through
            // writeMailboxMessage (via deliverToRecipients) so concurrent
            // senders cannot both pass the check and collectively exceed the cap.
            try {
                await deliverToRecipients(
                    ctx,
                    team,
                    recipients,
                    base,
                    team.bounds.messageUnreadMaxBytes,
                    () => { deliveredCount += 1 },
                )
            } catch (err) {
                // Roll back messagesSent only for undelivered recipients. Delivery
                // continues after per-recipient failures, so successful recipients
                // retain their quota usage.
                const undelivered = recipients.length - deliveredCount
                if (taskAtDispatch && undelivered > 0) {
                    await team.mutex.runExclusive(async () => {
                        // Same task still active — debit refund.
                        if (taskAtDispatch === team.activeTask) {
                            taskAtDispatch.messagesSent = Math.max(0, taskAtDispatch.messagesSent - undelivered)
                            try {
                                await saveTeamStateBounded(team)
                            } catch (rollbackErr) {
                                logSwallowed(
                                    ctx,
                                    "send_message: rollback save failed after delivery error",
                                    rollbackErr,
                                    { team: team.teamName },
                                )
                            }
                        } else {
                            // Run switched during delivery — cannot safely
                            // debit the new run. Log the lost quota.
                            logSwallowed(
                                ctx,
                                "send_message: run finished during delivery; cannot refund quota (run switched)",
                                err,
                                { team: team.teamName, undelivered },
                            )
                        }
                    })
                }
                if (err instanceof BackpressureError) {
                    return `Error: recipient "${err.recipient}" mailbox is full (backpressure). Try later.`
                }
                throw err
            }
            return `Message delivered to ${recipients.length === 1 ? recipients[0] : `${recipients.length} members`}.`
        },
    })
}
