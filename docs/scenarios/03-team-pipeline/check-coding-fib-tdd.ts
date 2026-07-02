/**
 * Check script: Fibonacci TDD pipeline (alice -> bob -> carol).
 *
 * Pipeline output is the FINAL stage's markdown (carol.md). This script
 * extracts the refactored fib code, loads it via `new Function`, and re-runs
 * the 4 canonical cases to confirm the refactor preserved behavior.
 *
 * NOTE on TS loading: members are asked to emit `function fib(n: number):
 * number`, but `new Function` is a runtime JS primitive that does NOT accept
 * TypeScript type annotations or module `export` (Bun transpiles .ts files but
 * not dynamic strings). We therefore run the extracted code through
 * `Bun.Transpiler` (strips types) and a regex (strips `export`) before loading.
 * This mirrors the shared check-script convention (see _AUTHORING.md).
 *
 * Usage:  bun check-coding-fib-tdd.ts <run_dir>
 *   <run_dir>  directory containing carol.md
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

const FINAL_MEMBER = "carol";

interface FibCase {
    n: number;
    expected: number;
}

const CASES: FibCase[] = [
    { n: 0, expected: 0 },
    { n: 1, expected: 1 },
    { n: 10, expected: 55 },
    { n: 20, expected: 6765 },
];

// Pipeline stage-3's task is prefixed with stage-2's output (which also
// contains a typescript block). The member is instructed to embed ONLY the
// refactored code, but for robustness we collect all blocks and take the
// LAST one — the refactored artifact is always the final code the member
// produces.
const CODE_BLOCK_RE = /```typescript\s*\n([\s\S]*?)```/g;
const PASSES_RE = /<!--\s*PASSES:\s*(\d+)\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

/**
 * Load TypeScript code via the shared `Bun.Transpiler` + strip-`export`
 * convention (matches check-coding-twosum.md et al.). Members are asked to emit
 * `function fib(n: number): number`, but `new Function` is a runtime JS
 * primitive that does NOT accept TypeScript annotations or module `export`.
 * Bun.Transpiler strips types; the regex strips `export`.
 */
function loadFib(code: string): (n: number) => number {
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const jsCode = transpiled.replace(/\bexport\s+/g, "");
    let factory: () => unknown;
    try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        factory = new Function(`${jsCode}; return typeof fib === "function" ? fib : null;`) as () => unknown;
    } catch (err) {
        throw new Error(`syntax error after transpiling: ${(err as Error).message}`);
    }
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error("code did not expose a `fib` function");
    }
    return fn as (n: number) => number;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-fib-tdd.ts <run_dir>");
        process.exit(2);
    }

    const path = join(runDir, `${FINAL_MEMBER}.md`);
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (err) {
        console.error(`IO error reading ${FINAL_MEMBER}.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: the final stage reported all 4 cases pass.
    const passesMatch = raw.match(PASSES_RE);
    if (!passesMatch) {
        fail(`final stage "${FINAL_MEMBER}" did not emit a <!-- PASSES: ... --> marker`);
    }
    const passes = parseInt(passesMatch[1], 10);
    if (passes !== CASES.length) {
        fail(`final stage reported PASSES: ${passes}, expected ${CASES.length}`);
    }

    // Assertion 2: extract the refactored code block (last typescript block).
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = CODE_BLOCK_RE.exec(raw)) !== null) {
        blocks.push(m[1]);
    }
    if (blocks.length === 0) {
        fail(`final stage "${FINAL_MEMBER}" has no \`\`\`typescript code block`);
    }
    const code = blocks[blocks.length - 1];

    // Assertion 3: code loads as a fib function.
    let fib: (n: number) => number;
    try {
        fib = loadFib(code);
    } catch (err) {
        fail(`final stage "${FINAL_MEMBER}" code failed to load: ${(err as Error).message}`);
    }

    // Assertion 4: all 4 cases pass.
    for (const c of CASES) {
        let got: number;
        try {
            got = fib(c.n);
        } catch (err) {
            fail(`fib(${c.n}) threw: ${(err as Error).message}`);
        }
        if (got !== c.expected) {
            fail(`fib(${c.n}) returned ${got}, expected ${c.expected}`);
        }
    }

    console.log(`  ${FINAL_MEMBER}: PASSES=${passes}, ${CASES.length}/${CASES.length} cases verified by check script`);
    console.log(`PASS: refactored fib is loadable and correct on all ${CASES.length} cases.`);
}

main();
