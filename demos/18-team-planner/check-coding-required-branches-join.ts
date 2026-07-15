/**
 * Check script: clamp required-branches-join fanout (Scenario 3).
 *
 * Reads ALL .md files from the run directory, extracts the LAST
 * ```typescript code block from each, transpiles and evaluates
 * clamp, and asserts at least one implementation passes all 4
 * test cases (required_branches: 'critical-impl' must succeed;
 * use_survivors: true allows optional branches to fail).
 *
 * Usage:  bun check-coding-required-branches-join.ts <run_dir>
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
        console.error("Usage: bun check-coding-required-branches-join.ts <run_dir>");
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

    let found = false;

    for (const [member, content] of mdFiles) {
        const code = extractLastCodeBlock(content);
        if (!code) {
            console.log(`  ${member}: no typescript code block found`);
            continue;
        }

        let fn: (...args: unknown[]) => unknown;
        try {
            fn = loadFn(code, "clamp");
        } catch (err) {
            console.log(`  ${member}: code failed to load: ${(err as Error).message}`);
            continue;
        }

        try {
            if (fn(5, 0, 10) !== 5) { console.log(`  ${member}: clamp(5,0,10) !== 5`); continue; }
            if (fn(-1, 0, 10) !== 0) { console.log(`  ${member}: clamp(-1,0,10) !== 0`); continue; }
            if (fn(15, 0, 10) !== 10) { console.log(`  ${member}: clamp(15,0,10) !== 10`); continue; }
            if (fn(3, 0, 10) !== 3) { console.log(`  ${member}: clamp(3,0,10) !== 3`); continue; }

            console.log(`  ${member}: all 4 cases pass`);
            found = true;
            break;
        } catch (err) {
            console.log(`  ${member}: threw: ${(err as Error).message}`);
        }
    }

    if (!found) {
        fail("no member produced a working clamp implementation");
    }

    console.log("PASS: at least one clamp implementation is correct.");
}

main();
