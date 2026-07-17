/**
 * Check script: competitive selection workflow (Scenario 4 · challenge).
 *
 * Validates the select-join workflow in a team_workflow run with 5 members:
 *   - alice.md, bob.md, carol.md: each contain <!-- APPROACH: <name> --> markers
 *   - frank.md (reducer): selects a winner with <selection>{"winner":"<branch-id>"}</selection> block
 *   - dave.md: contains a PASS <verdict> gate decision
 *   - The selected approach's fibonacci function computes correct values
 *
 * Usage:  bun check-coding-select-optimal.ts <run_dir>
 *   <run_dir>  directory containing alice/bob/carol/frank/dave.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CODE_RE = /```typescript\s*\n([\s\S]*?)```/g;
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;
const APPROACH_RE = /<!--\s*APPROACH:\s*(\S+)\s*-->/;
const SELECTION_RE = /<selection>\s*(\{[\s\S]*?\})\s*<\/selection>/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

interface Verdict {
    result: string;
    rationale: string;
    diff: string;
}

interface Selection {
    winner: string;
    rationale: string;
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

function loadFibonacci(codeBlock: string): (n: number) => number {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const jsCode = transpiler.transformSync(codeBlock);
    const fn = new Function(`${jsCode}\nreturn fibonacci;`)() as unknown;
    if (typeof fn !== "function") {
        fail("fibonacci was not exported as a function from the code block");
    }
    return fn as (n: number) => number;
}

function extractApproach(raw: string): string | null {
    const m = raw.match(APPROACH_RE);
    return m ? m[1] : null;
}

function extractSelection(raw: string): Selection | null {
    const m = raw.match(SELECTION_RE);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[1]) as Record<string, string>;
        const winner = (obj.winner ?? "").trim();
        if (!winner) return null;
        return {
            winner,
            rationale: (obj.rationale ?? "").trim(),
        };
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-select-optimal.ts <run_dir>");
        process.exit(2);
    }

    // --- Load all 5 member files ---
    const members = ["alice", "bob", "carol", "frank", "dave"];
    const files: Record<string, string> = {};

    for (const name of members) {
        try {
            files[name] = await readFile(join(runDir, `${name}.md`), "utf8");
        } catch (err) {
            console.error(`IO error reading ${name}.md: ${(err as Error).message}`);
            process.exit(2);
        }
    }

    // Assertion 1: each coder has an APPROACH marker matching their assigned approach.
    const expectedApproaches: Record<string, string> = {
        alice: "iterative",
        bob: "recursive-memo",
        carol: "binet",
    };

    // Map branch id (frank's winner value) to the coder who implemented that branch.
    const branchIdToCoder: Record<string, string> = {
        iterative: "alice",
        recursive: "bob",
        binet: "carol",
    };

    const coderToCode: Record<string, string> = {};

    for (const [coder, expected] of Object.entries(expectedApproaches)) {
        const approach = extractApproach(files[coder]);
        if (!approach) {
            fail(`${coder}.md does not contain <!-- APPROACH: ${expected} --> marker`);
        }
        if (approach !== expected) {
            fail(`${coder}.md APPROACH is "${approach}", expected "${expected}"`);
        }
        console.log(`  ${coder}: APPROACH: ${approach} ✓`);

        // Extract code block for later testing of the selected approach.
        const blocks = extractCodeBlocks(files[coder]);
        if (blocks.length === 0) {
            fail(`${coder}.md has no code block`);
        }
        coderToCode[coder] = blocks[blocks.length - 1];
    }

    // Assertion 2: frank (reducer) selected a winner via <selection>{"winner":...}</selection>.
    const selection = extractSelection(files.frank);
    if (!selection) {
        fail("frank.md does not contain <selection>{\"winner\": \"<branch-id>\", ...}</selection> block");
    }
    console.log(`  frank: SELECTED: ${selection.winner} ✓`);

    // Assertion 3: the selected winner is one of the three branch ids we expect.
    const winnerCoder = branchIdToCoder[selection.winner];
    if (!winnerCoder) {
        fail(`frank selected unknown branch id "${selection.winner}" (expected one of: ${Object.keys(branchIdToCoder).join(", ")})`);
    }
    console.log(`  winner: ${winnerCoder} (branch ${selection.winner})`);

    // Assertion 4: the winning fibonacci function is loadable and correct.
    const winnerCode = coderToCode[winnerCoder];
    if (!/\bfibonacci\b/.test(winnerCode)) {
        fail(`${winnerCoder}'s code block does not contain fibonacci function`);
    }

    let fib: (n: number) => number;
    try {
        fib = loadFibonacci(winnerCode);
    } catch (err) {
        fail(`failed to load fibonacci: ${(err as Error).message}`);
    }

    const testCases: [number, number][] = [
        [0, 0],
        [1, 1],
        [10, 55],
        [20, 6765],
    ];

    for (const [n, expected] of testCases) {
        const actual = fib(n);
        if (actual !== expected) {
            fail(`fib(${n}) = ${actual}, expected ${expected}`);
        }
        console.log(`  fib(${n}) = ${actual} ✓`);
    }

    // Assertion 5: dave emitted a PASS verdict.
    const daveVerdicts = parseVerdicts(files.dave);
    if (daveVerdicts.length === 0) {
        fail("dave.md has no verdict");
    }
    const finalV = daveVerdicts[daveVerdicts.length - 1];
    if (finalV.result !== "PASS") {
        fail(`dave final verdict is ${finalV.result}, expected PASS (rationale: ${finalV.rationale.substring(0, 120)})`);
    }
    console.log(`  dave: final verdict = PASS (rationale: ${finalV.rationale.substring(0, 80)}) ✓`);

    console.log(`PASS: ${winnerCoder}'s ${selection.winner} fibonacci passes all test cases; dave's gate verdict is PASS.`);
}

main();
