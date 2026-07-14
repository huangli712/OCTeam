/**
 * Check script: fix-verify loop workflow (Scenario 1).
 *
 * Validates the on_fail_goto loop in a team_workflow run:
 *   - alice.md contains TypeScript code for parseList (possibly multiple versions from loop iterations)
 *   - bob.md contains <verdict> gate decisions (possibly multiple from loop iterations)
 *   - The final verdict is PASS
 *   - parseList correctly handles three edge cases
 *
 * Usage:  bun check-coding-fix-loop.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CODE_RE = /```typescript\s*\n([\s\S]*?)```/g;
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;
const IMPL_RE = /<!--\s*IMPL:\s*parseList\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

interface Verdict {
    result: string;
    rationale: string;
    diff: string;
}

function parseVerdicts(raw: string): Verdict[] {
    const verdicts: Verdict[] = [];
    let m: RegExpExecArray | null;
    while ((m = VERDICT_RE.exec(raw)) !== null) {
        try {
            const obj = JSON.parse(m[1]) as Record<string, string>;
            const result = (obj.result ?? "").trim().toUpperCase();
            if (!result) fail("verdict JSON lacks a non-empty 'result' field");
            verdicts.push({
                result,
                rationale: (obj.rationale ?? "").trim(),
                diff: (obj.diff ?? "").trim(),
            });
        } catch {
            fail(`verdict block is not valid JSON: ${m[1].substring(0, 200)}`);
        }
    }
    return verdicts;
}

function extractCodeBlocks(raw: string): string[] {
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = CODE_RE.exec(raw)) !== null) {
        blocks.push(m[1]);
    }
    return blocks;
}

function arrEq(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

function loadParseList(codeBlock: string): (s: string) => number[] {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const jsCode = transpiler.transformSync(codeBlock);
    const fn = new Function(`${jsCode}\nreturn parseList;`)() as unknown;
    if (typeof fn !== "function") {
        fail("parseList was not exported as a function from the code block");
    }
    return fn as (s: string) => number[];
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-fix-loop.ts <run_dir>");
        process.exit(2);
    }

    // --- Load alice.md ---
    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // --- Load bob.md ---
    let bobRaw: string;
    try {
        bobRaw = await readFile(join(runDir, "bob.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading bob.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: alice.md has the IMPL: parseList marker.
    if (!IMPL_RE.test(aliceRaw)) {
        fail("alice.md does not contain <!-- IMPL: parseList --> marker");
    }
    console.log("  alice: IMPL: parseList marker found");

    // Assertion 2: alice produced at least one code block.
    const codeBlocks = extractCodeBlocks(aliceRaw);
    if (codeBlocks.length === 0) {
        fail("alice.md has no code blocks");
    }
    console.log(`  alice: ${codeBlocks.length} code block(s) found`);

    // Assertion 3: the last code block contains a loadable parseList function.
    const implCode = codeBlocks[codeBlocks.length - 1];
    if (!/\bparseList\b/.test(implCode)) {
        fail("code block does not contain parseList function");
    }

    let parseList: (s: string) => number[];
    try {
        parseList = loadParseList(implCode);
    } catch (err) {
        fail(`failed to load parseList: ${(err as Error).message}`);
    }
    console.log("  alice: parseList function loadable");

    // Assertion 4: parseList("1,2,3") = [1,2,3].
    const r1 = parseList("1,2,3");
    if (!arrEq(r1, [1, 2, 3])) {
        fail(`parseList("1,2,3") returned [${r1}], expected [1,2,3]`);
    }
    console.log(`  parseList("1,2,3") = [${r1}] ✓`);

    // Assertion 5: parseList("") = [].
    const r2 = parseList("");
    if (!arrEq(r2, [])) {
        fail(`parseList("") returned [${r2}], expected []`);
    }
    console.log(`  parseList("") = [${r2}] ✓`);

    // Assertion 6: parseList("1,abc,3") = [1,3] (skip malformed).
    const r3 = parseList("1,abc,3");
    if (!arrEq(r3, [1, 3])) {
        fail(`parseList("1,abc,3") returned [${r3}], expected [1,3]`);
    }
    console.log(`  parseList("1,abc,3") = [${r3}] ✓`);

    // Assertion 7: bob emitted at least one verdict.
    const verdicts = parseVerdicts(bobRaw);
    if (verdicts.length === 0) {
        fail("bob.md has no verdict");
    }
    console.log(`  bob: ${verdicts.length} verdict(s) found`);

    // Assertion 8: the FINAL verdict is PASS (after any loop iterations, the last one matters).
    const finalV = verdicts[verdicts.length - 1];
    if (finalV.result !== "PASS") {
        fail(`bob final verdict is ${finalV.result}, expected PASS (rationale: ${finalV.rationale.substring(0, 120)})`);
    }
    console.log(`  bob: final verdict = PASS (rationale: ${finalV.rationale.substring(0, 80)})`);

    console.log(`PASS: parseList passes all 3 edge cases; bob's final verdict is PASS after ${verdicts.length} verdict(s).`);
}

main();
