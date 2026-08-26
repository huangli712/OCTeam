/**
 * Member readiness: create worktrees and sessions, deliver role prompts, and
 * wait for initialization, compensating partial spawn failures best-effort
 * (a session that cannot be deleted after retries stays indexed as an orphan
 * with a warning; a worktree cleanup failure is logged and swallowed so it
 * does not mask the original spawn error, which is rethrown).
 *
 * Must run outside team.mutex because idle initialization acquires that mutex.
 */

import type { PluginContext } from "../../core/context.js"
import { logEvent, logSwallowed } from "../../core/log.js"
import { safeMemberAgent } from "../../core/role.js"
import type { MemberSpec, MemberState } from "../../core/types.js"
import { waitUntil } from "../../core/utils.js"
import fs from "node:fs/promises"
import { join, resolve } from "node:path"
import { safeReadFile } from "../../state/locks.js"
import { statePath, worktreesDir, worktreePath } from "../../state/paths.js"
import { indexMember, unindexSession } from "../../state/resolve.js"
import {
    isValidTeamState,
    type Team,
    readTeamSpecFromDir,
    saveTeamState,
    saveTeamStateBounded,
} from "../../state/store.js"
import { createWorktree, destroyWorktree } from "../../state/worktrees.js"
import { buildRolePrompt } from "../protocol/output.js"

/** Max milliseconds to wait for all non-master members to reach initialized state. */
const ROLE_SETUP_BARRIER_TIMEOUT_MS = 120_000

/** Delay before the single session.delete retry during spawn rollback. */
const SESSION_DELETE_RETRY_DELAY_MS = 500

/**
 * Wait outside the mutex for role-setup idle acknowledgements.
 *
 * On timeout, persisted readiness is revalidated under the mutex before any
 * destructive cleanup so a delayed idle acknowledgement can still recover.
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
        // Run cleanup under team.mutex so an idle event from an uninitialized
        // member cannot race session deletion, unindexing, or status changes.
        let barrierRecovered = false
        await team.mutex.runExclusive(async () => {
            let persistedMembers: MemberState[] | undefined
            let revalidationBlocked = false
            try {
                const diskRaw = await safeReadFile(
                    team.directory,
                    statePath(team.directory),
                    { maxBytes: 1024 * 1024 },
                )
                if (diskRaw !== undefined) {
                    const parsed: unknown = JSON.parse(diskRaw)
                    if (isValidTeamState(parsed, team.directory)) {
                        if (parsed.teamRunId !== team.teamRunId) {
                            revalidationBlocked = true
                            logEvent(ctx, "warn", "barrier timeout: persisted teamRunId differs from live team; skipping cleanup", {
                                team: team.teamName,
                                liveTeamRunId: team.teamRunId,
                                persistedTeamRunId: parsed.teamRunId,
                            })
                        } else {
                            persistedMembers = parsed.members
                        }
                    }
                }
            } catch (err) {
                logSwallowed(ctx, "barrier timeout: persisted state read failed", err, {
                    team: team.teamName,
                })
            }
            if (revalidationBlocked) return

            for (const name of waitNames) {
                const current = team.members.find(member => member.name === name)
                const persisted = persistedMembers?.find(member => member.name === name)
                const currentSessionId = current?.sessionId
                const persistedSessionId = persisted?.sessionId
                if (
                    current
                    && !current.initialized
                    && typeof currentSessionId === "string"
                    && currentSessionId.length > 0
                    && persisted?.name === current.name
                    && typeof persistedSessionId === "string"
                    && persistedSessionId.length > 0
                    && persistedSessionId === currentSessionId
                    && persisted.initialized === true
                    && persisted.status === "idle"
                ) {
                    current.initialized = true
                    current.status = "idle"
                    current.error = undefined
                }
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
                        // Keep sessionId on failure so the reconciler can retry
                        // cleanup of the orphaned session.
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
            barrierRecovered = [...waitNames].every(
                name => team.members.find(member => member.name === name)?.initialized === true,
            )
            // Persist recovered or terminal timeout state in the same critical section.
            await saveTeamState(team).catch(err =>
                logSwallowed(
                    ctx,
                    "persist failed after barrier-timeout reconciliation",
                    err,
                    { team: team.teamName },
                ),
            )
        })
        if (barrierRecovered) return
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
 * A leftover member worktree is adoptable on respawn only when it is exactly
 * the canonical path OCTeam would create for this member AND it still looks
 * like a live git worktree.
 *
 * Ownership: adopting only the exact canonical worktreePath(teamDirectory,
 * memberName) means a tampered or relocated persisted path is never adopted;
 * the create path reassigns the canonical path instead, self-healing drift.
 *
 * Liveness: lstat (not stat) so a symlink at the dest is rejected, and the
 * .git entry must be present (a file for linked worktrees, a directory for
 * defensive compatibility). Guards against adopting a half-deleted husk left
 * by a partially failed destroyWorktree.
 */
async function isUsableWorktree(
    teamDirectory: string,
    memberName: string,
    leftover: string,
): Promise<boolean> {
    if (resolve(leftover) !== resolve(worktreePath(teamDirectory, memberName))) {
        return false
    }
    try {
        const dirStat = await fs.lstat(leftover)
        if (!dirStat.isDirectory()) return false
        const gitStat = await fs.lstat(join(leftover, ".git"))
        return gitStat.isFile() || gitStat.isDirectory()
    } catch {
        return false
    }
}

/**
 * Spawn one member's session and deliver its role prompt.
 *
 * Worktree creation, session creation, and role-prompt delivery are sequenced
 * with best-effort compensation on failure: session indexes and member state
 * roll back, but a session that survives delete retries stays as an indexed
 * orphan (warned) and a failed worktree cleanup is logged then swallowed so
 * it does not mask the original spawn error (which is rethrown) — side
 * effects are not atomically undone.
 *
 * A worktree-enabled member whose prior spawn attempt or barrier-timeout
 * teardown left a usable worktree behind (sessionId cleared but the worktree
 * survived cleanup) re-adopts it instead of re-creating: createWorktree would
 * fail fast with "branch already exists" (its contract puts worktreePath
 * idempotency on the caller), and the leftover may hold the member's
 * in-progress work from the prior run. Adopted worktrees are not destroyed by
 * this spawn's rollback (worktreeCreated stays false) — teardown remains the
 * responsibility of team deletion and barrier-timeout cleanup.
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
        const leftover = member.worktreePath
        if (leftover && (await isUsableWorktree(team.directory, member.name, leftover))) {
            logEvent(ctx, "info", "spawn: adopting leftover member worktree", {
                team: team.teamName,
                member: member.name,
                worktreePath: leftover,
            })
        } else {
            member.worktreePath = await createWorktree(
                ctx.directory,
                team.directory,
                team.teamName,
                member.name,
            )
            worktreeCreated = true
        }
    }
    try {
        // Session creation and role-prompt delivery are sequenced with
        // best-effort compensation (not an atomic transaction).
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
        // Persist the new session ID before the first role idle so a crash cannot
        // make restart create a second session and orphan the first.
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
                    logSwallowed(
                        ctx,
                        "spawn rollback: session.delete failed after retry; host session is orphaned",
                        secondErr,
                        { team: team.teamName, member: member.name, sessionId },
                        "error",
                    )
                }
            }
            // Keep sessionId indexed when deletion fails so the crash reconciler
            // can find the host session and retry cleanup on the next sweep.
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
        // Reset to pending only after the session is successfully deleted.
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
 * idle initialization, whose event handler acquires that mutex. Spawn
 * failures compensate best-effort: session indexes and member state roll
 * back, worktrees and temporary branches are cleaned when their teardown
 * succeeds (a failed session deletion leaves an indexed orphan with a
 * warning; a failed worktree cleanup is logged and swallowed, and the
 * original spawn error is rethrown).
 */
export async function ensureMembersReady(
    ctx: PluginContext,
    team: Team,
): Promise<void> {
    // Snapshot both spawn work and the full readiness barrier set.
    const { toSpawn, waitNames } = planMemberSpawn(team)
    if (waitNames.size === 0) return

    // Read config.json from team.directory, not readTeamSpec(storageRoot,
    // teamName, leadSessionId): passing leadSessionId as a path segment is
    // correct for project scope (<root>/<sid>/teams/<name>) but wrong for
    // user scope (<root>/teams/<name>, no session segment). team.directory
    // is already scope-resolved.
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

    // Wait outside the mutex for role-setup idle acknowledgements.
    await waitForRoleSetupBarrier(ctx, team, waitNames)
}
