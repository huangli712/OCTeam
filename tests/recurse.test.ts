import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getExpectedMember, parseDecompose, processIdle } from "../src/orchestration/handlers.js"
import { readRunEvents } from "../src/orchestration/runs.js"
import { createTask, getTask, listAllTasks, updateTask } from "../src/state/tasks.js"
import type { ActiveTask, MemberState, Task } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { PluginContext } from "../src/core/context.js"

// --- fixtures ---

type DispatchCall = { sessionId: string; text: string }

/**
 * Stub PluginContext. `messages` returns a single user+assistant turn whose
 * assistant text is `outputs[sessionId]` (the member's claimed output). Empty
 * output returns an empty assistant turn so processIdle Step 4 captures nothing.
 * `promptAsync` records each dispatch for assertion.
 */
function makeCtx(
    outputs: Record<string, string>,
    calls: DispatchCall[] = [],
): PluginContext {
    return {
        client: {
            session: {
                messages: async ({ path }: { path: { id: string } }) => {
                    const text = outputs[path.id] ?? ""
                    return {
                        data: [
                            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                            ...(text
                                ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]
                                : []),
                        ],
                    }
                },
                promptAsync: async (args: any) => {
                    calls.push({
                        sessionId: args.path.id,
                        text: args.body.parts[0].text,
                    })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

function makeRecurseTask(opts: Partial<ActiveTask> = {}): ActiveTask {
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
    } as ActiveTask
}

function makeTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
    }))
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-rec-")),
    } as unknown as Team
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

    test("tag with no JSON braces is treated as a leaf (no match)", () => {
        // The regex requires a {...} block; bare text inside the tag does not
        // register as a decompose attempt and is treated like an absent tag.
        const result = parseDecompose("<decompose>not json</decompose>")
        expect(result).toEqual({ subtasks: [] })
        expect(result.parseFailed).toBeUndefined()
    })

    test("tag with no subtasks key returns parseFailed", () => {
        expect(parseDecompose('<decompose>{"foo":1}</decompose>').parseFailed).toBe(true)
    })

    test("filters out items missing a description", () => {
        const text = '<decompose>{"subtasks":[{"subject":"a"},{"subject":"b","description":"y"}]}</decompose>'
        // Only the well-formed item survives.
        expect(parseDecompose(text).subtasks).toEqual([{ subject: "b", description: "y" }])
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

        await processIdle(makeCtx({ ses_alice: DECOMPOSE_2 }, calls), team, team.members[0], "ses_alice")

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

        // decomposed event recorded.
        await new Promise(r => setTimeout(r, 50))
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
        const team = makeTeam({
            activeTask: makeRecurseTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            subject: "leaf task",
            description: "solve directly",
            owner: "alice",
            status: "claimed",
        })

        await processIdle(
            makeCtx({ ses_alice: "Here is the direct solution." }, calls),
            team,
            team.members[0],
            "ses_alice",
        )

        const t = await getTask(team.directory, root.id)
        expect(t!.status).toBe("completed")
        expect(t!.result).toContain("direct solution")
        // No children were created.
        const all = await listAllTasks(team.directory)
        expect(all).toHaveLength(1)
    })

    test("parseFailed (empty array tag): finalizes as completed (not an error)", async () => {
        const team = makeTeam({
            activeTask: makeRecurseTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            owner: "alice",
            status: "claimed",
        })

        await processIdle(
            makeCtx({ ses_alice: '<decompose>{"subtasks":[]}</decompose>' }, []),
            team,
            team.members[0],
            "ses_alice",
        )

        const t = await getTask(team.directory, root.id)
        expect(t!.status).toBe("completed")
    })

    test("depth capped (depth >= maxDepth): finalizes as completed", async () => {
        const team = makeTeam({
            activeTask: makeRecurseTask({ maxDepth: 2 }),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const root = await seedTask(team, {
            owner: "alice",
            status: "claimed",
            depth: 2, // at the cap
        })

        await processIdle(makeCtx({ ses_alice: DECOMPOSE_2 }, []), team, team.members[0], "ses_alice")

        const t = await getTask(team.directory, root.id)
        expect(t!.status).toBe("completed")
        // No children despite a valid decompose (depth cap prevents branching).
        const all = await listAllTasks(team.directory)
        expect(all.filter(x => x.depth === 3)).toHaveLength(0)
    })

    test("aggregator task (has blockers): finalizes instead of re-decomposing", async () => {
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

        await processIdle(makeCtx({ ses_alice: DECOMPOSE_2 }, []), team, team.members[0], "ses_alice")

        const t = await getTask(team.directory, root.id)
        // Finalized (aggregation), NOT re-decomposed.
        expect(t!.status).toBe("completed")
        const all = await listAllTasks(team.directory)
        expect(all.filter(x => x.depth === 1 && x.subject !== "child")).toHaveLength(0)
    })

    test("too many subtasks (> maxSubtasks): finalizes as completed", async () => {
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

        await processIdle(makeCtx({ ses_alice: six }, []), team, team.members[0], "ses_alice")

        const t = await getTask(team.directory, root.id)
        expect(t!.status).toBe("completed")
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

        await processIdle(makeCtx({ ses_alice: "idle output" }, calls), team, team.members[0], "ses_alice")

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

        await processIdle(makeCtx({}, calls), team, team.members[0], "ses_alice")

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
        const blocker = await seedTask(team, { subject: "block", description: "x", status: "in_progress" })
        await seedTask(team, {
            subject: "stuck",
            description: "x",
            status: "pending",
            blockedBy: [blocker.id],
        })

        await processIdle(makeCtx({}, calls), team, team.members[0], "ses_alice")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()

        await new Promise(r => setTimeout(r, 50))
        const events = await readRunEvents(team.directory, runId)
        const terminated = events.find(e => e.kind === "terminated")
        expect(terminated).toBeDefined()
        expect(terminated!.reason).toContain("recurse_deadlock")
    })
})
