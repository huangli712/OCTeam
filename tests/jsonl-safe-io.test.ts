import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { appendJsonl, readJsonl, truncateFile } from "../src/messaging/jsonl.js"
import { inboxPath } from "../src/state/paths.js"
import { countMailbox } from "../src/tui/teams.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function message(id: string, body: string): Record<string, unknown> {
    return {
        version: 1,
        id,
        from: "alice",
        to: "bob",
        kind: "message",
        timestamp: 1,
        body,
        deliveryStatus: "pending",
    }
}

describe("JSONL fd-based I/O", () => {
    test("readJsonl does not follow a leaf symlink swapped after validation", async () => {
        const root = tmpRoot("jsonl-read-swap")
        const target = path.join(root, "mailbox", "bob.jsonl")
        const outside = path.join(tmpRoot("jsonl-read-swap-outside"), "outside.jsonl")
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, `${JSON.stringify(message("inside", "inside"))}\n`)
        await fs.writeFile(outside, `${JSON.stringify(message("outside", "outside"))}\n`)

        const originalReadFile = fs.readFile
        let swapped = false
        Object.defineProperty(fs, "readFile", {
            configurable: true,
            value: async (...args: Parameters<typeof fs.readFile>) => {
                if (!swapped && path.resolve(String(args[0])) === path.resolve(target)) {
                    swapped = true
                    await fs.unlink(target)
                    await fs.symlink(outside, target)
                }
                return originalReadFile(...args)
            },
        })

        try {
            const messages = await readJsonl(target, root)
            expect(messages.map(item => item.id)).toEqual(["inside"])
        } finally {
            Object.defineProperty(fs, "readFile", { configurable: true, value: originalReadFile })
        }
    })

    test("appendJsonl does not follow a leaf symlink swapped before append", async () => {
        const root = tmpRoot("jsonl-append-swap")
        const target = path.join(root, "mailbox", "bob.jsonl")
        const outside = path.join(tmpRoot("jsonl-append-swap-outside"), "outside.jsonl")
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, "")
        await fs.writeFile(outside, "outside\n")

        const originalAppendFile = fs.appendFile
        let swapped = false
        Object.defineProperty(fs, "appendFile", {
            configurable: true,
            value: async (...args: Parameters<typeof fs.appendFile>) => {
                if (!swapped && path.resolve(String(args[0])) === path.resolve(target)) {
                    swapped = true
                    await fs.unlink(target)
                    await fs.symlink(outside, target)
                }
                return originalAppendFile(...args)
            },
        })

        try {
            await appendJsonl(target, message("new", "new"), root)
            expect(await fs.readFile(outside, "utf8")).toBe("outside\n")
        } finally {
            Object.defineProperty(fs, "appendFile", { configurable: true, value: originalAppendFile })
        }
    })

    test("truncateFile does not follow a leaf symlink swapped before write", async () => {
        const root = tmpRoot("jsonl-truncate-swap")
        const target = path.join(root, "mailbox", "bob.jsonl")
        const outside = path.join(tmpRoot("jsonl-truncate-swap-outside"), "outside.jsonl")
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, "inside\n")
        await fs.writeFile(outside, "outside\n")

        const originalWriteFile = fs.writeFile
        let swapped = false
        Object.defineProperty(fs, "writeFile", {
            configurable: true,
            value: async (...args: Parameters<typeof fs.writeFile>) => {
                if (!swapped && path.resolve(String(args[0])) === path.resolve(target)) {
                    swapped = true
                    await fs.unlink(target)
                    await fs.symlink(outside, target)
                }
                return originalWriteFile(...args)
            },
        })

        try {
            await truncateFile(target, root)
            expect(await fs.readFile(outside, "utf8")).toBe("outside\n")
        } finally {
            Object.defineProperty(fs, "writeFile", { configurable: true, value: originalWriteFile })
        }
    })

    test("countMailbox does not follow a leaf symlink swapped after validation", async () => {
        const root = tmpRoot("mailbox-count-swap")
        const target = inboxPath(root, "bob")
        const outside = path.join(tmpRoot("mailbox-count-swap-outside"), "outside.jsonl")
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, "inside\n")
        await fs.writeFile(outside, "one\ntwo\nthree\n")

        const originalReadFile = fs.readFile
        let swapped = false
        Object.defineProperty(fs, "readFile", {
            configurable: true,
            value: async (...args: Parameters<typeof fs.readFile>) => {
                if (!swapped && path.resolve(String(args[0])) === path.resolve(target)) {
                    swapped = true
                    await fs.unlink(target)
                    await fs.symlink(outside, target)
                }
                return originalReadFile(...args)
            },
        })

        try {
            const result = await countMailbox(root, "bob")
            expect(result).toEqual({ status: "ok", data: { unread: 1, total: 1 } })
        } finally {
            Object.defineProperty(fs, "readFile", { configurable: true, value: originalReadFile })
        }
    })
})
