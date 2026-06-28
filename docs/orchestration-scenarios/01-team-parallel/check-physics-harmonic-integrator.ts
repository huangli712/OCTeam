/**
 * Check script: harmonic oscillator integrator energy drift (3 methods).
 *
 * Verifies each simulator member reported a relative energy drift and that
 * symplectic (Verlet) / high-order (RK4) integrators drift less than
 * explicit Euler, as theory predicts.
 *
 * Usage:  bun check-physics-harmonic-integrator.ts <run_dir>
 *   <run_dir>  directory containing euler.md, verlet.md, rk4.md
 *
 * Exit codes:  0 PASS  |  1 FAIL  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MEMBERS = ["euler", "verlet", "rk4"] as const;
const DRIFT_RE = /<!--\s*ENERGY_DRIFT:\s*([\d.eE+-]+)\s*-->/;

// Explicit Euler on a harmonic oscillator with h=0.01, 1000 steps: energy
// grows ~1e-3 per step amplitude factor, so total drift is comfortably > 1e-3.
const EULER_MIN_DRIFT = 1e-3;

interface Drift {
    member: string;
    value: number | null;
}

async function loadDrift(runDir: string, member: string): Promise<Drift> {
    const path = join(runDir, `${member}.md`);
    const raw = await readFile(path, "utf8");
    const match = raw.match(DRIFT_RE);
    const value = match ? parseFloat(match[1]) : null;
    return { member, value };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-harmonic-integrator.ts <run_dir>");
        process.exit(2);
    }

    const drifts: Drift[] = [];
    try {
        for (const m of MEMBERS) {
            drifts.push(await loadDrift(runDir, m));
        }
    } catch (err) {
        console.error(`IO error reading member output: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: every member produced a parseable drift.
    for (const d of drifts) {
        if (d.value === null || Number.isNaN(d.value)) {
            fail(`member "${d.member}" did not emit a parseable <!-- ENERGY_DRIFT: ... --> marker`);
        }
        console.log(`  ${d.member}: drift = ${d.value!.toExponential(4)}`);
    }

    const byMember = new Map(drifts.map(d => [d.member, d.value!]));
    const euler = byMember.get("euler")!;
    const verlet = byMember.get("verlet")!;
    const rk4 = byMember.get("rk4")!;

    // Assertion 2: explicit Euler shows visible drift.
    if (euler < EULER_MIN_DRIFT) {
        fail(`euler drift ${euler.toExponential(3)} < expected minimum ${EULER_MIN_DRIFT.toExponential(0)} (would not demonstrate the pathology)`);
    }

    // Assertion 3: symplectic Verlet drifts less than Euler.
    if (verlet >= euler) {
        fail(`verlet drift ${verlet.toExponential(3)} >= euler drift ${euler.toExponential(3)} (symplectic advantage violated)`);
    }

    // Assertion 4: RK4 (higher order) drifts less than Euler.
    if (rk4 >= euler) {
        fail(`rk4 drift ${rk4.toExponential(3)} >= euler drift ${euler.toExponential(3)} (higher-order advantage violated)`);
    }

    console.log("PASS: euler shows drift; verlet & rk4 both beat euler.");
}

main();
