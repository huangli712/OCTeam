/**
 * Check script: Two Sum multi-solution complexity (3 approaches).
 *
 * Verifies each coder member produced runnable TypeScript that (a) solves the
 * 3 canonical test cases and (b) declares the expected time complexity.
 *
 * Usage:  bun check-coding-twosum.ts <run_dir>
 *   <run_dir>  directory containing alice.md, bob.md, carol.md
 *
 * Exit codes:  0 PASS  |  1 FAIL  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Minimal type declaration for Bun.Transpiler -- the check script convention
// is zero external deps, so we declare only the surface we
// use instead of pulling in @types/bun. Accessed via globalThis at runtime.
interface BunTranspiler {
    transformSync(code: string): string;
}
interface BunGlobal {
    Transpiler: new (opts: { loader: string }) => BunTranspiler;
}
const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

interface TestCase {
    nums: number[];
    target: number;
    expected: number[]; // sorted for order-insensitive compare
}

const TEST_CASES: TestCase[] = [
    { nums: [2, 7, 11, 15], target: 9, expected: [0, 1] },
    { nums: [3, 2, 4], target: 6, expected: [1, 2] },
    { nums: [3, 3], target: 6, expected: [0, 1] },
];

const EXPECTED_COMPLEXITY: Record<string, string> = {
    alice: "O(n^2)",
    bob: "O(n)",
    carol: "O(n log n)",
};

const MEMBERS = ["alice", "bob", "carol"] as const;
const CODE_RE = /```typescript\s*\n([\s\S]*?)```/;
const COMPLEXITY_RE = /<!--\s*COMPLEXITY:\s*(O\([^)]+\))\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function loadFunction(code: string): (nums: number[], target: number) => number[] {
    // Member prompt asks for TypeScript (with type annotations) in a
    // ```typescript block. `new Function` is a JS-only evaluator, so transpile
    // the snippet to JS via bun's TS transpiler first. Also strip any leading
    // `export` / `export default` -- valid ESM but illegal inside a function body.
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(
        code.replace(/\bexport\s+(?:default\s+)?/g, ""),
    );
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(`${js}; return typeof twoSum === "function" ? twoSum : null;`) as
        () => ((nums: number[], target: number) => number[]) | null;
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error("code did not expose a `twoSum` function");
    }
    return fn;
}

function compareIndices(actual: number[], expected: number[]): boolean {
    if (actual.length !== 2) return false;
    return (
        [...actual].sort((a, b) => a - b).join(",") ===
        [...expected].sort((a, b) => a - b).join(",")
    );
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-twosum.ts <run_dir>");
        process.exit(2);
    }

    for (const member of MEMBERS) {
        const path = join(runDir, `${member}.md`);
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch (err) {
            console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
            process.exit(2);
        }

        const codeMatch = raw.match(CODE_RE);
        if (!codeMatch) {
            fail(`member "${member}" has no \`\`\`typescript code block`);
        }
        const complexityMatch = raw.match(COMPLEXITY_RE);
        if (!complexityMatch) {
            fail(`member "${member}" did not emit a <!-- COMPLEXITY: ... --> marker`);
        }

        // Assertion: stated complexity matches expectation.
        const expected = EXPECTED_COMPLEXITY[member];
        if (complexityMatch[1] !== expected) {
            fail(`member "${member}" declared ${complexityMatch[1]}, expected ${expected}`);
        }

        // Assertion: code loads as a twoSum function.
        let fn: (nums: number[], target: number) => number[];
        try {
            fn = loadFunction(codeMatch[1]);
        } catch (err) {
            fail(`member "${member}" code failed to load: ${(err as Error).message}`);
        }

        // Assertion: passes all test cases.
        for (let i = 0; i < TEST_CASES.length; i++) {
            const tc = TEST_CASES[i];
            let result: number[];
            try {
                result = fn(tc.nums, tc.target);
            } catch (err) {
                fail(`member "${member}" threw on case ${i}: ${(err as Error).message}`);
            }
            if (!compareIndices(result, tc.expected)) {
                fail(`member "${member}" case ${i}: got [${result}], expected [${tc.expected}]`);
            }
        }

        console.log(`  ${member}: complexity=${complexityMatch[1]}, 3/3 cases pass`);
    }

    console.log("PASS: all three solutions correct; complexities match.");
}

main();
