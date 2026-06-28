/**
 * Check script: fast modular exponentiation (implement + gate-verify).
 *
 * Verifies the producer's (coder.md) modPow passes 3 known cases and that the
 * verifier (auditor.md) emitted a PASS verdict — i.e. the tollgate let it through.
 *
 * Usage:  bun check-math-fast-pow.ts <run_dir>
 *   <run_dir>  directory containing coder.md and auditor.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface ModPowCase {
    base: number;
    exp: number;
    mod: number;
    expected: number;
}

const CASES: ModPowCase[] = [
    { base: 2, exp: 10, mod: 1000, expected: 24 }, // 2^10 = 1024 -> 24
    { base: 3, exp: 0, mod: 7, expected: 1 }, // exp=0 must return 1
    { base: 7, exp: 256, mod: 13, expected: 9 }, // Fermat: 7^256 = 7^4 = 9 (mod 13)
];

const CODE_RE = /```typescript\s*\n([\s\S]*?)```/;
const VERDICT_RE = /<!--\s*VERDICT:\s*(PASS|FAIL)\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function loadModPow(code: string): (base: number, exp: number, mod: number) => number {
    // Member prompt fixes the signature `function modPow(base, exp, mod)`.
    // Works for both `function modPow(...)` declarations and `const modPow = ...`.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(`${code}; return typeof modPow === "function" ? modPow : null;`) as
        () => ((base: number, exp: number, mod: number) => number) | null;
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error("code did not expose a `modPow` function");
    }
    return fn;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-fast-pow.ts <run_dir>");
        process.exit(2);
    }

    // --- Load producer (coder.md) ---
    let coderRaw: string;
    try {
        coderRaw = await readFile(join(runDir, "coder.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading coder.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const codeMatch = coderRaw.match(CODE_RE);
    if (!codeMatch) {
        fail(`producer (coder.md) has no \`\`\`typescript code block`);
    }

    // Assertion 1: code loads as a modPow function.
    let modPow: (base: number, exp: number, mod: number) => number;
    try {
        modPow = loadModPow(codeMatch[1]);
    } catch (err) {
        fail(`producer code failed to load: ${(err as Error).message}`);
    }

    // Assertion 2: passes all 3 known cases (covers exp=0 -> 1 via case 2).
    for (let i = 0; i < CASES.length; i++) {
        const c = CASES[i];
        let result: number;
        try {
            result = modPow(c.base, c.exp, c.mod);
        } catch (err) {
            fail(`modPow threw on case ${i} (${c.base}^${c.exp} mod ${c.mod}): ${(err as Error).message}`);
        }
        if (result !== c.expected) {
            fail(`modPow(${c.base}, ${c.exp}, ${c.mod}) = ${result}, expected ${c.expected}`);
        }
        console.log(`  case ${i}: modPow(${c.base}, ${c.exp}, ${c.mod}) = ${result} (ok)`);
    }

    // --- Load verifier (auditor.md) ---
    let auditorRaw: string;
    try {
        auditorRaw = await readFile(join(runDir, "auditor.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading auditor.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const verdictMatch = auditorRaw.match(VERDICT_RE);
    if (!verdictMatch) {
        fail(`verifier (auditor.md) did not emit a <!-- VERDICT: PASS|FAIL --> marker`);
    }

    // Assertion 3: verifier verdict is PASS (the gate let the implementation through).
    if (verdictMatch[1] !== "PASS") {
        fail(`verifier verdict is ${verdictMatch[1]}, expected PASS`);
    }

    console.log("PASS: modPow correct on all 3 cases; verifier verdict = PASS.");
}

main();
