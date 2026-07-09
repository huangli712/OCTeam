import { describe, expect, test } from "bun:test"

import { activationError, isInteractionForbidden } from "../src/state/activation.js"

describe("isInteractionForbidden (master-only activation gate)", () => {
    test("master + active team → allowed", () => {
        expect(isInteractionForbidden(true, Date.now())).toBe(false)
    })
    test("master + inactive team (undefined) → forbidden", () => {
        expect(isInteractionForbidden(true, undefined)).toBe(true)
    })
    test("member + inactive team → allowed (members never gated)", () => {
        expect(isInteractionForbidden(false, undefined)).toBe(false)
    })
    test("member + active team → allowed", () => {
        expect(isInteractionForbidden(false, Date.now())).toBe(false)
    })
})

describe("activationError", () => {
    test("inactive → actionable message naming the team", () => {
        const msg = activationError("alpha", undefined)
        expect(msg).toContain('team_activate(team_id="alpha")')
    })
    test("active → null", () => {
        expect(activationError("alpha", Date.now())).toBeNull()
    })
})
