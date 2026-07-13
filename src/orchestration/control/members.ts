import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PluginContext } from "../../core/context.js";
import { logSwallowed } from "../../core/log.js";
import { safeMemberAgent } from "../../core/role.js";
import { chunk, waitUntil } from "../../core/utils.js";
import { worktreesDir } from "../../state/paths.js";
import { indexMember, unindexSession } from "../../state/resolve.js";
import { type Team, readTeamSpec, saveTeamState } from "../../state/store.js";
import { cleanWorktree, createWorktree } from "../../state/worktrees.js";
import { buildRolePrompt } from "../protocol/output.js";

const execFileP = promisify(execFile);
const ROLE_SETUP_BARRIER_TIMEOUT_MS = 120_000;

export async function ensureMembersReady(
    ctx: PluginContext,
    team: Team,
): Promise<void> {
    const toSpawn = team.members.filter((member) => !member.sessionId);
    const initializationWaitNames = new Set(
        team.members
            .filter((member) => !member.isMaster && (!member.sessionId || !member.initialized))
            .map((member) => member.name),
    );
    if (initializationWaitNames.size === 0) return;

    const spec = toSpawn.length > 0
        ? await readTeamSpec(ctx.storageRoot, team.teamName, team.leadSessionId)
        : undefined;
    if (toSpawn.length > 0 && !spec) {
        throw new Error(`ensureMembersReady: no config.json for team "${team.teamName}"`);
    }
    const specByName = new Map((spec?.members ?? []).map((member) => [member.name, member]));
    const peerNames = (spec?.members ?? []).map((member) => member.name);

    for (const batch of chunk(toSpawn, team.bounds.maxParallelMembers)) {
        await Promise.all(
            batch.map(async (member) => {
                const memberSpec = specByName.get(member.name);
                let worktreeCreated = false;
                if (memberSpec?.worktree) {
                    member.worktreePath = await createWorktree(
                        ctx.directory,
                        team.directory,
                        team.teamName,
                        member.name,
                    );
                    worktreeCreated = true;
                }
                try {
                    const result = await ctx.client.session.create({
                        body: {
                            parentID: team.leadSessionId,
                            title: `${team.teamName}/${member.name}`,
                        },
                        query: { directory: member.worktreePath ?? ctx.directory },
                    });
                    const sessionId = result.data?.id;
                    if (!sessionId) {
                        throw new Error(`session.create returned no id for ${member.name}`);
                    }
                    member.sessionId = sessionId;
                    member.prompt = memberSpec?.prompt;
                    member.promptDelivered = false;
                    indexMember(
                        sessionId,
                        team.teamName,
                        member.name,
                        team.leadSessionId,
                        ctx.storageRoot,
                    );
                    member.status = "running";
                    member.initialized = false;
                    const rolePrompt = memberSpec
                        ? buildRolePrompt(memberSpec, team.teamName, peerNames)
                        : `You are "${member.name}" on team "${team.teamName}". Acknowledge, then stop.`;
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
                    });
                    member.turnCount = 1;
                } catch (err) {
                    if (member.sessionId) {
                        const sessionId = member.sessionId;
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
                        );
                        unindexSession(sessionId);
                        member.sessionId = undefined;
                    }
                    member.status = "pending";
                    member.initialized = false;
                    member.prompt = undefined;
                    member.promptDelivered = false;
                    member.turnCount = 0;
                    if (worktreeCreated) {
                        const branch = `team/${team.teamName}/${member.name}`;
                        await cleanWorktree(
                            ctx.directory,
                            member.worktreePath,
                            worktreesDir(team.directory),
                        );
                        member.worktreePath = undefined;
                        await execFileP("git", ["branch", "-D", branch], {
                            cwd: ctx.directory,
                        }).catch(() => {
                            // Best effort.
                        });
                    }
                    throw err;
                }
            }),
        );
    }

    await waitUntil(
        () =>
            [...initializationWaitNames].every(
                (name) => team.members.find((member) => member.name === name)?.initialized,
            ),
        { timeoutMs: ROLE_SETUP_BARRIER_TIMEOUT_MS },
    ).catch(async () => {
        await team.mutex.runExclusive(async () => {
            for (const name of initializationWaitNames) {
                const current = team.members.find((member) => member.name === name);
                if (current && !current.initialized) {
                    current.status = "errored";
                    current.error = "role-setup barrier timed out";
                }
            }
            await saveTeamState(team).catch((err) =>
                logSwallowed(
                    ctx,
                    "persist failed before barrier-timeout abort",
                    err,
                    { team: team.teamName },
                ),
            );
        });
        throw new Error("ensureMembersReady: role-setup barrier timed out");
    });
}
