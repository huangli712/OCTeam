/**
 * Check script: small-angle pendulum pipeline (alice -> bob -> carol).
 *
 * Pipeline output is the FINAL stage's markdown (carol.md). This script
 * parses the max-deviation marker emitted by the carol stage and asserts
 * it is below 1e-4. Classical RK4 with h=0.001 over one period accumulates
 * O(h^4) local error per step; the global max deviation is well under 1e-4.
 *
 * Usage:  bun check-physics-pendulum.ts <run_dir>
 *   <run_dir>  directory containing carol.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FINAL_MEMBER = "carol";
const MAX_ERR_RE = /<!--\s*MAX_ERR:\s*([\d.eE+-]+)\s*-->/;

// RK4 (4th order) with h=0.001 over one period (~2.0 s => ~2000 steps):
// local truncation error per step ~ O(h^5) ~ 1e-15, global ~ N*h^4 ~ 2e-12.
// 1e-4 is a generous bound that still catches wrong-integrator or wrong-ODE
// mistakes while tolerating float accumulation in naive loops.
const MAX_ALLOWED = 1e-4;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-pendulum.ts <run_dir>");
        process.exit(2);
    }

    const path = join(runDir, `${FINAL_MEMBER}.md`);
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (err) {
        console.error(`IO error reading ${FINAL_MEMBER}.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: the final stage emitted a parseable MAX_ERR marker.
    const match = raw.match(MAX_ERR_RE);
    if (!match) {
        fail(`final stage "${FINAL_MEMBER}" did not emit a parseable <!-- MAX_ERR: ... --> marker`);
    }
    const maxErr = parseFloat(match[1]);
    if (Number.isNaN(maxErr)) {
        fail(`final stage "${FINAL_MEMBER}" MAX_ERR marker is not numeric: "${match[1]}"`);
    }

    console.log(`  ${FINAL_MEMBER}: reported max |theta_rk4 - theta_analytic| = ${maxErr.toExponential(4)}`);

    // Assertion 2: max deviation within tolerance.
    if (!(maxErr < MAX_ALLOWED)) {
        fail(`max deviation ${maxErr.toExponential(4)} >= tolerance ${MAX_ALLOWED.toExponential(0)} (RK4 at h=0.001 over one period should be far tighter)`);
    }

    console.log(`PASS: max deviation ${maxErr.toExponential(4)} < ${MAX_ALLOWED.toExponential(0)}.`);
}

main();
