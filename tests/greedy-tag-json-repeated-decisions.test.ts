/**
 * Regression test for confirmed finding "greedy-tag-json-breaks-repeated-decisions".
 *
 * Bug: src/orchestration/decisions.ts:39 uses a GREEDY regex to capture the
 * JSON payload inside a tag:
 *   new RegExp(`<${tag}>\\s*(\\{[\\s\\S]*\\})\\s*</${tag}>`)
 *                                  ^^^ greedy [^]*
 * The `.*` greedily matches from the FIRST `{` to the LAST `}` in the entire
 * text. When a member's output contains TWO same-named tags (e.g. a decider
 * that re-states a prior decision before issuing a new one, or a router that
 * quotes a previous route block), the greedy capture spans from the first tag's
 * `{` through the second tag's closing `}`, producing invalid JSON:
 *
 *   <decision>{"decision":"continue",...}</decision>
 *   ... some text ...
 *   <decision>{"decision":"done",...}</decision>
 *
 * Greedy match captures: {"decision":"continue",...}</decision>\n...\n<decision>{"decision":"done",...}
 * → JSON.parse fails → parseFailed → the decision is incorrectly rejected.
 *
 * Every parser that calls extractTaggedJSON is affected: parseDecision (loop),
 * parseRouteDecision (route), parseArbitrationDecision (arbitrate), parseVerdict
 * (tollgate), parseDecompose (recurse), parseSignoff, allMembersAgree.
 *
 * Fix: use a LAZY quantifier (\{[\s\S]*?\}) or — better — a brace-matching
 * extraction that finds the balanced {...} immediately after the opening tag.
 * Lazy alone is insufficient when the closing tag text appears inside a string
 * value, so a non-greedy match paired with the closing tag is the minimal fix.
 *
 * This test feeds text with two <decision> blocks to parseDecision and asserts
 * the SECOND (latest) decision is parsed correctly. On UNFIXED code the greedy
 * regex captures across both blocks → JSON.parse fails → parseFailed=true →
 * test FAILS. On FIXED code the second block parses cleanly → decision="done" →
 * test PASSES.
 */

import { describe, expect, test } from "bun:test"

import { parseDecision } from "../src/orchestration/decisions.js"

describe("greedy tag JSON breaks repeated decisions (finding: greedy-tag-json-breaks-repeated-decisions)", () => {
    test("two <decision> tags in one output: the second must parse (not fail)", async () => {
        // Simulate a decider that references its prior decision, then issues a
        // new one. This is realistic: a loop round-2 decider often recaps
        // round-1 before deciding "done".
        const output = [
            'I previously said:',
            '<decision>{"decision":"continue","rationale":"round 1 not done","nextActions":["fix A"]}</decision>',
            '',
            'Now after the fix, I conclude:',
            '<decision>{"decision":"done","rationale":"all tests pass","nextActions":[]}</decision>',
        ].join("\n")

        const result = parseDecision(output)

        // --- ASSERT: the decision must parse successfully (no parseFailed) ---
        // On UNFIXED code: the greedy \{[\s\S]*\} captures from the first `{`
        // through the LAST `}` across BOTH blocks → the captured string is not
        // valid JSON → JSON.parse throws → parseFailed=true → FAIL.
        // On FIXED code: the regex matches only the second (last) block's
        // payload (or each independently) → parses → parseFailed not set → PASS.
        expect(result.parseFailed).not.toBe(true)

        // --- ASSERT: the latest decision is "done" ---
        expect(result.decision).toBe("done")
    })
})
