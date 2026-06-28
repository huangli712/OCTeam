/**
 * Check script: Gaussian integral pipeline (simplify -> numerical -> error-bound).
 *
 * Pipeline output is the FINAL stage's markdown (error-bound.md). This script
 * parses the absolute-error marker emitted by the error-bound stage and asserts
 * it is below 1e-8. Gauss-Legendre quadrature with n=8 nodes is exact for
 * polynomials up to degree 15; e^(-x^2) on [0,1] is entire and its quadrature
 * error is far below 1e-8.
 *
 * Usage:  bun check-math-gaussian-integral.ts <run_dir>
 *   <run_dir>  directory containing error-bound.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FINAL_MEMBER = "error-bound";
const ERROR_RE = /<!--\s*ERROR:\s*([\d.eE+-]+)\s*-->/;

// Gauss-Legendre n=8 on [0,1] for e^(-x^2): error is ~1e-12 or smaller, so
// 1e-8 is a generous upper bound that still catches genuinely broken work
// (e.g. wrong node count, wrong interval mapping, arithmetic slips).
const MAX_ERROR = 1e-8;

// Closed-form reference value supplied to the error-bound stage.
const REFERENCE = 0.7468241328;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-gaussian-integral.ts <run_dir>");
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

    // Assertion 1: the final stage emitted a parseable ERROR marker.
    const match = raw.match(ERROR_RE);
    if (!match) {
        fail(`final stage "${FINAL_MEMBER}" did not emit a parseable <!-- ERROR: ... --> marker`);
    }
    const error = parseFloat(match[1]);
    if (Number.isNaN(error)) {
        fail(`final stage "${FINAL_MEMBER}" ERROR marker is not numeric: "${match[1]}"`);
    }

    console.log(`  ${FINAL_MEMBER}: reported absolute error = ${error.toExponential(4)}`);
    console.log(`  reference value (sqrt(pi)/2 * erf(1)) ~= ${REFERENCE}`);

    // Assertion 2: error within tolerance.
    if (!(error < MAX_ERROR)) {
        fail(`error ${error.toExponential(4)} >= tolerance ${MAX_ERROR.toExponential(0)} (Gauss-Legendre n=8 should be far tighter)`);
    }

    console.log(`PASS: absolute error ${error.toExponential(4)} < ${MAX_ERROR.toExponential(0)}.`);
}

main();
