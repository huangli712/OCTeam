import { describe, expect, test } from "bun:test"

import { parseVerdict } from "../src/orchestration/protocol/decisions.js"

describe("parseVerdict structured fields", () => {
    test("parses score, confidence, and issues without changing the primary verdict", () => {
        const result = parseVerdict('<verdict>{"result":"PASS","rationale":"solid","diff":"","score":9,"confidence":0.85,"issues":[{"severity":"high","message":"needs polish"},{"severity":"low"}]}</verdict>')

        expect(result.verdict).toBe("PASS")
        expect(result.rationale).toBe("solid")
        expect(result.score).toBe(9)
        expect(result.confidence).toBe(0.85)
        expect(result.issues).toEqual([
            { severity: "high", message: "needs polish" },
            { severity: "low" },
        ])
    })

    test("H40: any malformed issue makes the entire issues field unevaluable", () => {
        const result = parseVerdict('<verdict>{"result":"FAIL","score":"bad","confidence":null,"issues":[{"severity":"unknown","message":"drop"},{"severity":"critical","message":7}]}</verdict>')

        expect(result.verdict).toBe("FAIL")
        expect(result.parseFailed).toBeUndefined()
        expect(result.score).toBeUndefined()
        expect(result.confidence).toBeUndefined()
        // H40: a mix of valid + invalid issues now returns undefined (unevaluable)
        // rather than silently dropping the invalid ones. Pre-fix code kept only
        // the valid entry, which was fail-open for quality gates.
        expect(result.issues).toBeUndefined()
    })

    test("legacy verdicts keep structured fields absent", () => {
        const result = parseVerdict('<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>')

        expect(result.verdict).toBe("PASS")
        expect(result.score).toBeUndefined()
        expect(result.confidence).toBeUndefined()
        expect(result.issues).toBeUndefined()
    })
})
