/**
 * Member readiness transaction: create worktrees and sessions, deliver role
 * prompts, wait for initialization, and roll back partial spawn failures.
 *
 * Must run outside team.mutex because idle initialization acquires that mutex.
 */

import type { PluginContext } from "../../core/context.js"
import { logger, logSwallowed } from "../../core/log.js"
import { safeMemberAgent } from "../../core/role.js"
import type { MemberSpec, MemberState } from "../../core/types.js"
import { waitUntil } from "../../core/utils.js"
import { worktreesDir } from "../../state/paths.js"
import { indexMember, unindexSession } from "../../state/resolve.js"
import { type Team, readTeamSpecFromDir, saveTeamState, saveTeamStateBounded } from "../../state/store.js"
import { createWorktree, destroyWorktree } from "../../state/worktrees.js"
import { buildRolePrompt } from "../protocol/output.js"

// Max milliseconds to wait for all non-master members to reach initialized state.
const ROLE_SETUP_BARRIER_TIMEOUT_MS = 120_000
const SESSION_DELETE_RETRY_DELAY_MS = 500

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
        // HIGH-B: run the entire cleanup under team.mutex so a concurrent idle
        // event from a spawned-but-not-initialized member cannot race with the
        // session.delete / unindexSession / status=errored mutations. Pre-fix
        // code ran cleanup outside the mutex; an idle event firing between the
        // barrier timeout and the mutex acquisition would see the member as
        // still having a sessionId and try to process its (non-existent) output.
        await team.mutex.runExclusive(async () => {
            for (const name of waitNames) {
                const current = team.members.find(member => member.name === name)
                if (current && !current.initialized && current.sessionId) {
                    const sid = current.sessionId
                    const dir = current.worktreePath ?? ctx.directory
                    try {
                        await ctx.client.session.delete({
                            path: { id: sid },
                            query: { directory: dir },
                        })
                        unindexSession(sid)
                        current.sessionId = undefined
                    } catch (err) {
                        logSwallowed(ctx, "barrier timeout: session.delete failed", err, {
                            team: team.teamName, member: name, sessionId: sid,
                        })
                        // H-H4: keep sessionId on failure so the reconciler can
                        // retry cleanup. Pre-fix code cleared it unconditionally,
                        // making the orphaned session unrecoverable.
                    }
                    if (current.worktreePath) {
                        try {
                            const destroyed = await destroyWorktree(
                                ctx.directory, current.worktreePath,
                                worktreesDir(team.directory), team.teamName, name,
                            )
                            if (destroyed) current.worktreePath = undefined
                        } catch (err) {
                            logSwallowed(ctx, "barrier timeout: destroyWorktree failed", err, {
                                team: team.teamName, member: name,
                            })
                            // Keep worktreePath for reconciler retry.
                        }
                    }
                }
                if (current && !current.initialized) {
                    current.status = "errored"
                    current.error = "role-setup barrier timed out"
                }
            }
            // Timeout state persisted in the same critical section.
            await saveTeamState(team).catch(err =>
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
                        synthetic: false,
                    },
                ],
                agent: safeMemberAgent(member.agent),
            },
        })
        member.turnCount = 1
        // H-H3: persist the new session ID immediately so a crash between
        // session.create and the first role-idle does not orphan the session.
        // Pre-fix code only saved on the next unrelated idle; a restart would
        // re-create a second session, leaving the first orphaned.
        try {
            await team.mutex.runExclusive(() => saveTeamStateBounded(team))
        } catch (persistErr) {
            logSwallowed(ctx, "spawnMemberSafely: post-spawn persist failed", persistErr, {
                team: team.teamName, member: member.name, sessionId,
            })
            throw persistErr
        }
    } catch (err) {
        // Roll back every side effect before exposing the spawn error.
        if (member.sessionId) {
            const sessionId = member.sessionId
            const dir = member.worktreePath ?? ctx.directory
            // Retry session.delete once after a short delay to handle transient
            // network errors. If it still fails, log at error level so operators
            // notice the orphaned host session.
            let deleted = false
            try {
                await ctx.client.session.delete({ path: { id: sessionId }, query: { directory: dir } })
                deleted = true
            } catch {
                await new Promise(r => setTimeout(r, SESSION_DELETE_RETRY_DELAY_MS))
                try {
                    await ctx.client.session.delete({ path: { id: sessionId }, query: { directory: dir } })
                    deleted = true
                } catch (secondErr) {
                    logger.error("spawn rollback: session.delete failed after retry; host session is orphaned", {
                        team: team.teamName, member: member.name, sessionId,
                        error: secondErr instanceof Error ? secondErr.message : String(secondErr),
                    })
                }
            }
            // L-3: keep the sessionId indexed when session.delete fails so the
            // crash reconciler (reconcile.ts) can retry cleanup on the next
            // sweep. Pre-fix code always called unindexSession, orphaning the
            // host session permanently — no index entry means reconcile cannot
            // find it to retry the delete.
            if (deleted) {
                unindexSession(sessionId)
                member.sessionId = undefined
            } else {
                // Keep sessionId in memory AND index so reconcile retries.
                // Mark the member as errored so checkTermination/sweep handle
                // it as a known-bad state.
                member.status = "errored"
                member.error = "spawn_rollback_failed: orphaned host session"
                // Do NOT clear member.sessionId — reconcile needs it.
            }
        }
        // HIGH: only reset to pending if session was successfully deleted.
        // If delete failed, keep errored status so reconcile retries.
        if (member.status !== "errored") {
            member.status = "pending"
        }
        member.initialized = false
        member.prompt = undefined
        member.promptDelivered = false
        member.turnCount = 0
        if (worktreeCreated) {
            try {
                const destroyed = await destroyWorktree(
                    ctx.directory,
                    member.worktreePath,
                    worktreesDir(team.directory),
                    team.teamName,
                    member.name,
                )
                if (destroyed) member.worktreePath = undefined
            } catch (worktreeError) {
                // Do NOT let the cleanup error mask the original spawn error.
                logSwallowed(ctx, "spawn rollback failed to destroy worktree", worktreeError, {
                    team: team.teamName, member: member.name,
                })
            }
        }
        throw err
    }
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

    // H-L10: read config.json from team.directory directly, not via
    // readTeamSpec(ctx.storageRoot, team.teamName, team.leadSessionId).
    // Pre-fix code passed team.leadSessionId as the path segment, which is
    // correct for project scope (<root>/<sid>/teams/<name>) but WRONG for
    // user scope (<root>/teams/<name> — no session segment). Using
    // team.directory avoids the scope mismatch entirely.
    const spec = toSpawn.length > 0
        ? await readTeamSpecFromDir(team.directory)
        : undefined
    if (toSpawn.length > 0 && !spec) {
        throw new Error(`ensureMembersReady: no config.json for team "${team.teamName}"`)
    }
    const specByName = new Map((spec?.members ?? []).map((member) => [member.name, member]))
    const peerNames = (spec?.members ?? []).map((member) => member.name)

    for (const member of toSpawn) {
        await spawnMemberSafely(ctx, team, member, specByName, peerNames)
    }

    // Phase 3: wait outside the mutex for role-setup idle acknowledgements.
    await waitForRoleSetupBarrier(ctx, team, waitNames)
}
