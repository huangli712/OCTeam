import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")
const realDateNow = Date.now
const STALE_OWNER = "invalid-owner"

let root: string | undefined
let watchedLockPath: string | undefined
let staleOwnerUnlinkCount = 0

const mockedFs = {
    ...realFs,
    unlink: (async (filePath: string) => {
        if (
            filePath === watchedLockPath
            && await realFs.readFile(filePath, "utf8") === STALE_OWNER
        ) {
            staleOwnerUnlinkCount++
        }
        return realFs.unlink(filePath)
    }) as typeof realFs.unlink,
}

mock.module("node:fs/promises", () => ({ ...mockedFs, default: mockedFs }))

const { LOCK_TTL_MS, withLock } = await import("../src/state/locks.js")

afterEach(async () => {
    Date.now = realDateNow
    watchedLockPath = undefined
    staleOwnerUnlinkCount = 0
    if (root !== undefined) {
        await realFs.rm(root, { recursive: true, force: true })
        root = undefined
    }
})

describe("withLock stale-lock waiter", () => {
    test("EEXIST waiter never unlinks a stale lock and times out", async () => {
        // Given an existing lock whose age and owner previously triggered reaping.
        root = await realFs.mkdtemp(path.join(os.tmpdir(), "octeam-stale-lock-"))
        const lockPath = path.join(root, "state.json.lock")
        const baseNow = realDateNow()
        await realFs.writeFile(lockPath, STALE_OWNER, "utf8")
        const staleTime = new Date(baseNow - LOCK_TTL_MS - 1)
        await realFs.utimes(lockPath, staleTime, staleTime)
        watchedLockPath = lockPath

        let now = baseNow
        Date.now = () => {
            const current = now
            now += LOCK_TTL_MS + 1
            return current
        }

        // When another caller encounters EEXIST.
        let criticalSectionRan = false
        const outcome = await withLock(lockPath, async () => {
            criticalSectionRan = true
        }).then(
            () => ({ kind: "acquired" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
        )

        // Then it waits to timeout without unlinking or replacing that lock.
        expect(staleOwnerUnlinkCount).toBe(0)
        expect(criticalSectionRan).toBe(false)
        expect(outcome.kind).toBe("rejected")
        if (outcome.kind === "rejected") {
            expect(String(outcome.error)).toContain("timed out acquiring")
        }
        expect(await realFs.readFile(lockPath, "utf8")).toBe(STALE_OWNER)
    })
})
