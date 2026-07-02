/**
 * Check script: Unicode-safe string reverse (implement + gate-verify).
 *
 * Verifies the producer's (alice.md) reverseStr passes 3 cases — including a
 * surrogate-pair (emoji) case that naive split/reverse would corrupt — and that
 * the verifier (bob.md) emitted a PASS verdict.
 *
 * Usage:  bun check-coding-reverse-str.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Minimal type declaration for Bun.Transpiler -- the check script convention
// is zero external deps (see _AUTHORING.md), so we declare only the surface we
// use instead of pulling in @types/bun. Accessed via globalThis at runtime.
interface BunTranspiler {
    transformSync(code: string): string;
}
interface BunGlobal {
    Transpiler: new (opts: { loader: string }) => BunTranspiler;
}
const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

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
// The verifier emits a tagged-JSON verdict block (aligned with the
// orchestration's parseVerdict convention) rather than HTML comments, so the
// orchestration layer can also parse the gate result:
//   <verdict>{"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."}</verdict>
const VERDICT_TAG_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/;

function parseVerdict(raw: string): { result: string; rationale: string; diff: string } {
    const m = raw.match(VERDICT_TAG_RE);
    if (!m) fail("verifier did not emit a <verdict>{...}</verdict> decision block");
    let obj: { result?: string; rationale?: string; diff?: string };
    try {
        obj = JSON.parse(m![1]) as { result?: string; rationale?: string; diff?: string };
    } catch {
        fail(`verifier <verdict> block is not valid JSON: ${m![1]}`);
    }
    const result = (obj!.result ?? "").trim().toUpperCase();
    if (!result) fail('verifier <verdict> JSON lacks a non-empty "result" field');
    return { result, rationale: (obj!.rationale ?? "").trim(), diff: (obj!.diff ?? "").trim() };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function loadReverseStr(code: string): (s: string) => string {
    // Member prompt fixes the signature `function reverseStr(s)`.
    // Works for both `function reverseStr(...)` declarations and `const reverseStr = ...`.
    // Producer emits TypeScript with `: string` annotations and may use a
    // module-level `export`; transpile types to JS, then strip `export` so
    // `new Function` (a function body, not a module) can load it.
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const js = transpiled.replace(/\bexport\s+/g, "");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(`${js}; return typeof reverseStr === "function" ? reverseStr : null;`) as
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

    // --- Load producer (alice.md) ---
    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const codeMatch = aliceRaw.match(CODE_RE);
    if (!codeMatch) {
        fail(`producer (alice.md) has no \`\`\`typescript code block`);
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

    // --- Load verifier (bob.md) ---
    let bobRaw: string;
    try {
        bobRaw = await readFile(join(runDir, "bob.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading bob.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const { result: verdict } = parseVerdict(bobRaw);

    // Assertion 3: verifier verdict is PASS.
    if (verdict !== "PASS") {
        fail(`verifier verdict is ${verdict}, expected PASS`);
    }

    console.log("PASS: reverseStr correct incl. surrogate pair; verifier verdict = PASS.");
}

main();
