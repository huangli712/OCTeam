/**
 * Check script: REST API handler workflow (Scenario 1).
 *
 * Validates the task-gate chain in a team_workflow run:
 *   - alice.md contains TypeScript code for handleRegister (step 1 + step 3)
 *   - bob.md contains two <verdict> gate decisions (step 2 + step 4)
 *   - Both gate verdicts are PASS
 *   - The refactored code (step 3) includes a validate() function
 *
 * Usage:  bun check-coding-handler.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CODE_RE = /```typescript\s*\n([\s\S]*?)```/g;
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;

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

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-handler.ts <run_dir>");
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

    // Assertion 1: alice produced at least 2 code blocks (step 1 implement + step 3 refactor).
    const codeBlocks = extractCodeBlocks(aliceRaw);
    if (codeBlocks.length < 2) {
        fail(`alice.md has only ${codeBlocks.length} code block(s), expected at least 2 (implement + refactor)`);
    }
    console.log(`  alice: ${codeBlocks.length} code blocks found`);

    // Assertion 2: the refactored code (latest block) contains a validate() function.
    const refactored = codeBlocks[codeBlocks.length - 1];
    if (!/\bvalidate\s*\(/.test(refactored)) {
        fail("refactored code does not contain a validate() function extraction");
    }
    console.log("  alice: validate() function extracted in refactored code");

    // Assertion 3: original code (first block) has handleRegister function.
    const original = codeBlocks[0];
    if (!/\bhandleRegister\b/.test(original)) {
        fail("original code does not contain handleRegister function");
    }
    console.log("  alice: handleRegister found in original implementation");

    // Assertion 4: bob emitted at least 2 verdicts (gate 2 + gate 4).
    const verdicts = parseVerdicts(bobRaw);
    if (verdicts.length < 2) {
        fail(`bob.md has only ${verdicts.length} verdict(s), expected at least 2 (step 2 + step 4 gates)`);
    }
    console.log(`  bob: ${verdicts.length} verdicts found`);

    // Assertion 5: all verdicts are PASS.
    for (let i = 0; i < verdicts.length; i++) {
        if (verdicts[i].result !== "PASS") {
            fail(`bob verdict ${i + 1} is ${verdicts[i].result}, expected PASS`);
        }
        console.log(`  bob: verdict ${i + 1} = PASS (rationale: ${verdicts[i].rationale.substring(0, 80)})`);
    }

    console.log(`PASS: alice produced ${codeBlocks.length} code blocks with validate() extraction; bob emitted ${verdicts.length} PASS verdicts.`);
}

main();
