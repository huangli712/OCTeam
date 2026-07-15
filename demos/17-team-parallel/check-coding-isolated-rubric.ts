/**
 * Check script: binarySearch rubric-scored isolated implementations.
 *
 * Loads all .md files, extracts the LAST ```typescript code block from each,
 * transpiles and evaluates binarySearch, and asserts at least one
 * implementation passes all 5 test cases.
 *
 * Usage:  bun check-coding-isolated-rubric.ts <run_dir>
 *   <run_dir>  directory containing per-member markdown outputs
 *
 * Exit codes:  0 PASS  |  1 FAIL  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

interface BunTranspiler {
    transformSync(code: string): string;
}
interface BunGlobal {
    Transpiler: new (opts: { loader: string }) => BunTranspiler;
}
const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

const CODE_BLOCK_RE = /```typescript\s*\n([\s\S]*?)(?=```)/g;
const IMPL_RE = /<!--\s*IMPL:\s*binarySearch\s*-->/;

interface TestCase {
    arr: number[];
    target: number;
    expected: number;
}

const TEST_CASES: TestCase[] = [
    { arr: [1, 3, 5, 7, 9], target: 5, expected: 2 },
    { arr: [1, 3, 5, 7, 9], target: 1, expected: 0 },
    { arr: [1, 3, 5, 7, 9], target: 9, expected: 4 },
    { arr: [1, 3, 5, 7, 9], target: 4, expected: -1 },
    { arr: [], target: 1, expected: -1 },
];

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function loadFn(code: string, fnName: string): (...args: unknown[]) => unknown {
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const jsCode = transpiled.replace(/\bexport\s+/g, "");
    const factory = new Function(
        `${jsCode}; return typeof ${fnName} === "function" ? ${fnName} : null;`,
    ) as () => unknown;
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error(`code did not expose a "${fnName}" function`);
    }
    return fn as (...args: unknown[]) => unknown;
}

/**
 * Extracts the LAST ```typescript code block from a markdown string.
 * The member may have multiple blocks (examples, code); we want their final
 * implementation block.
 */
function extractLastCodeBlock(content: string): string | null {
    const matches = content.matchAll(CODE_BLOCK_RE);
    let last: string | null = null;
    for (const m of matches) {
        last = m[1];
    }
    return last;
}

async function readAllMd(runDir: string): Promise<Map<string, string>> {
    const files = await readdir(runDir);
    const mdFiles = files.filter(f => f.endsWith(".md"));
    const result = new Map<string, string>();
    for (const f of mdFiles) {
        try {
            const content = await readFile(join(runDir, f), "utf8");
            result.set(f.replace(".md", ""), content);
        } catch { /* skip */ }
    }
    return result;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-isolated-rubric.ts <run_dir>");
        process.exit(2);
    }

    const mdFiles = await readAllMd(runDir).catch((err: Error) => {
        console.error(`IO error reading run dir: ${err.message}`);
        process.exit(2);
    });

    if (mdFiles.size === 0) {
        console.error("IO error: no .md files found in run directory");
        process.exit(2);
    }

    let onePassed = false;

    for (const [member, content] of mdFiles) {
        if (!IMPL_RE.test(content)) {
            fail(`member "${member}" did not emit <!-- IMPL: binarySearch --> marker`);
        }
        const code = extractLastCodeBlock(content);
        if (!code) {
            console.log(`  ${member}: no typescript code block found`);
            continue;
        }

        let fn: (...args: unknown[]) => unknown;
        try {
            fn = loadFn(code, "binarySearch");
        } catch (err) {
            console.log(`  ${member}: code failed to load: ${(err as Error).message}`);
            continue;
        }

        let allPass = true;
        for (let i = 0; i < TEST_CASES.length; i++) {
            const tc = TEST_CASES[i];
            try {
                const result = fn(tc.arr, tc.target);
                if (result !== tc.expected) {
                    console.log(`  ${member}: case ${i} got ${result}, expected ${tc.expected}`);
                    allPass = false;
                    break;
                }
            } catch (err) {
                console.log(`  ${member}: case ${i} threw: ${(err as Error).message}`);
                allPass = false;
                break;
            }
        }

        if (allPass) {
            console.log(`  ${member}: all ${TEST_CASES.length} cases pass`);
            onePassed = true;
            break;
        }
    }

    if (!onePassed) {
        fail("no binarySearch implementation passed all test cases");
    }

    console.log("PASS: at least one binarySearch implementation is correct.");
}

main();
