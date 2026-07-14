import { afterEach, describe, expect, mock, test } from "bun:test"

import type { ActiveTask, MemberState, Stage, TeamSpec } from "../src/core/types.js"
import { advanceToStage } from "../src/orchestration/modes/stages.js"
import { ensureMembersReady } from "../src/orchestration/control/members.js"
import { initTeamState, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

// --- ctx + team fixtures ---

/** Shared request shape for promptAsync mocks (union of all fields accessed across tests). */
type PromptReq = { path: { id: string }; body: { parts: Array<{ text: string; synthetic?: boolean }>; title?: string } }
type DeleteReq = { path: { id: string }; query: { directory: string } }


async function makeTeam(
    root: string,
    sid: string,
    tracker: string[] | undefined,
    members: MemberState[],
) {
    // rebuildSessionIndex below indexes every member.sessionId into the global
    // memberIndex. Track them all so afterEach can unindexSession them —
    // otherwise generic names like "ses_a" leak across test files and collide
    // with siblings (e.g. migration.test.ts uses ses_a..ses_e as lead sids).
    if (tracker) {
        tracker.push(sid)
        for (const m of members) if (m.sessionId) tracker.push(m.sessionId)
    }
    const state = makeState("alpha", sid, members, Date.now())
    await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return loadTeamState(root, "alpha", sid)
}

async function setActiveTask(
    root: string,
    sid: string,
    partial: Partial<ActiveTask> & { type: string },
) {
    const team = await loadTeamState(root, "alpha", sid)
    await team.mutex.runExclusive(async () => {
        team.activeTask = {
            runId: "run-extra-test",
            startedAt: Date.now(),
            wallClockTimeoutMs: 300_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages: [],
            currentStageIndex: 0,
            currentRound: 1,
            decisionHistory: [],
            decisionParseFailures: 0,
            ...partial,
        } as ActiveTask
    })
}

// ============================================================
// advanceToStage: branch coverage for the early-return paths,
// upstream/prefix/contract injection, and dispatched event wiring.
// ============================================================

describe("advanceToStage", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("no activeTask: returns immediately without dispatching", async () => {
        const root = tmpRoot("ats-noactive")
        const sid = "ses_ats_noactive"
        tracked.push(sid)
        const promptAsync = mock(async () => ({}))
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        const team = await makeTeam(root, sid, tracked, [makeMember("alice", "ses_alice")])

        const stage: Stage = { member: "alice", task: "do thing", completed: false }
        await advanceToStage(ctx, team, stage)

        expect(promptAsync).toHaveBeenCalledTimes(0)
    })

    test("member has no sessionId: rejects with 'has no session'", async () => {
        const root = tmpRoot("ats-nosess")
        const sid = "ses_ats_nosess"
        tracked.push(sid)
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        const team = await makeTeam(root, sid, tracked, [makeMember("alice")]) // no sessionId
        await setActiveTask(root, sid, {
            type: "pipeline",
            stages: [{ member: "alice", task: "x", completed: false }],
        })

        const stage: Stage = { member: "alice", task: "x", completed: false }
        expect(advanceToStage(ctx, team, stage)).rejects.toThrow(/has no session/)
    })

    test("unknown member name: rejects with 'has no session'", async () => {
        const root = tmpRoot("ats-unknown")
        const sid = "ses_ats_unknown"
        tracked.push(sid)
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        const team = await makeTeam(root, sid, tracked, [makeMember("alice", "ses_alice")])
        await setActiveTask(root, sid, {
            type: "pipeline",
            stages: [{ member: "ghost", task: "x", completed: false }],
        })

        const stage: Stage = { member: "ghost", task: "x", completed: false }
        expect(advanceToStage(ctx, team, stage)).rejects.toThrow(/has no session/)
    })

    test("injects upstream context with [Output from] label and [Your task] header", async () => {
        const root = tmpRoot("ats-upstream")
        const sid = "ses_ats_upstream"
        tracked.push(sid)
        let captured = ""
        const promptAsync = mock(async (req: PromptReq) => {
            captured = req.body.parts[0].text
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        await setActiveTask(root, sid, {
            type: "pipeline",
            currentStageIndex: 1,
            stages: [
                { member: "alice", task: "do A", completed: true },
                { member: "bob", task: "do B", completed: false },
            ],
            responses: { alice: "ALICE_OUTPUT" },
        })

        const stage: Stage = { member: "bob", task: "do B specifically", completed: false }
        await advanceToStage(ctx, team, stage)

        expect(captured).toContain("[Output from alice]")
        expect(captured).toContain("ALICE_OUTPUT")
        expect(captured).toContain("[Your task]")
        expect(captured).toContain("do B specifically")
        // turnCount bumped + status flipped (dispatched event recorded via recordEvent)
        const bob = team.members.find(m => m.name === "bob")!
        expect(bob.turnCount).toBe(1)
        expect(bob.status).toBe("running")
        expect(bob.promptDelivered).toBe(true)
    })

    test("read_only action injects <no_issues/> contract", async () => {
        const root = tmpRoot("ats-ro")
        const sid = "ses_ats_ro"
        tracked.push(sid)
        let captured = ""
        const promptAsync = mock(async (req: PromptReq) => {
            captured = req.body.parts[0].text
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        const team = await makeTeam(root, sid, tracked, [makeMember("alice", "ses_alice")])
        await setActiveTask(root, sid, { type: "loop", stages: [] })

        const stage: Stage = {
            member: "alice",
            task: "review code",
            completed: false,
            action: "read_only",
        }
        await advanceToStage(ctx, team, stage)

        expect(captured).toContain("<no_issues/>")
        expect(captured).toContain("review code")
    })

    test("modify (default) action does NOT inject the no_issues contract", async () => {
        const root = tmpRoot("ats-modify")
        const sid = "ses_ats_modify"
        tracked.push(sid)
        let captured = ""
        const promptAsync = mock(async (req: PromptReq) => {
            captured = req.body.parts[0].text
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        const team = await makeTeam(root, sid, tracked, [makeMember("alice", "ses_alice")])
        await setActiveTask(root, sid, { type: "pipeline", stages: [] })

        const stage: Stage = { member: "alice", task: "do thing", completed: false }
        await advanceToStage(ctx, team, stage)

        expect(captured).not.toContain("<no_issues/>")
        expect(captured).toContain("do thing")
    })

    test("contextPrefix is prepended at the very top of the dispatched text", async () => {
        const root = tmpRoot("ats-prefix")
        const sid = "ses_ats_prefix"
        tracked.push(sid)
        let captured = ""
        const promptAsync = mock(async (req: PromptReq) => {
            captured = req.body.parts[0].text
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        await setActiveTask(root, sid, {
            type: "loop",
            currentStageIndex: 1,
            stages: [
                { member: "alice", task: "do A", completed: true },
                { member: "bob", task: "do B", completed: false },
            ],
            responses: { alice: "ALICE_OUT" },
        })

        const stage: Stage = { member: "bob", task: "do B", completed: false }
        const prefix = "FEEDBACK_FROM_DECIDER: fix X before retrying"
        await advanceToStage(ctx, team, stage, prefix)

        // Prefix is prepended verbatim, ahead of upstream context and task.
        expect(captured.indexOf(prefix)).toBe(0)
        expect(captured).toContain("[Output from alice]")
        expect(captured).toContain("ALICE_OUT")
        expect(captured).toContain("do B")
    })

    test("task-instruction is prepended exactly once on first advanceToStage dispatch", async () => {
        const root = tmpRoot("ats-si")
        const sid = "ses_ats_si"
        tracked.push(sid)
        const captured: string[] = []
        const promptAsync = mock(async (req: PromptReq) => {
            captured.push(req.body.parts[0].text)
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        const team = await makeTeam(root, sid, tracked, [makeMember("alice", "ses_alice")])
        const alice = team.members.find(m => m.name === "alice")!
        alice.prompt = "You are the verifier."
        alice.promptDelivered = false
        await setActiveTask(root, sid, { type: "pipeline", stages: [] })

        const stage: Stage = { member: "alice", task: "do thing", completed: false }
        await advanceToStage(ctx, team, stage)

        expect(captured).toHaveLength(1)
        expect(captured[0]).toContain("<task-instruction>")
        expect(captured[0]).toContain("You are the verifier.")
        expect(captured[0]).toContain("do thing")
        expect(alice.promptDelivered).toBe(true)
    })
})

// ============================================================
// ensureMembersReady: spawn lifecycle, error paths, and worktree
// failure. The happy-path test mocks the event-handler side-effect
// (flip member.initialized) inside the promptAsync mock so the
// role-setup barrier resolves on its first synchronous tick.
// ============================================================

describe("ensureMembersReady", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    async function writeSpec(
        root: string,
        teamName: string,
        sid: string,
        members: Array<{ name: string; role?: string; prompt?: string; worktree?: boolean }>,
    ) {
        const spec: TeamSpec = {
            version: 1,
            name: teamName,
            createdAt: Date.now(),
            members: members.map(m => ({
                name: m.name,
                role: m.role ?? "coder",
                prompt: m.prompt ?? "do good work",
                ...(m.worktree ? { worktree: true } : {}),
            })),
        }
        await writeTeamSpec(root, spec, sid)
    }

    test("all members already have sessionId: no-op early return (no spawn)", async () => {
        const root = tmpRoot("emr-noop")
        const sid = "ses_emr_noop"
        tracked.push(sid)
        const create = mock(async () => {
            throw new Error("session.create must NOT be called when all members are spawned")
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create } } } })
        const team = await makeTeam(root, sid, tracked, [makeMember("alice", "ses_a")])

        await ensureMembersReady(ctx, team)

        expect(create).toHaveBeenCalledTimes(0)
    })

    test("existing session waits until its non-master member initializes", async () => {
        const root = tmpRoot("emr-existing-init")
        const sid = "ses_emr_existing_init"
        tracked.push(sid)
        const create = mock(async () => {
            throw new Error("session.create must NOT be called for an existing session")
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create } } } })
        await writeSpec(root, "alpha", sid, [{ name: "alice" }])
        const team = await makeTeam(root, sid, tracked, [makeMember("alice", "ses_alice_existing")])
        const alice = team.members.find(m => m.name === "alice")!
        alice.initialized = false

        const readiness = ensureMembersReady(ctx, team)
        let resolved = false
        const settlement = readiness.then(() => {
            resolved = true
        })
        await Promise.resolve()

        expect(resolved).toBe(false)
        expect(create).toHaveBeenCalledTimes(0)
        alice.initialized = true
        await settlement
    })

    test("spec missing (no config.json): rejects with 'no config.json for team'", async () => {
        const root = tmpRoot("emr-nospec")
        const sid = "ses_emr_nospec"
        tracked.push(sid)
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        // Deliberately do NOT call writeTeamSpec.
        const team = await makeTeam(root, sid, tracked, [makeMember("alice")])

        expect(ensureMembersReady(ctx, team)).rejects.toThrow(/no config\.json for team/)
    })

    test("session.create returns no id: rejects with 'returned no id'", async () => {
        const root = tmpRoot("emr-noid")
        const sid = "ses_emr_noid"
        tracked.push(sid)
        const create = mock(async () => ({ data: {} })) // missing id
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create } } } })
        await writeSpec(root, "alpha", sid, [{ name: "alice" }])
        const team = await makeTeam(root, sid, tracked, [makeMember("alice")])

        expect(ensureMembersReady(ctx, team)).rejects.toThrow(/returned no id/)
    })

    test("prompt failure deletes the spawned session best-effort and preserves the original error", async () => {
        const root = tmpRoot("emr-prompt-delete")
        const sid = "ses_emr_prompt_delete"
        const spawnedSid = "ses_emr_prompt_delete_spawned"
        tracked.push(sid, spawnedSid)
        const promptError = new Error("promptAsync boom")
        const create = mock(async () => ({ data: { id: spawnedSid } }))
        const promptAsync = mock(async () => {
            throw promptError
        })
        const deleteSession = mock(async (_req: DeleteReq) => {
            throw new Error("session.delete boom")
        })
        const ctx = makeCtx({ storageRoot: root, directory: "/project", overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create, delete: deleteSession } } } })
        await writeSpec(root, "alpha", sid, [{ name: "alice" }])
        const team = await makeTeam(root, sid, tracked, [makeMember("alice")])

        let thrown: unknown
        try {
            await ensureMembersReady(ctx, team)
        } catch (error) {
            thrown = error
        }

        expect(thrown).toBe(promptError)
        expect(deleteSession).toHaveBeenCalledTimes(1)
        expect(deleteSession).toHaveBeenCalledWith({
            path: { id: spawnedSid },
            query: { directory: "/project" },
        })
    })

    test("happy path: spawns session, sends role-setup prompt, flips member to running", async () => {
        const root = tmpRoot("emr-happy")
        const sid = "ses_emr_happy"
        tracked.push(sid)
        const newMemberSid = "ses_alice_spawned"
        tracked.push(newMemberSid)

        let promptText = ""
        const promptAsync = mock(async (req: PromptReq) => {
            promptText = req.body.parts[0].text
            // Simulate the event handler flipping initialized after the
            // role-setup prompt is sent — the barrier resolves on its next tick.
            const alice = team.members.find(m => m.name === "alice")!
            alice.initialized = true
        })
        const create = mock(async () => ({ data: { id: newMemberSid } }))
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create } } } })

        await writeSpec(root, "alpha", sid, [
            { name: "alice", prompt: "You are the coder.", role: "coder" },
        ])
        const team = await makeTeam(root, sid, tracked, [makeMember("alice")])
        const alice = team.members.find(m => m.name === "alice")!
        // helper defaults initialized=true; ensureMembersReady flips it false
        // internally before the barrier, so just confirm the lifecycle runs.

        await ensureMembersReady(ctx, team)

        // Spawn side-effects on the in-memory member.
        expect(alice.sessionId).toBe(newMemberSid)
        expect(alice.status).toBe("running")
        expect(alice.turnCount).toBe(1)
        // spec.prompt is captured onto member.prompt for the FIRST real dispatch
        // (delivered as <task-instruction>); role-setup is identity-only.
        expect(alice.prompt).toBe("You are the coder.")
        expect(alice.promptDelivered).toBe(false)
        expect(alice.initialized).toBe(true)
        // role-setup prompt was actually dispatched.
        expect(create).toHaveBeenCalledTimes(1)
        expect(promptAsync).toHaveBeenCalledTimes(1)
        // buildRolePrompt embeds team name + member name + role label; it
        // intentionally does NOT embed spec.prompt (delivered later as standing
        // instruction to keep role-setup turn sub-second).
        expect(promptText).toContain("alpha")
        expect(promptText).toContain("alice")
        expect(promptText).toContain("Your role: coder")
        expect(promptText).not.toContain("You are the coder.")
        // body.agent + query.directory wired through on session.create
        // (role-setup promptAsync is identity-only — no directory needed,
        // member session already inherits ctx.directory from create).
        const createReq = (create.mock.calls[0] as unknown as Array<{ body: { parentID: string }; query: { directory: string } }>)[0]
        expect(createReq.body.parentID).toBe(sid)
        expect(createReq.query.directory).toBe("/app")
        const promptReq = (promptAsync.mock.calls[0] as unknown as Array<{ body: { parts: Array<{ synthetic: boolean }> } }>)[0]
        expect(promptReq.body.parts[0].synthetic).toBe(true)
    })

    test("member without a matching spec entry still spawns with the fallback role prompt", async () => {
        // Covers the `memberSpec` falsy branch in the rolePrompt selection.
        const root = tmpRoot("emr-fallbackspec")
        const sid = "ses_emr_fallbackspec"
        tracked.push(sid)
        const newMemberSid = "ses_bob_spawned"
        tracked.push(newMemberSid)

        let promptText = ""
        const promptAsync = mock(async (req: PromptReq) => {
            promptText = req.body.parts[0].text
            const bob = team.members.find(m => m.name === "bob")!
            bob.initialized = true
        })
        const create = mock(async () => ({ data: { id: newMemberSid } }))
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create } } } })

        // Spec lists a DIFFERENT member; bob is in state but not in spec.
        await writeSpec(root, "alpha", sid, [{ name: "alice" }])
        const team = await makeTeam(root, sid, tracked, [makeMember("bob")])

        await ensureMembersReady(ctx, team)

        const bob = team.members.find(m => m.name === "bob")!
        expect(bob.sessionId).toBe(newMemberSid)
        // Fallback role prompt must still mention the team and member name.
        expect(promptText).toContain("alpha")
        expect(promptText).toContain("bob")
        // The spec's alice prompt must NOT leak into bob's fallback prompt.
        expect(promptText).not.toContain("do good work")
    })

    test("multiple members: spawned in parallel within maxParallelMembers", async () => {
        const root = tmpRoot("emr-multi")
        const sid = "ses_emr_multi"
        tracked.push(sid)
        const state = makeState(
            "alpha",
            sid,
            [makeMember("alice"), makeMember("bob")],
            Date.now(),
        )
        await initTeamState(root, state, sid)
        await rebuildSessionIndex(root, `${root}__user_unused`)
        const team = await loadTeamState(root, "alpha", sid)
        await writeSpec(root, "alpha", sid, [{ name: "alice" }, { name: "bob" }])

        const spawnOrder: string[] = []
        const create = mock(async (req: PromptReq) => {
            const name = req.body.title!.split("/")[1]
            const id = `ses_${name}_spawned`
            spawnOrder.push(name)
            tracked.push(id)
            return { data: { id } }
        })
        const promptAsync = mock(async (req: PromptReq) => {
            const m = team.members.find(x => `ses_${x.name}_spawned` === req.path.id)
            if (m) m.initialized = true
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync, messages: async () => ({ data: [] }), create } } } })

        await ensureMembersReady(ctx, team)

        // Both spawned exactly once, both initialized, both running.
        expect(create).toHaveBeenCalledTimes(2)
        expect(spawnOrder.sort()).toEqual(["alice", "bob"])
        for (const m of team.members) {
            expect(m.sessionId).toBeDefined()
            expect(m.initialized).toBe(true)
            expect(m.status).toBe("running")
            expect(m.turnCount).toBe(1)
        }
    })

    test("worktree=true on a non-git project dir: createWorktree rejects with 'createWorktree(...) failed'", async () => {
        const root = tmpRoot("emr-wt-fail")
        const sid = "ses_emr_wt_fail"
        tracked.push(sid)
        // ctx.directory is the tmp root, which is NOT a git repo — git worktree add fails.
        const ctx = makeCtx({ storageRoot: root, directory: root, overrides: { client: { app: { log: async () => ({}) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_default" } }) } } } })
        await writeSpec(root, "alpha", sid, [{ name: "alice", worktree: true }])
        const team = await makeTeam(root, sid, tracked, [makeMember("alice")])

        expect(ensureMembersReady(ctx, team)).rejects.toThrow(/createWorktree\(alice\) failed/)

        // Failure happened before session.create — no session was spawned.
        const alice = team.members.find(m => m.name === "alice")!
        expect(alice.sessionId).toBeUndefined()
    })
})
