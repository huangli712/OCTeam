/**
 * Check script: hashString done-ack barrier implementations.
 *
 * Loads all .md files, extracts the LAST ```typescript code block from each,
 * transpiles and evaluates hashString, and asserts at least one
 * implementation passes all 4 test cases.
 *
 * Usage:  bun check-coding-done-ack.ts <run_dir>
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
const IMPL_RE = /<!--\s*IMPL:\s*hashString\s*-->/;

interface TestCase {
    input: string;
    expected: number;
}

const TEST_CASES: TestCase[] = [
    { input: "ab", expected: 293 },        // 97*1 + 98*2
    { input: "", expected: 0 },
    { input: "a", expected: 97 },          // 97*1
    { input: "abc", expected: 592 },       // 97*1 + 98*2 + 99*3 = 97 + 196 + 299
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
        console.error("Usage: bun check-coding-done-ack.ts <run_dir>");
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
            fail(`member "${member}" did not emit <!-- IMPL: hashString --> marker`);
        }
        const code = extractLastCodeBlock(content);
        if (!code) {
            console.log(`  ${member}: no typescript code block found`);
            continue;
        }

        let fn: (...args: unknown[]) => unknown;
        try {
            fn = loadFn(code, "hashString");
        } catch (err) {
            console.log(`  ${member}: code failed to load: ${(err as Error).message}`);
            continue;
        }

        let allPass = true;
        for (let i = 0; i < TEST_CASES.length; i++) {
            const tc = TEST_CASES[i];
            try {
                const result = fn(tc.input);
                if (result !== tc.expected) {
                    console.log(`  ${member}: case "${tc.input}" got ${result}, expected ${tc.expected}`);
                    allPass = false;
                    break;
                }
            } catch (err) {
                console.log(`  ${member}: case "${tc.input}" threw: ${(err as Error).message}`);
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
        fail("no hashString implementation passed all test cases");
    }

    console.log("PASS: at least one hashString implementation is correct.");
}

main();
