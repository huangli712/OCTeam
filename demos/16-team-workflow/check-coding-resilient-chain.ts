/**
 * Check script: Resilient Chain with Timeout + Fallback + Malformed Handling (Scenario 4).
 *
 * Validates the on_timeout, fallback_member, and on_malformed engine features:
 *   - alice.md or bob.md contains TypeScript code for deduplicate
 *   - dave.md or erin.md contains a gate <verdict> (PASS)
 *   - carol.md contains usage documentation with DOCS_OK marker
 *   - deduplicate removes duplicates preserving first-occurrence order
 *
 * Usage:  bun check-coding-resilient-chain.ts <run_dir>
 *   <run_dir>  directory containing member .md files
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CODE_BLOCK_RE = /```typescript\s*\n([\s\S]*?)```/g;
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;
const IMPL_RE = /<!--\s*IMPL:\s*deduplicate\s*-->/;
const DOCS_OK_RE = /<!--\s*DOCS_OK:\s*true\s*-->/;

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

interface Verdict {
    result: string;
    rationale: string;
    diff: string;
}

function parseLastVerdict(raw: string): Verdict {
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = VERDICT_RE.exec(raw)) !== null) {
        matches.push(m);
    }
    if (matches.length === 0) {
        fail("no <verdict> block found in verifier output");
    }
    const last = matches[matches.length - 1];
    try {
        const obj = JSON.parse(last[1]) as Record<string, string>;
        const result = (obj.result ?? "").trim().toUpperCase();
        if (!result) fail("verdict JSON lacks a non-empty 'result' field");
        return {
            result,
            rationale: (obj.rationale ?? "").trim(),
            diff: (obj.diff ?? "").trim(),
        };
    } catch {
        fail(`verdict block is not valid JSON: ${last[1].substring(0, 200)}`);
    }
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

async function readFirstAvailable(
    runDir: string,
    members: string[]
): Promise<{ member: string; content: string } | null> {
    for (const m of members) {
        try {
            const content = await readFile(join(runDir, `${m}.md`), "utf8");
            if (content.trim().length > 0) return { member: m, content };
        } catch {
            /* try next */
        }
    }
    return null;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-resilient-chain.ts <run_dir>");
        process.exit(2);
    }

    // --- Load implementer output: try alice first, fallback to bob ---
    const implResult = await readFirstAvailable(runDir, ["alice", "bob"]);
    if (!implResult) fail("neither alice.md nor bob.md found with content");
    console.log(`  implementer: ${implResult.member}.md`);

    if (!IMPL_RE.test(implResult.content)) {
        fail(`${implResult.member}.md missing <!-- IMPL: deduplicate --> marker`);
    }
    console.log(`  ${implResult.member}: <!-- IMPL: deduplicate --> marker present`);

    // Assertion 1: Extract and load deduplicate function
    const code = extractLastCodeBlock(implResult.content);
    const deduplicate = loadFn(code, "deduplicate");

    // Assertion 2: deduplicate([1,2,2,3,3,3]) === [1,2,3]
    const r1 = deduplicate([1, 2, 2, 3, 3, 3]) as unknown[];
    if (!arrEq(r1, [1, 2, 3])) fail(`deduplicate([1,2,2,3,3,3]) returned [${r1}], expected [1,2,3]`);
    console.log(`  deduplicate([1,2,2,3,3,3]) = [${r1}]`);

    // Assertion 3: deduplicate([]) === []
    const r2 = deduplicate([]) as unknown[];
    if (!arrEq(r2, [])) fail(`deduplicate([]) returned [${r2}], expected []`);
    console.log(`  deduplicate([]) = [${r2}]`);

    // Assertion 4: deduplicate([5,5,5,5]) === [5]
    const r3 = deduplicate([5, 5, 5, 5]) as unknown[];
    if (!arrEq(r3, [5])) fail(`deduplicate([5,5,5,5]) returned [${r3}], expected [5]`);
    console.log(`  deduplicate([5,5,5,5]) = [${r3}]`);

    // --- Load verifier output: try dave first, fallback to erin ---
    const verifierResult = await readFirstAvailable(runDir, ["dave", "erin"]);
    if (!verifierResult) fail("neither dave.md nor erin.md found with content");
    console.log(`  verifier: ${verifierResult.member}.md`);

    const verdict = parseLastVerdict(verifierResult.content);
    if (verdict.result !== "PASS") {
        fail(`${verifierResult.member} verdict is ${verdict.result}, expected PASS (rationale: ${verdict.rationale})`);
    }
    console.log(`  ${verifierResult.member}: verdict = PASS (rationale: ${verdict.rationale.substring(0, 80)})`);

    // --- Load documentation: carol ---
    let carolRaw: string;
    try {
        carolRaw = await readFile(join(runDir, "carol.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading carol.md: ${(err as Error).message}`);
        process.exit(2);
    }

    if (!DOCS_OK_RE.test(carolRaw)) {
        fail("carol.md missing <!-- DOCS_OK: true --> marker");
    }
    console.log("  carol: <!-- DOCS_OK: true --> marker present");

    console.log("PASS: deduplicate correct; verifier PASS; documentation complete.");
}

main();
