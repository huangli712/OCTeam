/**
 * team_fix_member tool -- modify a member's name, role, prompt, and/or agent.
 * Changing the agent re-resolves the bound model from the agent registry.
 */

import fs from "node:fs/promises"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { logger } from "../../core/log.js"
import { loadTeamState, readTeamSpec, saveTeamState, saveTeamStateBounded, writeTeamSpec } from "../../state/store.js"
import { indexMember, resolveCallerInTeam, unindexSession } from "../../state/resolve.js"
import { inboxPath, worktreesDir } from "../../state/paths.js"
import { destroyWorktree } from "../../state/worktrees.js"
import { OCTEAM_AGENTS, isOCTeamAgent, normalizeRole, roleAgent } from "../../core/role.js"
import type { ActiveTask, TeamSpec, WorkflowStep } from "../../core/types.js"
import { MEMBER_NAME_POOL } from "../../state/naming.js"

/**
 * C-19: migrate all member-name references inside an ActiveTask when a member
 * is renamed. Used for both activeTask and lastInterruptedTask so a rename on
 * a failed team does not break the preserved checkpoint.
 */
function renameRecordKey<T>(record: Record<string, T> | undefined, oldName: string, newName: string): void {
    const value = record?.[oldName]
    if (record === undefined || value === undefined) return
    record[newName] = value
    delete record[oldName]
}

function migrateWorkflowStepMemberRefs(step: WorkflowStep, oldName: string, newName: string): void {
    if (step.dispatchedActor === oldName) step.dispatchedActor = newName
    switch (step.kind) {
        case "task":
            if (step.member === oldName) step.member = newName
            if (step.fallbackMember === oldName) step.fallbackMember = newName
            return
        case "gate":
            if (step.verifier === oldName) step.verifier = newName
            if (step.fallbackVerifier === oldName) step.fallbackVerifier = newName
            if (step.verifiers !== undefined) {
                step.verifiers = step.verifiers.map(name => name === oldName ? newName : name)
            }
            renameRecordKey(step.ensembleResults, oldName, newName)
            return
        case "fanout":
            if (step.fanout.reducerMember === oldName) {
                step.fanout = { ...step.fanout, reducerMember: newName }
            }
            return
        case "join":
            if (step.join.reducerMember === oldName) {
                step.join = { ...step.join, reducerMember: newName }
            }
            return
        default:
            step satisfies never
    }
}

function migrateActiveTaskMemberRefs(task: ActiveTask, oldName: string, newName: string): void {
    renameRecordKey(task.tokensByMember, oldName, newName)
    renameRecordKey(task.tokenBaselineByMember, oldName, newName)
    renameRecordKey(task.responses, oldName, newName)
    renameRecordKey(task.signoffApprovals, oldName, newName)
    renameRecordKey(task.signoffParseFailures, oldName, newName)
    renameRecordKey(task.signoffRawOutputs, oldName, newName)
    if (task.reducerMember === oldName) task.reducerMember = newName
    if (task.signoffDecider === oldName) task.signoffDecider = newName
    if (task.signoffReviewers !== undefined) {
        task.signoffReviewers = task.signoffReviewers.map(name => name === oldName ? newName : name)
    }
    if (task.approvalRequest?.member === oldName) task.approvalRequest.member = newName
    for (const stage of task.stages) {
        if (stage.member === oldName) stage.member = newName
    }

    switch (task.type) {
        case "parallel":
            renameRecordKey(task.tasks, oldName, newName)
            return
        case "pipeline":
        case "delegate":
        case "consensus":
            return
        case "loop":
            if (task.deciderMember === oldName) task.deciderMember = newName
            return
        case "route":
            if (task.routerMember === oldName) task.routerMember = newName
            for (const branch of task.routeBranches ?? []) {
                if (branch.member === oldName) branch.member = newName
            }
            if (task.routeTargets !== undefined) {
                task.routeTargets = task.routeTargets.map(name => name === oldName ? newName : name)
            }
            return
        case "arbitrate":
            if (task.arbiterMember === oldName) task.arbiterMember = newName
            if (task.disputants !== undefined) {
                task.disputants = task.disputants.map(name => name === oldName ? newName : name)
            }
            return
        case "recurse":
            if (task.decomposerMember === oldName) task.decomposerMember = newName
            return
        case "tollgate":
            for (const stage of task.gatedStages ?? []) {
                if (stage.member === oldName) stage.member = newName
                if (stage.verifier === oldName) stage.verifier = newName
            }
            if (task.escalateTo === oldName) task.escalateTo = newName
            return
        case "workflow":
            for (const step of task.steps ?? []) {
                migrateWorkflowStepMemberRefs(step, oldName, newName)
            }
            return
        case "arena":
            if (task.evaluatorMember === oldName) task.evaluatorMember = newName
            task.candidates = task.candidates.map(name => name === oldName ? newName : name)
            if (task.survivingCandidates !== undefined) {
                task.survivingCandidates = task.survivingCandidates.map(name => name === oldName ? newName : name)
            }
            for (const score of task.scoreboard?.scores ?? []) {
                if (score.member === oldName) score.member = newName
            }
            if (task.winner === oldName) task.winner = newName
            return
        case "quorum":
            task.participants = task.participants.map(name => name === oldName ? newName : name)
            renameRecordKey(task.ballots, oldName, newName)
            return
        default:
            task satisfies never
    }
}

/** Modify a team member's name, role, prompt, or agent. */
export function teamFixMemberTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Modify a team member's name, role, system prompt, and/or agent. new_role must be a preset role "
            + `(unknown → "reviewer", read-only) and re-derives the member's agent unless new_agent is also given. `
            + "new_name must be a preset pool name. Changing the agent re-resolves the model from the agent registry. "
            + "Only allowed when the team is not busy and the target member is not running.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
            new_name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/).optional(),
            new_role: tool.schema.string().min(1).max(64).regex(
                /^[a-zA-Z]+$/,
                "a single English word, letters only, e.g. \"coder\"",
            ).optional(),
            new_prompt: tool.schema.string().min(1).max(8192).optional(),
            new_agent: tool.schema.string().min(1).optional(),
        },
        async execute(args, context) {
            if (!args.new_name && !args.new_role && !args.new_prompt && !args.new_agent) {
                return "Error: provide at least one of new_name, new_role, new_prompt, or new_agent"
            }
            const caller = await resolveCallerInTeam(
                ctx.storageRoot, context.sessionID, args.team_id, { requireActive: false },
            )
            if (!caller) {
                return "Error: caller is not a member of this team"
            }
            if (!caller.isMaster) {
                return "Error: team_fix_member is master-only (only the team's leader session can modify members)"
            }
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            if (team.status === "busy") {
                return `Error: team "${args.team_id}" is busy. `
                    + `Wait for the workflow to finish before modifying members.`
            }
            const member = team.members.find(m => m.name === args.member_name)
            if (!member) return `Error: member "${args.member_name}" not found in team "${args.team_id}"`
            if (member.status === "running") {
                return `Error: member "${args.member_name}" is currently running. `
                    + `Wait for it to finish before modifying.`
            }

            // Agent override (optional): must be one of OCTeam's hardened oct-*
            // agents. A bare host agent (e.g. "build") would bypass the
            // role->agent permission-hardening chokepoint (role.ts).
            if (args.new_agent !== undefined && !isOCTeamAgent(args.new_agent)) {
                return `Error: agent "${args.new_agent}" is not a hardened oct-* agent. `
                    + `Members must run as one of: ${OCTEAM_AGENTS.join(", ")}. `
                    + `Omit 'new_agent' to derive it from the role.`
            }

            // Validate new_name BEFORE taking the lock.
            const renaming = !!(args.new_name && args.new_name !== args.member_name)
            if (renaming) {
                if (!(MEMBER_NAME_POOL as readonly string[]).includes(args.new_name!)) {
                    return `Error: name "${args.new_name}" is not a preset pool name. `
                        + `Choose one of: ${MEMBER_NAME_POOL.join(", ")}`
                }
                if (team.members.some(m => m.name === args.new_name)) {
                    return `Error: name "${args.new_name}" already exists in this team`
                }
            }

            const changes: string[] = []

            // Pre-fetch agent registry OUTSIDE the mutex — this API call can
            // be slow (network/IPC) and would block all team operations while
            // the mutex is held. Only needed when changing agent/role.
            let agentsList: Array<{ name: string; model?: { providerID: string; modelID: string } }> = []
            const targetAgent = args.new_agent ?? (args.new_role ? roleAgent(normalizeRole(args.new_role)) : undefined)
            if (targetAgent) {
                try {
                    agentsList = (await ctx.client.app.agents({ query: { directory: ctx.directory } })).data ?? []
                } catch {
                    agentsList = []
                }
            }

            let staleState = false
            let renameCollision = false
            let specMissing = false
            await team.mutex.runExclusive(async () => {
                // Revalidate inside the mutex: a concurrent
                // startOrchestration may have flipped status to "busy" since
                // the outside-mutex check at line 43. Refuse rather than
                // modifying members during an active run.
                if (team.status === "busy" || team.spawning) {
                    staleState = true
                    return
                }
                // Re-read config.json INSIDE the mutex so concurrent mutators
                // don't clobber each other's spec changes.
                let spec: TeamSpec | null = null
                try {
                    spec = await readTeamSpec(ctx.storageRoot, caller.teamName, caller.leadSessionId)
                } catch (err) {
                    logger.warn("fixmember: failed to read team spec", { teamName: caller.teamName, error: String(err) })
                }
                const specMember = spec?.members.find(m => m.name === args.member_name)

                // Re-check name collision INSIDE the mutex: a concurrent
                // fixmember could have renamed another member to the same
                // new_name since the outside-mutex check at line 88.
                if (renaming && team.members.some(m => m.name === args.new_name && m !== member)) {
                    renameCollision = true
                    return
                }
                // H59: re-find the member INSIDE the mutex. The `member` reference
                // at line 65 was obtained outside the lock; a concurrent
                // team_remove_member could have removed it since. Operating on the
                // stale reference would mutate a member that no longer belongs to
                // the team, and the subsequent save would silently drop the change.
                const liveMember = team.members.find(m => m.name === args.member_name)
                if (!liveMember) {
                    staleState = true
                    return
                }
                // If renaming, the spec must be readable and contain the
                // member — otherwise config.json would retain the old name
                // after rename, creating a state/spec inconsistency.
                if (renaming && !specMember) {
                    specMissing = true
                    return
                }

                // --- H-23: snapshot all fields that will be mutated, for complete rollback ---
                const savedAgent = liveMember.agent
                const savedModel = liveMember.model
                const savedRole = specMember?.role
                const savedPrompt = specMember?.prompt
                const savedSpecModel = specMember?.model

                // --- new_name: rename member across state, spec, index, mailbox ---
                if (renaming) {
                    const newName = args.new_name!
                    const oldName = liveMember.name
                    liveMember.name = newName
                    if (specMember) specMember.name = newName
                    if (liveMember.sessionId) {
                        unindexSession(liveMember.sessionId)
                        indexMember(
                            liveMember.sessionId, team.teamName, newName,
                            caller.leadSessionId, ctx.storageRoot,
                        )
                    }
                    // H-T2/H-T6: worktree destroy deferred to AFTER successful
                    // persistence (see below). Pre-fix code destroyed here,
                    // but a subsequent writeTeamState/saveTeamState failure
                    // left the member with no worktree and no session, and
                    // rollback couldn't restore them.
                    try {
                        await fs.rename(inboxPath(team.directory, oldName), inboxPath(team.directory, newName))
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                            changes.push(`warning: mailbox rename failed (${err instanceof Error ? err.message : String(err)})`)
                        }
                    }
                    if (team.activeTask) {
                        migrateActiveTaskMemberRefs(team.activeTask, oldName, newName)
                    }
                    // C-19: a failed team carries lastInterruptedTask (the
                    // checkpoint preserved by reconcile.ts for team_resume).
                    // Pre-fix code only migrated activeTask references, so
                    // renaming a member on a failed team left the checkpoint
                    // pointing at the old name → team_resume could not resolve
                    // the actor/verifier and immediately failed the recovered
                    // run. Apply the same migration to lastInterruptedTask.
                    if (team.lastInterruptedTask) {
                        migrateActiveTaskMemberRefs(team.lastInterruptedTask, oldName, newName)
                    }
                    changes.push(`name: ${oldName} → ${newName}`)
                }

                // M-FIXMEMBER: if spec is unreadable but the user requested
                // spec-only changes (new_role/new_prompt), fail explicitly
                // rather than silently skipping and returning success.
                if (!spec && (args.new_role || args.new_prompt)) {
                    specMissing = true
                    return
                }

                // --- new_role: normalize to a preset role ---
                if (args.new_role && specMember) {
                    specMember.role = normalizeRole(args.new_role)
                    changes.push(`role: ${specMember.role}`)
                }

                // --- new_prompt: spec only ---
                if (args.new_prompt && specMember) {
                    specMember.prompt = args.new_prompt
                    changes.push("prompt: updated")
                }

                // --- agent: explicit new_agent wins; otherwise a changed role
                // re-derives the agent. The agent registry was pre-fetched outside the mutex.
                if (targetAgent) {
                    liveMember.agent = targetAgent
                    if (specMember) specMember.agent = targetAgent
                    const entry = agentsList.find(a => a.name === targetAgent)
                    if (entry?.model) {
                        const m = `${entry.model.providerID}/${entry.model.modelID}`
                        liveMember.model = m
                        if (specMember) specMember.model = m
                        changes.push(`agent: ${targetAgent}, model: ${m}`)
                    } else if (agentsList.length > 0) {
                        changes.push(`agent: ${targetAgent} (no bound model — model unchanged)`)
                    } else {
                        changes.push(`agent: ${targetAgent} (registry unavailable — model unchanged)`)
                    }
                }

                // Write spec FIRST so that if saveTeamState fails, the
                // disk state.json (runtime source of truth) retains the old
                // values while config.json has the new ones — strictly better
                // than the reverse where state.json is ahead of config.json.
                let specWritten = false
                const writeErr = await (async () => {
                    if (spec) {
                        await writeTeamSpec(ctx.storageRoot, spec, caller.leadSessionId, ctx.storageRoot)
                        specWritten = true
                    }
                    await saveTeamState(team)
                    return null
                })().catch(e => e as Error)

                if (writeErr) {
                    // Rollback snapshot — capture ALL mutated fields BEFORE any
                    // write attempt so we can restore them atomically on failure.
                    // H-23: the pre-fix code restored rename-related fields but
                    // left agent/role/model mutations in place, so a saveTeamState
                    // failure left the in-memory object with agent/model changes
                    // that the next unrelated save would silently persist.
                    if (renaming) {
                        const newName = args.new_name!
                        const oldName = member.name === newName ? args.member_name : newName
                        // Restore member name
                        liveMember.name = args.member_name
                        if (specMember) specMember.name = args.member_name
                        // Restore index
                        if (liveMember.sessionId) {
                            unindexSession(liveMember.sessionId)
                            indexMember(
                                liveMember.sessionId, team.teamName, args.member_name,
                                caller.leadSessionId, ctx.storageRoot,
                            )
                        }
                        if (team.activeTask) {
                            migrateActiveTaskMemberRefs(team.activeTask, newName, oldName)
                        }
                        if (team.lastInterruptedTask) {
                            migrateActiveTaskMemberRefs(team.lastInterruptedTask, newName, oldName)
                        }
                        try {
                            await fs.rename(
                                inboxPath(team.directory, newName),
                                inboxPath(team.directory, args.member_name),
                            )
                        } catch (err) {
                            if (!isEnoent(err)) {
                                logSwallowed(ctx, "fixmember: mailbox rollback rename failed", err, { newName, oldName: args.member_name })
                            }
                        }
                    }
                    // H-23: restore agent/model mutations too. Pre-fix code
                    // guarded each restore on `savedX !== undefined`, which
                    // skipped restoration when the original value was absent —
                    // the new value then silently persisted via the next
                    // unrelated save. Restore agent/model unconditionally
                    // (including back to undefined) so the in-memory object
                    // matches disk. role/prompt are required strings on
                    // MemberSpec, so we keep the undefined-guard for them
                    // (when specMember exists, savedRole/savedPrompt are
                    // always strings, but TS cannot infer that across the
                    // earlier nullish-coalesce snapshot).
                    liveMember.agent = savedAgent
                    liveMember.model = savedModel
                    if (specMember) {
                        specMember.agent = savedAgent
                        specMember.model = savedSpecModel
                        if (savedRole !== undefined) specMember.role = savedRole
                        if (savedPrompt !== undefined) specMember.prompt = savedPrompt
                    }
                    // H-23: if config.json was already written (specWritten=true)
                    // but state.json save failed, the spec on disk still holds
                    // the new values while we just rolled them back in memory.
                    // Compensate by re-writing config.json with the rolled-back
                    // spec so disk and memory agree. A failure here is logged
                    // but does not mask the original writeErr.
                    if (specWritten && spec) {
                        try {
                            await writeTeamSpec(ctx.storageRoot, spec, caller.leadSessionId, ctx.storageRoot)
                        } catch (specRollbackErr) {
                            logger.warn("fixmember: failed to compensate-rewrite config.json after saveTeamState failure", {
                                teamName: caller.teamName,
                                error: specRollbackErr instanceof Error ? specRollbackErr.message : String(specRollbackErr),
                            })
                        }
                    }
                    throw writeErr
                }
                // H-T6: NOW safe to destroy old worktree after successful
                // persistence. If this fails, the member still has name/index/
                // spec correctly updated; the stale worktree is a benign orphan
                // that cleanWorktree will eventually clear on team_delete.
                if (renaming && liveMember.worktreePath) {
                    let destroyed = true
                    try {
                        await destroyWorktree(
                            ctx.directory,
                            liveMember.worktreePath,
                            worktreesDir(team.directory),
                            team.teamName,
                            args.member_name,
                        )
                    } catch (err) {
                        destroyed = false
                        logSwallowed(ctx, "fixmember: old worktree destroy failed", err, { member: args.member_name }, "debug")
                    }
                    // Only clear worktree/session state when the destroy actually
                    // succeeded. If it failed, the worktree still exists on disk,
                    // so clearing worktreePath/sessionId would report success while
                    // orphaning a live worktree; keep the fields and warn instead.
                    if (destroyed) {
                        liveMember.worktreePath = undefined
                        if (liveMember.sessionId) {
                            unindexSession(liveMember.sessionId)
                        }
                        liveMember.sessionId = undefined
                        liveMember.initialized = false
                        // H5: unindex the old session and persist the cleared state.
                        // Pre-fix code cleared fields in memory but didn't save —
                        // a process restart would reload the old sessionId from
                        // disk, making the destroyed worktree appear active.
                        changes.push(`worktree: destroyed old (will re-create on next start)`)
                    } else {
                        changes.push(`worktree: WARNING old worktree destroy failed; stale worktree left in place`)
                    }
                }
                // G: teardown-save with bounded retry. Pre-fix code used bare
                // saveTeamState which swallows save failures silently — if
                // this save fails, the in-memory worktree/session fields are
                // already cleared but disk still references the destroyed
                // worktree, so a restart would fail to spawn the member.
                // saveTeamStateBounded retries 3x before throwing; on throw
                // we surface the error so the caller knows the member state
                // may be inconsistent.
                try {
                    await saveTeamStateBounded(team)
                } catch (teardownErr) {
                    logger.error("fixmember: teardown save failed; disk may still reference destroyed worktree/session", {
                        teamName: caller.teamName,
                        member: liveMember.name,
                        error: teardownErr instanceof Error ? teardownErr.message : String(teardownErr),
                    })
                    throw teardownErr
                }
            })

            if (staleState) {
                return `Error: team "${args.team_id}" is busy. `
                    + `Wait for the workflow to finish before modifying members.`
            }
            if (renameCollision) {
                return `Error: name "${args.new_name}" already exists in this team`
            }
            if (specMissing) {
                return `Error: cannot modify member — team config (config.json) is unreadable or member absent from spec`
            }

            return `Member "${args.member_name}" updated — ${changes.join("; ")}`
        },
    })
}
