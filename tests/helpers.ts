import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ToolContext } from "@opencode-ai/plugin"
import type { ActiveTask, MemberState, TeamState, WorkflowTask } from "../src/core/types.js"
import type { PluginContext } from "../src/core/context.js"
import { afterAll, afterEach } from 'bun:test'

import { initTeamState, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { indexMasterTeam, rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { AsyncMutex } from "../src/state/locks.js"
import { waitUntil } from "../src/core/utils.js"
import { inboxPath, runEventsPath } from "../src/state/paths.js"

/** PluginContext for resume: storageRoot + a capturing promptAsync. */
export function makeResumeCtx(
    root: string,
    promptAsync: (req: { path: { id: string } }) => Promise<void>,
): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        directory: "/app",
        client: {
            session: {
                promptAsync,
                messages: async () => ({ data: [] }),
            },
        },
    } as unknown as PluginContext
}

/**
 * Build a failed team carrying a lastInterruptedTask, indexed for resume.
 * Common to route/arbitrate/recurse/tollgate resume tests.
 */
export async function setupFailedTeam(
    root: string,
    sid: string,
    task: ActiveTask,
    members: MemberState[],
): Promise<Team> {
    const state = makeState("alpha", sid, members, Date.now())
    state.status = "failed"
    await initTeamState(root, state, sid)
    const team = await loadTeamState(root, "alpha", sid)
    await team.mutex.runExclusive(async () => {
        team.lastInterruptedTask = task
        await saveTeamState(team)
    })
    await rebuildSessionIndex(root, `${root}__unused`)
    return team
}

// Track every tmp root created in this process. mkdtempSync dirs otherwise
// leak: most suites only unindexSession in their afterEach and never remove the
// tmp dir, so /tmp/octeam-* accumulates across runs. Suites opt into cleanup by
// calling cleanupTmpRoots() in an afterAll (see recommended usage below).
const createdTmpRoots: string[] = []

/** Create an isolated tmp storage root for a test. Tracked for cleanupTmpRoots(). */
export function tmpRoot(label: string): string {
    const root = mkdtempSync(path.join(os.tmpdir(), `octeam-${label}-`))
    createdTmpRoots.push(root)
    return root
}

/**
 * Remove every tmp root created via tmpRoot() so far and reset the tracking
 * list. Recommended usage — keep /tmp clean without per-test bookkeeping:
 *
 *     import { afterAll } from "bun:test"
 *     import { cleanupTmpRoots } from "./helpers.js"
 *     afterAll(cleanupTmpRoots)
 */
export function cleanupTmpRoots(): void {
    for (const root of createdTmpRoots.splice(0)) {
        try {
            rmSync(root, { recursive: true, force: true })
        } catch (e) {
            console.warn(`[cleanupTmpRoots] failed to remove ${root}:`, e)
        }
    }
}

/** Minimal valid MemberState for fixtures. */
export function makeMember(name: string, sessionId?: string): MemberState {
    return {
        name,
        sessionId,
        status: "idle",
        initialized: true,
        turnCount: 0,
    }
}

/** Minimal valid TeamState for fixtures. */
export function makeState(
    teamName: string,
    leadSessionId: string,
    members: MemberState[] = [],
    activatedAt?: number,
): TeamState {
    return {
        version: 1,
        teamRunId: `run-${teamName}-${leadSessionId}`,
        teamName,
        status: "live",
        leadSessionId,
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
        createdAt: Date.now(),
        activatedAt,
    }
}

/**
 * Build a minimal ToolContext stub for tool.execute() calls in tests.
 *
 * The real ToolContext (from @opencode-ai/plugin) has 8 required fields, but
 * OCTeam tool handlers only read `sessionID` (for master/member resolution).
 * This factory fills the remaining fields with safe no-op defaults so tests
 * pass a fully-typed ToolContext instead of `{ sessionID } as any`.
 *
 * `ask` returns an Effect; the no-op stub never resolves (tools that call ask
 * would hang — but no OCTeam tool uses ask in the tested code paths).
 *
 * Override any field via the optional second argument when a test needs a
 * non-default value (e.g. a custom abort signal).
 */
export function makeToolContext(
    sessionID: string,
    overrides?: Partial<ToolContext>,
): ToolContext {
    return {
        sessionID,
        messageID: `msg-${sessionID}`,
        agent: "oct-junior",
        directory: "/app",
        worktree: "/app",
        abort: new AbortController().signal,
        metadata: () => {},
        // ask is never called by OCTeam tools; stub with an unresolved Effect.
        ask: (() => ({}) as never) as ToolContext["ask"],
        ...overrides,
    }
}

// --- Shared orchestration-test fixtures ---
// These collapse the makeCtx / makeTeam / makeTask / DispatchCall /
// waitForEvent duplication documented across 100+ test files. See
// tests/README-FIXTURES.md (or the Phase 1 migration notes) for usage.

/**
 * A recorded promptAsync call: which session got which text. Shared by
 * orchestration-handler suites that assert on dispatch order/content.
 */
export type DispatchCall = { readonly sessionId: string; readonly text: string }

/**
 * Poll the run events file until an event of `kind` is flushed to disk.
 * recordEvent is fire-and-forget, so we wait deterministically for the append
 * to land rather than sleeping a fixed duration. Verbatim copy across 5 files.
 */
export async function waitForEvent(
    directory: string,
    runId: string,
    kind: string,
): Promise<void> {
    const p = runEventsPath(directory, runId)
    await waitUntil(
        () => existsSync(p) && readFileSync(p, "utf8").includes(`"kind":"${kind}"`),
        { timeoutMs: 2000, pollMs: 10 },
    )
}

/**
 * Minimal valid ActiveTask with overrides. Defaults to a parallel task; tests
 * pass `type` and type-specific fields via overrides. Used by suites that only
 * need the common ActiveTask shape.
 */
export function makeTask(overrides: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        ...overrides,
    } as ActiveTask
}

/**
 * Minimal valid WorkflowTask with overrides. Defaults match the most common
 * fixture pattern across 11+ workflow test suites: Date.now() start, 300s
 * timeout, random runId, signoffPolicy="none". Callers override via opts
 * (e.g. steps, activeStepIndices, responses, wallClockTimeoutMs).
 */
export function makeWorkflowTask(opts: Partial<WorkflowTask> = {}): WorkflowTask {
    return {
        type: "workflow",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        signoffPolicy: "none",
        ...opts,
    } as WorkflowTask
}

/**
 * Build a stub PluginContext. A single options object covers the four shapes
 * that recurred across 80+ files:
 *
 *   - storage-only (no client):        { storageRoot }
 *   - calls-recording:                 { calls, outputs? }  / { storageRoot, calls }
 *   - custom promptAsync:              { storageRoot, promptAsync }
 *   - overrides object (abort/status): { storageRoot, abort?, messages?, status? }
 *
 * Rules:
 *   - directory defaults to "/app".
 *   - When storageRoot is set, scope defaults to "project".
 *   - A client block is built iff any dispatch field (calls, outputs, promptAsync,
 *     abort, messages, status) is provided OR `client: true`. storageRoot alone
 *     yields a client-less ctx (matches the storage-only tool suites).
 *   - When a client is built, app.log defaults to a no-op (logEvent reads it at
 *     info+ levels; the no-op is strictly additive and never changes behavior).
 *   - `calls` installs a promptAsync recorder; `outputs` additionally installs a
 *     messages stub returning per-session assistant text. `promptAsync`/`messages`
 *     overrides take precedence over the calls/outputs-derived defaults.
 *   - `overrides` is merged last for any field not modeled above.
 */
/** Shape of a promptAsync request as issued by dispatchToMember. */
type PromptAsyncRequest = {
    path: { id: string }
    body: { parts: Array<{ type: string; text: string }> }
}

export interface MakeCtxOptions {
    storageRoot?: string
    directory?: string
    scope?: "project" | "user"
    calls?: DispatchCall[]
    outputs?: Record<string, string>
    promptAsync?: (req: PromptAsyncRequest) => Promise<unknown>
    messages?: (req: unknown) => Promise<{ data: unknown[] }>
    status?: (req: unknown) => Promise<{ data: unknown }>
    abort?: (req: unknown) => Promise<unknown>
    /** Force-build a client block even with no dispatch fields. */
    client?: boolean
    /** Force-omit the client block even when dispatch fields are present. */
    noClient?: boolean
    /** Extra fields merged last (e.g. projectStorageRoot). */
    overrides?: Record<string, unknown>
}

export function makeCtx(opts: MakeCtxOptions = {}): PluginContext {
    const base: Record<string, unknown> = { directory: opts.directory ?? "/app" }
    if (opts.storageRoot !== undefined) {
        base.storageRoot = opts.storageRoot
        base.scope = opts.scope ?? "project"
    } else if (opts.scope !== undefined) {
        base.scope = opts.scope
    }

    const hasDispatch =
        opts.calls !== undefined ||
        opts.outputs !== undefined ||
        opts.promptAsync !== undefined ||
        opts.abort !== undefined ||
        opts.messages !== undefined ||
        opts.status !== undefined
    if ((hasDispatch || opts.client === true) && opts.noClient !== true) {
        const session: Record<string, unknown> = {}
        if (opts.abort !== undefined) session.abort = opts.abort
        if (opts.promptAsync !== undefined) {
            session.promptAsync = opts.promptAsync
        } else if (opts.calls !== undefined) {
            const calls = opts.calls
            session.promptAsync = async (args: PromptAsyncRequest) => {
                // Strip the OMO_INTERNAL_INITIATOR marker appended by dispatchToMember;
                // it is a dispatch-layer detail, not semantic task content.
                const raw = (args.body.parts[0]?.text ?? "").replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "")
                calls.push({ sessionId: args.path.id, text: raw })
                return { data: {} }
            }
        }
        if (opts.messages !== undefined) {
            session.messages = opts.messages
        } else if (opts.outputs !== undefined) {
            const outputs = opts.outputs
            session.messages = async ({ path }: { path: { id: string } }) => {
                const text = outputs[path.id] ?? ""
                return {
                    data: [
                        { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                        ...(text
                            ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]
                            : []),
                    ],
                }
            }
        } else {
            session.messages = async () => ({ data: [] })
        }
        if (opts.status !== undefined) session.status = opts.status
        base.client = { app: { log: async () => ({}) }, session }
    }

    if (opts.overrides) Object.assign(base, opts.overrides)
    return base as unknown as PluginContext
}

/**
 * Minimal in-memory busy Team wrapper for orchestration-handler suites. Builds
 * a real tmp directory (for file IO) unless `directory` is provided. Members are
 * normalized with idle/initialized/turnCount defaults plus passthrough of
 * sessionId/agent/isMaster/error/declaredDone.
 *
 * Covers the `makeTeam({ activeTask?, members? })` shape from parallel, consensus,
 * arbitrate, route, delegate, tollgate, workflow-*, etc. Does NOT cover the
 * disk-based async makeTeam (real initTeamState) nor the barrier-specialized
 * variants — those stay local where their semantics differ.
 */
export interface MakeTeamOptions {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
    /** Fresh tmp dir when omitted; provided directory when set. */
    directory?: string
    teamName?: string
    teamRunId?: string
    leadSessionId?: string
}

export function makeTeam(opts: MakeTeamOptions = {}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
        error: m.error,
        declaredDone: m.declaredDone,
    }))
    const team: Team = {
        version: 1,
        teamRunId: opts.teamRunId ?? "test-run",
        teamName: opts.teamName ?? "test-team",
        status: "busy",
        leadSessionId: opts.leadSessionId ?? "ses_lead",
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
        directory: opts.directory ?? tmpRoot("team"),
    } as unknown as Team
    // Register the master session in the in-memory index so tools that
    // verify master authorization via isIndexedMasterOf find the team. Test
    // fixtures built with makeTeam are in-memory only (no disk scan via
    // rebuildSessionIndex), so without this registration the master-auth
    // hardening check would reject every fixture-driven master call.
    if (team.leadSessionId) {
        indexMasterTeam(team.leadSessionId, team.teamName, team.leadSessionId,
            path.dirname(team.directory), team.directory)
    }
    return team
}

/**
 * Append a raw line to a recipient's inbox file, creating the directory if
 * needed. Used by mailbox regression tests to seed malformed/edge-case lines
 * directly, bypassing writeMailboxMessage's validation.
 */
export async function writeRawInboxLine(teamDir: string, recipient: string, line: string): Promise<void> {
    const p = inboxPath(teamDir, recipient)
    await mkdir(path.dirname(p), { recursive: true })
    await appendFile(p, line + "\n", "utf8")
}

/**
 * Build a status() function that returns "idle" for sessions listed in
 * `outputs` and nothing for others. Used by orchestration-handler suites
 * to simulate member idle events deterministically.
 */
export function statusIdleFrom(outputs: Record<string, string>): () => Promise<{ data: Record<string, { type: string }> }> {
    return async () => ({ data: Object.fromEntries(Object.entries(outputs).map(([id]) => [id, { type: "idle" }])) })
}

/**
 * Shared HITL test lifecycle: tracked session cleanup + setupTeam for team-creation.
 * Call once at module level in any HITL test file to replace the 15-line
 * duplicated pattern (tracked/afterEach/afterAll/setupTeam).
 */
export function makeHitlLifecycle() {
    const tracked: string[] = []

    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })
    afterAll(cleanupTmpRoots)

    async function setupTeam(root: string, sid: string, members: MemberState[]): Promise<Team> {
        tracked.push(sid)
        for (const member of members) {
            if (member.sessionId) tracked.push(member.sessionId)
        }
        await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
        await rebuildSessionIndex(root, `${root}__user_unused`)
        return loadTeamState(root, "alpha", sid)
    }

    return { setupTeam }
}
