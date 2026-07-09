/**
 * Check script: Monte Carlo pi estimation (3 methods).
 *
 * Verifies each mathematician member produced a pi estimate within tolerance
 * and that stratified sampling is at least as accurate as naive MC.
 *
 * Usage:  bun check-math-montecarlo-pi.ts <run_dir>
 *   <run_dir>  directory containing the per-member markdown outputs
 *              (expects alice.md, bob.md, carol.md)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PI = Math.PI;
const ABS_TOLERANCE = 0.05; // 1e6 samples: all three methods should be within 0.05

const MEMBERS = ["alice", "bob", "carol"] as const;
const PI_EST_RE = /<!--\s*PI_EST:\s*([\d.]+)\s*-->/;

interface Estimate {
    member: string;
    raw: string;
    value: number | null;
}

async function loadEstimate(runDir: string, member: string): Promise<Estimate> {
    const path = join(runDir, `${member}.md`);
    const raw = await readFile(path, "utf8");
    const match = raw.match(PI_EST_RE);
    const value = match ? parseFloat(match[1]) : null;
    return { member, raw, value };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-montecarlo-pi.ts <run_dir>");
        process.exit(2);
    }

    const estimates: Estimate[] = [];
    try {
        for (const m of MEMBERS) {
            estimates.push(await loadEstimate(runDir, m));
        }
    } catch (err) {
        console.error(`IO error reading member output: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: every member produced a parseable estimate.
    for (const e of estimates) {
        if (e.value === null || Number.isNaN(e.value)) {
            fail(`member "${e.member}" did not emit a parseable <!-- PI_EST: ... --> marker`);
        }
        console.log(`  ${e.member}: pi_est = ${e.value!.toFixed(6)}  (err = ${Math.abs(e.value! - PI).toFixed(6)})`);
    }

    // Assertion 2: each estimate within absolute tolerance.
    for (const e of estimates) {
        const err = Math.abs(e.value! - PI);
        if (err >= ABS_TOLERANCE) {
            fail(`${e.member} error ${err.toExponential(3)} >= tolerance ${ABS_TOLERANCE}`);
        }
    }

    // Assertion 3: bob (stratified sampling) is at least as accurate as alice (naive MC).
    const byMember = new Map(estimates.map(e => [e.member, e.value!]));
    const naiveErr = Math.abs(byMember.get("alice")! - PI);
    const stratErr = Math.abs(byMember.get("bob")! - PI);
    if (stratErr > naiveErr) {
        fail(`stratified error ${stratErr.toExponential(3)} > naive error ${naiveErr.toExponential(3)} (variance reduction violated)`);
    }

    console.log("PASS: all three methods within tolerance; stratified <= naive.");
}

main();
