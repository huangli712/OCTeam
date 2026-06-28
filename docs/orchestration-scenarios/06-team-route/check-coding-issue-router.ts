/**
 * Check script: GitHub issue router (bug classification).
 *
 * Verifies the router member classified the "getUser(-1) should throw" issue as
 * "bug" and the matched branch member (bug-fixer) proposed a fix strategy that
 * mentions a guard / throw / RangeError.
 *
 * Usage:  bun check-coding-issue-router.ts <run_dir>
 *   <run_dir>  directory containing issue-router.md and bug-fixer.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertion)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROUTER = "issue-router";
const BRANCH_TO_MEMBER: Record<string, string> = {
    bug: "bug-fixer",
    feature: "feature-coder",
    docs: "docs-writer",
    refactor: "refactor-coder",
};
const EXPECTED_BRANCH = "bug";

// A bug fix for "should throw on negative id" must name a defensive action.
// Accept any of: guard, throw, rangeerror (case-insensitive).
const FIX_KEYWORD_RE = /guard|throw|rangeerror/;

const ROUTE_TAG_RE = /<route>([\s\S]*?)<\/route>/;
const FIX_STRATEGY_RE = /<!--\s*FIX_STRATEGY:\s*([\s\S]*?)\s*-->/;
const DOMAIN_FALSE_RE = /<!--\s*DOMAIN_MATCH:\s*false\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

/**
 * Extract the routed branch name from the router's <route>{...} decision.
 * Accepts both {"branch": "x"} and {"branches": ["x", ...]} forms.
 */
function extractBranch(routerRaw: string): { branch: string | null; raw: string } {
    const tag = routerRaw.match(ROUTE_TAG_RE);
    if (!tag) return { branch: null, raw: "" };
    let parsed: { branch?: string; branches?: string[] };
    try {
        parsed = JSON.parse(tag[1]);
    } catch {
        return { branch: null, raw: tag[1] };
    }
    const branch =
        parsed.branch ?? (Array.isArray(parsed.branches) ? parsed.branches[0] : undefined);
    return { branch: branch ?? null, raw: tag[1] };
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-issue-router.ts <run_dir>");
        process.exit(2);
    }

    // Load router output.
    let routerRaw: string;
    try {
        routerRaw = await readFile(join(runDir, `${ROUTER}.md`), "utf8");
    } catch (err) {
        console.error(`IO error reading ${ROUTER}.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const { branch, raw } = extractBranch(routerRaw);
    if (branch === null) {
        fail(
            `router "${ROUTER}" did not emit a parseable ` +
                `<route>{"branch": ...}</route> decision (raw: ${raw || "<no route tag>"})`,
        );
    }
    console.log(`  router picked branch: ${branch}`);

    // Assertion 1: router selected the expected branch.
    if (branch !== EXPECTED_BRANCH) {
        fail(`router selected "${branch}", expected "${EXPECTED_BRANCH}"`);
    }

    // Load the matched branch member's output.
    const member = BRANCH_TO_MEMBER[EXPECTED_BRANCH];
    let fixerRaw: string;
    try {
        fixerRaw = await readFile(join(runDir, `${member}.md`), "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 2: matched branch did not reject the issue.
    if (DOMAIN_FALSE_RE.test(fixerRaw)) {
        fail(
            `matched branch "${member}" rejected the issue (DOMAIN_MATCH: false) ` +
                `— routing was correct but the coder disowned it`,
        );
    }

    // Assertion 3: matched branch produced a FIX_STRATEGY marker.
    const strategyMatch = fixerRaw.match(FIX_STRATEGY_RE);
    if (!strategyMatch) {
        fail(`matched branch "${member}" did not emit <!-- FIX_STRATEGY: ... -->`);
    }
    const strategy = strategyMatch[1];
    console.log(`  ${member} FIX_STRATEGY: ${strategy.trim()}`);

    // Assertion 4: strategy mentions a guard / throw / RangeError.
    if (!FIX_KEYWORD_RE.test(strategy.toLowerCase())) {
        fail(
            `fix strategy does not mention guard/throw/RangeError ` +
                `(strategy: ${strategy.trim()})`,
        );
    }

    console.log(`PASS: router selected bug; ${member} proposed a guard/throw fix.`);
}

main();
