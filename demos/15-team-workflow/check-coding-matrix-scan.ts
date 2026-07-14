/**
 * Check script: multi-branch fanout sort testing workflow (Scenario 3).
 *
 * Validates the fanout-all workflow in a team_workflow run:
 *   - alice.md contains TypeScript code for bubbleSort and mergeSort
 *   - bob.md and carol.md each contain <!-- SORT_OK: true --> markers
 *   - frank.md contains a PASS <verdict> gate decision
 *   - Both sort functions sort [5,3,8,1,9,2,7] correctly
 *
 * Usage:  bun check-coding-matrix-scan.ts <run_dir>
 *   <run_dir>  directory containing alice.md, bob.md, carol.md, frank.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CODE_RE = /```typescript\s*\n([\s\S]*?)```/g;
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;
const IMPL_RE = /<!--\s*IMPL:\s*sorts\s*-->/;
const SORT_OK_RE = /<!--\s*SORT_OK:\s*true\s*-->/;

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

function loadSortFunction(codeBlock: string, fnName: string): (arr: number[]) => number[] {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const jsCode = transpiler.transformSync(codeBlock);
    const fn = new Function(`${jsCode}\nreturn ${fnName};`)() as unknown;
    if (typeof fn !== "function") {
        fail(`${fnName} was not exported as a function from the code block`);
    }
    return fn as (arr: number[]) => number[];
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-matrix-scan.ts <run_dir>");
        process.exit(2);
    }

    // --- Load member files ---
    const members = ["alice", "bob", "carol", "frank"];
    const files: Record<string, string> = {};

    for (const name of members) {
        try {
            files[name] = await readFile(join(runDir, `${name}.md`), "utf8");
        } catch (err) {
            console.error(`IO error reading ${name}.md: ${(err as Error).message}`);
            process.exit(2);
        }
    }

    // Assertion 1: alice.md has the IMPL: sorts marker.
    if (!IMPL_RE.test(files.alice)) {
        fail("alice.md does not contain <!-- IMPL: sorts --> marker");
    }
    console.log("  alice: IMPL: sorts marker found ✓");

    // Assertion 2: bob.md and carol.md both report SORT_OK.
    if (!SORT_OK_RE.test(files.bob)) {
        fail("bob.md does not contain <!-- SORT_OK: true --> marker");
    }
    if (!SORT_OK_RE.test(files.carol)) {
        fail("carol.md does not contain <!-- SORT_OK: true --> marker");
    }
    console.log("  bob: SORT_OK: true ✓");
    console.log("  carol: SORT_OK: true ✓");

    // Assertion 3: alice produced at least one code block containing both sort functions.
    const codeBlocks = extractCodeBlocks(files.alice);
    if (codeBlocks.length === 0) {
        fail("alice.md has no code blocks");
    }
    const implCode = codeBlocks[codeBlocks.length - 1];

    if (!/\bbubbleSort\b/.test(implCode)) {
        fail("code block does not contain bubbleSort function");
    }
    if (!/\bmergeSort\b/.test(implCode)) {
        fail("code block does not contain mergeSort function");
    }
    console.log("  alice: bubbleSort and mergeSort found in code ✓");

    // Assertion 4: load and test bubbleSort.
    let bubbleSort: (arr: number[]) => number[];
    try {
        bubbleSort = loadSortFunction(implCode, "bubbleSort");
    } catch (err) {
        fail(`failed to load bubbleSort: ${(err as Error).message}`);
    }

    const testInput = [5, 3, 8, 1, 9, 2, 7];
    const expected = [1, 2, 3, 5, 7, 8, 9];

    const bubbleResult = bubbleSort([...testInput]);
    if (!arrEq(bubbleResult, expected)) {
        fail(`bubbleSort([${testInput}]) returned [${bubbleResult}], expected [${expected}]`);
    }
    console.log(`  bubbleSort([${testInput}]) = [${bubbleResult}] ✓`);

    // Assertion 5: load and test mergeSort.
    let mergeSort: (arr: number[]) => number[];
    try {
        mergeSort = loadSortFunction(implCode, "mergeSort");
    } catch (err) {
        fail(`failed to load mergeSort: ${(err as Error).message}`);
    }

    const mergeResult = mergeSort([...testInput]);
    if (!arrEq(mergeResult, expected)) {
        fail(`mergeSort([${testInput}]) returned [${mergeResult}], expected [${expected}]`);
    }
    console.log(`  mergeSort([${testInput}]) = [${mergeResult}] ✓`);

    // Assertion 6: frank emitted a PASS verdict.
    const verdicts = parseVerdicts(files.frank);
    if (verdicts.length === 0) {
        fail("frank.md has no verdict");
    }
    const finalV = verdicts[verdicts.length - 1];
    if (finalV.result !== "PASS") {
        fail(`frank final verdict is ${finalV.result}, expected PASS (rationale: ${finalV.rationale.substring(0, 120)})`);
    }
    console.log(`  frank: final verdict = PASS (rationale: ${finalV.rationale.substring(0, 80)}) ✓`);

    console.log("PASS: both sort functions correct; bob and carol report SORT_OK; frank's verdict is PASS.");
}

main();
