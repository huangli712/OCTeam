/**
 * Check script: PDE type router (parabolic classification).
 *
 * Verifies the router member classified the heat/diffusion equation as
 * "parabolic" and the matched branch member (bob) proposed a valid
 * parabolic numerical method (crank-nicolson / implicit / ftcs).
 *
 * Usage:  bun check-physics-pde-router.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertion)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROUTER = "alice";
const BRANCH_TO_MEMBER: Record<string, string> = {
    parabolic: "bob",
    elliptic: "carol",
    hyperbolic: "dave",
};
const EXPECTED_BRANCH = "parabolic";

// Acceptable numerical methods for a parabolic (heat/diffusion) equation.
// Comparison is case-insensitive after trimming.
const VALID_METHODS = new Set(["crank-nicolson", "implicit", "ftcs"]);

const ROUTE_TAG_RE = /<route>([\s\S]*?)<\/route>/;
const METHOD_RE = /<!--\s*METHOD:\s*(.*?)\s*-->/;
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
        console.error("Usage: bun check-physics-pde-router.ts <run_dir>");
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
    let simRaw: string;
    try {
        simRaw = await readFile(join(runDir, `${member}.md`), "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 2: matched branch did not reject the problem.
    if (DOMAIN_FALSE_RE.test(simRaw)) {
        fail(
            `matched branch "${member}" rejected the problem (DOMAIN_MATCH: false) ` +
                `— routing was correct but the simulator disowned it`,
        );
    }

    // Assertion 3: matched branch produced a METHOD marker with a valid value.
    const methodMatch = simRaw.match(METHOD_RE);
    if (!methodMatch) {
        fail(`matched branch "${member}" did not emit <!-- METHOD: ... -->`);
    }
    const method = methodMatch[1].trim().toLowerCase();
    console.log(`  ${member} METHOD: ${method}`);
    if (!VALID_METHODS.has(method)) {
        fail(
            `method "${method}" not in valid set {${[...VALID_METHODS].join(", ")}} ` +
                `for a parabolic equation`,
        );
    }

    console.log(`PASS: router selected parabolic; ${member} proposed "${method}".`);
}

main();
