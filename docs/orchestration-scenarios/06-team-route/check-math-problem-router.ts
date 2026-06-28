/**
 * Check script: math problem router (calculus classification).
 *
 * Verifies the router member classified the derivative problem as "calculus"
 * and the matched branch member (calc-expert) produced the correct product-rule
 * derivative: d/dx[x^3 * sin(x)] = 3x^2*sin(x) + x^3*cos(x).
 *
 * Usage:  bun check-math-problem-router.ts <run_dir>
 *   <run_dir>  directory containing math-router.md and calc-expert.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertion)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROUTER = "math-router";
const BRANCH_TO_MEMBER: Record<string, string> = {
    calculus: "calc-expert",
    algebra: "algebra-expert",
    "number-theory": "nt-expert",
    combinatorics: "combo-expert",
};
const EXPECTED_BRANCH = "calculus";

const ROUTE_TAG_RE = /<route>([\s\S]*?)<\/route>/;
const ANSWER_RE = /<!--\s*ANSWER:\s*([\s\S]*?)\s*-->/;
const DOMAIN_FALSE_RE = /<!--\s*DOMAIN_MATCH:\s*false\s*-->/

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

/**
 * Extract the routed branch name from the router's <route>{...} decision.
 * Accepts both single-branch {"branch": "x"} and multi-branch
 * {"branches": ["x", ...]} forms (takes the first in the latter case).
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

/**
 * Normalize a math expression for tolerant comparison:
 * drop whitespace, fold `**` to `^`, strip multiplication asterisks, lowercase.
 * Tolerates 3*x^2*sin(x), 3x^2*sin(x), x**3*cos(x), etc.
 */
function normalizeExpr(s: string): string {
    return s
        .replace(/\s+/g, "")
        .replace(/\*\*/g, "^")
        .replace(/\*/g, "")
        .toLowerCase();
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-problem-router.ts <run_dir>");
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
    let expertRaw: string;
    try {
        expertRaw = await readFile(join(runDir, `${member}.md`), "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 2: matched branch did not reject the problem.
    if (DOMAIN_FALSE_RE.test(expertRaw)) {
        fail(
            `matched branch "${member}" rejected the problem (DOMAIN_MATCH: false) ` +
                `— routing was correct but the expert disowned it`,
        );
    }

    // Assertion 3: matched branch produced an ANSWER marker.
    const ansMatch = expertRaw.match(ANSWER_RE);
    if (!ansMatch) {
        fail(`matched branch "${member}" did not emit <!-- ANSWER: ... -->`);
    }
    const answer = ansMatch[1];
    console.log(`  ${member} ANSWER: ${answer.trim()}`);

    // Assertion 4: answer matches the product-rule derivative
    // 3x^2*sin(x) + x^3*cos(x) — term order independent, notation tolerant.
    const norm = normalizeExpr(answer);
    const hasFirstTerm = /3x\^2sin\(x\)/.test(norm);
    const hasSecondTerm = /x\^3cos\(x\)/.test(norm);
    if (!hasFirstTerm || !hasSecondTerm) {
        fail(
            `answer does not match product-rule derivative 3x^2*sin(x) + x^3*cos(x) ` +
                `(normalized: ${norm})`,
        );
    }

    console.log("PASS: router selected calculus; calc-expert derived 3x^2*sin(x) + x^3*cos(x).");
}

main();
