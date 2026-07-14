/**
 * Check script: release pipeline workflow with HITL approval.
 *
 * A 6-step declarative workflow: spec define -> spec verify (gate) -> version
 * bump implement -> test -> release notes -> final review. Human approval
 * pauses after steps 3 (implement), 4 (test), and 6 (review) via
 * approval_after. This script verifies the test results (carol), final review
 * (erin), and loads the bumpVersion implementation (bob) to run two known cases.
 *
 * Usage:  bun check-coding-release-workflow.ts <run_dir>
 *   <run_dir>  directory containing carol.md, bob.md, erin.md
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

const PASSES_RE = /<!--\s*PASS_COUNT:\s*2\s*\/\s*2\s*-->/;
const REVIEW_RE = /<!--\s*REVIEW_OK:\s*true\s*-->/;
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

function loadBumpVersion(code: string): (v: string) => string {
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const jsCode = transpiled.replace(/\bexport\s+/g, "");
    let factory: () => unknown;
    try {
        factory = new Function(`${jsCode}; return typeof bumpVersion === "function" ? bumpVersion : null;`) as () => unknown;
    } catch (err) {
        throw new Error(`syntax error after transpiling: ${(err as Error).message}`);
    }
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error('code did not expose a "bumpVersion" function');
    }
    return fn as (v: string) => string;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-release-workflow.ts <run_dir>");
        process.exit(2);
    }

    const carolRaw = await readMember(runDir, "carol");
    const erinRaw = await readMember(runDir, "erin");
    const bobRaw = await readMember(runDir, "bob");

    // Assertion 1: carol reports PASS_COUNT = 2/2.
    const passesMatch = carolRaw.match(PASSES_RE);
    if (!passesMatch) {
        fail('carol did not emit a <!-- PASS_COUNT: 2/2 --> marker');
    }
    console.log("  carol: PASS_COUNT = 2/2");

    // Assertion 2: erin reports REVIEW_OK = true.
    const reviewMatch = erinRaw.match(REVIEW_RE);
    if (!reviewMatch) {
        fail('erin did not emit a <!-- REVIEW_OK: true --> marker');
    }
    console.log("  erin: REVIEW_OK = true");

    // Assertion 3: bob's code block loads as bumpVersion.
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = CODE_BLOCK_RE.exec(bobRaw)) !== null) {
        blocks.push(m[1]);
    }
    if (blocks.length === 0) {
        fail('bob has no ```typescript code block');
    }
    const code = blocks[blocks.length - 1];

    let bumpVersion: (v: string) => string;
    try {
        bumpVersion = loadBumpVersion(code);
    } catch (err) {
        fail(`bob code failed to load: ${(err as Error).message}`);
    }

    // Assertion 4: bumpVersion("1.0.0") === "1.0.1".
    let result1: string;
    try {
        result1 = bumpVersion("1.0.0");
    } catch (err) {
        fail(`bumpVersion("1.0.0") threw: ${(err as Error).message}`);
    }
    if (result1 !== "1.0.1") {
        fail(`bumpVersion("1.0.0") returned "${result1}", expected "1.0.1"`);
    }
    console.log(`  bumpVersion("1.0.0") = "${result1}"`);

    // Assertion 5: bumpVersion("2.3.9") === "2.3.10".
    let result2: string;
    try {
        result2 = bumpVersion("2.3.9");
    } catch (err) {
        fail(`bumpVersion("2.3.9") threw: ${(err as Error).message}`);
    }
    if (result2 !== "2.3.10") {
        fail(`bumpVersion("2.3.9") returned "${result2}", expected "2.3.10"`);
    }
    console.log(`  bumpVersion("2.3.9") = "${result2}"`);

    console.log("PASS: release workflow verified; all tests pass and version bump is correct.");
}

main();
