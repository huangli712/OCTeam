/**
 * Check script: multi-faceted ticket router (challenge-level, 9 members, multi-branch).
 *
 * Verifies the router member (alice) classified a 200-word ticket spanning
 * bug + refactor + test + docs + perf into >=4 branches via the multi-branch
 * {"branches":[...]} form, every selected branch member produced an ACTION plan,
 * and the bug branch (bob) named a concrete defensive guard.
 *
 * Usage:  bun check-coding-multi-ticket-router.ts <run_dir>
 *   <run_dir>  directory containing alice.md plus each selected branch member .md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertion)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROUTER = "alice";

// Branch label -> member name. routes[].name (the branch label) is NOT a member
// name per the team_route schema; this map is how the check script locates the
// .md file for each selected branch.
const BRANCH_TO_MEMBER: Record<string, string> = {
    bug: "bob",
    refactor: "carol",
    test: "dave",
    docs: "erin",
    perf: "frank",
    security: "grace",
    dependency: "henry",
    question: "iris",
};

// The ticket genuinely spans these 5 core concerns; the router must select at
// least MIN_REQUIRED_DOMAINS of them. security/dependency/question are bonus
// branches the router may also legitimately fire.
const REQUIRED_DOMAINS = ["bug", "refactor", "test", "docs", "perf"];
const MIN_REQUIRED_DOMAINS = 4;
// Hard floor on total selected branches (the ticket's true breadth is >= 4).
const MIN_BRANCHES = 4;
// The bug is an empty/null-input crash; any credible fix names a defensive
// action. Accept: guard, throw, empty, null, undefined, check.
const BUG_FIX_RE = /guard|throw|empty|null|undefined|check/;

const ROUTE_TAG_RE = /<route>([\s\S]*?)<\/route>/;
const ACTION_RE = /<!--\s*ACTION:\s*([\s\S]*?)\s*-->/;
const DOMAIN_FALSE_RE = /<!--\s*DOMAIN_MATCH:\s*false\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function readMember(runDir: string, member: string): Promise<string> {
    try {
        return await readFile(join(runDir, `${member}.md`), "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }
}

/**
 * Extract the routed branch list from the router's <route>{...} decision.
 * Accepts {"branches": ["a","b"]} (multi) and {"branch": "x"} (single,
 * wrapped to ["x"]).
 */
function extractBranches(routerRaw: string): { branches: string[]; raw: string } {
    const tag = routerRaw.match(ROUTE_TAG_RE);
    if (!tag) return { branches: [], raw: "" };
    let parsed: { branch?: string; branches?: unknown };
    try {
        parsed = JSON.parse(tag[1]);
    } catch {
        return { branches: [], raw: tag[1] };
    }
    if (Array.isArray(parsed.branches)) {
        const list = parsed.branches.filter((b): b is string => typeof b === "string");
        return { branches: list, raw: tag[1] };
    }
    if (typeof parsed.branch === "string") {
        return { branches: [parsed.branch], raw: tag[1] };
    }
    return { branches: [], raw: tag[1] };
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-multi-ticket-router.ts <run_dir>");
        process.exit(2);
    }

    const routerRaw = await readMember(runDir, ROUTER);
    const { branches, raw } = extractBranches(routerRaw);
    if (branches.length === 0) {
        fail(
            `router "${ROUTER}" did not emit a parseable ` +
                `<route>{"branches": [...]}</route> decision (raw: ${raw || "<no route tag>"})`,
        );
    }
    console.log(`  router picked ${branches.length} branch(es): ${branches.join(", ")}`);

    // Assertion 1: a multi-faceted ticket must fire >= MIN_BRANCHES.
    if (branches.length < MIN_BRANCHES) {
        fail(
            `router selected only ${branches.length} branch(es); a ticket spanning ` +
                `bug+refactor+test+docs+perf must fire >= ${MIN_BRANCHES} ` +
                `(got: ${branches.join(", ")})`,
        );
    }

    // Assertion 2: >= MIN_REQUIRED_DOMAINS of the 5 core concerns selected.
    const selectedRequired = REQUIRED_DOMAINS.filter((d) => branches.includes(d));
    if (selectedRequired.length < MIN_REQUIRED_DOMAINS) {
        fail(
            `router selected only ${selectedRequired.length} of 5 core concerns ` +
                `(${REQUIRED_DOMAINS.join("/")}); need >= ${MIN_REQUIRED_DOMAINS} ` +
                `(selected core: ${selectedRequired.join(", ") || "none"})`,
        );
    }

    // Assertion 3: "bug" must be among the selected branches.
    if (!branches.includes("bug")) {
        fail(
            `router did not select "bug" — the ticket explicitly reports a crash on ` +
                `empty input, which is unambiguously a bug (selected: ${branches.join(", ")})`,
        );
    }

    // Assertion 4: every selected branch produced an ACTION plan and did not
    // disown the ticket with DOMAIN_MATCH: false.
    for (const branch of branches) {
        const member = BRANCH_TO_MEMBER[branch];
        if (!member) {
            fail(`router selected unknown branch "${branch}" (no member mapping)`);
        }
        const memberRaw = await readMember(runDir, member);
        if (DOMAIN_FALSE_RE.test(memberRaw)) {
            fail(
                `branch "${branch}" (member ${member}) rejected the ticket ` +
                    `(DOMAIN_MATCH: false) — routing selected it but the coder disowned it`,
            );
        }
        const actionMatch = memberRaw.match(ACTION_RE);
        if (!actionMatch) {
            fail(`branch "${branch}" (member ${member}) did not emit <!-- ACTION: ... -->`);
        }
        console.log(`  ${member} [${branch}] ACTION: ${actionMatch![1].trim()}`);
    }

    // Assertion 5: the bug branch (bob) must name a concrete defensive guard.
    const bugAction =
        (await readMember(runDir, BRANCH_TO_MEMBER.bug)).match(ACTION_RE)?.[1] ?? "";
    if (!BUG_FIX_RE.test(bugAction.toLowerCase())) {
        fail(
            `bug branch (bob) ACTION does not name a defensive ` +
                `guard/throw/empty/null/undefined/check (ACTION: ${bugAction.trim()})`,
        );
    }

    console.log(
        `PASS: router fired ${branches.length} branches ` +
            `(core: ${selectedRequired.join(", ")}); each produced an ACTION plan; ` +
            `bug branch names a defensive fix.`,
    );
}

main();
