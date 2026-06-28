/**
 * Check script: spring-mass energy drift debug (team_loop).
 *
 * Verifies the loop's decider (carol) converged to "done" with
 * driftAcceptable=true, AND cross-checks the bob's measured post-fix
 * energy drift is below the 1e-3 symplectic threshold.
 *
 * Usage:  bun check-physics-spring-energy.ts <run_dir>
 *   <run_dir>  directory containing carol.md (decider), alice.md, bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DECIDER = "carol";
const DRIFT_THRESHOLD = 1e-3; // Velocity Verlet on h=0.05, 1000 steps must stay well under this
const DECISION_RE = /<decision>([\s\S]*?)<\/decision>/g;
const DRIFT_AFTER_RE = /<!--\s*DRIFT_AFTER:\s*([\d.eE+-]+)\s*-->/;
const DRIFT_BEFORE_RE = /<!--\s*DRIFT_BEFORE:\s*([\d.eE+-]+)\s*-->/;

interface Decision {
    decision: string;
    rationale?: string;
    nextActions?: unknown;
    driftAcceptable?: boolean;
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

function parseNonNegative(raw: string, re: RegExp, label: string, member: string): number {
    const m = raw.match(re);
    if (!m) {
        fail(`member "${member}" did not emit a ${label} marker`);
    }
    const v = parseFloat(m[1]);
    if (Number.isNaN(v) || v < 0) {
        fail(`member "${member}" ${label} value is not a non-negative number: ${m[1]}`);
    }
    return v;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-spring-energy.ts <run_dir>");
        process.exit(2);
    }

    const deciderRaw = await loadRaw(runDir, DECIDER);
    const analystRaw = await loadRaw(runDir, "bob");

    // Best-effort: surface the alice's integrator choice.
    const simulatorRaw = await loadRaw(runDir, "alice");
    const integratorMatch = simulatorRaw.match(/<!--\s*INTEGRATOR:\s*(.+?)\s*-->/);
    if (integratorMatch) {
        console.log(`  alice: integrator = ${integratorMatch[1].trim()}`);
    }

    // Cross-check the bob's measured drifts.
    const driftBefore = parseNonNegative(analystRaw, DRIFT_BEFORE_RE, "<!-- DRIFT_BEFORE: ... -->", "bob");
    const driftAfter = parseNonNegative(analystRaw, DRIFT_AFTER_RE, "<!-- DRIFT_AFTER: ... -->", "bob");
    console.log(`  bob:  drift_before = ${driftBefore.toExponential(4)}, drift_after = ${driftAfter.toExponential(4)}`);

    // Assertion 1 (bob): the fix actually reduced drift (sanity).
    if (driftAfter >= driftBefore) {
        fail(`bob drift_after ${driftAfter.toExponential(3)} >= drift_before ${driftBefore.toExponential(3)} (fix did not reduce drift)`);
    }

    // Assertion 2 (bob): post-fix drift is below the symplectic threshold.
    if (driftAfter >= DRIFT_THRESHOLD) {
        fail(`bob drift_after ${driftAfter.toExponential(3)} >= threshold ${DRIFT_THRESHOLD.toExponential(0)} (Velocity Verlet must stay symplectic)`);
    }

    // Assertions 3-4 (decider): converged to "done" with driftAcceptable=true.
    const decision = extractFinalDecision(deciderRaw);
    if (decision.decision !== "done") {
        fail(`decider.decision = ${JSON.stringify(decision.decision)} (expected "done"); rationale: ${decision.rationale ?? "<none>"}`);
    }
    if (typeof decision.driftAcceptable !== "boolean") {
        fail(`decider decision is missing the boolean "driftAcceptable" field (got ${JSON.stringify(decision.driftAcceptable)})`);
    }
    if (decision.driftAcceptable !== true) {
        fail(`decider.driftAcceptable = false (energy drift not deemed acceptable)`);
    }

    console.log("PASS: decider \"done\" + driftAcceptable=true; bob DRIFT_AFTER below 1e-3.");
}

main();
