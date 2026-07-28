/**
 * team_remove_member tool -- remove a member from an existing team (live only).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import type { PluginContext } from "../../core/context.js"
import { loadTeamState, readTeamSpec, saveTeamState, writeTeamSpec } from "../../state/store.js"
import { isIndexedMasterOf } from "../../state/resolve.js"
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
            let team
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
            if (team.status !== "live") {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". `
                    + `Members can only be removed before sessions are spawned (workflow calls).`
            }

            const stateIdx = team.members.findIndex(m => m.name === args.member_name)
            if (stateIdx === -1) {
                return `Error: member "${args.member_name}" not found in team "${args.team_id}"`
            }
            if (team.members.length <= 1) {
                return `Error: team "${args.team_id}" has only ${team.members.length} member(s). `
                    + `Cannot remove the last member.`
            }

            let staleState = false
            let specError = false
            await team.mutex.runExclusive(async () => {
                // Revalidate inside the mutex: a concurrent
                // startOrchestration may have flipped status live→busy since
                // the outside-mutex check at line 32. Refuse rather than
                // mutating during an active run.
                if (team.status !== "live" || team.spawning) {
                    staleState = true
                    return
                }
                // Re-read config.json INSIDE the mutex so concurrent mutators
                // don't clobber each other's spec changes.
                let spec: TeamSpec | null = null
                try {
                    spec = await readTeamSpec(ctx.storageRoot, args.team_id, pathLeadSessionId)
                } catch {
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
                // Recompute index INSIDE the mutex: a concurrent remove may have
                // shifted the array, making the outside-mutex stateIdx stale.
                const currentIdx = team.members.findIndex(m => m.name === args.member_name)
                if (currentIdx === -1 || team.members.length <= 1) {
                    staleState = true
                    // Restore spec mutation before returning
                    if (specIdx !== -1 && removedSpecMember) spec.members.splice(specIdx, 0, removedSpecMember)
                    return
                }
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
            })

            if (staleState) {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". `
                    + `Members can only be removed before sessions are spawned (workflow calls).`
            }
            if (specError) {
                return `Error: cannot read config for team "${args.team_id}"`
            }

            return `Member "${args.member_name}" removed from team "${args.team_id}" `
                + `(${team.members.length} members remaining).`
        },
    })
}
