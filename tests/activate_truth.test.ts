import { describe, expect, test } from "bun:test"

import { decideActivate } from "../src/tools/lifecycle.js"

const X_STATES = ["live", "idle", "failed", "busy"] as const

describe("decideActivate truth table", () => {
    test("target already active → no-op (any X status)", () => {
        for (const _ of X_STATES) {
            expect(decideActivate({ targetIsAlreadyActive: true, outgoingBusy: false })).toEqual({
                kind: "noop",
            })
        }
    })

    test("no active sibling → ok (any X status)", () => {
        for (const _ of X_STATES) {
            expect(decideActivate({ targetIsAlreadyActive: false, outgoingBusy: false })).toEqual({
                kind: "ok",
            })
        }
    })

    test("sibling live/idle/failed (not busy) → ok", () => {
        // outgoing not busy regardless of which non-busy lifecycle state it is in
        expect(
            decideActivate({ targetIsAlreadyActive: false, outgoingBusy: false, outgoingName: "yyy" }),
        ).toEqual({ kind: "ok" })
    })

    test("sibling busy → error naming the outgoing team", () => {
        const d = decideActivate({
            targetIsAlreadyActive: false,
            outgoingBusy: true,
            outgoingName: "yyy",
        })
        expect(d.kind).toBe("error")
        if (d.kind === "error") {
            expect(d.message).toContain('"yyy"')
            expect(d.message).toContain("busy")
        }
    })

    test("already-active takes precedence over a busy sibling flag", () => {
        // Defensive: targetIsAlreadyActive short-circuits before the busy check.
        expect(
            decideActivate({ targetIsAlreadyActive: true, outgoingBusy: true, outgoingName: "yyy" }),
        ).toEqual({ kind: "noop" })
    })
})
