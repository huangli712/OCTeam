/**
 * team_remove_member tool -- remove a member from an existing team (live only).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import type { PluginContext } from "../../core/context.js"
import fs from "node:fs/promises"
import { loadTeamState, readTeamSpec, reloadTeamStateLocked, saveTeamState, type Team, writeTeamSpec } from "../../state/store.js"
import { isIndexedMasterOf } from "../../state/resolve.js"
import { withLock } from "../../state/locks.js"
import { inboxPath, teamLifecycleLockPath } from "../../state/paths.js"
import type { TeamSpec } from "../../core/types.js"

/** Remove a member from a live team with at least one member remaining. */
export function teamRemoveMemberTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Remove a member from an existing team. Only allowed when team status is \"live\" " +
            "(sessions not yet spawned) and only by the master session. At least 1 member must " +
            "remain after removal.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const pathLeadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            let team: Team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id, pathLeadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            if (team.leadSessionId !== context.sessionID || !isIndexedMasterOf(context.sessionID, team.directory)) {
                return "Error: team_remove_member is master-only (only the team's leader can remove members)"
            }
            let staleState = false
            let specError = false
            let stateError = false
            let memberMissing = false
            let lastMember = false
            await withLock(teamLifecycleLockPath(team.directory), async () => team.mutex.runExclusive(async () => {
                try {
                    await reloadTeamStateLocked(team)
                } catch (err) {
                    logSwallowed(ctx, "team_remove_member: team state reload failed", err, { team: args.team_id })
                    stateError = true
                    return
                }
                // Validate mutable state only after the locked disk refresh.
                if (team.status !== "live" || team.spawning) {
                    staleState = true
                    return
                }
                const currentIdx = team.members.findIndex(member => member.name === args.member_name)
                if (currentIdx === -1) {
                    memberMissing = true
                    return
                }
                if (team.members.length <= 1) {
                    lastMember = true
                    return
                }
                // Re-read config.json INSIDE the mutex so concurrent mutators
                // don't clobber each other's spec changes.
                let spec: TeamSpec | null = null
                try {
                    spec = await readTeamSpec(ctx.storageRoot, args.team_id, pathLeadSessionId)
                } catch (err) {
                    logSwallowed(ctx, "team_remove_member: team spec unreadable", err, { team: args.team_id })
                    specError = true
                    return
                }
                if (!spec) {
                    specError = true
                    return
                }
                const specIdx = spec.members.findIndex(m => m.name === args.member_name)
                const removedSpecMember = specIdx !== -1 ? spec.members[specIdx] : undefined
                if (specIdx !== -1) spec.members.splice(specIdx, 1)
                const removedStateMember = team.members[currentIdx]
                team.members.splice(currentIdx, 1)

                try {
                    await writeTeamSpec(ctx.storageRoot, spec, pathLeadSessionId, ctx.storageRoot)
                } catch (err) {
                    // Config write failed — nothing on disk, full rollback.
                    if (specIdx !== -1 && removedSpecMember) spec.members.splice(specIdx, 0, removedSpecMember)
                    team.members.splice(currentIdx, 0, removedStateMember)
                    throw err
                }
                try {
                    await saveTeamState(team)
                } catch (err) {
                    // State write failed but config was already written.
                    // Rollback memory, then compensating write to revert
                    // config.json so disk stays consistent.
                    if (specIdx !== -1 && removedSpecMember) spec.members.splice(specIdx, 0, removedSpecMember)
                    team.members.splice(currentIdx, 0, removedStateMember)
                    try {
                        await writeTeamSpec(ctx.storageRoot, spec, pathLeadSessionId, ctx.storageRoot)
                    } catch (compensateErr) {
                        logSwallowed(ctx, "remove: compensating spec revert failed after state save failure", compensateErr, { team: args.team_id })
                    }
                    throw err
                }
                // C16: clean up mailbox ONLY after both config + state saved
                // successfully. Pre-fix code deleted the inbox BEFORE saving,
                // so a save failure rolled back the member but permanently
                // lost messages. Now a save failure leaves the inbox intact
                // for the restored member.
                try {
                    const mbPath = inboxPath(team.directory, args.member_name)
                    await fs.rm(mbPath, { recursive: true, force: true })
                } catch (err) {
                    logSwallowed(ctx, "remove: mailbox cleanup failed", err, { member: args.member_name })
                }
            }), team.directory)

            if (stateError) {
                return `Error: team "${args.team_id}" could not be reloaded (state file unreadable)`
            }
            if (staleState) {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". `
                    + `Members can only be removed before sessions are spawned (workflow calls).`
            }
            if (specError) {
                return `Error: cannot read config for team "${args.team_id}"`
            }
            if (memberMissing) {
                return `Error: member "${args.member_name}" not found in team "${args.team_id}"`
            }
            if (lastMember) {
                return `Error: team "${args.team_id}" has only ${team.members.length} member(s). `
                    + `Cannot remove the last member.`
            }

            return `Member "${args.member_name}" removed from team "${args.team_id}" `
                + `(${team.members.length} members remaining).`
        },
    })
}
