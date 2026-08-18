/**
 * team_fix_member tool -- modify a member's name, role, prompt, and/or agent.
 * Changing the agent re-resolves the bound model from the agent registry.
 */

import fs from "node:fs/promises"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { loadTeamState, readTeamSpec, reloadTeamStateLocked, saveTeamState, saveTeamStateBounded, type Team, writeTeamSpec } from "../../state/store.js"
import { indexMember, resolveCallerInTeam, unindexSession } from "../../state/resolve.js"
import { configPath, inboxPath, processedPath, reservedDir, worktreesDir, teamLifecycleLockPath } from "../../state/paths.js"
import { withLock } from "../../state/locks.js"
import { destroyWorktree, hasUncommittedChanges } from "../../state/worktrees.js"
import { listAllTasks, updateTask } from "../../state/tasks.js"
import { OCTEAM_AGENTS, isOCTeamAgent, normalizeRole, roleAgent } from "../../core/role.js"
import type { ActiveTask, TeamSpec, WorkflowStep } from "../../core/types.js"
import { MEMBER_NAME_POOL } from "../../state/naming.js"

/** Rename an optional record key while preserving its value. */
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
            let team: Team
            try {
                team = await loadTeamState(caller.storageRoot, caller.teamName, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
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
                } catch (err) {
                    logSwallowed(ctx, "fixmember: agent registry unavailable", err, { targetAgent })
                    agentsList = []
                }
            }

            let staleState = false
            let renameCollision = false
            let specMissing = false
            let specUnreadable = false
            let stateUnreadable = false
            let memberMissing = false
            let memberRunning = false
            await withLock(teamLifecycleLockPath(team.directory), async () => team.mutex.runExclusive(async () => {
                try {
                    await reloadTeamStateLocked(team)
                } catch (err) {
                    logSwallowed(ctx, "fixmember: team state reload failed", err, { teamName: caller.teamName })
                    stateUnreadable = true
                    return
                }
                // Validate mutable state only after the locked disk refresh.
                if (team.status === "busy" || team.spawning) {
                    staleState = true
                    return
                }
                const liveMember = team.members.find(member => member.name === args.member_name)
                if (!liveMember) {
                    memberMissing = true
                    return
                }
                if (liveMember.status === "running") {
                    memberRunning = true
                    return
                }
                if (renaming && team.members.some(member => member.name === args.new_name && member !== liveMember)) {
                    renameCollision = true
                    return
                }
                // Re-read config.json INSIDE the mutex so concurrent mutators
                // don't clobber each other's spec changes.
                let spec: TeamSpec | null = null
                try {
                    spec = await readTeamSpec(caller.storageRoot, caller.teamName, caller.leadSessionId)
                } catch (err) {
                    logSwallowed(ctx, "fixmember: failed to read team spec", err, { teamName: caller.teamName })
                    specUnreadable = true
                    return
                }
                if (!spec) {
                    try {
                        await fs.access(configPath(team.directory))
                        specUnreadable = true
                        return
                    } catch (err) {
                        if (!isEnoent(err)) {
                            logSwallowed(ctx, "fixmember: failed to inspect team spec", err, { teamName: caller.teamName })
                            specUnreadable = true
                            return
                        }
                    }
                    if (renaming || args.new_role || args.new_prompt) {
                        specMissing = true
                        return
                    }
                }
                const specMember = spec?.members.find(m => m.name === args.member_name)
                if (spec && !specMember) {
                    specMissing = true
                    return
                }

                // Snapshot every field that rollback may need.
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
                            caller.leadSessionId, caller.storageRoot,
                        )
                    }
                    // Worktree destruction is deferred until persistence succeeds
                    // (see the destroy block below) so a write failure can roll back
                    // the member without losing its worktree or session.
                    try {
                        await fs.rename(inboxPath(team.directory, oldName), inboxPath(team.directory, newName))
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                            changes.push(`warning: mailbox rename failed (${err instanceof Error ? err.message : String(err)})`)
                        }
                    }
                    // Rename the processed log and reserved directory with the inbox
                    // to preserve deduplication state and prevent delivery to a future
                    // member with the old name.
                    try {
                        await fs.rename(processedPath(team.directory, oldName), processedPath(team.directory, newName))
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                            changes.push(`warning: processed log rename failed (${err instanceof Error ? err.message : String(err)})`)
                        }
                    }
                    try {
                        await fs.rename(reservedDir(team.directory, oldName), reservedDir(team.directory, newName))
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                            changes.push(`warning: reserved dir rename failed (${err instanceof Error ? err.message : String(err)})`)
                        }
                    }
                    if (team.activeTask) {
                        migrateActiveTaskMemberRefs(team.activeTask, oldName, newName)
                    }
                    // A failed team keeps lastInterruptedTask as the checkpoint used by
                    // team_resume. Migrate the same member references as activeTask so
                    // resume can resolve the renamed actor or verifier.
                    if (team.lastInterruptedTask) {
                        migrateActiveTaskMemberRefs(team.lastInterruptedTask, oldName, newName)
                    }
                    changes.push(`name: ${oldName} → ${newName}`)
                    // Task migration is transactional: if any
                    // update fails, roll back all previously migrated tasks.
                    const migrated: Array<{ id: string; oldOwner: string }> = []
                    try {
                        const tasks = await listAllTasks(team.directory)
                        for (const t of tasks) {
                            if (t.owner === oldName && (t.status === "claimed" || t.status === "in_progress")) {
                                await updateTask(team.directory, t.id, { owner: newName }, {
                                    expectedOwner: oldName,
                                    expectedStatus: t.status as "claimed" | "in_progress",
                                })
                                migrated.push({ id: t.id, oldOwner: oldName })
                            }
                        }
                    } catch (err) {
                        // Rollback all successfully migrated tasks.
                        for (const m of migrated) {
                            try {
                                await updateTask(team.directory, m.id, { owner: m.oldOwner })
                            } catch (rollbackErr) {
                                logSwallowed(ctx, "fixmember: task owner rollback failed", rollbackErr, { taskId: m.id })
                            }
                        }
                        changes.push(`warning: task owner migration failed and rolled back (${err instanceof Error ? err.message : String(err)})`)
                    }
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

                // Defer session deletion for role or prompt changes until
                // persistence succeeds so disk cannot point to a deleted session
                // after a write failure.
                let needsSessionReset = false
                if ((args.new_role || args.new_prompt) && liveMember.sessionId && liveMember.initialized) {
                    needsSessionReset = true
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
                        await writeTeamSpec(caller.storageRoot, spec, caller.leadSessionId, caller.storageRoot)
                        specWritten = true
                    }
                    await saveTeamState(team)
                    return null
                })().catch(e => e as Error)

                if (writeErr) {
                    // Rollback snapshot — capture ALL mutated fields BEFORE any
                    // write attempt so we can restore them atomically on failure.
                    // Restore agent, role, and model fields with rename-related state
                    // so the in-memory member remains aligned with disk after a save failure.
                    if (renaming) {
                        const newName = args.new_name!
                        const oldName = liveMember.name === newName ? args.member_name : newName
                        // Restore member name
                        liveMember.name = args.member_name
                        if (specMember) specMember.name = args.member_name
                        // Restore index
                        if (liveMember.sessionId) {
                            unindexSession(liveMember.sessionId)
                            indexMember(
                                liveMember.sessionId, team.teamName, args.member_name,
                                caller.leadSessionId, caller.storageRoot,
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
                    // Restore agent and model unconditionally, including undefined,
                    // so memory matches disk. Role and prompt stay guarded because
                    // TypeScript treats their snapshots as optional even though
                    // MemberSpec requires strings when the member exists.
                    liveMember.agent = savedAgent
                    liveMember.model = savedModel
                    if (specMember) {
                        specMember.agent = savedAgent
                        specMember.model = savedSpecModel
                        if (savedRole !== undefined) specMember.role = savedRole
                        if (savedPrompt !== undefined) specMember.prompt = savedPrompt
                    }
                    // If config.json was written before the state save failed,
                    // rewrite it with the rolled-back spec. Log compensation
                    // failures without masking the original writeErr.
                    if (specWritten && spec) {
                        try {
                            await writeTeamSpec(caller.storageRoot, spec, caller.leadSessionId, caller.storageRoot)
                        } catch (specRollbackErr) {
                            logSwallowed(
                                ctx,
                                "fixmember: failed to compensate-rewrite config.json after saveTeamState failure",
                                specRollbackErr,
                                { teamName: caller.teamName },
                            )
                        }
                    }
                    throw writeErr
                }
                if (needsSessionReset && liveMember.sessionId) {
                    const oldSid = liveMember.sessionId
                    try {
                        await ctx.client.session.delete({
                            path: { id: oldSid },
                            query: { directory: liveMember.worktreePath ?? ctx.directory },
                        })
                    } catch (err) {
                        if (!isEnoent(err)) {
                            logSwallowed(ctx, "fixmember: deferred session delete failed", err, { member: args.member_name, session: oldSid })
                        }
                    }
                    unindexSession(oldSid)
                    liveMember.sessionId = undefined
                    liveMember.initialized = false
                    try { await saveTeamStateBounded(team) } catch { /* state already saved above */ }
                    changes.push("session: cleared for re-initialization with new role/prompt")
                }
                // Destroy the old worktree only after persistence succeeds. A
                // failure leaves the renamed member consistent, and cleanWorktree
                // can remove the stale worktree during team_delete.
                if (renaming && liveMember.worktreePath) {
                    let destroyed = true
                    // Check for uncommitted changes before force-destroying.
                    try {
                        const dirty = await hasUncommittedChanges(liveMember.worktreePath)
                        if (dirty) {
                            changes.push("warning: worktree has uncommitted changes, NOT destroying")
                            destroyed = false
                        }
                    } catch {
                        // can't check — proceed with destroy
                    }
                    if (destroyed) try {
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
                        // Unindex the old session and persist the cleared fields so
                        // a restart cannot reload the destroyed worktree as active.
                        changes.push(`worktree: destroyed old (will re-create on next start)`)
                    } else {
                        changes.push(`worktree: WARNING old worktree destroy failed; stale worktree left in place`)
                    }
                }
                // Persist teardown with bounded retries because the in-memory
                // worktree and session fields are already cleared. Surface a final
                // failure so the caller knows disk may still reference the destroyed
                // worktree.
                try {
                    await saveTeamStateBounded(team)
                } catch (teardownErr) {
                    logSwallowed(
                        ctx,
                        "fixmember: teardown save failed; disk may still reference destroyed worktree/session",
                        teardownErr,
                        { teamName: caller.teamName, member: liveMember.name },
                        "error",
                    )
                    throw teardownErr
                }
            }), team.directory)

            if (stateUnreadable) {
                return `Error: team "${args.team_id}" could not be reloaded (state file unreadable)`
            }
            if (staleState) {
                return `Error: team "${args.team_id}" is busy. `
                    + `Wait for the workflow to finish before modifying members.`
            }
            if (renameCollision) {
                return `Error: name "${args.new_name}" already exists in this team`
            }
            if (memberMissing) {
                return `Error: member "${args.member_name}" not found in team "${args.team_id}"`
            }
            if (memberRunning) {
                return `Error: member "${args.member_name}" is currently running. `
                    + `Wait for it to finish before modifying.`
            }
            if (specUnreadable) {
                return "Error: cannot modify member — team config (config.json) is unreadable"
            }
            if (specMissing) {
                return "Error: cannot modify member — team config is absent or member missing from spec"
            }

            return `Member "${args.member_name}" updated — ${changes.join("; ")}`
        },
    })
}
