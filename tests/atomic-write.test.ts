/**
 * Unit tests for atomicWrite (src/state/locks.ts). Covers the happy path plus
 * the safety invariants: symlink refusal, tmp-file cleanup, parent-dir
 * auto-creation, and convergence under concurrent writers.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { assertNoSymlinkTraversal, atomicWrite } from "../src/state/locks.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("atomicWrite", () => {
    it("writes content correctly and reads it back", async () => {
        const root = tmpRoot("atomic-basic")
        const file = path.join(root, "foo.txt")
        await atomicWrite(file, "hello world")
        expect(readFileSync(file, "utf8")).toBe("hello world")
    })

    it("creates nested parent directories that do not yet exist", async () => {
        const root = tmpRoot("atomic-nested")
        const file = path.join(root, "a", "b", "c", "deep.txt")
        await atomicWrite(file, "nested")
        expect(existsSync(file)).toBe(true)
    })

    it("refuses to write through a symlink (no silent redirect)", async () => {
        const root = tmpRoot("atomic-symlink")
        const real = path.join(root, "real.txt")
        const link = path.join(root, "link.txt")
        writeFileSync(real, "original")
        symlinkSync(real, link)
        await expect(atomicWrite(link, "hijacked")).rejects.toThrow(
            /atomicWrite: refusing to write through symlink/,
        )
        // The symlink target is NOT overwritten.
        expect(readFileSync(real, "utf8")).toBe("original")
    })

    it("leaves no .tmp.* leftover files after a successful write", async () => {
        const root = tmpRoot("atomic-tmpclean")
        const file = path.join(root, "out.txt")
        await atomicWrite(file, "clean")
        const leftovers = readdirSync(root).filter(name => name.includes(".tmp."))
        expect(leftovers).toEqual([])
    })

    it("converges under concurrent writers (one winner, file stays valid)", async () => {
        const root = tmpRoot("atomic-concurrent")
        const file = path.join(root, "same.txt")
        // Two concurrent writes to the same path — both settle, final content
        // is exactly one of the two payloads (no corruption, no partial write).
        await Promise.all([
            atomicWrite(file, "version-1"),
            atomicWrite(file, "version-2"),
        ])
        const final = readFileSync(file, "utf8")
        expect(["version-1", "version-2"]).toContain(final)
        // No tmp leftovers from the race.
        const leftovers = readdirSync(root).filter(name => name.includes(".tmp."))
        expect(leftovers).toEqual([])
    })
})

describe("assertNoSymlinkTraversal", () => {
    it("accepts a regular file inside trusted root", async () => {
        const root = tmpRoot("symlink-clean")
        const file = path.join(root, "foo.txt")
        writeFileSync(file, "ok")
        await expect(assertNoSymlinkTraversal(root, file)).resolves.toBeUndefined()
    })

    it("accepts a not-yet-existing target whose ancestors do not exist", async () => {
        const root = tmpRoot("symlink-missing")
        // No file or dir created — should still succeed (component will be
        // created as a real dir/file by the subsequent write).
        const file = path.join(root, "a", "b", "c.txt")
        await expect(assertNoSymlinkTraversal(root, file)).resolves.toBeUndefined()
    })

    it("rejects when target itself is a symlink", async () => {
        const root = tmpRoot("symlink-target")
        const real = path.join(root, "real.txt")
        const link = path.join(root, "link.txt")
        writeFileSync(real, "original")
        symlinkSync(real, link)
        await expect(assertNoSymlinkTraversal(root, link)).rejects.toThrow(
            /symlink in path chain/,
        )
    })

    it("rejects when an intermediate ancestor directory is a symlink (the ancestor-chain gap)", async () => {
        const root = tmpRoot("symlink-ancestor")
        // <root>/realdir/ is a legitimate directory.
        const realDir = path.join(root, "realdir")
        mkdirSync(realDir)
        // <root>/mailbox -> realdir; this is the attack: an intermediate
        // component of the target path is a symlink, but the target leaf does
        // not exist, so the old refuseSymlink (target + parent only) would
        // miss it.
        const symlinkedMailbox = path.join(root, "mailbox")
        symlinkSync(realDir, symlinkedMailbox)
        const target = path.join(symlinkedMailbox, "alice.jsonl")
        await expect(assertNoSymlinkTraversal(root, target)).rejects.toThrow(
            /symlink in path chain/,
        )
    })

    it("rejects when target resolves outside trusted root via ..", async () => {
        const root = tmpRoot("symlink-escape")
        const outside = tmpRoot("symlink-outside")
        const target = path.join(root, "..", path.basename(outside), "foo.txt")
        await expect(assertNoSymlinkTraversal(root, target)).rejects.toThrow(
            /escapes trusted root/,
        )
    })
})

describe("atomicWrite with trustedRoot", () => {
    it("refuses to write when an intermediate ancestor directory is a symlink", async () => {
        const root = tmpRoot("atomic-trusted-ancestor")
        const realDir = path.join(root, "realdir")
        mkdirSync(realDir)
        const symlinkedMailbox = path.join(root, "mailbox")
        symlinkSync(realDir, symlinkedMailbox)
        const target = path.join(symlinkedMailbox, "alice.jsonl")
        // Without trustedRoot the legacy check only inspects target + parent,
        // missing the symlink on `mailbox` itself. With trustedRoot the full
        // ancestor chain is walked and the write is refused.
        await expect(atomicWrite(target, "payload", root)).rejects.toThrow(
            /symlink in path chain/,
        )
    })

    it("writes normally when trustedRoot is provided and path is clean", async () => {
        const root = tmpRoot("atomic-trusted-clean")
        const file = path.join(root, "nested", "out.txt")
        await atomicWrite(file, "ok", root)
        expect(readFileSync(file, "utf8")).toBe("ok")
    })
})
