import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { getExpectedMember, processIdle } from "../src/orchestration/lifecycle/idle.js"
import { parseDecompose } from "../src/orchestration/protocol/decisions.js"
import { readRunEvents } from "../src/orchestration/records/runs.js"
import { writeMailboxMessage } from "../src/messaging/mailbox.js"

import { createTask, getTask, listAllTasks, updateTask } from "../src/state/tasks.js"
import type { MemberState, Message, RecurseTask, Task } from "../src/core/types.js"
import { initTeamState, type Team } from "../src/state/store.js"
import { buildSummary } from "../src/orchestration/records/summary.js"
import { teamRecurseTool } from "../src/tools/modes/recurse.js"
import { teamResumeTool } from "../src/tools/control/resume.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { type DispatchCall, cleanupTmpRoots, makeCtx, makeMember, makeResumeCtx, makeState, makeTeam, makeToolContext, setupFailedTeam, statusIdleFrom, tmpRoot, waitForEvent } from './helpers.js';

afterAll(cleanupTmpRoots)

// --- fixtures ---

function makeRecurseTask(opts: Partial<RecurseTask> = {}): RecurseTask {
    return {
        type: "recurse",
        startedAt: 0,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        decomposerMember: "alice",
        maxDepth: 3,
        maxSubtasks: 5,
        task: "build the app",
        signoffPolicy: "none",
        ...opts,
    } as RecurseTask
}

/**
 * Seed a task into the team store, optionally claiming it for a member at a
 * given depth. Returns the created Task so the caller can reference its id.
 */
async function seedTask(
    team: Team,
    opts: {
        subject?: string
        description?: string
        depth?: number
        owner?: string
        status?: Task["status"]
        blockedBy?: string[]
    },
): Promise<Task> {
    const t = await createTask(team.directory, {
        subject: opts.subject ?? "root",
        description: opts.description ?? "do it",
        depth: opts.depth ?? 0,
        blockedBy: opts.blockedBy,
    })
    if (opts.owner || opts.status) {
        await updateTask(team.directory, t.id, {
            owner: opts.owner,
            status: opts.status ?? "claimed",
        })
    }
    return t
}

// The two-subtask decompose block reused by branching tests.
const DECOMPOSE_2 = `<decompose>{"subtasks":[
    {"subject":"part A","description":"do A"},
    {"subject":"part B","description":"do B"}
]}</decompose>`

// --- parseDecompose (pure function) ---

describe("parseDecompose", () => {
    test("parses a valid <decompose> block into subtasks", () => {
        const text = '<decompose>{"subtasks":[{"subject":"a","description":"x"}]}</decompose>'
        const result = parseDecompose(text)
        expect(result).toEqual({ subtasks: [{ subject: "a", description: "x" }] })
        expect(result.parseFailed).toBeUndefined()
    })

    test("no tag returns empty subtasks WITHOUT parseFailed (leaf signal)", () => {
        const result = parseDecompose("I solved it directly.")
        expect(result).toEqual({ subtasks: [] })
        expect(result.parseFailed).toBeUndefined()
    })

    test("bilingual <分解> tag is accepted", () => {
        const text = '<分解>{"subtasks":[{"subject":"甲","description":"做甲"}]}</分解>'
        expect(parseDecompose(text).subtasks).toEqual([{ subject: "甲", description: "做甲" }])
    })

    test("tag with empty subtasks array returns parseFailed", () => {
        expect(parseDecompose('<decompose>{"subtasks":[]}</decompose>').parseFailed).toBe(true)
    })

    test("tag with malformed JSON returns parseFailed", () => {
        // Braces present but invalid JSON -> regex matches -> JSON.parse throws.
        expect(parseDecompose("<decompose>{bad json}</decompose>").parseFailed).toBe(true)
    })

    test("tag with no JSON braces is treated as parse failure (H-14)", () => {
        // H-14: extractTaggedJSON now enumerates ALL complete <tag>...</tag>
        // pairs and treats the LAST as authoritative. A tag with no brace
        // block is a parse failure (the LLM used the tag but produced invalid
        // content). Pre-fix regex required `{...}` to match, so this was
        // silently skipped and treated as an absent tag — letting stale earlier
        // blocks win. The new contract surfaces the failure to the caller so
        // the decider is asked to retry rather than silently inheriting a
        // prior decision.
        const result = parseDecompose("<decompose>not json</decompose>")
        expect(result).toEqual({ subtasks: [], parseFailed: true })
    })

    test("tag with no subtasks key returns parseFailed", () => {
        expect(parseDecompose('<decompose>{"foo":1}</decompose>').parseFailed).toBe(true)
    })

    test("H-16 strict: items missing a description make the whole decompose fail", () => {
        const text = '<decompose>{"subtasks":[{"subject":"a"},{"subject":"b","description":"y"}]}</decompose>'
        // H-16: one invalid entry fails the entire decompose (no lossy filter).
        expect(parseDecompose(text).parseFailed).toBe(true)
        expect(parseDecompose(text).subtasks).toEqual([])
    })

    test("filters out items with empty-string subject", () => {
        const text = '<decompose>{"subtasks":[{"subject":"","description":"y"}]}</decompose>'
        expect(parseDecompose(text).parseFailed).toBe(true)
    })

    test("filters out items with empty-string description", () => {
        const text = '<decompose>{"subtasks":[{"subject":"a","description":""}]}</decompose>'
        expect(parseDecompose(text).parseFailed).toBe(true)
    })

    test("all items filtered out yields parseFailed", () => {
        const text = '<decompose>{"subtasks":[{"subject":"a"},{"foo":1}]}</decompose>'
        expect(parseDecompose(text).parseFailed).toBe(true)
    })

    test("parses tag embedded in longer output", () => {
        const text = `Analyzing...\nThis is complex.\n<decompose>{"subtasks":[{"subject":"s","description":"d"}]}</decompose>\nDone.`
        expect(parseDecompose(text).subtasks).toEqual([{ subject: "s", description: "d" }])
    })

    test("handles empty string input as a leaf", () => {
        expect(parseDecompose("")).toEqual({ subtasks: [] })
    })

    test("handles undefined-like input as a leaf", () => {
        expect(parseDecompose(undefined as unknown as string)).toEqual({ subtasks: [] })
    })
})

// --- getExpectedMember (recurse identity gate) ---

describe("getExpectedMember: recurse type", () => {
    test("returns null (any member may advance, like delegate)", () => {
        expect(getExpectedMember(makeRecurseTask())).toBe(null)
    })

    test("signoff stage overrides to null", () => {
        expect(getExpectedMember(makeRecurseTask({ signoffStage: true }))).toBe(null)
    })
})

// --- handleRecurseIdle branching (via processIdle) ---

describe("handleRecurseIdle branching: decompose creates children", () => {
    test("branch: splits task into subtasks and re-queues it as their aggregator", async () => {
        const calls: DispatchCall[] = []
        const task = makeRecurseTask({ maxDepth: 3, maxSubtasks: 5 })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            subject: "build app",
            description: "the whole thing",
            owner: "alice",
            status: "claimed",
        })

        await processIdle(makeCtx({ outputs: { ses_alice: DECOMPOSE_2 }, calls, status: statusIdleFrom({ ses_alice: DECOMPOSE_2 }) }), team, team.members[0], "ses_alice")

        const all = await listAllTasks(team.directory)

        // Two children created at depth 1.
        const children = all.filter(t => t.depth === 1)
        expect(children).toHaveLength(2)
        expect(children.every(c => c.status === "pending")).toBe(true)

        // Root re-queued as pending aggregator blocked by the children.
        const updated = await getTask(team.directory, root.id)
        expect(updated!.status).toBe("pending")
        expect(updated!.owner).toBeUndefined()
        expect(updated!.blockedBy).toHaveLength(2)
        expect(updated!.blockedBy.every(id => children.some(c => c.id === id))).toBe(true)
        expect(task.responses.alice).toBeUndefined()

        // decomposed event recorded.
        await waitForEvent(team.directory, runId, "decomposed")
        const events = await readRunEvents(team.directory, runId)
        const decomposed = events.find(e => e.kind === "decomposed")
        expect(decomposed).toBeDefined()
        expect(decomposed!.member).toBe("alice")
        expect(decomposed!.detail).toContain("@d1")
    })
})

// --- handleRecurseIdle leaf variants (via processIdle) ---

describe("handleRecurseIdle leaf: finalize instead of decompose", () => {
    test("no <decompose> tag: finalizes the task as completed with member output", async () => {
        const calls: DispatchCall[] = []
        const task = makeRecurseTask()
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            subject: "leaf task",
            description: "solve directly",
            owner: "alice",
            status: "claimed",
        })

        await processIdle(
            makeCtx({ outputs: { ses_alice: "Here is the direct solution." }, calls, status: statusIdleFrom({ ses_alice: "Here is the direct solution." }) }),
            team,
            team.members[0],
            "ses_alice",
        )

        const t = await getTask(team.directory, root.id)
        expect(t!.status).toBe("completed")
        expect(t!.result).toContain("direct solution")
        expect(task.responses.alice).toBeUndefined()
        // No children were created.
        const all = await listAllTasks(team.directory)
        expect(all).toHaveLength(1)
    })

    test("parseFailed (empty array tag): re-dispatches member, NOT completed (H46)", async () => {
        // H46: a malformed <decompose> block is NOT a leaf. The member
        // explicitly tried to decompose but the format was wrong. Marking
        // the task completed with the raw output would be a false success.
        // The member is re-dispatched with feedback to retry.
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeRecurseTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            owner: "alice",
            status: "claimed",
        })

        await processIdle(
            makeCtx({ outputs: { ses_alice: '<decompose>{"subtasks":[]}</decompose>' }, calls, status: statusIdleFrom({ ses_alice: '<decompose>{"subtasks":[]}</decompose>' }) }),
            team,
            team.members[0],
            "ses_alice",
        )

        const t = await getTask(team.directory, root.id)
        // Task must NOT be completed — it stays claimed for re-dispatch.
        expect(t!.status).not.toBe("completed")
        // Member was re-dispatched with feedback.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
    })

    test("depth capped (depth >= maxDepth): re-dispatches for a direct solution", async () => {
        const calls: DispatchCall[] = []
        const task = makeRecurseTask({ maxDepth: 2 })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            owner: "alice",
            status: "claimed",
            depth: 2, // at the cap
        })

        await processIdle(makeCtx({ outputs: { ses_alice: DECOMPOSE_2 }, calls, status: statusIdleFrom({ ses_alice: DECOMPOSE_2 }) }), team, team.members[0], "ses_alice")

        const t = await getTask(team.directory, root.id)
        expect(t?.status).toBe("claimed")
        expect(t?.result).toBeUndefined()
        expect(calls.some(call => call.sessionId === "ses_alice")).toBe(true)
        expect(task.forcedDirectTaskIds).toContain(root.id)
        // No children despite a valid decompose (depth cap prevents branching).
        const all = await listAllTasks(team.directory)
        expect(all.filter(x => x.depth === 3)).toHaveLength(0)
    })

    test("forced-direct task bypasses approval and increments its own retry counter", async () => {
        const calls: DispatchCall[] = []
        const task = makeRecurseTask({ humanApproval: true })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            owner: "alice",
            status: "claimed",
        })
        task.rootTaskId = root.id
        task.forcedDirectTaskIds = [root.id]

        await processIdle(
            makeCtx({ outputs: { ses_alice: DECOMPOSE_2 }, calls, status: statusIdleFrom({ ses_alice: DECOMPOSE_2 }) }),
            team,
            team.members[0],
            "ses_alice",
        )

        expect(task.approvalStage).not.toBe(true)
        expect(task.forcedDirectDecomposeAttempts?.[root.id]).toBe(1)
        expect(calls.some(call => call.sessionId === "ses_alice")).toBe(true)
    })

    test("forced-direct task fails after its own retry limit", async () => {
        const task = makeRecurseTask({ humanApproval: true })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            owner: "alice",
            status: "claimed",
        })
        task.rootTaskId = root.id
        task.forcedDirectTaskIds = [root.id]
        task.forcedDirectDecomposeAttempts = { [root.id]: 3 }

        await processIdle(
            makeCtx({ outputs: { ses_alice: DECOMPOSE_2 }, calls: [], status: statusIdleFrom({ ses_alice: DECOMPOSE_2 }) }),
            team,
            team.members[0],
            "ses_alice",
        )

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("aggregator task (has blockers): re-dispatches for a direct solution", async () => {
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeRecurseTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        // A completed child that the root aggregates.
        const child = await seedTask(team, {
            subject: "child",
            description: "done",
            status: "completed",
        })
        const root = await seedTask(team, {
            subject: "aggregator",
            description: "aggregate",
            owner: "alice",
            status: "claimed",
            blockedBy: [child.id],
        })

        await processIdle(makeCtx({ outputs: { ses_alice: DECOMPOSE_2 }, calls, status: statusIdleFrom({ ses_alice: DECOMPOSE_2 }) }), team, team.members[0], "ses_alice")

        const t = await getTask(team.directory, root.id)
        expect(t?.status).toBe("claimed")
        expect(t?.result).toBeUndefined()
        expect(calls.some(call => call.sessionId === "ses_alice")).toBe(true)
        const all = await listAllTasks(team.directory)
        expect(all.filter(x => x.depth === 1 && x.subject !== "child")).toHaveLength(0)
    })

    test("too many subtasks (> maxSubtasks): re-dispatches for a direct solution", async () => {
        const calls: DispatchCall[] = []
        const six = `<decompose>{"subtasks":[
            {"subject":"s1","description":"d"},{"subject":"s2","description":"d"},
            {"subject":"s3","description":"d"},{"subject":"s4","description":"d"},
            {"subject":"s5","description":"d"},{"subject":"s6","description":"d"}
        ]}</decompose>`
        const team = makeTeam({
            activeTask: makeRecurseTask({ maxSubtasks: 5 }),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            owner: "alice",
            status: "claimed",
        })

        await processIdle(makeCtx({ outputs: { ses_alice: six }, calls, status: statusIdleFrom({ ses_alice: six }) }), team, team.members[0], "ses_alice")

        const t = await getTask(team.directory, root.id)
        expect(t?.status).toBe("claimed")
        expect(t?.result).toBeUndefined()
        expect(calls.some(call => call.sessionId === "ses_alice")).toBe(true)
        const all = await listAllTasks(team.directory)
        expect(all).toHaveLength(1) // no children created
    })

    test("member with no claimed task: skips finalize, runs tail only", async () => {
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeRecurseTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        // No task claimed by alice.
        await seedTask(team, { subject: "untouched", description: "x", status: "pending" })

        await processIdle(makeCtx({ outputs: { ses_alice: "idle output" }, calls, status: statusIdleFrom({ ses_alice: "idle output" }) }), team, team.members[0], "ses_alice")

        // Untouched task remains pending (not finalized by a non-owner).
        const all = await listAllTasks(team.directory)
        expect(all[0].status).toBe("pending")
    })
})

// --- tail engine (runDelegateStyleTail via processIdle) ---

describe("recurse tail engine", () => {
    test("all tasks complete: delivers recurse_complete and idles the team", async () => {
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeRecurseTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        await seedTask(team, { subject: "done", description: "x", status: "completed" })

        await processIdle(makeCtx({ outputs: {}, calls, status: statusIdleFrom({}) }), team, team.members[0], "ses_alice")

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        // Summary delivered to the leader.
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
    })

    test("deadlock (unclaimable tasks, all members idle): fails with recurse_deadlock", async () => {
        const calls: DispatchCall[] = []
        const runId = makeRecurseTask().runId!
        const team = makeTeam({
            activeTask: makeRecurseTask({ runId }),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        // A pending task blocked by an incomplete (never-completing) dependency.
        const blocker = await seedTask(team, {
            subject: "block", description: "x", status: "pending", blockedBy: [crypto.randomUUID()],
        })
        await seedTask(team, {
            subject: "stuck",
            description: "x",
            status: "pending",
            blockedBy: [blocker.id],
        })

        await processIdle(makeCtx({ outputs: {}, calls, status: statusIdleFrom({}) }), team, team.members[0], "ses_alice")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()

        await waitForEvent(team.directory, runId, "terminated")
        const events = await readRunEvents(team.directory, runId)
        const terminated = events.find(e => e.kind === "terminated")
        expect(terminated).toBeDefined()
        expect(terminated!.reason).toContain("recurse_deadlock")
    })
})

// =======================================================================
// Tool-level fixtures (disk-backed team state + master session indexing).
// teamRecurseTool validation (LOW-1) and team_resume (LOW-2) flow through
// resolveCallerInTeam + loadTeamState, so they need real on-disk state and
// an indexed master session.
// =======================================================================

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})



async function setupRecurseTeam(
    root: string,
    sid: string,
    members: MemberState[] = [makeMember("alice"), makeMember("bob"), makeMember("carol")],
): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

// --- MEDIUM-1: maxTasks resource cap ---

describe("MEDIUM-1: maxTasks cap rejects an over-budget decomposition", () => {
    test("tasks + proposed subtasks > maxTasks re-dispatches for a direct solution", async () => {
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeRecurseTask({ maxDepth: 3, maxSubtasks: 5 }),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        // 1 existing task (root) + 2 proposed subtasks = 3 > 2 -> leaf.
        team.bounds.maxTasks = 2
        const root = await seedTask(team, { owner: "alice", status: "claimed" })

        await processIdle(makeCtx({ outputs: { ses_alice: DECOMPOSE_2 }, calls, status: statusIdleFrom({ ses_alice: DECOMPOSE_2 }) }), team, team.members[0], "ses_alice")

        const t = await getTask(team.directory, root.id)
        expect(t?.status).toBe("claimed")
        expect(t?.result).toBeUndefined()
        expect(calls.some(call => call.sessionId === "ses_alice")).toBe(true)
        // No children created despite a valid decompose (resource cap).
        const all = await listAllTasks(team.directory)
        expect(all).toHaveLength(1)
    })

    test("just-under-cap still branches (tasks + subtasks == maxTasks)", async () => {
        const team = makeTeam({
            activeTask: makeRecurseTask({ maxDepth: 3, maxSubtasks: 5 }),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        // 1 existing + 2 proposed = 3 == maxTasks(3) -> allowed to branch.
        team.bounds.maxTasks = 3
        const root = await seedTask(team, { owner: "alice", status: "claimed" })

        await processIdle(makeCtx({ outputs: { ses_alice: DECOMPOSE_2 }, calls: [], status: statusIdleFrom({ ses_alice: DECOMPOSE_2 }) }), team, team.members[0], "ses_alice")

        const all = await listAllTasks(team.directory)
        expect(all.filter(t => t.depth === 1)).toHaveLength(2)
        const t = await getTask(team.directory, root.id)
        expect(t!.status).toBe("pending") // re-queued as aggregator
    })
})

// --- LOW-4: empty-output leaf placeholder ---

describe("LOW-4: empty member output finalizes with a placeholder result", () => {
    test("a member that produced nothing leaves a recognizable result, not an empty string", async () => {
        const team = makeTeam({
            activeTask: makeRecurseTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, { owner: "alice", status: "claimed" })

        // No output entry for ses_alice -> empty assistant turn -> nothing captured.
        await processIdle(makeCtx({ outputs: {}, calls: [], status: statusIdleFrom({}) }), team, team.members[0], "ses_alice")

        const t = await getTask(team.directory, root.id)
        expect(t!.status).toBe("completed")
        expect(t!.result).toBe("(no output provided)")
    })
})

// --- LOW-1: teamRecurseTool input validation ---

describe("teamRecurseTool: input validation", () => {
    test('decomposer = "master" is rejected before any team lookup', async () => {
        const root = tmpRoot("rec-val-master")
        const sid = "ses_rec_val_master"
        tracked.push(sid)
        await setupRecurseTeam(root, sid)
        const result = await teamRecurseTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "build the whole app",
                decomposer: "master",
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: decomposer must be a member name, not "master"')
    })

    test("unknown decomposer member is rejected", async () => {
        const root = tmpRoot("rec-val-unknown")
        const sid = "ses_rec_val_unknown"
        tracked.push(sid)
        await setupRecurseTeam(root, sid)
        const result = await teamRecurseTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "build the whole app",
                decomposer: "ghost",
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: decomposer "ghost" is not a member of team "alpha"')
    })

    test("signoff_policy 'decider' without signoff_decider is rejected", async () => {
        const root = tmpRoot("rec-val-nodecider")
        const sid = "ses_rec_val_nodecider"
        tracked.push(sid)
        await setupRecurseTeam(root, sid)
        const result = await teamRecurseTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "build the whole app",
                decomposer: "alice",
                signoff_policy: "decider",
            },
            makeToolContext(sid),
        )
        expect(result).toBe(
            "Error: signoff_policy 'decider' requires signoff_decider (a member name)",
        )
    })

    test("signoff_policy 'decider' with an unknown signoff_decider is rejected", async () => {
        const root = tmpRoot("rec-val-baddecider")
        const sid = "ses_rec_val_baddecider"
        tracked.push(sid)
        await setupRecurseTeam(root, sid)
        const result = await teamRecurseTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "build the whole app",
                decomposer: "alice",
                signoff_policy: "decider",
                signoff_decider: "ghost",
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: signoff_decider "ghost" is not a member of team "alpha"')
    })
})

// --- LOW-2: team_resume recurse branches ---

describe("team_resume: recurse case", () => {
    test("resets interrupted claims to pending and re-dispatches idle members", async () => {
        const root = tmpRoot("rec-resume-reset")
        const sid = "ses_rec_resume_reset"
        tracked.push(sid)
        const task = makeRecurseTask({ decomposerMember: "alice", rootTaskId: "root-1" })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        // An interrupted in-flight claim on disk.
        const claimed = await createTask(team.directory, { subject: "wip", description: "x", depth: 0 })
        await updateTask(team.directory, claimed.id, { status: "claimed", owner: "alice" })

        const calls: string[] = []
        const ctx = makeResumeCtx(root, async req => { calls.push(req.path.id) })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed recurse")
        // Interrupted claim reset to pending (re-claimable).
        const t = await getTask(team.directory, claimed.id)
        expect(t!.status).toBe("pending")
        expect(t!.owner).toBeUndefined()
        // Both idle members re-dispatched with the recursive contract.
        expect(calls).toEqual(expect.arrayContaining(["ses_alice", "ses_bob"]))
        expect(calls).toHaveLength(2)
    })

    test("does not re-dispatch members that are still running", async () => {
        const root = tmpRoot("rec-resume-running")
        const sid = "ses_rec_resume_running"
        tracked.push(sid)
        const task = makeRecurseTask({ decomposerMember: "alice", rootTaskId: "root-1" })
        await setupFailedTeam(root, sid, task, [
            makeMember("alice", "ses_alice"),
            { ...makeMember("bob", "ses_bob"), status: "running" },
        ])

        const calls: string[] = []
        const ctx = makeResumeCtx(root, async req => { calls.push(req.path.id) })

        await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        // Only the idle member (alice) is re-dispatched; bob is still running.
        expect(calls).toEqual(["ses_alice"])
    })
})

// --- LOW-3: buildSummary recurse case ---

describe("buildSummary: recurse case", () => {
    test("leads with the root result and renders a depth-indented task tree", async () => {
        const task = makeRecurseTask()
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice" }, { name: "bob" }],
        })
        const root = await seedTask(team, { subject: "build app", description: "x", depth: 0, status: "completed" })
        await updateTask(team.directory, root.id, { status: "completed", result: "the final deliverable" })
        task.rootTaskId = root.id
        const childA = await seedTask(team, { subject: "part A", description: "x", depth: 1, status: "completed" })
        const childB = await seedTask(team, { subject: "part B", description: "x", depth: 1, status: "completed" })
        // M-RENDERER: recurse stores child IDs in parent.blockedBy (root waits
        // for children), NOT child.blockedBy = [root]. The old test had the
        // direction reversed.
        await updateTask(team.directory, root.id, { status: "completed", result: "the final deliverable", blockedBy: [childA.id, childB.id] })

        const summary = await buildSummary(team, task, "recurse_complete")

        // Head reflects mode + reason.
        expect(summary).toContain("<mode>recurse</mode>")
        expect(summary).toContain("<reason>recurse_complete</reason>")
        // Root result leads the summary.
        expect(summary).toContain("Root result:")
        expect(summary).toContain("the final deliverable")
        // Depth-indented task tree: root at column 0, children indented.
        expect(summary).toContain("- [completed] build app")
        expect(summary).toContain("  - [completed] part A")
        expect(summary).toContain("  - [completed] part B")
        // No <decompose> decision JSON leaks into the summary.
        expect(summary).not.toContain("<decompose>")
    })

    test("falls back to '(no result)' when the root has no result", async () => {
        const task = makeRecurseTask()
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice" }],
        })
        const root = await seedTask(team, { subject: "build app", description: "x", depth: 0 })
        task.rootTaskId = root.id

        const summary = await buildSummary(team, task, "recurse_complete")

        expect(summary).toContain("Root result:")
        expect(summary).toContain("(no result)")
    })
})

// --- aggregation dispatch + stall detection (regression for removed fallback) ---

describe("handleRecurseIdle aggregation dispatch (no fake completion)", () => {
    test("decomposer idle without claiming root: dispatched with [AGGREGATION PHASE] prompt, root stays pending", async () => {
        const calls: DispatchCall[] = []
        const task = makeRecurseTask()
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice", status: "idle" }],
        })
        // Root pending, blocked by two completed children.
        const childA = await seedTask(team, { subject: "A", description: "x", status: "completed" })
        const childB = await seedTask(team, { subject: "B", description: "x", status: "completed" })
        const root = await seedTask(team, {
            subject: "root",
            description: "aggregate A and B",
            status: "pending",
            blockedBy: [childA.id, childB.id],
        })
        task.rootTaskId = root.id

        // Alice idles WITHOUT claiming root -- protocol slip. The old fallback
        // would have faked root completion here using her non-empty output.
        await processIdle(
            makeCtx({ outputs: { ses_alice: "Waiting for teammate info..." }, calls, status: statusIdleFrom({ ses_alice: "Waiting for teammate info..." }) }),
            team,
            team.members[0],
            "ses_alice",
        )

        // Aggregation prompt dispatched (not the generic recurse prompt).
        expect(calls.some(c => c.text.includes("[Aggregation Phase]"))).toBe(true)
        // Root NOT fake-completed -- remains pending for the decomposer to claim.
        const r = await getTask(team.directory, root.id)
        expect(r!.status).toBe("pending")
    })

    test("stall detection: exceeds dispatch cap -> fail with recurse_aggregation_stalled", async () => {
        const calls: DispatchCall[] = []
        const task = makeRecurseTask({ aggregationDispatchCount: 3 })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice", status: "idle" }],
        })
        const child = await seedTask(team, { subject: "A", description: "x", status: "completed" })
        const root = await seedTask(team, {
            subject: "root",
            description: "aggregate",
            status: "pending",
            blockedBy: [child.id],
        })
        task.rootTaskId = root.id

        await processIdle(
            makeCtx({ outputs: { ses_alice: "still not claiming root" }, calls, status: statusIdleFrom({ ses_alice: "still not claiming root" }) }),
            team,
            team.members[0],
            "ses_alice",
        )

        // Run failed fast instead of looping to wall-clock.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        // aggregation_stalled event recorded.
        await waitForEvent(team.directory, runId, "aggregation_stalled")
        // Summary delivered to leader.
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
        // Root still pending -- never fake-completed.
        const r = await getTask(team.directory, root.id)
        expect(r!.status).toBe("pending")
    })

    test("decomposer claims root and finalizes: stall counter reset, normal completion", async () => {
        const calls: DispatchCall[] = []
        // Pre-set a non-zero stall count to verify it resets on root claim.
        const task = makeRecurseTask({ aggregationDispatchCount: 2 })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice", status: "idle" }],
        })
        const child = await seedTask(team, { subject: "A", description: "x", status: "completed" })
        const root = await seedTask(team, {
            subject: "root",
            description: "aggregate",
            owner: "alice",
            status: "claimed",
            blockedBy: [child.id],
        })
        task.rootTaskId = root.id

        await processIdle(
            makeCtx({ outputs: { ses_alice: "Synthesized final answer: D4=9 <!-- D4_FINAL: 9 -->" }, calls, status: statusIdleFrom({ ses_alice: "Synthesized final answer: D4=9 <!-- D4_FINAL: 9 -->" }) }),
            team,
            team.members[0],
            "ses_alice",
        )

        // Root finalized with the decomposer's output.
        const r = await getTask(team.directory, root.id)
        expect(r!.status).toBe("completed")
        expect(r!.result).toContain("D4_FINAL")
        // Stall counter reset (decomposer did its job).
        expect(task.aggregationDispatchCount).toBe(0)
        // No aggregation dispatch needed -- decomposer already claimed root.
        expect(calls.some(c => c.text.includes("[AGGREGATION PHASE]"))).toBe(false)
    })
})

// Regression: decompose block + unread inbox in the same turn.
//
// Before the fix, the decomposer's prompt instructs her to broadcast
// coordination messages to teammates in the SAME turn as her <decompose>
// block. Teammates reply before her idle event fires, so step 7's
// unread-inbox wake-hint short-circuit returns early and skips
// handleRecurseIdle entirely. The <decompose> block is silently dropped;
// the wake-hint-triggered next turn captures non-decompose output,
// overwrites task.responses[decomposer], and the leaf branch then
// finalizes the ROOT as completed without ever creating subtasks.
//
// Fix: processIdle step 6.5 hands the decomposer's turn to
// handleRecurseIdle BEFORE the wake-hint short-circuit when the captured
// output contains a <decompose> tag.
describe("processIdle step 6.5: decompose block survives unread inbox", () => {
    test("decompose + unread teammate reply in same turn: subtasks still created", async () => {
        const calls: DispatchCall[] = []
        const task = makeRecurseTask({ maxDepth: 3, maxSubtasks: 5 })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            subject: "build app",
            description: "the whole thing",
            owner: "alice",
            status: "claimed",
        })
        task.rootTaskId = root.id

        // Seed the race: a teammate replies to alice's broadcast BEFORE her
        // idle event fires. The reply lands in alice's inbox, so step 7's
        // countUnreadMessages would return > 0 and short-circuit.
        const teammateReply: Message = {
            version: 1,
            id: crypto.randomUUID(),
            from: "bob",
            to: "alice",
            kind: "message",
            body: "Got it -- I'll watch for Path B.",
            timestamp: Date.now(),
            deliveryStatus: "pending",
        }
        await writeMailboxMessage(team.directory, "alice", teammateReply)

        // Alice's turn contains both the decompose block AND her broadcast
        // preamble (simulating her turn-1 message-sending pattern).
        const turnOutput = `Coordinating with teammates.\n${DECOMPOSE_2}\nNotified bob and carol.`

        await processIdle(
            makeCtx({
                outputs: { ses_alice: turnOutput },
                calls,
                status: statusIdleFrom({ ses_alice: turnOutput }),
            }),
            team,
            team.members[0],
            "ses_alice",
        )

        // Subtasks MUST be created despite the unread inbox.
        const all = await listAllTasks(team.directory)
        const children = all.filter(t => t.depth === 1)
        expect(children).toHaveLength(2)
        expect(children.every(c => c.status === "pending")).toBe(true)

        // Root MUST be re-queued as the aggregator (NOT finalized as a leaf).
        const updated = await getTask(team.directory, root.id)
        expect(updated!.status).toBe("pending")
        expect(updated!.owner).toBeUndefined()
        expect(updated!.blockedBy).toHaveLength(2)

        // decomposed event MUST be recorded.
        await waitForEvent(team.directory, runId, "decomposed")
        const events = await readRunEvents(team.directory, runId)
        expect(events.some(e => e.kind === "decomposed" && e.member === "alice")).toBe(true)
    })
})
