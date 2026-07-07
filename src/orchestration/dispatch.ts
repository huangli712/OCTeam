/**
 * Dispatch primitives: ensureMembersReady (spawn + role-setup barrier) and
 * advanceToStage (dispatch one stage's task, prefixing prior output).
 *
 * CRITICAL lock-order: ensureMembersReady MUST run OUTSIDE the
 * team mutex. Its role-setup barrier waits for the event handler to flip
 * member.initialized, which the event handler does INSIDE team.mutex.runExclusive.
 * Holding the mutex here would deadlock the barrier.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { PluginContext } from "../core/context.js"
import type { Team } from "../state/store.js"
import { readTeamSpec, saveTeamState } from "../state/store.js"
import { worktreePath, worktreesDir } from "../state/paths.js"
import { cleanWorktree } from "../state/worktrees.js"
import { buildRolePrompt, chunk, truncateOutput, waitUntil } from "../core/utils.js"
import { indexMember, unindexSession } from "../state/resolve.js"
import { safeMemberAgent } from "../core/role.js"
import type { MemberState, Stage } from "../core/types.js"
import { logSwallowed } from "../core/log.js"
import { recordEvent } from "./events.js"

const execFileP = promisify(execFile)

const ROLE_SETUP_BARRIER_TIMEOUT_MS = 120_000

// Total byte budget for injected upstream context (sum across all prior
// stages). Without a cap, a long pipeline/loop would grow the prompt linearly
// with stage count. Each stage is also individually truncated (truncateOutput).
const UPSTREAM_TOTAL_CAP = 65_536

// read_only loop stages signal "clean" with this structured tag (i18n-consistent
// with allReadOnlyStagesReportNoIssues in handlers.ts).
const NO_ISSUES_CONTRACT =
    'If you find NO issues, end your reply with the literal tag <no_issues/> ' +
    '(or <无问题/>). Emit it ONLY when truly clean — it ends the loop.'

/**
 * Build the upstream-context prefix for a pipeline/loop stage: ALL completed
 * prior stages (not just the immediate predecessor), each labelled by member
 * and individually truncated, then capped at UPSTREAM_TOTAL_CAP total bytes.
 * Returns "" when there is no completed upstream. Exported for unit testing.
 */
export function buildUpstreamContext(
    stages: Stage[],
    responses: Record<string, string>,
    uptoIndex: number,
): string {
    const blocks: string[] = []
    let used = 0
    for (let i = 0; i < uptoIndex; i++) {
        const s = stages[i]
        if (!s?.completed) continue
        const out = responses[s.member]
        if (!out) continue
        const block = `[Output from ${s.member}]\n${truncateOutput(out)}`
        if (used + block.length > UPSTREAM_TOTAL_CAP) {
            blocks.push(`[…upstream context truncated at ${UPSTREAM_TOTAL_CAP} bytes]`)
            break
        }
        blocks.push(block)
        used += block.length
    }
    return blocks.join("\n\n")
}

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
 * once on its role-setup prompt (the role-setup barrier). After this
 * returns, all members are `initialized: true` and idle, ready for the first
 * real dispatch.
 *
 * MUST be called OUTSIDE team.mutex (see file header).
 */
export async function ensureMembersReady(ctx: PluginContext, team: Team): Promise<void> {
    const toSpawn = team.members.filter(m => !m.sessionId)
    if (toSpawn.length === 0) return // team reused; all sessions live & initialized

    const spec = await readTeamSpec(ctx.storageRoot, team.teamName, team.leadSessionId)
    if (!spec) throw new Error(`ensureMembersReady: no config.json for team "${team.teamName}"`)
    const specByName = new Map(spec.members.map(m => [m.name, m]))
    const peerNames = spec.members.map(m => m.name)

    for (const batch of chunk(toSpawn, team.bounds.maxParallelMembers)) {
        await Promise.all(
            batch.map(async member => {
                const memberSpec = specByName.get(member.name)
                // 1. Worktree (only if configured)
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
                // Copy the member's standing instruction onto the runtime state so the
                // first task dispatch can prepend it as <standing-instruction> (see
                // prependStandingInstruction). Role-setup no longer embeds it.
                member.prompt = memberSpec?.prompt
                member.promptDelivered = false
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
                        agent: safeMemberAgent(member.agent),
                    },
                })
                member.turnCount = 1
                } catch (err) {
                    // Rollback to pre-spawn state so a retry re-enters
                    // toSpawn (no sessionId) cleanly. Undo in reverse order:
                    // unindex/forget the session, restore member runtime
                    // fields, then tear down the worktree + branch.
                    if (member.sessionId) {
                        unindexSession(member.sessionId)
                        member.sessionId = undefined
                    }
                    member.status = "pending"
                    member.initialized = false
                    member.prompt = undefined
                    member.promptDelivered = false
                    member.turnCount = 0
                    if (worktreeCreated) {
                        const branch = `team/${team.teamName}/${member.name}`
                        await cleanWorktree(ctx.directory, member.worktreePath, worktreesDir(team.directory))
                        member.worktreePath = undefined
                        await execFileP("git", ["branch", "-D", branch], {
                            cwd: ctx.directory,
                        }).catch(() => { /* best effort */ })
                    }
                    throw err
                }
            }),
        )
        // NOTE: no per-batch saveTeamState here. saveTeamState documents that
        // the caller must already hold team.mutex (store.ts), but this runs
        // OUTSIDE the mutex — a save here would race the role-setup idle handler
        // (which saves under the mutex) and could clobber member.initialized.
        // sessionId/worktreePath set above are persisted by that idle handler
        // during the barrier below, and finalized by the Phase-3 caller's
        // saveTeamState. The barrier-timeout path below still persists errored
        // state before throwing.
    }

    // 4. ROLE-SETUP BARRIER: wait until every spawned member has idled once.
    //    The event handler flips member.initialized on the first idle of an
    //    uninitialized member and returns WITHOUT capturing output or advancing.
    await waitUntil(
        () => toSpawn.every(m => team.members.find(x => x.name === m.name)?.initialized),
        { timeoutMs: ROLE_SETUP_BARRIER_TIMEOUT_MS },
    ).catch(async () => {
        // Serialize the errored-marking + save with the idle handler (which
        // also mutates member state + saves under team.mutex). Without the
        // mutex here, the unlocked saveTeamState would violate the save
        // contract (store.ts: caller must hold team.mutex) and could clobber
        // an idle handler's just-persisted initialized=true with errored.
        await team.mutex.runExclusive(async () => {
            // Re-check initialized under the mutex: the idle handler may have
            // flipped it since the outside-mutex waitUntil evaluation.
            for (const m of toSpawn) {
                const cur = team.members.find(x => x.name === m.name)
                if (cur && !cur.initialized) {
                    cur.status = "errored"
                    cur.error = "role-setup barrier timed out"
                }
            }
            // L3: persist the errored state before throwing so a restart sees it
            // (the tool handler aborts before its Phase 3 saveTeamState).
            await saveTeamState(team).catch((err) =>
                logSwallowed(ctx, "persist failed before barrier-timeout abort", err, { team: team.teamName })
            )
        })
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
    // Inject ALL completed upstream stages (capped), not just the immediate
    // predecessor — a later stage may depend on an earlier one whose output the
    // intermediate stage did not forward.
    const upstream = buildUpstreamContext(task.stages, task.responses, task.currentStageIndex)
    const roContract = stage.action === "read_only" ? `\n\n${NO_ISSUES_CONTRACT}` : ""
    const base = upstream
        ? `${upstream}\n\n[Your task]\n${stage.task}${roContract}`
        : `${stage.task}${roContract}`
    // contextPrefix carries cross-round feedback (e.g. the decider's decision in a
    // loop) so the next round is actually corrective rather than re-asking verbatim.
    const rawText = contextPrefix ? `${contextPrefix}\n\n${base}` : base
    const text = prependStandingInstruction(member, rawText)
    await ctx.client.session.promptAsync({
        path: { id: member.sessionId },
        body: {
            parts: [{ type: "text", text, synthetic: true }],
            agent: safeMemberAgent(member.agent),
        },
        // Members work in the PROJECT dir (or their worktree), never the
        // .octeam state dir. session.create already used ctx.directory.
        query: { directory: member.worktreePath ?? ctx.directory },
    })
    member.promptDelivered = true
    member.status = "running"
    member.turnCount++
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "dispatched",
        member: member.name,
        stage: task.currentStageIndex,
        round: task.currentRound,
    })
}

/**
 * Prepend the member's standing instruction (MemberSpec.prompt, copied onto
 * MemberState.prompt at spawn) as a <standing-instruction> block in front of
 * the task text, ONCE per member. Returns text unchanged once delivered.
 *
 * Pure text transform — callers set member.promptDelivered = true after the
 * promptAsync succeeds, so a failed/retried dispatch re-delivers it.
 */
export function prependStandingInstruction(member: MemberState, text: string): string {
    if (member.promptDelivered || !member.prompt) return text
    return `<standing-instruction>\n${member.prompt}\n</standing-instruction>\n\n${text}`
}

/**
 * Send a synthetic text prompt to a member; flip it to running. The single
 * canonical member-dispatch primitive — every member prompt MUST go through
 * here so body.agent (role routing) and query.directory (worktree isolation)
 * are always set. OpenCode resolves both per-prompt (omitting agent falls back
 * to "build"; omitting directory falls back to the server cwd), so they cannot
 * be inherited from session.create.
 */
export async function dispatchToMember(
    ctx: PluginContext,
    member: MemberState,
    text: string,
    directory: string,
    team?: Team,   // when provided, emit a 'dispatched' run event (#5 observability)
    eventMeta?: { stepIndex?: number; correlationId?: string },
): Promise<void> {
    if (!member.sessionId) return
    // Errored is terminal: never re-dispatch. A dispatch would flip the member
    // back to "running", violating the errored-is-terminal invariant and
    // potentially stalling barriers/quorum that wait on it. Callers that have a
    // legitimate reason to retry an errored member must clear the status
    // explicitly first (no such path exists today by design).
    if (member.status === "errored") return
    const dispatchedText = prependStandingInstruction(member, text)
    await ctx.client.session.promptAsync({
        path: { id: member.sessionId },
        body: {
            parts: [{ type: "text", text: dispatchedText, synthetic: true }],
            agent: safeMemberAgent(member.agent),
        },
        query: { directory },
    })
    member.promptDelivered = true
    member.status = "running"
    member.turnCount++
    if (team) {
        recordEvent(team, { timestamp: Date.now(), kind: "dispatched", member: member.name, ...eventMeta })
    }
}
