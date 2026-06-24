import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import { teamDetailsTool } from "../src/tools/lifecycle.js"
import { initTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/core/utils.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

/** Minimal valid ActiveTask with overrides. */
function makeTask(partial: Partial<ActiveTask>): ActiveTask {
    return {
        type: "parallel",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        ...partial,
    }
}

async function setupTeam(
    root: string,
    sid: string,
    opts: { activeTask?: ActiveTask; activatedAt?: number; members?: ReturnType<typeof makeMember>[] } = {},
): Promise<void> {
    const members = opts.members ?? [makeMember("alice")]
    const state = makeState("alpha", sid, members, opts.activatedAt)
    if (opts.activeTask) state.activeTask = opts.activeTask
    await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("team_details new fields", () => {
    test("(1) active status yes when activatedAt set", async () => {
        const root = tmpRoot("det-active")
        const sid = "ses_det_active"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })
        const result = await teamDetailsTool(makeCtx(root)).execute({ team_id: "alpha" }, { sessionID: sid } as any)
        expect(result).toContain("active: yes")
    })

    test("(1) active status no when activatedAt absent", async () => {
        const root = tmpRoot("det-inactive")
        const sid = "ses_det_inactive"
        tracked.push(sid)
        await setupTeam(root, sid, {})
        const result = await teamDetailsTool(makeCtx(root)).execute({ team_id: "alpha" }, { sessionID: sid } as any)
        expect(result).toContain("active: no")
    })

    test("(6) member model shows provider prefix", async () => {
        const root = tmpRoot("det-model")
        const sid = "ses_det_model"
        tracked.push(sid)
        const alice = { ...makeMember("alice"), model: "anthropic/claude-sonnet-4" }
        await setupTeam(root, sid, { members: [alice] })
        const result = await teamDetailsTool(makeCtx(root)).execute({ team_id: "alpha" }, { sessionID: sid } as any)
        expect(result).toContain("anthropic/claude-sonnet-4")
    })

    test("(2) parallel shows reduce + signoff policy", async () => {
        const root = tmpRoot("det-parallel")
        const sid = "ses_det_par"
        tracked.push(sid)
        await setupTeam(root, sid, {
            activeTask: makeTask({
                type: "parallel",
                mode: "isolated",
                reducePolicy: "rubric",
                reduceRubric: " correctness",
                signoffPolicy: "decider",
                signoffDecider: "alice",
            }),
        })
        const result = await teamDetailsTool(makeCtx(root)).execute({ team_id: "alpha" }, { sessionID: sid } as any)
        expect(result).toContain("reduce: rubric")
        expect(result).toContain("signoff: decider")
        expect(result).toContain("decider: alice")
    })

    test("(4) loop shows decider + last decision", async () => {
        const root = tmpRoot("det-loop")
        const sid = "ses_det_loop"
        tracked.push(sid)
        await setupTeam(root, sid, {
            activeTask: makeTask({
                type: "loop",
                deciderMember: "alice",
                decisionHistory: [
                    { round: 1, decision: "continue", rationale: "not done", nextActions: ["fix tests"], timestamp: Date.now() },
                ],
                decisionParseFailures: 0,
            }),
        })
        const result = await teamDetailsTool(makeCtx(root)).execute({ team_id: "alpha" }, { sessionID: sid } as any)
        expect(result).toContain("decider: alice")
        expect(result).toContain("last: continue")
        expect(result).toContain("round 1")
    })

    test("(5) consensus shows reached flag", async () => {
        const root = tmpRoot("det-consensus")
        const sid = "ses_det_cons"
        tracked.push(sid)
        await setupTeam(root, sid, {
            activeTask: makeTask({
                type: "consensus",
                consensusReached: true,
                topic: "use sqlite",
            }),
        })
        const result = await teamDetailsTool(makeCtx(root)).execute({ team_id: "alpha" }, { sessionID: sid } as any)
        expect(result).toContain("Consensus: reached")
    })

    test("(3) delegate shows tasklist summary (empty)", async () => {
        const root = tmpRoot("det-delegate")
        const sid = "ses_det_del"
        tracked.push(sid)
        await setupTeam(root, sid, {
            activeTask: makeTask({ type: "delegate" }),
        })
        const result = await teamDetailsTool(makeCtx(root)).execute({ team_id: "alpha" }, { sessionID: sid } as any)
        expect(result).toContain("Tasks:")
        expect(result).toContain("of 0)")
    })
})
