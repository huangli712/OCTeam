/**
 * Check script: isPrime implementation with FAIL->retry (gate-verify).
 *
 * Verifies the producer's (alice.md) isPrime passes 6 test cases — including
 * the n<2 edge case that commonly triggers a first-attempt FAIL — and that
 * the verifier (bob.md) ultimately emitted a PASS verdict.
 *
 * The tollgate's max_gate_retries: 2 allows the producer up to 2 fixes after
 * FAIL. This check script extracts the LAST code block (post-retry fix) and
 * the LAST verdict tag.
 *
 * Demonstrates `max_gate_retries` > 1: the FAIL -> retry -> PASS cycle across
 * multiple attempts, validating that the producer's final code is correct even
 * if the first attempt missed edge cases.
 *
 * Usage:  bun check-coding-coverage-retry.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Minimal type declaration for Bun.Transpiler — the check script convention
// is zero external deps, so we declare only the surface we
// use instead of pulling in @types/bun. Accessed via globalThis at runtime.
interface BunTranspiler {
    transformSync(code: string): string;
}
interface BunGlobal {
    Transpiler: new (opts: { loader: string }) => BunTranspiler;
}
const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

interface IsPrimeCase {
    n: number;
    expected: boolean;
}

const CASES: IsPrimeCase[] = [
    { n: 2, expected: true },   // smallest prime
    { n: 1, expected: false },  // n<2 edge case
    { n: 0, expected: false },  // n<2 edge case
    { n: -5, expected: false }, // negative edge case
    { n: 17, expected: true },  // prime
    { n: 100, expected: false }, // composite
];

// Global regex so we can grab the LAST code block (post-retry fix, if any).
const CODE_RE = /```typescript\s*\n([\s\S]*?)```/g;
// Global regex so we can grab the LAST verdict (after potential retry cycles).
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;

function parseLastVerdict(raw: string): { result: string; rationale: string } {
    const matches = [...raw.matchAll(VERDICT_RE)];
    if (matches.length === 0) fail("no <verdict> tag found in verifier output");
    const last = matches[matches.length - 1];
    let obj: { result?: string; rationale?: string };
    try {
        obj = JSON.parse(last[1]) as { result?: string; rationale?: string };
    } catch {
        fail(`final <verdict> block is not valid JSON: ${last[1]}`);
    }
    const result = (obj!.result ?? "").trim().toUpperCase();
    if (!result) fail('final <verdict> JSON lacks a non-empty "result" field');
    return { result, rationale: (obj!.rationale ?? "").trim() };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function loadIsPrime(code: string): (n: number) => boolean {
    // Producer emits TypeScript with `: number`, `: boolean` annotations
    // and may use a module-level `export`; transpile types to JS, then strip
    // `export` so `new Function` (a function body, not a module) can load it.
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const jsCode = transpiled.replace(/\bexport\s+/g, "");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
        `${jsCode}; return typeof isPrime === "function" ? isPrime : null;`,
    ) as () => ((n: number) => boolean) | null;
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error('code did not expose an "isPrime" function');
    }
    return fn;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-coverage-retry.ts <run_dir>");
        process.exit(2);
    }

    // --- Load producer (alice.md) ---
    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Extract the LAST code block — after retry, the fixed code replaces
    // (or is appended after) the buggy version.
    const codeMatches = [...aliceRaw.matchAll(CODE_RE)];
    if (codeMatches.length === 0) {
        fail(`producer (alice.md) has no \`\`\`typescript code block`);
    }
    const lastCode = codeMatches[codeMatches.length - 1];

    // Assertion 1: code loads as an isPrime function.
    let isPrime: (n: number) => boolean;
    try {
        isPrime = loadIsPrime(lastCode[1]);
    } catch (err) {
        fail(`producer code failed to load: ${(err as Error).message}`);
    }

    // Assertion 2: passes all 6 test cases (including n<2 edge case).
    for (let i = 0; i < CASES.length; i++) {
        const c = CASES[i];
        let result: boolean;
        try {
            result = isPrime(c.n);
        } catch (err) {
            fail(`isPrime threw on case ${i} (n=${c.n}): ${(err as Error).message}`);
        }
        if (result !== c.expected) {
            fail(`isPrime(${c.n}) = ${result}, expected ${c.expected}`);
        }
        console.log(`  case ${i}: isPrime(${c.n}) = ${result} (ok)`);
    }

    // --- Load verifier (bob.md) ---
    let bobRaw: string;
    try {
        bobRaw = await readFile(join(runDir, "bob.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading bob.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Use the LAST verdict — after retry cycles, only the final verdict matters.
    const { result: verdict } = parseLastVerdict(bobRaw);

    // Assertion 3: final verifier verdict is PASS (gate let it through).
    if (verdict !== "PASS") {
        fail(`final verifier verdict is ${verdict}, expected PASS`);
    }

    console.log("PASS: isPrime correct on all 6 cases; final verifier verdict = PASS.");
}

main();
