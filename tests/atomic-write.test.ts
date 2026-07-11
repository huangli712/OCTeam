/**
 * Unit tests for atomicWrite (src/state/locks.ts). Covers the happy path plus
 * the safety invariants: symlink refusal, tmp-file cleanup, parent-dir
 * auto-creation, and convergence under concurrent writers.
 */
import { existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { atomicWrite } from "../src/state/locks.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("atomicWrite", () => {
    it("writes content correctly and reads it back", async () => {
        const root = tmpRoot("atomic-basic")
        const file = path.join(root, "foo.txt")
        await atomicWrite(file, "hello world")
        const { readFileSync } = await import("node:fs")
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
        expect(atomicWrite(link, "hijacked")).rejects.toThrow(
            /atomicWrite: refusing to write through symlink/,
        )
        // The symlink target is NOT overwritten.
        const { readFileSync } = await import("node:fs")
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
        const { readFileSync } = await import("node:fs")
        const final = readFileSync(file, "utf8")
        expect(["version-1", "version-2"]).toContain(final)
        // No tmp leftovers from the race.
        const leftovers = readdirSync(root).filter(name => name.includes(".tmp."))
        expect(leftovers).toEqual([])
    })
})
