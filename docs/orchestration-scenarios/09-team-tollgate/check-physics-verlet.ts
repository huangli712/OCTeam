/**
 * Check script: Velocity Verlet energy drift (implement + gate-verify).
 *
 * Verifies the producer's (coder.md) reported relative energy drift is below
 * the symplectic threshold (1e-3) and that the verifier (auditor.md) emitted a
 * PASS verdict.
 *
 * Usage:  bun check-physics-verlet.ts <run_dir>
 *   <run_dir>  directory containing coder.md and auditor.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Velocity Verlet is symplectic: over 1000 steps at h=0.01 on the harmonic
// oscillator, the relative energy drift stays well below 1e-3 (it oscillates
// in a bounded band rather than drifting systematically).
const DRIFT_TOLERANCE = 1e-3;

const DRIFT_RE = /<!--\s*DRIFT:\s*([\d.eE+-]+)\s*-->/;
const VERDICT_RE = /<!--\s*VERDICT:\s*(PASS|FAIL)\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-verlet.ts <run_dir>");
        process.exit(2);
    }

    // --- Load producer (coder.md) ---
    let coderRaw: string;
    try {
        coderRaw = await readFile(join(runDir, "coder.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading coder.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const driftMatch = coderRaw.match(DRIFT_RE);
    if (!driftMatch) {
        fail(`producer (coder.md) did not emit a <!-- DRIFT: ... --> marker`);
    }

    const drift = parseFloat(driftMatch[1]);

    // Assertion 1: drift is a finite number.
    if (!Number.isFinite(drift)) {
        fail(`producer DRIFT "${driftMatch[1]}" is not a finite number`);
    }

    console.log(`  producer reported drift = ${drift.toExponential(4)}`);

    // Assertion 2: drift below symplectic threshold.
    if (drift >= DRIFT_TOLERANCE) {
        fail(
            `drift ${drift.toExponential(3)} >= tolerance ${DRIFT_TOLERANCE.toExponential(0)} ` +
                `(symplectic conservation violated)`,
        );
    }

    // --- Load verifier (auditor.md) ---
    let auditorRaw: string;
    try {
        auditorRaw = await readFile(join(runDir, "auditor.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading auditor.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const verdictMatch = auditorRaw.match(VERDICT_RE);
    if (!verdictMatch) {
        fail(`verifier (auditor.md) did not emit a <!-- VERDICT: PASS|FAIL --> marker`);
    }

    // Assertion 3: verifier verdict is PASS.
    if (verdictMatch[1] !== "PASS") {
        fail(`verifier verdict is ${verdictMatch[1]}, expected PASS`);
    }

    console.log("PASS: drift within symplectic tolerance; verifier verdict = PASS.");
}

main();
