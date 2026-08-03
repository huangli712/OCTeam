/**
 * Regression test for R1: mergePermissionsMonotonic incorrectly drops
 * preset nested subtool permissions when user provides a nested map.
 *
 * Bug: When preset is `task: { "*": "deny", "oct-librarian": "allow" }`
 * and user provides `task: { "oct-oracle": "allow" }`, the merge used the
 * top-level "*" baseline and IGNORED the preset's "oct-librarian":"allow".
 * The result only had "*" and "oct-oracle" — the preset's explicit allow
 * for oct-librarian was silently deleted.
 *
 * Also: when user provides `task: "ask"` (scalar) for a nested preset,
 * the scalar should be compared against the preset's nested map entry
 * for "*", not replace the entire nested structure.
 */

import { describe, expect, test } from "bun:test"
import { mergePermissionsMonotonic } from "../src/agents/index.js"
import type { OcteamAgentPermission } from "../src/agents/types.js"

describe("R1: mergePermissionsMonotonic preserves preset nested subtool permissions", () => {
    const preset: OcteamAgentPermission = {
        "*": "deny",
        edit: "deny",
        task: { "*": "deny", "oct-librarian": "allow", "oct-explore": "allow" },
        bash: "deny",
        read: "allow",
    }

    test("user tightening with scalar does not lose preset nested allows", () => {
        const user: unknown = {
            task: "ask",  // user wants to tighten task to "ask"
        }
        const result = mergePermissionsMonotonic(preset, user)
        // Preset nested allows must survive.
        const taskPerm = result.task
        expect(typeof taskPerm).toBe("object")
        expect(taskPerm).not.toBeNull()
        const nested = taskPerm as Record<string, string>
        // User "ask" is stricter than preset "*"="deny"? No: ask < deny in rank.
        // ask(rank=1) < deny(rank=2), so "ask" would LOOSEN. Monotonic merge
        // must reject this and keep "deny" as the baseline.
        expect(nested["*"]).toBe("deny")
        // Preset's explicit allows must survive.
        expect(nested["oct-librarian"]).toBe("allow")
        expect(nested["oct-explore"]).toBe("allow")
    })

    test("user adding a subtool does not lose preset nested allows", () => {
        const user: unknown = {
            task: { "oct-oracle": "deny" },  // user tightens one subtool
        }
        const result = mergePermissionsMonotonic(preset, user)
        const nested = result.task as Record<string, string>
        // User addition present.
        expect(nested["oct-oracle"]).toBe("deny")
        // Preset allows MUST survive.
        expect(nested["oct-librarian"]).toBe("allow")
        expect(nested["oct-explore"]).toBe("allow")
        expect(nested["*"]).toBe("deny")
    })

    test("user tightening a subtool from allow to deny preserves other allows", () => {
        const user: unknown = {
            task: { "oct-librarian": "deny" },  // tighten one subtool
        }
        const result = mergePermissionsMonotonic(preset, user)
        const nested = result.task as Record<string, string>
        expect(nested["oct-librarian"]).toBe("deny")
        // Other preset allow must survive.
        expect(nested["oct-explore"]).toBe("allow")
        expect(nested["*"]).toBe("deny")
    })

    test("scalar preset + scalar user works correctly", () => {
        const scalarPreset: OcteamAgentPermission = { "*": "deny", edit: "allow", read: "allow" }
        const user: unknown = { edit: "deny" }  // tighten
        const result = mergePermissionsMonotonic(scalarPreset, user)
        expect(result.edit).toBe("deny")
        expect(result.read).toBe("allow")
    })
})
