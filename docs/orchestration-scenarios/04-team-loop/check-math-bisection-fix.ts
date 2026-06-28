/**
 * Check script: bisection root-finding edge-case bug fix (team_loop).
 *
 * The loop's decider (reviewer) reads the coder's fix and the tester's edge-case
 * report, then emits a <decision> block each round. This script parses the
 * decider's FINAL decision and verifies the loop converged with all tests
 * passing.
 *
 * Usage:  bun check-math-bisection-fix.ts <run_dir>
 *   <run_dir>  directory containing reviewer.md (decider), coder.md, tester.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DECIDER = "reviewer";
const DECISION_RE = /<decision>([\s\S]*?)<\/decision>/g;

interface Decision {
    decision: string;
    rationale?: string;
    nextActions?: unknown;
    testsPass?: boolean;
    [k: string]: unknown;
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function loadRaw(runDir: string, member: string): Promise<string> {
    const path = join(runDir, `${member}.md`);
    try {
        return await readFile(path, "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }
}

/** Extract the LAST <decision>{...}</decision> JSON body (decider's final round). */
function extractFinalDecision(raw: string): Decision {
    const matches = [...raw.matchAll(DECISION_RE)];
    if (matches.length === 0) {
        fail(`decider "${DECIDER}" emitted no <decision>{...}</decision> block`);
    }
    const lastBody = matches[matches.length - 1][1].trim();
    let parsed: Decision;
    try {
        parsed = JSON.parse(lastBody) as Decision;
    } catch (err) {
        fail(`decider's final <decision> body is not valid JSON: ${(err as Error).message}\nbody: ${lastBody.slice(0, 200)}`);
    }
    return parsed;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-bisection-fix.ts <run_dir>");
        process.exit(2);
    }

    const deciderRaw = await loadRaw(runDir, DECIDER);

    // Best-effort diagnostic: surface the coder/tester markers if present.
    const coderRaw = await loadRaw(runDir, "coder");
    const testerRaw = await loadRaw(runDir, "tester");
    const fixesMatch = coderRaw.match(/<!--\s*FIXES:\s*(\d+)\s*-->/);
    const failingMatch = testerRaw.match(/<!--\s*FAILING:\s*(\d+)\s*-->/);
    if (fixesMatch) {
        console.log(`  coder:    reported ${fixesMatch[1]} fix(es)`);
    }
    if (failingMatch) {
        console.log(`  tester:   reported ${failingMatch[1]} failing case(s)`);
    }

    const decision = extractFinalDecision(deciderRaw);

    // Assertion 1: the decider declared the loop "done".
    if (decision.decision !== "done") {
        fail(`decider.decision = ${JSON.stringify(decision.decision)} (expected "done"); rationale: ${decision.rationale ?? "<none>"}`);
    }

    // Assertion 2: the mode-specific boolean is present and true.
    if (typeof decision.testsPass !== "boolean") {
        fail(`decider decision is missing the boolean "testsPass" field (got ${JSON.stringify(decision.testsPass)})`);
    }
    if (decision.testsPass !== true) {
        fail(`decider.testsPass = false (bisection edge-case suite did not fully pass)`);
    }

    console.log("PASS: decider converged to \"done\" with testsPass=true.");
}

main();
