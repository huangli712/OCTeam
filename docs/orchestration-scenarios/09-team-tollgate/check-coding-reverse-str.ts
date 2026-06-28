/**
 * Check script: Unicode-safe string reverse (implement + gate-verify).
 *
 * Verifies the producer's (coder.md) reverseStr passes 3 cases — including a
 * surrogate-pair (emoji) case that naive split/reverse would corrupt — and that
 * the verifier (auditor.md) emitted a PASS verdict.
 *
 * Usage:  bun check-coding-reverse-str.ts <run_dir>
 *   <run_dir>  directory containing coder.md and auditor.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface ReverseCase {
    input: string;
    expected: string;
}

const CASES: ReverseCase[] = [
    { input: "abc", expected: "cba" },
    { input: "", expected: "" },
    { input: "a\u{1F680}b", expected: "b\u{1F680}a" }, // 'a🚀b' -> 'b🚀a' (surrogate pair intact)
];

const CODE_RE = /```typescript\s*\n([\s\S]*?)```/;
const VERDICT_RE = /<!--\s*VERDICT:\s*(PASS|FAIL)\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function loadReverseStr(code: string): (s: string) => string {
    // Member prompt fixes the signature `function reverseStr(s)`.
    // Works for both `function reverseStr(...)` declarations and `const reverseStr = ...`.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(`${code}; return typeof reverseStr === "function" ? reverseStr : null;`) as
        () => ((s: string) => string) | null;
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error("code did not expose a `reverseStr` function");
    }
    return fn;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-reverse-str.ts <run_dir>");
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

    // Assertion 1: code loads as a reverseStr function.
    let reverseStr: (s: string) => string;
    try {
        reverseStr = loadReverseStr(codeMatch[1]);
    } catch (err) {
        fail(`producer code failed to load: ${(err as Error).message}`);
    }

    // Assertion 2: passes all 3 cases (incl. the surrogate-pair emoji case).
    for (let i = 0; i < CASES.length; i++) {
        const c = CASES[i];
        let result: string;
        try {
            result = reverseStr(c.input);
        } catch (err) {
            fail(`reverseStr threw on case ${i} (${JSON.stringify(c.input)}): ${(err as Error).message}`);
        }
        if (result !== c.expected) {
            fail(
                `reverseStr(${JSON.stringify(c.input)}) = ${JSON.stringify(result)}, ` +
                    `expected ${JSON.stringify(c.expected)}`,
            );
        }
        console.log(`  case ${i}: reverseStr(${JSON.stringify(c.input)}) = ${JSON.stringify(result)} (ok)`);
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

    // Assertion 3: verifier verdict is PASS.
    if (verdictMatch[1] !== "PASS") {
        fail(`verifier verdict is ${verdictMatch[1]}, expected PASS`);
    }

    console.log("PASS: reverseStr correct incl. surrogate pair; verifier verdict = PASS.");
}

main();
