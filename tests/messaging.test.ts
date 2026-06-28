import { afterEach, describe, expect, spyOn, test } from "bun:test"

import { isForbiddenLateralMessage } from "../src/tools/messaging.js"

import fs from "node:fs/promises"

import type { PluginContext } from "../src/core/context.js"
import { createTransformHook } from "../src/hooks.js"
import { countUnreadMessages, formatMailboxInjection, writeMailboxMessage } from "../src/messaging/mailbox.js"
import { processedPath, reservedDir, teamDir } from "../src/state/paths.js"
import * as store from "../src/state/store.js"
import type { ActiveTask, Message, TeamState } from "../src/core/types.js"
import { indexMember, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

describe("isForbiddenLateralMessage (isolated comms gate)", () => {
    test("isolated + member sender + member recipient → forbidden", () => {
        expect(isForbiddenLateralMessage("isolated", false, ["bob"])).toBe(true)
    })

    test("isolated + member sender + master recipient → allowed", () => {
        expect(isForbiddenLateralMessage("isolated", false, ["master"])).toBe(false)
    })

    test("isolated + master sender + member recipient → allowed", () => {
        expect(isForbiddenLateralMessage("isolated", true, ["bob"])).toBe(false)
    })

    test("isolated + master sender + broadcast to all members → allowed", () => {
        expect(isForbiddenLateralMessage("isolated", true, ["alice", "bob", "carol"])).toBe(false)
    })

    test("isolated + member sender + multiple member recipients → forbidden", () => {
        expect(isForbiddenLateralMessage("isolated", false, ["alice", "carol"])).toBe(true)
    })

    test("isolated + member sender + mixed master/member recipients → forbidden (any member triggers)", () => {
        expect(isForbiddenLateralMessage("isolated", false, ["master", "bob"])).toBe(true)
    })

    test("collaborative + member sender + member recipient → allowed", () => {
        expect(isForbiddenLateralMessage("collaborative", false, ["bob"])).toBe(false)
    })

    test("undefined mode (no parallel run / pipeline / loop / delegate / consensus) → allowed", () => {
        expect(isForbiddenLateralMessage(undefined, false, ["bob"])).toBe(false)
    })

    test("isolated + member sender + empty recipients → allowed (nothing to forbid)", () => {
        expect(isForbiddenLateralMessage("isolated", false, [])).toBe(false)
    })
})

// --- T5: directive priority (Part A) + runId-scoped Transform filtering (Part B/C) ---

const LEAD = "ses_lead_msg"
const MEMBER = "ses_member_msg"
const TEAM = "mathx"
const MEMBER_NAME = "solver"

type TestPart = { type: string; text?: string; synthetic?: boolean }
type TestMsg = { info: { sessionID: string; role: string }; parts: TestPart[] }
type TransformOutput = Parameters<ReturnType<typeof createTransformHook>>[1]

/** The transform hook only reads ctx.storageRoot; a thin stub is enough. */
function ctxFor(root: string): PluginContext {
    return { storageRoot: root } as unknown as PluginContext
}

/** Fresh transform output each call (parts get mutated on injection). */
function makeOutput(sessionID: string): { messages: TestMsg[] } {
    return { messages: [{ info: { sessionID, role: "user" }, parts: [] }] }
}

function regularMsg(id: string, body: string): Message {
    return {
        version: 1,
        id,
        from: "verifier",
        to: MEMBER_NAME,
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

function directiveMsg(id: string, body: string, runId: string | undefined): Message {
    return {
        version: 1,
        id,
        from: "master",
        to: MEMBER_NAME,
        kind: "directive",
        body,
        timestamp: Date.now(),
        runId,
        deliveryStatus: "pending",
    }
}

/** Minimal ActiveTask fixture carrying a runId for scoped-directive tests. */
function makeActiveTask(runId: string): ActiveTask {
    return {
        type: "parallel",
        mode: "collaborative",
        startedAt: 1000,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId,
    }
}

/**
 * Set up a team whose activeTask carries `runId` (busy) — or no activeTask when
 * runId is undefined (live) — and index its member. Returns the team directory.
 */
async function setupTeam(root: string, runId: string | undefined): Promise<string> {
    const state: TeamState = {
        ...makeState(TEAM, LEAD, [makeMember(MEMBER_NAME, MEMBER)]),
        status: runId ? "busy" : "live",
        activeTask: runId ? makeActiveTask(runId) : undefined,
    }
    await store.initTeamState(root, state, LEAD)
    indexMember(MEMBER, TEAM, MEMBER_NAME, LEAD, root)
    return teamDir(root, TEAM, LEAD)
}

/** Count files currently stranded in the recipient's reserved/ dir (0 = no loop). */
async function reservedCount(dir: string, recipient: string): Promise<number> {
    try {
        return (await fs.readdir(reservedDir(dir, recipient))).length
    } catch {
        return 0
    }
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.stat(p)
        return true
    } catch {
        return false
    }
}

describe("formatMailboxInjection directive priority (T5 Part A)", () => {
    test("(a) directives render FIRST with [DIRECTIVE] marker, before regular messages", () => {
        const out = formatMailboxInjection([
            regularMsg("m1", "regular-one"),
            directiveMsg("d1", "the-directive", undefined),
            regularMsg("m2", "regular-two"),
        ])
        // Directive marker present and applied to the directive body.
        expect(out).toContain("[DIRECTIVE] the-directive")
        // Directive precedes BOTH regular messages.
        expect(out.indexOf("the-directive")).toBeLessThan(out.indexOf("regular-one"))
        expect(out.indexOf("the-directive")).toBeLessThan(out.indexOf("regular-two"))
        // Regular messages keep their relative order and are NOT marked.
        expect(out.indexOf("regular-one")).toBeLessThan(out.indexOf("regular-two"))
        expect(out).not.toContain("[DIRECTIVE] regular-one")
    })
})

describe("transform hook runId-scoped directive filtering (T5 Part B/C)", () => {
    afterEach(() => {
        unindexSession(MEMBER)
        unindexSession(LEAD)
    })

    test("(c) directive with MATCHING runId → injected", async () => {
        const root = tmpRoot("t5-match")
        const dir = await setupTeam(root, "R1")
        await writeMailboxMessage(dir, MEMBER_NAME, directiveMsg("d-match", "resume-now", "R1"))

        const transform = createTransformHook(ctxFor(root))
        const output = makeOutput(MEMBER)
        await transform({}, output as unknown as TransformOutput)

        expect(output.messages[0].parts).toHaveLength(1)
        expect(output.messages[0].parts[0].text).toContain("[DIRECTIVE] resume-now")
        // Acked: inbox drained, nothing stranded in reserved, committed to processed.
        expect(await countUnreadMessages(dir, MEMBER_NAME)).toBe(0)
        expect(await reservedCount(dir, MEMBER_NAME)).toBe(0)
        expect(await exists(processedPath(dir, MEMBER_NAME))).toBe(true)
    })

    test("(d) directive WITHOUT runId → injected (backward-compat)", async () => {
        const root = tmpRoot("t5-norun")
        const dir = await setupTeam(root, "R1")
        await writeMailboxMessage(dir, MEMBER_NAME, directiveMsg("d-norun", "legacy-directive", undefined))

        const transform = createTransformHook(ctxFor(root))
        const output = makeOutput(MEMBER)
        await transform({}, output as unknown as TransformOutput)

        expect(output.messages[0].parts).toHaveLength(1)
        expect(output.messages[0].parts[0].text).toContain("[DIRECTIVE] legacy-directive")
        expect(await countUnreadMessages(dir, MEMBER_NAME)).toBe(0)
        expect(await reservedCount(dir, MEMBER_NAME)).toBe(0)
    })

    test("(b) directive with NON-matching runId → skipped from injection BUT acked (no loop)", async () => {
        const root = tmpRoot("t5-mismatch")
        const dir = await setupTeam(root, "R1")
        // A regular message rides alongside the stale directive.
        await writeMailboxMessage(dir, MEMBER_NAME, regularMsg("m-keep", "still-flows"))
        await writeMailboxMessage(dir, MEMBER_NAME, directiveMsg("d-stale", "stale-body", "R2"))

        const transform = createTransformHook(ctxFor(root))
        const output = makeOutput(MEMBER)
        await transform({}, output as unknown as TransformOutput)

        // Regular message injected; the stale (mismatched-runId) directive is NOT.
        expect(output.messages[0].parts).toHaveLength(1)
        const text = output.messages[0].parts[0].text ?? ""
        expect(text).toContain("still-flows")
        expect(text).not.toContain("stale-body")
        // CRITICAL: the FULL reserved set is acked — the stale directive is NOT
        // stranded in reserved (which would loop via releaseStaleReservations → re-poll).
        expect(await countUnreadMessages(dir, MEMBER_NAME)).toBe(0)
        expect(await reservedCount(dir, MEMBER_NAME)).toBe(0)
        expect(await exists(processedPath(dir, MEMBER_NAME))).toBe(true)
    })

    test("(f) ALL messages stale directives → NO text part injected, full set acked (no loop)", async () => {
        const root = tmpRoot("t5-allstale")
        const dir = await setupTeam(root, "R1")
        await writeMailboxMessage(dir, MEMBER_NAME, directiveMsg("s1", "stale-1", "R2"))
        await writeMailboxMessage(dir, MEMBER_NAME, directiveMsg("s2", "stale-2", "R3"))

        const transform = createTransformHook(ctxFor(root))
        const output = makeOutput(MEMBER)
        await transform({}, output as unknown as TransformOutput)

        // Empty-injection guard: no synthetic text part pushed.
        expect(output.messages[0].parts).toHaveLength(0)
        // Full set still acked → no reservation loop.
        expect(await countUnreadMessages(dir, MEMBER_NAME)).toBe(0)
        expect(await reservedCount(dir, MEMBER_NAME)).toBe(0)

        // Idempotency: a second turn finds an empty inbox — still no injection, no loop.
        const output2 = makeOutput(MEMBER)
        await transform({}, output2 as unknown as TransformOutput)
        expect(output2.messages[0].parts).toHaveLength(0)
        expect(await reservedCount(dir, MEMBER_NAME)).toBe(0)
    })

    test("(e) loadTeamState consulted ONLY when a runId-scoped directive is present", async () => {
        const root = tmpRoot("t5-guard")
        const dir = await setupTeam(root, "R1")
        const transform = createTransformHook(ctxFor(root))
        const spy = spyOn(store, "loadTeamState")

        // Turn 1: a plain regular message — the guard must NOT load team state.
        // The only load on this turn is resolveTeamMember's own member resolution.
        await writeMailboxMessage(dir, MEMBER_NAME, regularMsg("m1", "hi"))
        spy.mockClear()
        await transform({}, makeOutput(MEMBER) as unknown as TransformOutput)
        const regularCalls = spy.mock.calls.length

        // Turn 2: a runId-scoped directive — the guard adds exactly one extra load.
        await writeMailboxMessage(dir, MEMBER_NAME, directiveMsg("d1", "go", "R1"))
        spy.mockClear()
        await transform({}, makeOutput(MEMBER) as unknown as TransformOutput)
        const scopedCalls = spy.mock.calls.length

        spy.mockRestore()

        // The scoped turn performs exactly ONE more loadTeamState than the regular
        // turn — that extra call IS the guard, and it fires only when a scoped
        // directive is present (not on every turn).
        expect(regularCalls).toBeGreaterThanOrEqual(1)
        expect(scopedCalls).toBe(regularCalls + 1)
    })
})
