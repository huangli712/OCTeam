/**
 * H-14 regression: extractTaggedJSON must enumerate ALL complete <tag>...</tag>
 * pairs (not just those whose payload contains a {...} block) and treat the
 * LAST one as authoritative. Pre-fix the regex required `{...}` to match, so
 * a malformed trailing block like `<decision>oops</decision>` (no braces) was
 * silently skipped and an EARLIER parseable block won — the decider's final
 * (corrupt) restatement was ignored, letting stale decisions silently win.
 */
import { describe, expect, test } from "bun:test"

import { parseDecision } from "../src/orchestration/protocol/decisions.js"

describe("H-14: extractTaggedJSON treats trailing malformed tag as parse failure", () => {
    test("trailing <decision>not-json</decision> does NOT silently revert to an earlier valid block", () => {
        // Decider restated an earlier "done" then wrote a corrupt final block.
        // Pre-fix: extractTaggedJSON skipped the no-braces trailing block,
        // matches=[first block only], lastMatch = first, parsed = done →
        // decision = "done" with parseFailed unset (silent stale revert).
        // Post-fix: enumerate all tag pairs, the trailing block is the last,
        // its payload has no parseable JSON → parseFailed=true.
        const output = [
            'I previously concluded:',
            '<decision>{"decision":"done","rationale":"done","nextActions":[]}</decision>',
            '',
            'Wait, let me reconsider:',
            '<decision>not valid json at all</decision>',
        ].join("\n")

        const result = parseDecision(output)

        expect(result.parseFailed).toBe(true)
        // The decision must NOT silently carry the stale "done" — even though
        // the default-on-fail is "continue", that default is the safe fallback
        // rather than the silently-inherited prior decision.
        expect(result.decision).toBe("continue")
    })

    test("trailing <decision>{} empty-brace block is treated as parse failure (M22)", () => {
        const output = [
            '<decision>{"decision":"done"}</decision>',
            '<decision>{}</decision>',  // empty JSON object — parses but lacks decision
        ].join("\n")

        const result = parseDecision(output)

        // M22 fix: empty {} has no `decision` key, which is a malformed payload.
        // Pre-fix code silently defaulted to "continue". Now it sets parseFailed
        // so the retry/reformat budget fires instead of wasting a loop round.
        expect(result.parseFailed).toBe(true)
    })

    test("trailing unclosed decision does not revert to an earlier complete block", () => {
        const output = [
            '<decision>{"decision":"done"}</decision>',
            '<decision>{"decision":"continue"',
        ].join("\n")

        const result = parseDecision(output)

        expect(result.parseFailed).toBe(true)
        expect(result.decision).toBe("continue")
    })

    test("control: single well-formed decision still parses", () => {
        const output = '<decision>{"decision":"done","rationale":"ok","nextActions":[]}</decision>'
        const result = parseDecision(output)
        expect(result.parseFailed).not.toBe(true)
        expect(result.decision).toBe("done")
    })

    test("control: latest valid decision wins when an earlier block is malformed", () => {
        // Inverse of the first test: an EARLIER corrupt block should NOT
        // shadow a LATER valid one. The latest tag pair is authoritative.
        const output = [
            '<decision>thinking...</decision>',  // no braces, malformed
            '<decision>{"decision":"done","rationale":"final","nextActions":[]}</decision>',
        ].join("\n")

        const result = parseDecision(output)
        expect(result.parseFailed).not.toBe(true)
        expect(result.decision).toBe("done")
    })
})

describe("parseDecision done alias", () => {
    test("rejects conflicting decision and done fields", () => {
        const result = parseDecision('<decision>{"decision":"continue","done":true}</decision>')

        expect(result.parseFailed).toBe(true)
    })

    test("accepts done true when decision is absent", () => {
        const result = parseDecision('<decision>{"done":true}</decision>')

        expect(result.parseFailed).not.toBe(true)
        expect(result.decision).toBe("done")
    })
})
