import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { MemberState, TeamState } from "../src/types.js"

/** Create an isolated tmp storage root for a test. */
export function tmpRoot(label: string): string {
    return mkdtempSync(path.join(os.tmpdir(), `octeam-${label}-`))
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
