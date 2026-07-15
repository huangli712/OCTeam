/**
 * Check script: Conditional Branch by Quality Score (Scenario 3).
 *
 * Validates the on_pass_goto + where engine feature in a team_workflow run:
 *   - alice.md contains TypeScript code for isPalindrome
 *   - isPalindrome handles racecar, hello, "A man a plan a canal Panama", empty string
 *   - Does NOT assert which branch was taken (deploy vs refine) — verifies code only
 *
 * Usage:  bun check-coding-conditional-branch.ts <run_dir>
 *   <run_dir>  directory containing alice.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CODE_BLOCK_RE = /```typescript\s*\n([\s\S]*?)```/g;

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
        console.error("Usage: bun check-coding-conditional-branch.ts <run_dir>");
        process.exit(2);
    }

    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: alice output contains isPalindrome reference
    if (!aliceRaw.includes("isPalindrome")) {
        fail("alice output does not contain isPalindrome reference");
    }
    console.log("  alice: isPalindrome reference found");

    // Assertion 2: Extract and load isPalindrome function
    const code = extractLastCodeBlock(aliceRaw);
    const isPalindrome = loadFn(code, "isPalindrome");

    // Assertion 3: isPalindrome("racecar") === true
    const r1 = isPalindrome("racecar");
    if (r1 !== true) fail(`isPalindrome("racecar") returned ${r1}, expected true`);
    console.log(`  isPalindrome("racecar") = ${r1}`);

    // Assertion 4: isPalindrome("hello") === false
    const r2 = isPalindrome("hello");
    if (r2 !== false) fail(`isPalindrome("hello") returned ${r2}, expected false`);
    console.log(`  isPalindrome("hello") = ${r2}`);

    // Assertion 5: isPalindrome("A man a plan a canal Panama") === true (ignore spaces, case-insensitive)
    const r3 = isPalindrome("A man a plan a canal Panama");
    if (r3 !== true) fail(`isPalindrome("A man a plan a canal Panama") returned ${r3}, expected true`);
    console.log(`  isPalindrome("A man a plan a canal Panama") = ${r3}`);

    // Assertion 6: isPalindrome("") === true
    const r4 = isPalindrome("");
    if (r4 !== true) fail(`isPalindrome("") returned ${r4}, expected true`);
    console.log(`  isPalindrome("") = ${r4}`);

    console.log("PASS: isPalindrome correctly handles all cases (palindrome, non-palindrome, spaces, case, empty).");
}

main();
