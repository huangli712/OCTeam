/**
 * Check script: interval-merge off-by-one bug fix (team_loop).
 *
 * Verifies the loop's decider (reviewer) converged to "done" with allPass=true,
 * i.e. the coder's fix passes the hidden 5-case suite (including the touching
 * interval case that the original off-by-one mishandled).
 *
 * Usage:  bun check-coding-interval-merge.ts <run_dir>
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
    allPass?: boolean;
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
        console.error("Usage: bun check-coding-interval-merge.ts <run_dir>");
        process.exit(2);
    }

    const deciderRaw = await loadRaw(runDir, DECIDER);

    // Best-effort diagnostics from the stage members.
    const coderRaw = await loadRaw(runDir, "coder");
    const testerRaw = await loadRaw(runDir, "tester");
    const bugfixMatch = coderRaw.match(/<!--\s*BUGFIX:\s*(.+?)\s*-->/);
    const passCountMatch = testerRaw.match(/<!--\s*PASS_COUNT:\s*(\d+)\/5\s*-->/);
    if (bugfixMatch) {
        console.log(`  coder:    bugfix = ${bugfixMatch[1].trim()}`);
    }
    if (passCountMatch) {
        console.log(`  tester:   ${passCountMatch[1]}/5 cases pass`);
    }

    const decision = extractFinalDecision(deciderRaw);

    // Assertion 1: the decider declared the loop "done".
    if (decision.decision !== "done") {
        fail(`decider.decision = ${JSON.stringify(decision.decision)} (expected "done"); rationale: ${decision.rationale ?? "<none>"}`);
    }

    // Assertion 2: the mode-specific boolean is present and true.
    if (typeof decision.allPass !== "boolean") {
        fail(`decider decision is missing the boolean "allPass" field (got ${JSON.stringify(decision.allPass)})`);
    }
    if (decision.allPass !== true) {
        fail(`decider.allPass = false (interval-merge suite did not fully pass)`);
    }

    console.log("PASS: decider converged to \"done\" with allPass=true.");
}

main();
