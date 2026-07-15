/**
 * Check script: gcd+lcm comprehensive-join fanout (Scenario 4 · challenge).
 *
 * Reads ALL .md files from the run directory, extracts the LAST
 * ```typescript code block from each, transpiles and evaluates
 * both gcd and lcm, and asserts at least one file exposes both
 * functions passing all test cases and the mathematical
 * relationship lcm(a,b) === a*b/gcd(a,b).
 *
 * Usage:  bun check-coding-comprehensive-join.ts <run_dir>
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
        console.error("Usage: bun check-coding-comprehensive-join.ts <run_dir>");
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

        let g: (a: unknown, b: unknown) => unknown;
        let l: (a: unknown, b: unknown) => unknown;
        try {
            g = loadFn(code, "gcd") as (a: unknown, b: unknown) => unknown;
            l = loadFn(code, "lcm") as (a: unknown, b: unknown) => unknown;
        } catch (err) {
            console.log(`  ${member}: code failed to load: ${(err as Error).message}`);
            continue;
        }

        try {
            // Test gcd cases
            if (g(12, 8) !== 4) { console.log(`  ${member}: gcd(12,8) !== 4`); continue; }
            if (g(7, 13) !== 1) { console.log(`  ${member}: gcd(7,13) !== 1`); continue; }

            // Test lcm cases
            if (l(12, 8) !== 24) { console.log(`  ${member}: lcm(12,8) !== 24`); continue; }
            if (l(7, 13) !== 91) { console.log(`  ${member}: lcm(7,13) !== 91`); continue; }

            // Verify mathematical relationship for all test pairs
            const pairs: [number, number][] = [[12, 8], [7, 13], [48, 18]];
            let relationshipHolds = true;
            for (const [a, b] of pairs) {
                const gcdVal = g(a, b) as number;
                const lcmVal = l(a, b) as number;
                const expected = a * b / gcdVal;
                if (lcmVal !== expected) {
                    console.log(`  ${member}: lcm(${a},${b})=${lcmVal} !== a*b/gcd=${expected}`);
                    relationshipHolds = false;
                    break;
                }
            }
            if (!relationshipHolds) continue;

            console.log(`  ${member}: all cases pass, relationship verified`);
            found = true;
            break;
        } catch (err) {
            console.log(`  ${member}: threw: ${(err as Error).message}`);
        }
    }

    if (!found) {
        fail("no member produced working gcd and lcm implementations with correct relationship");
    }

    console.log("PASS: at least one member's gcd and lcm implementations are correct.");
}

main();
