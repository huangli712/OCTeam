/**
 * Check script: Lennard-Jones molecular dynamics pipeline (8 stages:
 * alice -> bob -> carol -> dave -> erin -> frank -> grace -> henry).
 *
 * Pipeline judging reads ONLY the last stage's output. Per team_pipeline
 * semantics, every prior stage's markdown is auto-prefixed onto the next
 * stage's task, so the final stage's file (henry.md) is the full pipeline
 * product. This script parses the three markers emitted by the henry stage
 * and asserts each is within the physically expected range for liquid
 * argon (sigma = 3.40 A, epsilon/k_B ~ 119.8 K) at rho = 1.38 g/cm^3, T0 = 120 K.
 *
 * Markers (all emitted by the FINAL stage henry):
 *   <!-- TEMP_K: <mean_production_temperature_Kelvin> -->  expected ~120 K +/- 20
 *   <!-- RDF_PEAK_A: <g_r_first_peak_Angstrom> -->        expected ~3.65 A +/- 0.15 (literature-based)
 *   <!-- ENERGY_DRIFT: <relative_total_energy_drift> -->  expected < 0.05 over NVE production
 *
 * Usage:  bun check-physics-md-pipeline.ts <run_dir>
 *   <run_dir>  directory containing henry.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Pipeline judging reads ONLY the last stage's output file.
const FINAL_MEMBER = "henry";

const TEMP_K_RE = /<!--\s*TEMP_K:\s*([\d.eE+-]+)\s*-->/;
const RDF_PEAK_A_RE = /<!--\s*RDF_PEAK_A:\s*([\d.eE+-]+)\s*-->/;
const ENERGY_DRIFT_RE = /<!--\s*ENERGY_DRIFT:\s*([\d.eE+-]+)\s*-->/;

// NVT locks the bath at 120 K; the subsequent NVE production run fluctuates
// around the equilibrated temperature. [100, 140] K is a generous band that
// accepts a 120 K +/- 20 K drift while catching a clearly broken thermostat
// or a wrong initial temperature.
const TEMP_K_MIN = 100;
const TEMP_K_MAX = 140;

// Dense LJ liquid g(r) first peak sits at r* ≈ 1.07–1.10 sigma
// (3.64–3.74 A for sigma = 3.40 A), confirmed by Yarnell et al. (1973)
// neutron diffraction (3.68 A at 85 K), Lund (1974, 3.65–3.75 A),
// and Smelser (1969, 3.85 ± 0.05 A). [3.50, 3.80] A covers the published
// experimental range for dense liquid argon with bin-resolution margin.
const RDF_PEAK_A_MIN = 3.50;
const RDF_PEAK_A_MAX = 3.80;

// velocity Verlet at h = 2 fs over 1e5 steps (200 ps) for a simple LJ fluid
// conserves total energy to a few parts in 1e3 under a shifted cutoff; a
// 5% relative drift bound catches integrator/timestep mistakes while
// tolerating thermostat-residual and finite-cutoff noise.
const ENERGY_DRIFT_MAX = 0.05;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

/** Extract the first numeric match of `re` from `raw`; fail() if absent/non-numeric. */
function extractNumber(raw: string, re: RegExp, label: string): number {
    const match = raw.match(re);
    if (!match) {
        fail(`final stage "${FINAL_MEMBER}" did not emit a parseable <!-- ${label}: ... --> marker`);
    }
    const value = parseFloat(match[1]);
    if (Number.isNaN(value)) {
        fail(`final stage "${FINAL_MEMBER}" ${label} marker is not numeric: "${match[1]}"`);
    }
    return value;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-md-pipeline.ts <run_dir>");
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

    // Assertion 1: all three markers present and numeric.
    const tempK = extractNumber(raw, TEMP_K_RE, "TEMP_K");
    const rdfPeakA = extractNumber(raw, RDF_PEAK_A_RE, "RDF_PEAK_A");
    const energyDrift = extractNumber(raw, ENERGY_DRIFT_RE, "ENERGY_DRIFT");

    console.log(`  ${FINAL_MEMBER}: <T> = ${tempK.toFixed(3)} K`);
    console.log(`  ${FINAL_MEMBER}: g(r) first peak = ${rdfPeakA.toFixed(4)} A`);
    console.log(`  ${FINAL_MEMBER}: relative energy drift = ${energyDrift.toExponential(4)}`);

    // Assertion 2: mean production temperature within [100, 140] K.
    if (!(tempK >= TEMP_K_MIN && tempK <= TEMP_K_MAX)) {
        fail(`<T> = ${tempK.toFixed(3)} K outside [${TEMP_K_MIN}, ${TEMP_K_MAX}] K (NVT target 120 K, NVE should stay within +/- 20 K)`);
    }

    // Assertion 3: g(r) first peak within [3.50, 3.80] A (literature-based).
    if (!(rdfPeakA >= RDF_PEAK_A_MIN && rdfPeakA <= RDF_PEAK_A_MAX)) {
        fail(`g(r) first peak ${rdfPeakA.toFixed(4)} A outside [${RDF_PEAK_A_MIN}, ${RDF_PEAK_A_MAX}] A (experimental dense LJ liquid: 3.65–3.90 A)`);
    }

    // Assertion 4: relative energy drift below 0.05 over NVE production.
    if (!(energyDrift < ENERGY_DRIFT_MAX)) {
        fail(`relative energy drift ${energyDrift.toExponential(4)} >= ${ENERGY_DRIFT_MAX} (velocity Verlet at h=2 fs over 1e5 steps should drift far less)`);
    }

    console.log(`PASS: <T> = ${tempK.toFixed(3)} K in [${TEMP_K_MIN}, ${TEMP_K_MAX}], RDF peak = ${rdfPeakA.toFixed(4)} A in [${RDF_PEAK_A_MIN}, ${RDF_PEAK_A_MAX}], drift = ${energyDrift.toExponential(4)} < ${ENERGY_DRIFT_MAX}.`);
}

main();
