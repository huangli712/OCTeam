/**
 * Check script: config parser pipeline (spec -> implement -> test) with HITL.
 *
 * Three coder members relay serially: alice writes the spec, bob implements
 * parseConfig, carol writes and runs 3 test cases. Human approval pauses
 * between each stage hand-off. This script reads the final-stage output
 * (carol.md) and the implementation (bob.md) to verify correctness.
 *
 * Usage:  bun check-coding-config-pipeline.ts <run_dir>
 *   <run_dir>  directory containing carol.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface BunTranspiler {
    transformSync(code: string): string;
}
interface BunGlobal {
    Transpiler: new (opts: { loader: string }) => BunTranspiler;
}
const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

const PASSES_RE = /<!--\s*PASS_COUNT:\s*(\d+)\s*\/\s*3\s*-->/;
const CODE_BLOCK_RE = /```typescript\s*\n([\s\S]*?)```/g;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function readMember(runDir: string, member: string): Promise<string> {
    const path = join(runDir, `${member}.md`);
    try {
        return await readFile(path, "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }
}

function loadParseConfig(code: string): (input: string) => Map<string, string> {
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const jsCode = transpiled.replace(/\bexport\s+/g, "");
    let factory: () => unknown;
    try {
        factory = new Function(`${jsCode}; return typeof parseConfig === "function" ? parseConfig : null;`) as () => unknown;
    } catch (err) {
        throw new Error(`syntax error after transpiling: ${(err as Error).message}`);
    }
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error('code did not expose a "parseConfig" function');
    }
    return fn as (input: string) => Map<string, string>;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-config-pipeline.ts <run_dir>");
        process.exit(2);
    }

    const carolRaw = await readMember(runDir, "carol");
    const bobRaw = await readMember(runDir, "bob");

    // Assertion 1: carol reports 3/3 passes.
    const passesMatch = carolRaw.match(PASSES_RE);
    if (!passesMatch) {
        fail('final stage "carol" did not emit a <!-- PASS_COUNT: n/3 --> marker');
    }
    const passes = parseInt(passesMatch[1], 10);
    if (passes !== 3) {
        fail(`carol reported PASS_COUNT: ${passes}/3, expected 3/3`);
    }
    console.log(`  carol: PASS_COUNT = ${passes}/3`);

    // Assertion 2: bob's code block loads as parseConfig.
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = CODE_BLOCK_RE.exec(bobRaw)) !== null) {
        blocks.push(m[1]);
    }
    if (blocks.length === 0) {
        fail('bob has no ```typescript code block');
    }
    const code = blocks[blocks.length - 1];

    let parseConfig: (input: string) => Map<string, string>;
    try {
        parseConfig = loadParseConfig(code);
    } catch (err) {
        fail(`bob code failed to load: ${(err as Error).message}`);
    }

    // Assertion 3: parseConfig("a=1\nb=2") -> Map with 2 entries.
    let result1: Map<string, string>;
    try {
        result1 = parseConfig("a=1\nb=2");
    } catch (err) {
        fail(`parseConfig("a=1\\nb=2") threw: ${(err as Error).message}`);
    }
    if (result1.size !== 2) {
        fail(`parseConfig("a=1\\nb=2") returned Map size ${result1.size}, expected 2`);
    }
    console.log(`  parseConfig("a=1\\nb=2"): Map size = ${result1.size}`);

    // Assertion 4: parseConfig("") -> empty Map.
    let result2: Map<string, string>;
    try {
        result2 = parseConfig("");
    } catch (err) {
        fail(`parseConfig("") threw: ${(err as Error).message}`);
    }
    if (result2.size !== 0) {
        fail(`parseConfig("") returned Map size ${result2.size}, expected 0`);
    }
    console.log(`  parseConfig(""): Map size = ${result2.size}`);

    // Assertion 5: parseConfig("no_equals") -> throws Error.
    let threw = false;
    try {
        parseConfig("no_equals");
    } catch {
        threw = true;
    }
    if (!threw) {
        fail('parseConfig("no_equals") did not throw, expected Error');
    }
    console.log('  parseConfig("no_equals"): threw Error (expected)');

    console.log("PASS: config parser pipeline verified; all 3 test cases pass.");
}

main();
