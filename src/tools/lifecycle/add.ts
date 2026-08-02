/**
 * team_add_member tool -- add a member to an existing team (live status only).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import type { PluginContext } from "../../core/context.js"
import { loadTeamState, readTeamSpec, reloadTeamStateLocked, saveTeamState, type Team, writeTeamSpec } from "../../state/store.js"
import { isIndexedMasterOf } from "../../state/resolve.js"
import { withLock } from "../../state/locks.js"
import { teamLifecycleLockPath } from "../../state/paths.js"
import { normalizeRole, roleAgent } from "../../core/role.js"
import type { MemberSpec, MemberState, TeamSpec } from "../../core/types.js"
import { MEMBER_NAME_POOL } from "../../state/naming.js"
import { validateMemberAgent, validateMemberName } from "../support.js"

/** Add a member to an existing live team with auto-picked or explicit name. */
export function teamAddMemberTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Add a member to an existing team. Only allowed when team status is \"live\" " +
            "(sessions not yet spawned) and only by the master session. The new member's " +
            "name is auto-picked from the preset pool if not specified, and must not " +
            "duplicate any existing member in the team.",
        args: {
            team_id: tool.schema.string().min(1),
            name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/).optional(),
            role: tool.schema.string().min(1).max(64).regex(
                /^[a-zA-Z]+$/,
                "a single English word, letters only, e.g. \"coder\"",
            ),
            prompt: tool.schema.string().min(1).max(8192),
            model: tool.schema.string().optional(),
            agent: tool.schema.string().optional(),
            worktree: tool.schema.boolean().optional(),
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
                return "Error: team_add_member is master-only (only the team's leader can add members)"
            }
            if (args.name) {
                const nameErr = validateMemberName(args.name)
                if (nameErr) return nameErr
            }

            // Agent override (optional): must be one of OCTeam's hardened oct-*
            // agents. A bare host agent (e.g. "build") would bypass the
            // role->agent permission-hardening chokepoint (role.ts).
            if (args.agent !== undefined) {
                const err = validateMemberAgent(args.agent)
                if (err) return err
            }

            const role = normalizeRole(args.role)
            const agent = args.agent ?? roleAgent(role)

            let memberName: string | undefined
            let staleState = false
            let capReached = false
            let specError = false
            let stateError = false
            let nameError: string | undefined
            await withLock(teamLifecycleLockPath(team.directory), async () => team.mutex.runExclusive(async () => {
                try {
                    await reloadTeamStateLocked(team)
                } catch (err) {
                    logSwallowed(ctx, "team_add_member: team state reload failed", err, { team: args.team_id })
                    stateError = true
                    return
                }
                // Validate mutable state only after the locked disk refresh.
                if (team.status !== "live" || team.spawning) {
                    staleState = true
                    return
                }
                // Two concurrent add calls must not exceed maxMembers.
                if (team.members.length >= team.bounds.maxMembers) {
                    capReached = true
                    return
                }
                const existingNames = new Set(team.members.map(member => member.name))
                if (args.name) {
                    if (existingNames.has(args.name)) {
                        nameError = `Error: name "${args.name}" already exists in team "${args.team_id}"`
                        return
                    }
                    memberName = args.name
                } else {
                    const pool = (MEMBER_NAME_POOL as readonly string[]).filter(name => !existingNames.has(name))
                    if (pool.length === 0) {
                        nameError = "Error: no available names left in the pool (all taken by existing members)"
                        return
                    }
                    memberName = pool[Math.floor(Math.random() * pool.length)]
                }
                const newSpec: MemberSpec = {
                    name: memberName,
                    role,
                    prompt: args.prompt,
                    agent,
                    model: args.model,
                    worktree: args.worktree,
                }
                const newState: MemberState = {
                    name: memberName,
                    status: "pending",
                    initialized: false,
                    turnCount: 0,
                    model: args.model,
                    agent,
                }
                // Re-read config.json INSIDE the mutex so concurrent mutators
                // (e.g. a parallel add/remove) don't clobber each other's spec
                // changes. Reading outside the lock would produce a stale
                // snapshot whose writeTeamSpec overwrites another op's changes.
                let spec: TeamSpec | null = null
                try {
                    spec = await readTeamSpec(ctx.storageRoot, args.team_id, pathLeadSessionId)
                } catch (err) {
                    logSwallowed(ctx, "team_add_member: team spec unreadable", err, { team: args.team_id })
                    specError = true
                    return
                }
                if (!spec) {
                    specError = true
                    return
                }
                spec.members.push(newSpec)
                team.members.push(newState)

                try {
                    await writeTeamSpec(ctx.storageRoot, spec, pathLeadSessionId, ctx.storageRoot)
                } catch (err) {
                    // Config write failed — nothing on disk, full rollback.
                    spec.members.pop()
                    team.members.pop()
                    throw err
                }
                try {
                    await saveTeamState(team)
                } catch (err) {
                    // State write failed but config was already written.
                    // Rollback memory, then compensating write to revert
                    // config.json so disk stays consistent.
                    spec.members.pop()
                    team.members.pop()
                    try {
                        await writeTeamSpec(ctx.storageRoot, spec, pathLeadSessionId, ctx.storageRoot)
                    } catch (compensateErr) {
                        logSwallowed(ctx, "add: compensating spec revert failed after state save failure", compensateErr, { team: args.team_id })
                    }
                    throw err
                }
            }), team.directory)

            if (stateError) {
                return `Error: team "${args.team_id}" could not be reloaded (state file unreadable)`
            }
            if (staleState) {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". `
                    + `Members can only be added before sessions are spawned (workflow calls).`
            }
            if (capReached) {
                return `Error: team already has ${team.bounds.maxMembers} members (maximum)`
            }
            if (specError) {
                return `Error: cannot read config for team "${args.team_id}"`
            }
            if (nameError) return nameError
            if (!memberName) return `Error: team "${args.team_id}" changed while adding member`

            return `Member "${memberName}" added to team "${args.team_id}" (${team.members.length} members).`
        },
    })
}
