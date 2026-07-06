import { describe, expect, test } from "bun:test"

import { decideActivate } from "../src/tools/activation.js"

describe("decideActivate truth table", () => {
    test("target already active → no-op", () => {
        expect(decideActivate({ targetIsAlreadyActive: true, outgoingExists: false })).toEqual({
            kind: "noop",
        })
    })

    test("no active sibling → ok (activate allowed)", () => {
        expect(decideActivate({ targetIsAlreadyActive: false, outgoingExists: false })).toEqual({
            kind: "ok",
        })
    })

    test("another team already active → error naming it + hints team_deactivate", () => {
        const d = decideActivate({
            targetIsAlreadyActive: false,
            outgoingExists: true,
            outgoingName: "yyy",
        })
        expect(d.kind).toBe("error")
        if (d.kind === "error") {
            expect(d.message).toContain('"yyy"')
            expect(d.message).toContain("team_deactivate")
        }
    })

    test("already-active takes precedence over an outgoingExists flag", () => {
        // Defensive: targetIsAlreadyActive short-circuits before the outgoing check.
        expect(
            decideActivate({ targetIsAlreadyActive: true, outgoingExists: true, outgoingName: "yyy" }),
        ).toEqual({ kind: "noop" })
    })
})
