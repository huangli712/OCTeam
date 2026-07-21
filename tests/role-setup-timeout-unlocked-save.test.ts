/**
 * Regression test for confirmed finding "role-setup-timeout-unlocked-save".
 *
 * Bug: src/orchestration/control/dispatch.ts:202-219 — the role-setup barrier runs
 * OUTSIDE team.mutex (by necessity). Its .catch handler (timeout path) also
 * runs outside the mutex and:
 *   1. Mutates member state: sets status="errored", error="..." (lines 207-213)
 *   2. Calls saveTeamState(team) at line 216 — WITHOUT holding team.mutex,
 *      violating the save contract (store.ts:166: "The caller is expected to
 *      already hold team.mutex.runExclusive").
 *
 * Harm: saveTeamState is a BLIND WRITE of the in-memory Team snapshot under
 * the FILE lock only. Since the timeout handler is not serialized by
 * team.mutex, its save can land BEFORE a concurrent idle handler (which IS
 * under the mutex) has had a chance to flip member.initialized. The timeout
 * handler then persists status="errored" for a member that is ABOUT TO
 * initialize — corrupting the persisted state. A process crash in this window
 * leaves a permanently-wrong "errored" member on disk.
 *
 * Fix: wrap the timeout handler's state mutation + saveTeamState inside
 * team.mutex.runExclusive. The barrier wait itself stays outside the mutex
 * (holding it would deadlock the idle handler).
 *
 * This test deterministically reproduces the race: it pre-holds team.mutex so
 * a pending "idle handler" is queued behind it, then fires ensureMembersReady
 * (mocked waitUntil rejects immediately). On UNFIXED code the .catch handler
 * runs immediately (doesn't need team.mutex), marks the member errored, and
 * persists it to disk — BEFORE the idle handler gets to initialize the member.
 * On FIXED code the .catch handler blocks on team.mutex, the idle handler runs
 * first (flips initialized=true), and the timeout handler then sees
 * initialized=true and skips the errored marking.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

// --- Load the REAL core/utils.js BEFORE mock.module registers so all exports
//     except waitUntil keep their real implementations. mock.module replaces
//     the module globally and permanently in bun — other test files (e.g.
//     events.test.ts) use waitUntil as a test polling helper, so a permanent
//     always-reject mock breaks them. Solution: a runtime flag that makes the
//     mocked waitUntil delegate to the real one after this file's tests done. ---
const require = createRequire(import.meta.url)
const realUtils = require("../src/core/utils.js") as typeof import("../src/core/utils.js")
const realWaitUntil = realUtils.waitUntil

let forceTimeout = true

mock.module("../src/core/utils.js", () => ({
    ...realUtils,
    waitUntil: (...args: Parameters<typeof realWaitUntil>) =>
        forceTimeout
            ? Promise.reject(new Error("waitUntil: forced timeout"))
            : realWaitUntil(...args),
}))

import type { TeamSpec } from "../src/core/types.js"
import { ensureMembersReady } from "../src/orchestration/control/members.js"
import { initTeamState, loadTeamState, saveTeamState, writeTeamSpec } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { statePath } from "../src/state/paths.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"


/** Read state.json directly from disk, bypassing the registry cache. */
async function readDiskState(directory: string): Promise<{ members: Array<{ status: string; initialized: boolean }> }> {
    const raw = await readFile(statePath(directory), "utf8")
    return JSON.parse(raw)
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

// Restore the real waitUntil for subsequent test files. mock.module is
// process-global in bun — re-registration doesn't override. Instead, flip
// the runtime flag so the mocked waitUntil delegates to the real one.
afterAll(() => {
    forceTimeout = false
})

describe("role-setup timeout unlocked save (finding: role-setup-timeout-unlocked-save)", () => {
    test("timeout handler must NOT persist errored status for a member that is about to initialize", async () => {
        const root = tmpRoot("timeout-unlocked")
        const leadSid = "ses_to_master"
        const aliceSid = "ses_mock_alice"
        tracked.push(aliceSid)

        // --- Live team with alice (no sessionId → enters spawn loop) ---
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", leadSid, [alice]), leadSid)
        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [{ name: "alice", role: "coder", prompt: "code", agent: "oct-junior" }],
        }
        await writeTeamSpec(root, spec, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)

        // --- 1. Pre-hold team.mutex so a pending idle handler stays queued. ---
        let releaseGate!: () => void
        const gate = new Promise<void>(r => { releaseGate = r })
        const mutexHold = team.mutex.runExclusive(async () => { await gate })

        // --- 2. Queue the "idle handler": it will acquire the mutex (after the
        //     pre-hold releases), flip alice.initialized=true, and save. This
        //     represents alice's role-setup idle arriving just as the barrier
        //     times out. ---
        const idleHandlerDone = team.mutex.runExclusive(async () => {
            const m = team.members.find(x => x.name === "alice")!
            m.initialized = true
            m.status = "idle"
            m.error = undefined
            await saveTeamState(team)
        })

        // --- 3. Fire ensureMembersReady and IMMEDIATELY attach a .catch so
        //     the rejection (barrier timeout) is captured, not unhandled. The
        //     spawn loop creates alice's session (mocked), then the mocked
        //     waitUntil rejects immediately. The .catch handler runs:
        //       UNFIXED: marks alice "errored" + saveTeamState (OUTSIDE mutex,
        //               uses only the file lock → succeeds while mutex is held).
        //               Persists "errored" to disk immediately.
        //       FIXED: tries to acquire team.mutex → BLOCKS (behind pre-hold
        //             and the queued idle handler). Does NOT persist yet. ---
        const ensureResult = ensureMembersReady(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}) }, session: { create: async () => ({ data: { id: "ses_mock_alice" } }), promptAsync: async () => ({}) } } } }), team).then(
            () => "unexpected-success" as const,
            (err: unknown) => err as Error,
        )

        // Drain microtasks: spawn loop + waitUntil(reject) + .catch all run.
        await new Promise(r => setTimeout(r, 50))

        // --- 4. ASSERT: at this point, disk must NOT have alice persisted as
        //     "errored". On UNFIXED code the .catch saved "errored" outside
        //     the mutex → disk HAS "errored" → FAIL. On FIXED code the .catch
        //     is blocked on the mutex → disk is untouched → PASS. ---
        const diskState = await readDiskState(team.directory)
        const diskAlice = diskState.members.find((m: { status: string; initialized: boolean }) =>
            (m as { name?: string }).name === "alice",
        )!
        // Check the FIRST member (alice is the only non-master member).
        // On UNFIXED code: the timeout handler persisted status="errored".
        // On FIXED code: the timeout handler hasn't persisted anything yet.
        expect(diskAlice.status).not.toBe("errored")

        // --- 5. Release the mutex: the idle handler runs (flips initialized),
        //     then the timeout handler (if fixed) runs under the mutex. ---
        releaseGate()
        await mutexHold
        await idleHandlerDone
        // ensureMembersReady throws "barrier timed out" regardless of fix.
        const result = await ensureResult
        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toContain("barrier timed out")
    })
})
