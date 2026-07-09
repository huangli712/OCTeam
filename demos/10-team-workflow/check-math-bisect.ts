/**
 * Check script: bisection root-finding workflow (Scenario 2).
 *
 * Validates the task-gate chain in a team_workflow run:
 *   - alice.md: loads bisect function, verifies against 3 test cases
 *   - bob.md: extracts two <verdict> gate decisions, verifies both are PASS
 *
 * Usage:  bun check-math-bisect.ts <run_dir>
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

function loadBisect(code: string): (f: (x: number) => number, a: number, b: number, tol: number) => number {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
        `${code}; return typeof bisect === "function" ? bisect : null;`
    ) as () => ((f: (x: number) => number, a: number, b: number, tol: number) => number) | null;
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error("code did not expose a 'bisect' function");
    }
    return fn;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-bisect.ts <run_dir>");
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

    // Extract the code block (should be at least 1, the latest is the refined version).
    const codeMatches = [...aliceRaw.matchAll(CODE_RE)];
    if (codeMatches.length === 0) {
        fail("alice.md has no ```typescript code block");
    }
    const codeBlock = codeMatches[codeMatches.length - 1][1];
    console.log("  alice: code block extracted");

    // Load the bisect function.
    let bisect: (f: (x: number) => number, a: number, b: number, tol: number) => number;
    try {
        bisect = loadBisect(codeBlock);
    } catch (err) {
        fail(`failed to load bisect function: ${(err as Error).message}`);
    }

    // Assertion 1: sqrt(2) root finding.
    const sqrt2 = bisect((x) => x * x - 2, 1, 2, 1e-8);
    if (Math.abs(sqrt2 - Math.SQRT2) >= 1e-7) {
        fail(`bisect(x²-2, 1, 2, 1e-8) = ${sqrt2}, expected ≈ ${Math.SQRT2} (diff=${Math.abs(sqrt2 - Math.SQRT2)})`);
    }
    console.log(`  sqrt(2) ≈ ${sqrt2} (ok, diff=${Math.abs(sqrt2 - Math.SQRT2).toExponential(2)})`);

    // Assertion 2: no sign change → should throw.
    try {
        bisect((x) => x * x - 2, 2, 3, 1e-8);
        fail("bisect(x²-2, 2, 3, 1e-8) should have thrown (no sign change)");
    } catch {
        console.log("  bisect(x²-2, 2, 3, 1e-8) correctly threw (no sign change)");
    }

    // Assertion 3: cos(x) - x root ≈ 0.739085.
    const cosRoot = bisect((x) => Math.cos(x) - x, 0, 1, 1e-8);
    if (Math.abs(cosRoot - 0.739085) >= 1e-6) {
        fail(`bisect(cos(x)-x, 0, 1) = ${cosRoot}, expected ≈ 0.739085`);
    }
    console.log(`  cos(x)-x root ≈ ${cosRoot} (ok, diff=${Math.abs(cosRoot - 0.739085).toExponential(2)})`);

    // Assertion 4: x³ - 5 root ≈ cbrt(5) ≈ 1.709976.
    const cbrt5 = Math.cbrt(5);
    const cubeRoot = bisect((x) => x * x * x - 5, 1, 2, 1e-8);
    if (Math.abs(cubeRoot - cbrt5) >= 1e-6) {
        fail(`bisect(x³-5, 1, 2) = ${cubeRoot}, expected ≈ ${cbrt5}`);
    }
    console.log(`  x³-5 root ≈ ${cubeRoot} (ok, diff=${Math.abs(cubeRoot - cbrt5).toExponential(2)})`);

    // Assertion 5: bob emitted at least 2 verdicts (step 2 + step 4).
    const verdicts = parseVerdicts(bobRaw);
    if (verdicts.length < 2) {
        fail(`bob.md has only ${verdicts.length} verdict(s), expected at least 2`);
    }

    // Assertion 6: all verdicts are PASS.
    for (let i = 0; i < verdicts.length; i++) {
        if (verdicts[i].result !== "PASS") {
            fail(`bob verdict ${i + 1} is ${verdicts[i].result}, expected PASS`);
        }
        console.log(`  bob: verdict ${i + 1} = PASS`);
    }

    console.log(`PASS: bisect correct on all 3 test functions; bob emitted ${verdicts.length} PASS verdicts.`);
}

main();
