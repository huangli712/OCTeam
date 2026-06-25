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

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { resolveCallerInTeam } from "../core/utils.js"
import { loadTeamState } from "../state/store.js"
import { countUnreadMessages, writeMailboxMessage } from "../messaging/mailbox.js"
import { sendWakeHint } from "../messaging/wake-hint.js"
import type { Message } from "../core/types.js"

export function teamInterveneTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Master-only: inject a high-priority directive into a member's mailbox (point-to-point), or broadcast to all members (to: \"*\"), during a running orchestration. The recipient sees it injected FIRST (marked [DIRECTIVE]) on its next turn. Inject-only — it does not re-dispatch members or alter control flow.",
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
                team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
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

            // Resolve recipients: a single member, or every non-master member on
            // broadcast. Validate each exists (mirror send_message validation).
            const recipients: string[] =
                args.to === "*"
                    ? team.members.filter(m => !m.isMaster).map(m => m.name)
                    : [args.to]
            for (const r of recipients) {
                if (!team.members.some(m => m.name === r) && r !== "master") {
                    return `Error: unknown recipient "${r}"`
                }
            }

            // Backpressure: enforce the unread mailbox cap per recipient. This is
            // the ONLY rate bound on directives — there is NO separate quota and
            // NO maxMessagesPerRun check (directives are master control traffic).
            for (const r of recipients) {
                const unread = await countUnreadMessages(team.directory, r)
                if (unread > 0 && unread * 1024 > team.bounds.messageUnreadMaxBytes) {
                    return `Error: recipient "${r}" mailbox is full (backpressure). Try later.`
                }
            }

            // Snapshot the run id once before writing. activeTask.runId is
            // eager-assigned at workflow Phase 3 creation, so it is normally
            // defined; in the pre-capture edge it may be undefined, in which case
            // the directive carries an undefined runId and the Transform hook
            // injects it unconditionally — an acceptable bounded fallback.
            const runId = team.activeTask.runId

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
            // Mailbox write only — no activeTask.messagesSent increment, no mutex.
            for (const r of recipients) {
                await writeMailboxMessage(team.directory, r, { ...base, to: r })
                // Best-effort wake hint if the recipient is idle (Layer 2) so it
                // is prompted to process the directive on its next turn.
                const member = team.members.find(m => m.name === r)
                if (member?.sessionId && member.status === "idle") {
                    const n = await countUnreadMessages(team.directory, r)
                    await sendWakeHint(ctx, member.sessionId, n)
                }
            }
            return `Directive delivered to ${recipients.length === 1 ? recipients[0] : `${recipients.length} members`}.`
        },
    })
}
