/**
 * Check script: multi-gate clamp + lerp V&V chain with INVALID tolerance.
 *
 * Verifies the G1 producer's (alice.md) clamp function passes 3 test cases
 * and the G2 producer's (carol.md) lerp function passes 3 test cases, and
 * that both verifiers (bob.md for G1, dave.md for G2) emitted PASS verdicts.
 *
 * The tollgate's escalate_to: "frank" handles INVALID for both gates, and
 * max_invalid_cycles: 3 allows up to 3 INVALID->escalate->re-verify rounds
 * per gate. This check extracts the LAST code block and LAST verdict from
 * each producer/verifier pair.
 *
 * Demonstrates `max_invalid_cycles` across 2 serial gates with a shared
 * escalation handler: per-gate INVALID isolation, independent cycle counters,
 * and tolerance for repeated verifier-side failures.
 *
 * Usage:  bun check-coding-multi-invalid.ts <run_dir>
 *   <run_dir>  directory containing alice/bob/carol/dave/erin/frank.md
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

interface ClampCase {
    n: number;
    lo: number;
    hi: number;
    expected: number;
}

interface LerpCase {
    a: number;
    b: number;
    t: number;
    expected: number;
}

const CLAMP_CASES: ClampCase[] = [
    { n: 5, lo: 0, hi: 10, expected: 5 },   // within range
    { n: -1, lo: 0, hi: 10, expected: 0 },  // below lo
    { n: 15, lo: 0, hi: 10, expected: 10 }, // above hi
];

const LERP_CASES: LerpCase[] = [
    { a: 0, b: 10, t: 0.5, expected: 5 },  // midpoint
    { a: 0, b: 10, t: 0, expected: 0 },    // start
    { a: 0, b: 10, t: 1, expected: 10 },   // end
];

// Global regex so we can grab the LAST code block (post-retry fix, if any).
const CODE_RE = /```typescript\s*\n([\s\S]*?)```/g;
// Global regex so we can grab the LAST verdict (after escalation/retry cycles).
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

function loadFn(
    code: string,
    fnName: string,
): (...args: unknown[]) => unknown {
    // Producer emits TypeScript with annotations and may use `export`;
    // transpile types to JS, then strip `export` so `new Function`
    // (a function body, not a module) can load it.
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const jsCode = transpiled.replace(/\bexport\s+/g, "");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
        `${jsCode}; return typeof ${fnName} === "function" ? ${fnName} : null;`,
    ) as () => ((...args: unknown[]) => unknown) | null;
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error(`code did not expose a "${fnName}" function`);
    }
    return fn;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-multi-invalid.ts <run_dir>");
        process.exit(2);
    }

    // ======== Gate 1: clamp (alice -> bob) ========

    // --- Load G1 producer (alice.md) ---
    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const aliceCodeMatches = [...aliceRaw.matchAll(CODE_RE)];
    if (aliceCodeMatches.length === 0) {
        fail(`G1 producer (alice.md) has no \`\`\`typescript code block`);
    }
    const aliceLastCode = aliceCodeMatches[aliceCodeMatches.length - 1];

    // Assertion G1.1: code loads as a clamp function.
    let clamp: (n: number, lo: number, hi: number) => number;
    try {
        clamp = loadFn(aliceLastCode[1], "clamp") as (n: number, lo: number, hi: number) => number;
    } catch (err) {
        fail(`G1 producer code failed to load: ${(err as Error).message}`);
    }

    // Assertion G1.2: passes all 3 clamp test cases.
    for (let i = 0; i < CLAMP_CASES.length; i++) {
        const c = CLAMP_CASES[i];
        let result: number;
        try {
            result = clamp(c.n, c.lo, c.hi);
        } catch (err) {
            fail(`clamp threw on case ${i} (${c.n}, ${c.lo}, ${c.hi}): ${(err as Error).message}`);
        }
        if (result !== c.expected) {
            fail(
                `clamp(${c.n}, ${c.lo}, ${c.hi}) = ${result}, expected ${c.expected}`,
            );
        }
        console.log(
            `  G1 case ${i}: clamp(${c.n}, ${c.lo}, ${c.hi}) = ${result} (ok)`,
        );
    }

    // --- Load G1 verifier (bob.md) ---
    let bobRaw: string;
    try {
        bobRaw = await readFile(join(runDir, "bob.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading bob.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const { result: g1Verdict } = parseLastVerdict(bobRaw);

    // Assertion G1.3: verifier verdict is PASS.
    if (g1Verdict !== "PASS") {
        fail(`G1 verifier (bob) final verdict is ${g1Verdict}, expected PASS`);
    }

    // ======== Gate 2: lerp (carol -> dave) ========

    // --- Load G2 producer (carol.md) ---
    let carolRaw: string;
    try {
        carolRaw = await readFile(join(runDir, "carol.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading carol.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const carolCodeMatches = [...carolRaw.matchAll(CODE_RE)];
    if (carolCodeMatches.length === 0) {
        fail(`G2 producer (carol.md) has no \`\`\`typescript code block`);
    }
    const carolLastCode = carolCodeMatches[carolCodeMatches.length - 1];

    // Assertion G2.1: code loads as a lerp function.
    let lerp: (a: number, b: number, t: number) => number;
    try {
        lerp = loadFn(carolLastCode[1], "lerp") as (a: number, b: number, t: number) => number;
    } catch (err) {
        fail(`G2 producer code failed to load: ${(err as Error).message}`);
    }

    // Assertion G2.2: passes all 3 lerp test cases.
    for (let i = 0; i < LERP_CASES.length; i++) {
        const c = LERP_CASES[i];
        let result: number;
        try {
            result = lerp(c.a, c.b, c.t);
        } catch (err) {
            fail(`lerp threw on case ${i} (${c.a}, ${c.b}, ${c.t}): ${(err as Error).message}`);
        }
        if (result !== c.expected) {
            fail(
                `lerp(${c.a}, ${c.b}, ${c.t}) = ${result}, expected ${c.expected}`,
            );
        }
        console.log(
            `  G2 case ${i}: lerp(${c.a}, ${c.b}, ${c.t}) = ${result} (ok)`,
        );
    }

    // --- Load G2 verifier (dave.md) ---
    let daveRaw: string;
    try {
        daveRaw = await readFile(join(runDir, "dave.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading dave.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const { result: g2Verdict } = parseLastVerdict(daveRaw);

    // Assertion G2.3: verifier verdict is PASS.
    if (g2Verdict !== "PASS") {
        fail(`G2 verifier (dave) final verdict is ${g2Verdict}, expected PASS`);
    }

    console.log(
        "PASS: clamp and lerp correct on all cases; both verifier verdicts = PASS.",
    );
}

main();
