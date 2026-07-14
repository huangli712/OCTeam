/**
 * Check script: Auto-Retry on Incomplete Output (Scenario 1).
 *
 * Validates the retry_on engine feature in a team_workflow run:
 *   - alice.md contains TypeScript code for factorial with IMPL_DONE marker
 *   - bob.md contains a gate <verdict> (PASS)
 *   - factorial(0) === 1, factorial(5) === 120, factorial(10) === 3628800
 *   - factorial(-1) throws
 *
 * Usage:  bun check-coding-retry-on.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CODE_BLOCK_RE = /```typescript\s*\n([\s\S]*?)```/g;
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;

interface BunTranspiler {
    transformSync(code: string): string;
}
interface BunGlobal {
    Transpiler: new (opts: { loader: string }) => BunTranspiler;
}
const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

interface Verdict {
    result: string;
    rationale: string;
    diff: string;
}

function parseLastVerdict(raw: string): Verdict {
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = VERDICT_RE.exec(raw)) !== null) {
        matches.push(m);
    }
    if (matches.length === 0) {
        fail("no <verdict> block found in output");
    }
    const last = matches[matches.length - 1];
    try {
        const obj = JSON.parse(last[1]) as Record<string, string>;
        const result = (obj.result ?? "").trim().toUpperCase();
        if (!result) fail("verdict JSON lacks a non-empty 'result' field");
        return {
            result,
            rationale: (obj.rationale ?? "").trim(),
            diff: (obj.diff ?? "").trim(),
        };
    } catch {
        fail(`verdict block is not valid JSON: ${last[1].substring(0, 200)}`);
    }
}

function extractLastCodeBlock(raw: string): string {
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = CODE_BLOCK_RE.exec(raw)) !== null) {
        matches.push(m);
    }
    if (matches.length === 0) {
        fail("no ```typescript code block found in output");
    }
    return matches[matches.length - 1][1];
}

function loadFn(code: string, fnName: string): (...args: unknown[]) => unknown {
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const jsCode = transpiled.replace(/\bexport\s+/g, "");
    const factory = new Function(`${jsCode}; return typeof ${fnName} === "function" ? ${fnName} : null;`) as () => unknown;
    const fn = factory();
    if (typeof fn !== "function") throw new Error(`code did not expose a "${fnName}" function`);
    return fn as (...args: unknown[]) => unknown;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-retry-on.ts <run_dir>");
        process.exit(2);
    }

    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    let bobRaw: string;
    try {
        bobRaw = await readFile(join(runDir, "bob.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading bob.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: alice output contains IMPL_DONE marker (retry_on condition satisfied)
    if (!aliceRaw.includes("IMPL_DONE")) {
        fail("alice output missing IMPL_DONE marker (retry_on may have exhausted)");
    }
    console.log("  alice: IMPL_DONE marker present");

    // Assertion 2: Extract and load factorial function
    const code = extractLastCodeBlock(aliceRaw);
    const factorial = loadFn(code, "factorial");

    // Assertion 3: factorial(0) === 1
    const r0 = factorial(0);
    if (r0 !== 1) fail(`factorial(0) returned ${r0}, expected 1`);
    console.log(`  factorial(0) = ${r0}`);

    // Assertion 4: factorial(5) === 120
    const r5 = factorial(5);
    if (r5 !== 120) fail(`factorial(5) returned ${r5}, expected 120`);
    console.log(`  factorial(5) = ${r5}`);

    // Assertion 5: factorial(10) === 3628800
    const r10 = factorial(10);
    if (r10 !== 3628800) fail(`factorial(10) returned ${r10}, expected 3628800`);
    console.log(`  factorial(10) = ${r10}`);

    // Assertion 6: factorial(-1) throws
    let threw = false;
    try {
        factorial(-1);
    } catch {
        threw = true;
    }
    if (!threw) fail("factorial(-1) did not throw, expected Error");
    console.log("  factorial(-1) threw Error as expected");

    // Assertion 7: bob verdict is PASS
    const verdict = parseLastVerdict(bobRaw);
    if (verdict.result !== "PASS") {
        fail(`bob verdict is ${verdict.result}, expected PASS (rationale: ${verdict.rationale})`);
    }
    console.log(`  bob: verdict = PASS (rationale: ${verdict.rationale.substring(0, 80)})`);

    console.log("PASS: factorial implementations correct; bob gate verdict is PASS.");
}

main();
