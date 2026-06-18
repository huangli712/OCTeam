/**
 * Dispatch primitives: ensureMembersReady (spawn + role-setup barrier) and
 * advanceToStage (dispatch one stage's task, prefixing prior output).
 *
 * CRITICAL lock-order (design §4.1): ensureMembersReady MUST run OUTSIDE the
 * team mutex. Its role-setup barrier waits for the event handler to flip
 * member.initialized, which the event handler does INSIDE team.mutex.runExclusive.
 * Holding the mutex here would deadlock the barrier.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { PluginContext } from "../context.js"
import type { Team } from "../state/store.js"
import { readTeamSpec, saveTeamState } from "../state/store.js"
import { worktreePath } from "../state/paths.js"
import { buildRolePrompt, chunk, indexMember, truncateOutput, waitUntil } from "../utils.js"
import type { Stage } from "../types.js"

const execFileP = promisify(execFile)

const ROLE_SETUP_BARRIER_TIMEOUT_MS = 120_000

/**
 * Create an isolated git worktree for a member: `git worktree add <path> -b team/<team>/<member>`.
 * Only called when the member spec has worktree: true. Runs git in the project
 * directory; the worktree path lives under the team's worktrees/ dir.
 */
async function createWorktree(
    projectDir: string,
    teamDirectory: string,
    teamName: string,
    memberName: string,
): Promise<string> {
    const dest = worktreePath(teamDirectory, memberName)
    const branch = `team/${teamName}/${memberName}`
    // Fail fast if branch/worktree already exists; team_create idempotency is
    // handled by the caller checking member.worktreePath.
    await execFileP("git", ["worktree", "add", dest, "-b", branch], {
        cwd: projectDir,
    }).catch(err => {
        throw new Error(
            `createWorktree(${memberName}) failed: ${err instanceof Error ? err.message : String(err)}`,
        )
    })
    return dest
}

/**
 * Spawn (or reuse) member sessions and wait for every spawned member to idle
 * once on its role-setup prompt (the role-setup barrier, B3). After this
 * returns, all members are `initialized: true` and idle, ready for the first
 * real dispatch.
 *
 * MUST be called OUTSIDE team.mutex (see file header).
 */
export async function ensureMembersReady(ctx: PluginContext, team: Team): Promise<void> {
    const toSpawn = team.members.filter(m => !m.sessionId)
    if (toSpawn.length === 0) return // team reused; all sessions live & initialized

    const spec = await readTeamSpec(ctx.storageRoot, team.teamName)
    if (!spec) throw new Error(`ensureMembersReady: no config.json for team "${team.teamName}"`)
    const specByName = new Map(spec.members.map(m => [m.name, m]))
    const peerNames = spec.members.map(m => m.name)

    for (const batch of chunk(toSpawn, team.bounds.maxParallelMembers)) {
        await Promise.all(
            batch.map(async member => {
                const memberSpec = specByName.get(member.name)
                // 1. Worktree (only if configured)
                if (memberSpec?.worktree) {
                    member.worktreePath = await createWorktree(
                        ctx.directory,
                        team.directory,
                        team.teamName,
                        member.name,
                    )
                }
                // 2. Create child session linked to leader
                const result = await ctx.client.session.create({
                    body: {
                        parentID: team.leadSessionId,
                        title: `${team.teamName}/${member.name}`,
                    },
                    query: { directory: member.worktreePath ?? ctx.directory },
                })
                const sessionId = result.data?.id
                if (!sessionId) throw new Error(`session.create returned no id for ${member.name}`)
                member.sessionId = sessionId
                // S1: index the freshly spawned session so its role-setup idle
                // resolves to this member. Without this, resolveTeamMember returns
                // null in the event handler, member.initialized never flips, and the
                // role-setup barrier below spins until timeout (every workflow fails).
                indexMember(sessionId, team.teamName, member.name, team.leadSessionId, ctx.storageRoot)
                member.status = "running" // running role-setup, NOT yet idle
                member.initialized = false
                // 3. Send role-setup prompt (members idle when done)
                const rolePrompt = memberSpec
                    ? buildRolePrompt(memberSpec, team.teamName, peerNames)
                    : `You are "${member.name}" on team "${team.teamName}". Acknowledge, then stop.`
                await ctx.client.session.promptAsync({
                    path: { id: sessionId },
                    body: {
                        parts: [{ type: "text", text: rolePrompt, synthetic: true }],
                        agent: member.agent ?? "build",
                    },
                })
                member.turnCount = 1
            }),
        )
        // Persist each batch so a crash mid-spawn leaves recoverable state.
        await saveTeamState(team)
    }

    // 4. ROLE-SETUP BARRIER: wait until every spawned member has idled once.
    //    The event handler flips member.initialized on the first idle of an
    //    uninitialized member and returns WITHOUT capturing output or advancing.
    await waitUntil(
        () => toSpawn.every(m => team.members.find(x => x.name === m.name)?.initialized),
        { timeoutMs: ROLE_SETUP_BARRIER_TIMEOUT_MS },
    ).catch(async () => {
        // Mark non-idle members errored; the caller reports the failure.
        for (const m of toSpawn) {
            const cur = team.members.find(x => x.name === m.name)
            if (cur && !cur.initialized) {
                cur.status = "errored"
                cur.error = "role-setup barrier timed out"
            }
        }
        // L3: persist the errored state before throwing so a restart sees it
        // (the tool handler aborts before its Phase 3 saveTeamState).
        await saveTeamState(team).catch(() => {})
        throw new Error("ensureMembersReady: role-setup barrier timed out")
    })
}

/**
 * Dispatch a single stage's task to its member, prefixing the prior stage's
 * (or decider's) captured output. Sets member.status = "running" and bumps
 * turnCount. Shared by pipeline and loop rounds.
 */
export async function advanceToStage(
    ctx: PluginContext,
    team: Team,
    stage: Stage,
    contextPrefix?: string,
): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const member = team.members.find(m => m.name === stage.member)
    if (!member || !member.sessionId) {
        throw new Error(`advanceToStage: member "${stage.member}" has no session`)
    }
    const prevIdx = task.currentStageIndex - 1
    const prev = prevIdx >= 0 ? task.responses[task.stages[prevIdx].member] : null
    const base = prev
        ? `[Prior output]\n${truncateOutput(prev)}\n\n[Your task]\n${stage.task}`
        : stage.task
    // contextPrefix carries cross-round feedback (e.g. the decider's decision in a
    // loop) so the next round is actually corrective rather than re-asking verbatim.
    const text = contextPrefix ? `${contextPrefix}\n\n${base}` : base
    await ctx.client.session.promptAsync({
        path: { id: member.sessionId },
        body: {
            parts: [{ type: "text", text, synthetic: true }],
            agent: member.agent ?? "build",
        },
        // H2: members work in the PROJECT dir (or their worktree), never the
        // .octeam state dir. session.create already used ctx.directory.
        query: { directory: member.worktreePath ?? ctx.directory },
    })
    member.status = "running"
    member.turnCount++
}
