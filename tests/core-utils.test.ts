import { describe, expect, test } from "bun:test"

import { isEnoent } from "../src/core/utils.js"

describe("isEnoent", () => {
    test("returns false for nullish values", () => {
        expect(isEnoent(null)).toBe(false)
        expect(isEnoent(undefined)).toBe(false)
    })

    test("classifies Node error codes", () => {
        expect(isEnoent({ code: "ENOENT" })).toBe(true)
        expect(isEnoent({ code: "EPERM" })).toBe(false)
    })
})
