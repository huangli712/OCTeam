import { afterAll, describe, expect, test } from "bun:test"

import fs from "node:fs/promises"
import path from "node:path"

import { countMailbox } from "../src/tui/teams.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

/** Write lines into mailbox/<file> under teamDir, creating the dir as needed. */
async function writeMailbox(teamDir: string, file: string, lines: string[]): Promise<void> {
    const mailboxDir = path.join(teamDir, "mailbox")
    await fs.mkdir(mailboxDir, { recursive: true })
    await fs.writeFile(path.join(mailboxDir, file), lines.join("\n"))
}

afterAll(cleanupTmpRoots)

describe("countMailbox", () => {
    test("missing mailbox files -> zero, does not throw", async () => {
        const dir = tmpRoot("tui-mailbox-missing")
        const result = await countMailbox(dir, "alice")
        expect(result).toEqual({ unread: 0, total: 0 })
    })

    test("counts unread inbox lines", async () => {
        const dir = tmpRoot("tui-mailbox-unread")
        await writeMailbox(dir, "alice.jsonl", ['{"id":1}', '{"id":2}', '{"id":3}'])
        const result = await countMailbox(dir, "alice")
        expect(result).toEqual({ unread: 3, total: 3 })
    })

    test("total = inbox + processed", async () => {
        const dir = tmpRoot("tui-mailbox-total")
        await writeMailbox(dir, "alice.jsonl", ['{"id":1}', '{"id":2}'])
        await writeMailbox(dir, "alice.processed.jsonl", ['{"id":0}'])
        const result = await countMailbox(dir, "alice")
        expect(result).toEqual({ unread: 2, total: 3 })
    })

    test("blank lines are ignored", async () => {
        const dir = tmpRoot("tui-mailbox-blank")
        // trailing newline + interior blank line should not be counted
        await writeMailbox(dir, "alice.jsonl", ['{"id":1}', "", '{"id":2}', ""])
        const result = await countMailbox(dir, "alice")
        expect(result).toEqual({ unread: 2, total: 2 })
    })

    test("only processed present -> unread 0, total from processed", async () => {
        const dir = tmpRoot("tui-mailbox-processed-only")
        await writeMailbox(dir, "bob.processed.jsonl", ['{"id":1}', '{"id":2}'])
        const result = await countMailbox(dir, "bob")
        expect(result).toEqual({ unread: 0, total: 2 })
    })
})
