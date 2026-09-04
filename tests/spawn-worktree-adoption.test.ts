/**
 * spawnMemberSafely worktree adoption (finding: retry-after-teardown hits
 * "branch already exists" — #761 form (c)).
 *
 * Threat model: a barrier-timeout teardown or a failed spawn rollback can
 * leave a member with sessionId cleared but worktreePath set and a live
 * worktree + `team/<team>/<member>` branch on disk. The pre-fix spawn path
 * unconditionally ran createWorktree, which fails fast with
 *   fatal: a branch named 'team/<team>/<member>' already exists
 * making every retry of ensureMembersReady deterministically fail.
 *
 * Fix under test: spawnMemberSafely adopts the leftover worktree when it is
 * exactly the canonical member worktree path AND still looks like a live git
 * worktree (dir + .git entry); otherwise it falls back to createWorktree.
 * Adopted worktrees are never destroyed by this spawn's own rollback.
 *
 * Because ensureMembersReady waits on the role-setup barrier, each test drives
 * it in the background, asserts spawn side effects, then marks the member
 * initialized so the barrier releases (pattern from dispatch-extra.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"
import { ensureMembersReady } from "../src/orchestration/control/members.js"
import { waitUntil } from "../src/core/utils.js"
import { worktreePath } from "../src/state/paths.js"
import { unindexSession } from "../src/state/resolve.js"
import type { TeamSpec } from "../src/core/types.js"
import {
    initTeamState,
    loadTeamState,
    writeTeamSpec,
    type Team,
} from "../src/state/store.js"

const execFileP = promisify(execFile)

/** Per-test timeout. These tests spawn real git subprocesses (worktree add,
 *  init, commit), so they need more headroom than bun's 5s default, which
 *  tripped intermittently under full-suite concurrency. */
const TEST_TIMEOUT_MS = 30_000

/** Bound for waiting on the first session.create, which is gated behind a real
 *  `git worktree add`. Kept below TEST_TIMEOUT_MS so a genuine hang fails with
 *  this informative error instead of an opaque harness kill. */
const SPAWN_WAIT_MS = 15_000

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function initGitRepo(dir: string): Promise<void> {
    await execFileP("git", ["init", "-q"], { cwd: dir })
    await execFileP("git", ["config", "user.email", "test@test.test"], { cwd: dir })
    await execFileP("git", ["config", "user.name", "test"], { cwd: dir })
    await execFileP("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir })
}

interface Harness {
    projectDir: string
    storageRoot: string
    team: Team
    wtPath: string
    branchName: string
    sessionDirs: string[]
    sessionCreates: number
}

async function setupHarness(suffix: string): Promise<Harness> {
    const projectDir = tmpRoot(`wt-adopt-git-${suffix}`)
    const storageRoot = tmpRoot(`wt-adopt-store-${suffix}`)
    const leadSid = `ses_wt_adopt_${suffix}`

    await initGitRepo(projectDir)

    const alice = makeMember("alice") // no sessionId → in toSpawn
    await initTeamState(storageRoot, makeState("alpha", leadSid, [alice]), leadSid)
    const spec: TeamSpec = {
        version: 1,
        name: "alpha",
        createdAt: Date.now(),
        members: [{ name: "alice", role: "coder", prompt: "code", worktree: true }],
    }
    await writeTeamSpec(storageRoot, spec, leadSid)
    const team = await loadTeamState(storageRoot, "alpha", leadSid)

    return {
        projectDir,
        storageRoot,
        team,
        wtPath: worktreePath(team.directory, "alice"),
        branchName: "team/alpha/alice",
        sessionDirs: [],
        sessionCreates: 0,
    }
}

function makeSpawnCtx(
    h: Harness,
    overrides: { sessionCreateError?: Error } = {},
) {
    return makeCtx({
        storageRoot: h.storageRoot,
        directory: h.projectDir,
        overrides: {
            client: {
                app: { log: async () => ({}) },
                session: {
                    create: async (args: { query?: { directory?: string } }) => {
                        h.sessionCreates++
                        if (overrides.sessionCreateError) throw overrides.sessionCreateError
                        h.sessionDirs.push(args.query?.directory ?? "")
                        return { data: { id: `ses_mock_alice_${h.sessionCreates}` } }
                    },
                    promptAsync: async () => ({}),
                    delete: async () => ({}),
                },
            },
        },
    })
}

/** Create the real leftover state: worktree on disk + branch + member.worktreePath. */
async function seedLeftover(h: Harness): Promise<void> {
    await execFileP(
        "git",
        ["worktree", "add", h.wtPath, "-b", h.branchName],
        { cwd: h.projectDir },
    )
    h.team.members[0].worktreePath = h.wtPath
}

/** Drive ensureMembersReady in the background, then release the barrier.
 *
 * initialized must be set AFTER the spawn body ran: spawnMemberSafely resets
 * member.initialized = false after session.create resolves, so setting it too
 * early gets clobbered and the barrier would wait for the real 120s timeout.
 * Waiting for the recorded session.create (plus a macrotask tick so the
 * post-create continuation finishes) guarantees the reset already happened.
 */
async function drive(h: Harness, ctx: ReturnType<typeof makeSpawnCtx>): Promise<void> {
    const readiness = ensureMembersReady(ctx, h.team)
    await waitUntil(() => h.sessionCreates > 0, { timeoutMs: SPAWN_WAIT_MS, pollMs: 10 })
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const m of h.team.members) if (!m.isMaster) m.initialized = true
    await readiness
}

describe("spawn worktree adoption (finding: retry-after-teardown branch collision)", () => {
    test("1. usable leftover at canonical path is adopted, not re-created", async () => {
        const h = await setupHarness("adopt")
        await seedLeftover(h)

        // Precondition: the leftover branch exists (this is what made the old
        // code fail fast with "branch already exists").
        const before = await execFileP(
            "git", ["branch", "--list", h.branchName], { cwd: h.projectDir },
        )
        expect(before.stdout.trim()).not.toBe("")

        await drive(h, makeSpawnCtx(h))

        // Adopted: session started IN the leftover worktree dir, exactly once.
        expect(h.sessionCreates).toBe(1)
        expect(h.sessionDirs[0]).toBe(h.wtPath)
        // member.worktreePath unchanged (still the adopted path).
        expect(h.team.members[0].worktreePath).toBe(h.wtPath)
        // Branch still present (not duplicated, not deleted).
        const after = await execFileP(
            "git", ["branch", "--list", h.branchName], { cwd: h.projectDir },
        )
        expect(after.stdout.trim()).not.toBe("")
    }, TEST_TIMEOUT_MS)

    test("2. leftover at a NON-canonical path is not adopted — falls back to createWorktree", async () => {
        const h = await setupHarness("mismatch")

        // Point the member at another directory that exists and has .git —
        // not the canonical member worktree path. Ownership check must reject.
        const fakeDir = tmpRoot("wt-adopt-fake")
        await execFileP("git", ["init", "-q"], { cwd: fakeDir })
        h.team.members[0].worktreePath = fakeDir

        await drive(h, makeSpawnCtx(h))

        // createWorktree re-ran and reassigned the canonical path.
        expect(h.team.members[0].worktreePath).toBe(h.wtPath)
        expect(h.sessionDirs[0]).toBe(h.wtPath)
    }, TEST_TIMEOUT_MS)

    test("3. clean member with no worktreePath spawns via createWorktree as before", async () => {
        const h = await setupHarness("clean")

        await drive(h, makeSpawnCtx(h))

        expect(h.team.members[0].worktreePath).toBe(h.wtPath)
        expect(h.sessionDirs[0]).toBe(h.wtPath)
        const branches = await execFileP(
            "git", ["branch", "--list", h.branchName], { cwd: h.projectDir },
        )
        expect(branches.stdout.trim()).not.toBe("")
    }, TEST_TIMEOUT_MS)

    test("4. adopted worktree survives a session.create failure (non-destructive rollback)", async () => {
        const h = await setupHarness("rollback")
        await seedLeftover(h)

        await expect(
            ensureMembersReady(
                makeSpawnCtx(h, { sessionCreateError: new Error("session.create boom") }),
                h.team,
            ),
        ).rejects.toThrow("session.create boom")

        // The adopted worktree must NOT be destroyed by rollback: it predates
        // this spawn attempt and may hold the member's prior work.
        const dirStat = await fs.lstat(h.wtPath)
        expect(dirStat.isDirectory()).toBe(true)
        const gitStat = await fs.lstat(`${h.wtPath}/.git`)
        expect(gitStat.isFile()).toBe(true)
        // The branch must still exist too.
        const branches = await execFileP(
            "git", ["branch", "--list", h.branchName], { cwd: h.projectDir },
        )
        expect(branches.stdout.trim()).not.toBe("")
    }, TEST_TIMEOUT_MS)
})
