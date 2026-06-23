import { describe, expect, test } from "bun:test"

import { isForbiddenLateralMessage } from "../src/tools/messaging.js"

describe("isForbiddenLateralMessage (isolated comms gate)", () => {
    test("isolated + member sender + member recipient → forbidden", () => {
        expect(isForbiddenLateralMessage("isolated", false, ["bob"])).toBe(true)
    })

    test("isolated + member sender + master recipient → allowed", () => {
        expect(isForbiddenLateralMessage("isolated", false, ["master"])).toBe(false)
    })

    test("isolated + master sender + member recipient → allowed", () => {
        expect(isForbiddenLateralMessage("isolated", true, ["bob"])).toBe(false)
    })

    test("isolated + master sender + broadcast to all members → allowed", () => {
        expect(isForbiddenLateralMessage("isolated", true, ["alice", "bob", "carol"])).toBe(false)
    })

    test("isolated + member sender + multiple member recipients → forbidden", () => {
        expect(isForbiddenLateralMessage("isolated", false, ["alice", "carol"])).toBe(true)
    })

    test("isolated + member sender + mixed master/member recipients → forbidden (any member triggers)", () => {
        expect(isForbiddenLateralMessage("isolated", false, ["master", "bob"])).toBe(true)
    })

    test("collaborative + member sender + member recipient → allowed", () => {
        expect(isForbiddenLateralMessage("collaborative", false, ["bob"])).toBe(false)
    })

    test("undefined mode (no parallel run / pipeline / loop / delegate / consensus) → allowed", () => {
        expect(isForbiddenLateralMessage(undefined, false, ["bob"])).toBe(false)
    })

    test("isolated + member sender + empty recipients → allowed (nothing to forbid)", () => {
        expect(isForbiddenLateralMessage("isolated", false, [])).toBe(false)
    })
})
