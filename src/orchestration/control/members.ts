/**
 * Member readiness transaction: create worktrees and sessions, deliver role
 * prompts, wait for initialization, and roll back partial spawn failures.
 *
 * Must run outside team.mutex because idle initialization acquires that mutex.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import { safeMemberAgent } from "../../core/role.js"
import type { MemberSpec, MemberState } from "../../core/types.js"
import { chunk, waitUntil } from "../../core/utils.js"
import { worktreesDir } from "../../state/paths.js"
import { indexMember, unindexSession } from "../../state/resolve.js"
import { type Team, readTeamSpec, saveTeamState } from "../../state/store.js"
import { cleanWorktree, createWorktree } from "../../state/worktrees.js"
import { buildRolePrompt } from "../protocol/output.js"

// Promisified execFile for git branch deletion during worktree cleanup.
const execFileP = promisify(execFile)

// Max milliseconds to wait for all non-master members to reach initialized state.
const ROLE_SETUP_BARRIER_TIMEOUT_MS = 120_000

/**
 * Snapshot the spawn work and readiness-barrier set for a team.
 *
 * `toSpawn` captures members without a session id; `waitNames` is the broader
 * set of non-master members that still need to reach the initialized state
 * before dispatch may begin.
 */
function planMemberSpawn(team: Team): {
    toSpawn: MemberState[]
    waitNames: Set<string>
} {
    const toSpawn = team.members.filter((member) => !member.sessionId)
    const waitNames = new Set(
        team.members
            .filter((member) => !member.isMaster && (!member.sessionId || !member.initialized))
            .map((member) => member.name),
    )
    return { toSpawn, waitNames }
}

/**
 * Spawn one member's session and deliver its role prompt.
 *
 * Worktree creation, session creation, and role-prompt delivery form one
 * transaction: on any failure, every side effect is rolled back before the
 * error is re-thrown.
 */
async function spawnMemberSafely(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    specByName: Map<string, MemberSpec>,
    peerNames: string[],
): Promise<void> {
    const memberSpec = specByName.get(member.name)
    let worktreeCreated = false
    if (memberSpec?.worktree) {
        member.worktreePath = await createWorktree(
            ctx.directory,
            team.directory,
            team.teamName,
            member.name,
        )
        worktreeCreated = true
    }
    try {
        // Session creation and role-prompt delivery form one transaction.
        const result = await ctx.client.session.create({
            body: {
                parentID: team.leadSessionId,
                title: `${team.teamName}/${member.name}`,
            },
            query: { directory: member.worktreePath ?? ctx.directory },
        })
        const sessionId = result.data?.id
        if (!sessionId) {
            throw new Error(`session.create returned no id for ${member.name}`)
        }
        member.sessionId = sessionId
        member.prompt = memberSpec?.prompt
        member.promptDelivered = false
        indexMember(
            sessionId,
            team.teamName,
            member.name,
            team.leadSessionId,
            ctx.storageRoot,
        )
        member.status = "running"
        member.initialized = false
        const rolePrompt = memberSpec
            ? buildRolePrompt(memberSpec, team.teamName, peerNames)
            : `You are "${member.name}" on team "${team.teamName}". Acknowledge, then stop.`
        await ctx.client.session.promptAsync({
            path: { id: sessionId },
            body: {
                parts: [
                    {
                        type: "text",
                        text: `${rolePrompt}\n<!-- OMO_INTERNAL_INITIATOR -->`,
                        synthetic: true,
                    },
                ],
                agent: safeMemberAgent(member.agent),
            },
        })
        member.turnCount = 1
    } catch (err) {
        // Roll back every side effect before exposing the spawn error.
        if (member.sessionId) {
            const sessionId = member.sessionId
            await ctx.client.session.delete({
                path: { id: sessionId },
                query: { directory: member.worktreePath ?? ctx.directory },
            }).catch((deleteError) =>
                logSwallowed(
                    ctx,
                    "spawn rollback failed to delete session",
                    deleteError,
                    { team: team.teamName, member: member.name, sessionId },
                ),
            )
            unindexSession(sessionId)
            member.sessionId = undefined
        }
        member.status = "pending"
        member.initialized = false
        member.prompt = undefined
        member.promptDelivered = false
        member.turnCount = 0
        if (worktreeCreated) {
            const branch = `team/${team.teamName}/${member.name}`
            await cleanWorktree(
                ctx.directory,
                member.worktreePath,
                worktreesDir(team.directory),
            )
            member.worktreePath = undefined
            await execFileP("git", ["branch", "-D", branch], {
                cwd: ctx.directory,
            }).catch(() => {
                // Best effort.
            })
        }
        throw err
    }
}

/**
 * Wait outside the mutex for role-setup idle acknowledgements.
 *
 * On timeout, the errored state is persisted under the mutex before aborting
 * startup so a follow-up reconcile observes the terminal member status.
 */
async function waitForRoleSetupBarrier(
    ctx: PluginContext,
    team: Team,
    waitNames: Set<string>,
): Promise<void> {
    await waitUntil(
        () =>
            [...waitNames].every(
                (name) => team.members.find((member) => member.name === name)?.initialized,
            ),
        { timeoutMs: ROLE_SETUP_BARRIER_TIMEOUT_MS },
    ).catch(async () => {
        // Timeout state is persisted under the mutex before aborting startup.
        await team.mutex.runExclusive(async () => {
            for (const name of waitNames) {
                const current = team.members.find((member) => member.name === name)
                if (current && !current.initialized) {
                    current.status = "errored"
                    current.error = "role-setup barrier timed out"
                }
            }
            await saveTeamState(team).catch((err) =>
                logSwallowed(
                    ctx,
                    "persist failed before barrier-timeout abort",
                    err,
                    { team: team.teamName },
                ),
            )
        })
        throw new Error("ensureMembersReady: role-setup barrier timed out")
    })
}

/**
 * Ensure every non-master member has an initialized session before task
 * dispatch begins.
 *
 * This function must run outside team.mutex. The readiness barrier waits for
 * idle initialization, whose event handler acquires that mutex. Spawn failures
 * roll back session indexes, member state, worktrees, and temporary branches.
 */
export async function ensureMembersReady(
    ctx: PluginContext,
    team: Team,
): Promise<void> {
    // Phase 1: snapshot both spawn work and the full readiness barrier set.
    const { toSpawn, waitNames } = planMemberSpawn(team)
    if (waitNames.size === 0) return

    const spec = toSpawn.length > 0
        ? await readTeamSpec(ctx.storageRoot, team.teamName, team.leadSessionId)
        : undefined
    if (toSpawn.length > 0 && !spec) {
        throw new Error(`ensureMembersReady: no config.json for team "${team.teamName}"`)
    }
    const specByName = new Map((spec?.members ?? []).map((member) => [member.name, member]))
    const peerNames = (spec?.members ?? []).map((member) => member.name)

    // Phase 2: spawn missing members in bounded parallel batches.
    for (const batch of chunk(toSpawn, team.bounds.maxParallelMembers)) {
        await Promise.all(
            batch.map((member) =>
                spawnMemberSafely(ctx, team, member, specByName, peerNames),
            ),
        )
    }

    // Phase 3: wait outside the mutex for role-setup idle acknowledgements.
    await waitForRoleSetupBarrier(ctx, team, waitNames)
}
