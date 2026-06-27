import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { MemberState, TeamState } from "../src/core/types.js"

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
 * Remove a single tmp root created by tmpRoot(). Idempotent (force: true makes a
 * missing path a no-op), so it is safe to call more than once.
 */
export function cleanupTmpRoot(root: string): void {
    rmSync(root, { recursive: true, force: true })
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
        } catch {
            // best-effort cleanup
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
