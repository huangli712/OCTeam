import { describe, expect, test } from "bun:test"
import path from "node:path"

import { teamDir, teamsDir } from "../src/state/paths.js"

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
