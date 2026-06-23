/**
 * Cooperative shutdown tools (design §4.8, §4.9). Master requests shutdown of a
 * member; the member (or master) approves/rejects. On approval the member's
 * worktree is cleaned and its status flips to shutdown_approved.
 *
 * Auth model: team_shutdown_request is master-only. approve/reject may be
 * called by the master OR by the member being shut down (the cooperative party),
 * and the caller must belong to the target team.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../context.js"
import { resolveCallerInTeam } from "../utils.js"
import { loadTeamState, saveTeamState } from "../state/store.js"
import { countUnreadMessages, writeMailboxMessage } from "../mailbox.js"
import { sendWakeHint } from "../wake-hint.js"
import type { Message } from "../types.js"

const execFileP = promisify(execFile)

async function cleanWorktree(worktreePath: string | undefined): Promise<void> {
    if (!worktreePath) return
    await execFileP("git", ["worktree", "remove", worktreePath, "--force"]).catch(() => {
        // best effort
    })
}

export function teamShutdownRequestTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Master-only. Request cooperative shutdown of a member. The member sees the request (via mailbox injection) and may approve or reject.",
        args: {
            team_id: tool.schema.string().min(1),
            member: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_shutdown_request is master-only"
            }
            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
            const member = team.members.find(m => m.name === args.member)
            if (!member) return `Error: unknown member "${args.member}"`
            // Mark the pending request so approve/reject can only act on a member
            // whose shutdown was actually requested.
            member.shutdownRequested = true

            const msg: Message = {
                version: 1,
                id: crypto.randomUUID(),
                from: "orchestrator",
                to: args.member,
                kind: "announcement",
                body: `[Team Orchestrator] Master requests cooperative shutdown. Respond by calling team_approve_shutdown (to stop) or team_reject_shutdown (if you have unfinished work).`,
                summary: "shutdown request",
                timestamp: Date.now(),
                deliveryStatus: "pending",
            }
            await writeMailboxMessage(team.directory, args.member, msg)
            if (member.sessionId && member.status === "idle") {
                const n = await countUnreadMessages(team.directory, args.member)
                await sendWakeHint(ctx, member.sessionId, n)
            }
            await saveTeamState(team)
            return `Shutdown request sent to "${args.member}".`
        },
    })
}

export function teamApproveShutdownTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Approve cooperative shutdown for a member. Cleans the member's worktree and flips status to shutdown_approved. Callable by the master or by the member being shut down.",
        args: {
            team_id: tool.schema.string().min(1),
            member: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            if (!caller.isMaster && caller.name !== args.member) {
                return "Error: only the master or the member itself may approve its shutdown"
            }
            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
            return team.mutex.runExclusive(async () => {
                const member = team.members.find(m => m.name === args.member)
                if (!member) return `Error: unknown member "${args.member}"`
                if (!member.shutdownRequested) {
                    return `Error: no active shutdown request for "${args.member}" — call team_shutdown_request first`
                }
                await cleanWorktree(member.worktreePath)
                member.status = "shutdown_approved"
                member.shutdownRequested = undefined
                member.worktreePath = undefined
                const allDown = team.members.every(
                    m => m.status === "shutdown_approved",
                )
                await saveTeamState(team)
                return `Member "${args.member}" approved shutdown.${allDown ? " All members down." : ""}`
            })
        },
    })
}

export function teamRejectShutdownTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Reject cooperative shutdown for a member, with a reason. The member keeps running. Callable by the master or by the member being shut down.",
        args: {
            team_id: tool.schema.string().min(1),
            member: tool.schema.string().min(1),
            reason: tool.schema.string().min(1).max(2048),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            if (!caller.isMaster && caller.name !== args.member) {
                return "Error: only the master or the member itself may reject its shutdown"
            }
            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
            return team.mutex.runExclusive(async () => {
                const member = team.members.find(m => m.name === args.member)
                if (!member) return `Error: unknown member "${args.member}"`
                if (!member.shutdownRequested) {
                    return `Error: no active shutdown request for "${args.member}" — nothing to reject`
                }
                // Request declined; clear the marker so the member keeps running.
                member.shutdownRequested = undefined
                member.error = `shutdown rejected: ${args.reason}`
                await saveTeamState(team)
                return `Member "${args.member}" rejected shutdown: ${args.reason}`
            })
        },
    })
}
