import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { countMailbox, loadTeams } from "../src/tui/teams.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("TUI load state", () => {
    test("mailbox I/O failure is distinct from an empty mailbox", async () => {
        const teamDirectory = tmpRoot("tui-load-mailbox-error")
        await fs.mkdir(teamDirectory, { recursive: true })
        await fs.writeFile(path.join(teamDirectory, "mailbox"), "not a directory")

        const result = await countMailbox(teamDirectory, "alice")

        expect(result).toMatchObject({ status: "error" })
    })

    test("team directory I/O failure is distinct from no teams", async () => {
        const directory = tmpRoot("tui-load-teams-error")
        const sessionId = "ses_tui_load_error"
        const teamsPath = path.join(directory, ".octeam", sessionId, "teams")
        await fs.mkdir(path.dirname(teamsPath), { recursive: true })
        await fs.writeFile(teamsPath, "not a directory")

        const result = await loadTeams(directory, sessionId)

        expect(result).toMatchObject({ status: "error" })
    })
})
