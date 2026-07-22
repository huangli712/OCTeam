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

    test("returns false for object without code property", () => {
        expect(isEnoent({ message: "something" })).toBe(false)
        expect(isEnoent({})).toBe(false)
    })

    test("returns false for Error instance with ENOENT code", () => {
        const err = new Error("not found")
        ;(err as NodeJS.ErrnoException).code = "ENOENT"
        expect(isEnoent(err)).toBe(true)
    })

    test("returns false for non-object values", () => {
        expect(isEnoent("ENOENT")).toBe(false)
        expect(isEnoent(42)).toBe(false)
        expect(isEnoent(false)).toBe(false)
    })
})
