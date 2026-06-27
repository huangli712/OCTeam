import { describe, expect, test } from "bun:test"
import path from "node:path"

import {
    claimLockPath,
    inboxPath,
    mailboxLockPath,
    processedPath,
    reservedDir,
    reservedPath,
    runDir,
    runMemberOutputPath,
    taskPath,
    taskUpdateLockPath,
    teamDir,
    teamsDir,
    worktreePath,
} from "../src/state/paths.js"

describe("teamsDir", () => {
    test("with leadSessionId → <root>/<sid>/teams", () => {
        expect(teamsDir("/root", "ses_x")).toBe(path.join("/root", "ses_x", "teams"))
    })

    test("without leadSessionId → <root>/teams", () => {
        expect(teamsDir("/root")).toBe(path.join("/root", "teams"))
    })
})

describe("teamDir", () => {
    test("with leadSessionId → <root>/<sid>/teams/<name>", () => {
        expect(teamDir("/root", "aaa", "ses_x")).toBe(path.join("/root", "ses_x", "teams", "aaa"))
    })

    test("without leadSessionId → <root>/teams/<name>", () => {
        expect(teamDir("/root", "aaa")).toBe(path.join("/root", "teams", "aaa"))
    })
})

// --- P1-3: assertSafeSegment path-traversal guards ---

// The set of single-segment inputs that MUST be rejected by assertSafeSegment:
// parent-dir refs, path separators (both kinds), the bare "." / "..", the empty
// string, and an embedded NUL. A safe segment ("alice") must always be accepted.
const UNSAFE_SEGMENTS = ["../", "/", "\\", "..", ".", "", "x\0"]

describe("assertSafeSegment path guards", () => {
    // Each guarded helper, exercised through the public path-construction API so
    // the test pins the actual chokepoint (not assertSafeSegment in isolation).
    const helpers: Array<{ name: string; call: (seg: string) => unknown }> = [
        { name: "teamDir", call: seg => teamDir("/root", seg, "ses_x") },
        { name: "worktreePath", call: seg => worktreePath("/team", seg) },
        { name: "runMemberOutputPath", call: seg => runMemberOutputPath("/team", "run1", seg) },
        { name: "inboxPath", call: seg => inboxPath("/team", seg) },
        { name: "processedPath", call: seg => processedPath("/team", seg) },
        { name: "reservedDir", call: seg => reservedDir("/team", seg) },
        // reservedPath validates the messageId segment (recipient is a fixed safe value).
        { name: "reservedPath", call: seg => reservedPath("/team", "carol", seg) },
        { name: "mailboxLockPath", call: seg => mailboxLockPath("/team", seg) },
        { name: "taskPath", call: seg => taskPath("/team", seg) },
        { name: "claimLockPath", call: seg => claimLockPath("/team", seg) },
        { name: "taskUpdateLockPath", call: seg => taskUpdateLockPath("/team", seg) },
        { name: "runDir", call: seg => runDir("/team", seg) },
    ]

    for (const { name, call } of helpers) {
        for (const bad of UNSAFE_SEGMENTS) {
            test(`${name} throws on unsafe segment ${JSON.stringify(bad)}`, () => {
                expect(() => call(bad)).toThrow()
            })
        }
        test(`${name} accepts a safe segment`, () => {
            expect(() => call("alice")).not.toThrow()
        })
    }
})

describe("teamsDir leadSessionId guard", () => {
    for (const bad of UNSAFE_SEGMENTS) {
        test(`throws on unsafe leadSessionId ${JSON.stringify(bad)}`, () => {
            expect(() => teamsDir("/root", bad)).toThrow()
        })
    }

    test("accepts undefined leadSessionId (user scope, flat layout)", () => {
        expect(() => teamsDir("/root")).not.toThrow()
    })

    test("accepts a safe leadSessionId", () => {
        expect(() => teamsDir("/root", "ses_x")).not.toThrow()
    })
})
