/**
 * Check script: lock-free MPSC queue four-class concurrency bug fix (team_loop, challenge).
 *
 * Verifies the loop's decider (grace) converged to "done" with allFixed=true
 * AND stressPass=true, AND cross-checks frank's 10^7-operation stress reported
 * STRESS_RESULT=pass with the expected op count.
 *
 * Usage:  bun check-coding-lockfree-queue.ts <run_dir>
 *   <run_dir>  directory containing grace.md (decider), alice/bob/carol/dave.md
 *              (coders), erin.md (property test), frank.md (stress test)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DECIDER = "grace";
const EXPECTED_STRESS_OPS = 10_000_000; // 10^7
const DECISION_RE = /<decision>([\s\S]*?)<\/decision>/g;
const STRESS_RESULT_RE = /<!--\s*STRESS_RESULT:\s*(pass|fail)\s*-->/;
const STRESS_OPS_RE = /<!--\s*STRESS_OPS:\s*(\d+)\s*-->/;
const FIX_APPLIED_RE = /<!--\s*FIX_APPLIED:\s*(.+?)\s*-->/g;
const PROP_TEST_RE = /<!--\s*PROP_TEST:\s*(pass|fail)\s*-->/;

interface Decision {
    decision: string;
    rationale?: string;
    nextActions?: unknown;
    allFixed?: boolean;
    stressPass?: boolean;
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
        console.error("Usage: bun check-coding-lockfree-queue.ts <run_dir>");
        process.exit(2);
    }

    const deciderRaw = await loadRaw(runDir, DECIDER);
    const frankRaw = await loadRaw(runDir, "frank");

    // Best-effort diagnostics from the four coders and the property tester.
    for (const m of ["alice", "bob", "carol", "dave"]) {
        const raw = await loadRaw(runDir, m);
        const fixes = [...raw.matchAll(FIX_APPLIED_RE)].map((x) => x[1].trim());
        if (fixes.length > 0) {
            console.log(`  ${m}:    FIX_APPLIED = ${fixes.join(", ")}`);
        }
    }
    const erinRaw = await loadRaw(runDir, "erin");
    const propMatch = erinRaw.match(PROP_TEST_RE);
    if (propMatch) {
        console.log(`  erin:   PROP_TEST = ${propMatch[1]}`);
    }

    // --- Cross-check frank's stress markers -----------------------------------
    const opsMatch = frankRaw.match(STRESS_OPS_RE);
    if (!opsMatch) {
        fail(`member "frank" did not emit a <!-- STRESS_OPS: <n> --> marker`);
    }
    const ops = parseInt(opsMatch[1], 10);
    if (!Number.isFinite(ops) || ops <= 0) {
        fail(`frank STRESS_OPS value is not a positive integer: ${opsMatch[1]}`);
    }
    console.log(`  frank:  STRESS_OPS = ${ops.toExponential(3)}`);
    if (ops < EXPECTED_STRESS_OPS) {
        fail(`frank STRESS_OPS = ${ops} < expected ${EXPECTED_STRESS_OPS} (10^7)`);
    }

    const resultMatch = frankRaw.match(STRESS_RESULT_RE);
    if (!resultMatch) {
        fail(`member "frank" did not emit a <!-- STRESS_RESULT: pass|fail --> marker`);
    }
    const stressResult = resultMatch[1];
    console.log(`  frank:  STRESS_RESULT = ${stressResult}`);

    // Assertion 1 (frank): the 10^7 stress must pass.
    if (stressResult !== "pass") {
        fail(`frank STRESS_RESULT = ${stressResult} (expected "pass"; 10^7 stress failed)`);
    }

    // --- Decider assertions ----------------------------------------------------
    const decision = extractFinalDecision(deciderRaw);

    // Assertion 2: the decider declared the loop "done".
    if (decision.decision !== "done") {
        fail(`decider.decision = ${JSON.stringify(decision.decision)} (expected "done"); rationale: ${decision.rationale ?? "<none>"}`);
    }

    // Assertion 3: all four distinct fixes were applied.
    if (typeof decision.allFixed !== "boolean") {
        fail(`decider decision is missing the boolean "allFixed" field (got ${JSON.stringify(decision.allFixed)})`);
    }
    if (decision.allFixed !== true) {
        fail(`decider.allFixed = false (the four distinct fixes were not all applied)`);
    }

    // Assertion 4: the decider acknowledges the stress passed.
    if (typeof decision.stressPass !== "boolean") {
        fail(`decider decision is missing the boolean "stressPass" field (got ${JSON.stringify(decision.stressPass)})`);
    }
    if (decision.stressPass !== true) {
        fail(`decider.stressPass = false (10^7 stress not deemed passed)`);
    }

    // Assertion 5 (cross-check): decider.stressPass must agree with frank's STRESS_RESULT.
    const deciderSaysPass = decision.stressPass === true;
    const frankSaysPass = stressResult === "pass";
    if (deciderSaysPass !== frankSaysPass) {
        fail(`decider.stressPass=${deciderSaysPass} contradicts frank STRESS_RESULT="${stressResult}"`);
    }

    console.log("PASS: decider \"done\" + allFixed=true + stressPass=true; frank 10^7 stress clean.");
}

main();
