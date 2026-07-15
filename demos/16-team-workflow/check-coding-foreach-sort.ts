/**
 * Check script: Foreach Sort Test (Scenario 2).
 *
 * Validates the foreach fanout engine feature in a team_workflow run:
 *   - alice.md contains TypeScript code for bubbleSort
 *   - bubbleSort correctly sorts arrays: ascending, edge cases
 *   - Does NOT depend on foreach branch structure (verifies core deliverable only)
 *
 * Usage:  bun check-coding-foreach-sort.ts <run_dir>
 *   <run_dir>  directory containing alice.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CODE_BLOCK_RE = /```typescript\s*\n([\s\S]*?)```/g;
const IMPL_RE = /<!--\s*IMPL:\s*bubbleSort\s*-->/;

interface BunTranspiler {
    transformSync(code: string): string;
}
interface BunGlobal {
    Transpiler: new (opts: { loader: string }) => BunTranspiler;
}
const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function extractLastCodeBlock(raw: string): string {
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = CODE_BLOCK_RE.exec(raw)) !== null) {
        matches.push(m);
    }
    if (matches.length === 0) {
        fail("no ```typescript code block found in output");
    }
    return matches[matches.length - 1][1];
}

function arrEq(a: unknown[], b: unknown[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

function loadFn(code: string, fnName: string): (...args: unknown[]) => unknown {
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const jsCode = transpiled.replace(/\bexport\s+/g, "");
    const factory = new Function(`${jsCode}; return typeof ${fnName} === "function" ? ${fnName} : null;`) as () => unknown;
    const fn = factory();
    if (typeof fn !== "function") throw new Error(`code did not expose a "${fnName}" function`);
    return fn as (...args: unknown[]) => unknown;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-foreach-sort.ts <run_dir>");
        process.exit(2);
    }

    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: alice output contains bubbleSort implementation marker
    if (!IMPL_RE.test(aliceRaw)) {
        fail("alice output missing <!-- IMPL: bubbleSort --> marker");
    }
    console.log("  alice: <!-- IMPL: bubbleSort --> marker present");

    // Assertion 2: Extract and load bubbleSort function
    const code = extractLastCodeBlock(aliceRaw);
    const bubbleSort = loadFn(code, "bubbleSort");

    // Assertion 3: sort [3, 1, 2]
    const r1 = bubbleSort([3, 1, 2]) as unknown[];
    if (!arrEq(r1, [1, 2, 3])) fail(`bubbleSort([3,1,2]) returned [${r1}], expected [1,2,3]`);
    console.log(`  bubbleSort([3,1,2]) = [${r1}]`);

    // Assertion 4: sort [5, 4, 3, 2, 1]
    const r2 = bubbleSort([5, 4, 3, 2, 1]) as unknown[];
    if (!arrEq(r2, [1, 2, 3, 4, 5])) fail(`bubbleSort([5,4,3,2,1]) returned [${r2}], expected [1,2,3,4,5]`);
    console.log(`  bubbleSort([5,4,3,2,1]) = [${r2}]`);

    // Assertion 5: sort empty array
    const r3 = bubbleSort([]) as unknown[];
    if (!arrEq(r3, [])) fail(`bubbleSort([]) returned [${r3}], expected []`);
    console.log(`  bubbleSort([]) = [${r3}]`);

    // Assertion 6: sort single-element array
    const r4 = bubbleSort([1]) as unknown[];
    if (!arrEq(r4, [1])) fail(`bubbleSort([1]) returned [${r4}], expected [1]`);
    console.log(`  bubbleSort([1]) = [${r4}]`);

    console.log("PASS: bubbleSort correctly handles all cases (ascending, descending, empty, single).");
}

main();
