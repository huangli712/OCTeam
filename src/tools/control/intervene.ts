/**
 * team_intervene tool. Master-only, inject-only: writes a high-priority
 * directive to a member's mailbox (or broadcasts to all members) DURING a
 * running orchestration. The directive rides the same three-layer comms model
 * as team_send_message — mailbox write (Layer 1) + best-effort wake hint
 * (Layer 2); the Transform hook (Layer 3, T5) renders it FIRST with a
 * [DIRECTIVE] marker and filters by runId on the recipient's next turn.
 *
 * It has ZERO mutex contact and ZERO control-flow mutation: it only appends to
 * the mailbox. It does NOT acquire team.mutex, re-dispatch members, or touch
 * activeTask / stages / member.status. Directives are master control traffic and
 * are exempt from the per-run team-comms quota (maxMessagesPerRun).
 */

import crypto from "node:crypto"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { loadTeamState } from "../../state/store.js"
import { BackpressureError } from "../../messaging/mailbox.js"
import { deliverToRecipients } from "../../messaging/deliver.js"
import type { Message } from "../../core/types.js"
import { nonMasterMembers } from "../support.js"

/** Inject a high-priority directive into member mailboxes during a run. */
export function teamInterveneTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Master-only: inject a high-priority directive into a member's mailbox "
            + "(point-to-point), or broadcast to all members (to: \"*\"), during a running "
            + "orchestration. The recipient sees it injected FIRST (marked [DIRECTIVE]) "
            + "on its next turn. Inject-only — it does not re-dispatch members or alter "
            + "control flow.",
        args: {
            team_id: tool.schema.string().min(1),
            to: tool.schema.string().min(1).describe("member name, or \"*\" to broadcast to all members"),
            body: tool.schema.string().min(1).max(32768),
            summary: tool.schema.string().max(200).optional(),
        },
        async execute(args, context) {
            // Caller must be the team's master. resolveCallerInTeam defaults to
            // requireActive: true, so a master targeting an inactive team is
            // rejected here (null) by the single-active interaction gate.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            if (!caller.isMaster) return "Error: team_intervene is master-only"

            let team
            try {
                team = await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }

            // Enforce the configurable per-message payload cap (UTF-8 bytes). The
            // schema .max() is a static safety net; messagePayloadMaxBytes is the
            // team's actual limit.
            if (Buffer.byteLength(args.body, "utf8") > team.bounds.messagePayloadMaxBytes) {
                return `Error: directive body exceeds payload limit (${team.bounds.messagePayloadMaxBytes} bytes).`
            }

            // Precondition: there must be a live orchestration to intervene on.
            // No intervene on idle/live/failed — a directive would orphan with no
            // run to process it.
            if (team.status !== "busy" || !team.activeTask) {
                return `Error: team "${args.team_id}" has no active run to intervene on.`
            }
            if (args.to === "master") {
                return `Error: team_intervene cannot target "master"; directives are delivered to member mailboxes only.`
            }

            // Resolve recipients: a single member, or every non-master member on
            // broadcast. Validate each exists (mirror send_message validation).
            const recipients: string[] =
                args.to === "*"
                    ? nonMasterMembers(team).map(m => m.name)
                    : [args.to]
            for (const r of recipients) {
                if (!team.members.some(m => m.name === r)) {
                    return `Error: unknown recipient "${r}"`
                }
            }

            // M-20/C-10: the directive MUST carry the active run's runId so the
            // Transform hook can scope it. Pre-fix code allowed runId===undefined
            // which let the directive inject in ANY subsequent run (cross-run
            // replay). Now: refuse to send an unscoped directive when there IS
            // an active task. The only legitimate unscoped case is a pre-capture
            // team (no activeTask at all).
            const runId = team.activeTask?.runId
            if (team.activeTask && !runId) {
                return `Error: cannot send directive — active task has no runId. `
                    + `Wait for the workflow to initialize and retry.`
            }

            const base: Message = {
                version: 1,
                id: crypto.randomUUID(),
                from: "master",
                to: args.to,
                kind: "directive",
                body: args.body,
                summary: args.summary,
                timestamp: Date.now(),
                runId,
                deliveryStatus: "pending",
            }

            // Backpressure is now enforced INSIDE the mailbox lock by
            // writeMailboxMessage (via deliverToRecipients) so concurrent
            // senders cannot both pass the check and collectively exceed the cap.

            // Mailbox write only — no activeTask.messagesSent increment, no mutex.
            // Directive authentication is handled inside writeMailboxMessage
            // (the in-memory ID registration), which a FS-level forger bypasses.
            try {
                await deliverToRecipients(ctx, team, recipients, base, team.bounds.messageUnreadMaxBytes)
            } catch (err) {
                if (err instanceof BackpressureError) {
                    return `Error: recipient "${err.recipient}" mailbox is full (backpressure). Try later.`
                }
                throw err
            }
            return `Directive delivered to ${recipients.length === 1 ? recipients[0] : `${recipients.length} members`}.`
        },
    })
}
