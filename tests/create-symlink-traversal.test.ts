/**
 * Regression: team_create must reject when the teams directory or the
 * target team directory escapes the storage root via a symlink. Without the
 * assertNoSymlinkTraversal guard before fs.mkdir, a symlinked teams/ redirect
 * can write config.json and state.json outside storageRoot, and a later
 * team_delete will operate on the redirected path.
 *
 * Threat model: a member with FS write access tampering with .octeam/ contents
 * between runs (per assertNoSymlinkTraversal docstring in src/state/locks.ts).
 */
import { mkdirSync, symlinkSync, existsSync } from "node:fs"
import path from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { teamCreateTool } from "../src/tools/lifecycle/create.js"
import { cleanupTmpRoots, makeCtx, makeToolContext, tmpRoot } from "./helpers.js"
import { teamsDir } from "../src/state/paths.js"

afterAll(cleanupTmpRoots)

describe("team_create symlink traversal", () => {
    test("rejects when teams/ is a symlink to outside storage root", async () => {
        const root = tmpRoot("create-symlink-teams")
        const sid = "ses_create_symlink_teams"
        // Outside redirect target.
        const outside = tmpRoot("create-symlink-teams-outside")
        // <root>/<sid> parent must exist so we can place the teams symlink
        // under it (mkdirSync does not follow symlinks, only creates the path).
        mkdirSync(path.dirname(teamsDir(root, sid)), { recursive: true })
        // <root>/<sid>/teams -> outside (the attack).
        symlinkSync(outside, teamsDir(root, sid))

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        await expect(
            tool.execute(
                { name: "alpha", members: [{ role: "coder", prompt: "code" }] },
                makeToolContext(sid),
            ),
        ).rejects.toThrow(/symlink/i)

        // Crucially: no team directory was created outside the root.
        expect(existsSync(path.join(outside, "alpha"))).toBe(false)
    })

    test("rejects when an intermediate ancestor (<sid>/) is a symlink", async () => {
        const root = tmpRoot("create-symlink-ancestor")
        const sid = "ses_create_symlink_ancestor"
        const outside = tmpRoot("create-symlink-ancestor-outside")
        // <root>/<sid> -> outside (the ancestor-chain attack from
        // assertNoSymlinkTraversal's docstring).
        const realSidDir = path.join(root, sid)
        // Make the parent (<root>) see <sid> as a symlink.
        symlinkSync(outside, realSidDir)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        await expect(
            tool.execute(
                { name: "beta", members: [{ role: "coder", prompt: "code" }] },
                makeToolContext(sid),
            ),
        ).rejects.toThrow(/symlink/i)

        expect(existsSync(path.join(outside, "teams", "beta"))).toBe(false)
    })

    test("user scope: rejects when flat teams/ is a symlink", async () => {
        const root = tmpRoot("create-symlink-user")
        const outside = tmpRoot("create-symlink-user-outside")
        // <root>/teams -> outside (user scope uses flat <root>/teams).
        symlinkSync(outside, teamsDir(root))

        const tool = teamCreateTool(makeCtx({ storageRoot: root, scope: "user" }))
        await expect(
            tool.execute(
                { name: "gamma", members: [{ role: "coder", prompt: "code" }] },
                makeToolContext("ses_create_symlink_user"),
            ),
        ).rejects.toThrow(/symlink/i)

        expect(existsSync(path.join(outside, "gamma"))).toBe(false)
    })

    test("rejects when target team directory itself is a symlink", async () => {
        const root = tmpRoot("create-symlink-target")
        const sid = "ses_create_symlink_target"
        const outside = tmpRoot("create-symlink-target-outside")
        // teams/ exists legitimately.
        mkdirSync(teamsDir(root, sid), { recursive: true })
        // teams/delta -> outside (the leaf-team-dir attack).
        symlinkSync(outside, path.join(teamsDir(root, sid), "delta"))

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        await expect(
            tool.execute(
                { name: "delta", members: [{ role: "coder", prompt: "code" }] },
                makeToolContext(sid),
            ),
        ).rejects.toThrow(/symlink|EEXIST/i)

        expect(existsSync(path.join(outside, "config.json"))).toBe(false)
    })

    test("happy path: still creates the team when no symlinks are present", async () => {
        const root = tmpRoot("create-symlink-clean")
        const sid = "ses_create_symlink_clean"

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { name: "happy", members: [{ role: "coder", prompt: "code" }] },
            makeToolContext(sid),
        )

        expect(result).toContain("created with")
        expect(existsSync(path.join(teamsDir(root, sid), "happy", "config.json"))).toBe(true)
        expect(existsSync(path.join(teamsDir(root, sid), "happy", "state.json"))).toBe(true)
    })
})
