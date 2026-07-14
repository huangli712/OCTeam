/**
 * Check script: spring-mass velocity Verlet energy drift with HITL tollgate.
 *
 * The producer (alice) implements Velocity Verlet for the spring-mass system
 * (k=1, m=1, x0=1, v0=0) and runs 1000 steps at h=0.05, reporting the
 * relative energy drift. The verifier (bob) checks the drift against the
 * symplectic conservation bound (< 1e-3). Human approval pauses at the
 * verification gate before the verdict is applied.
 *
 * This script reads the producer's (alice.md) reported drift and verifies
 * it is below the symplectic threshold.
 *
 * Usage:  bun check-physics-spring-tollgate.ts <run_dir>
 *   <run_dir>  directory containing alice.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DRIFT_TOLERANCE = 1e-3;
const DRIFT_RE = /<!--\s*DRIFT:\s*([\d.eE+-]+)\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-spring-tollgate.ts <run_dir>");
        process.exit(2);
    }

    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const driftMatch = aliceRaw.match(DRIFT_RE);
    if (!driftMatch) {
        fail('producer (alice.md) did not emit a <!-- DRIFT: ... --> marker');
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

    console.log("PASS: drift within symplectic tolerance (Velocity Verlet conserved energy).");
}

main();
