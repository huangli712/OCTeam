/**
 * Check script: Classic ODE simulation suite (3 independent tasks).
 *
 * Delegate mode: any of the 3 simulator members may claim any task, so we
 * scan every <run_dir>/*.md for the three distinct markers. Each marker has
 * its own acceptance criterion (numeric range or fixed value).
 *
 *   Lotka-Volterra  -> <!-- PREY_X20: <value> -->     range [3.5, 5.5]
 *   Van der Pol     -> <!-- AMPLITUDE: <value> -->    range [1.8, 2.2]
 *   Damped osc      -> <!-- UNDERDAMPED: yes -->
 *
 * Usage:  bun check-physics-ode-suite.ts <run_dir>
 *   <run_dir>  directory containing <member>.md outputs from all claimers
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const PREY_RE = /<!--\s*PREY_X20:\s*([\d.eE+-]+)\s*-->/;
const AMP_RE = /<!--\s*AMPLITUDE:\s*([\d.eE+-]+)\s*-->/;
const UNDERDAMPED_RE = /<!--\s*UNDERDAMPED:\s*(\w+)\s*-->/;

const PREY_RANGE: [number, number] = [3.5, 5.5];
const AMP_RANGE: [number, number] = [1.8, 2.2];

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function readAll(runDir: string): Promise<string> {
    const files = (await readdir(runDir)).filter((f) => f.endsWith(".md"));
    const parts: string[] = [];
    for (const f of files) {
        parts.push(await readFile(join(runDir, f), "utf8"));
    }
    return parts.join("\n");
}

function extractNumeric(blob: string, re: RegExp, label: string): number {
    const m = blob.match(re);
    if (!m) {
        fail(`marker <!-- ${label}: ... --> not found in any member output`);
    }
    const val = parseFloat(m[1]);
    if (Number.isNaN(val)) {
        fail(`marker ${label} value "${m[1]}" is not numeric`);
    }
    return val;
}

function inRange(val: number, range: [number, number], label: string): void {
    if (val < range[0] || val > range[1]) {
        fail(`${label} = ${val} outside expected range [${range[0]}, ${range[1]}]`);
    }
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-ode-suite.ts <run_dir>");
        process.exit(2);
    }

    let blob: string;
    try {
        blob = await readAll(runDir);
    } catch (err) {
        console.error(`IO error: ${(err as Error).message}`);
        process.exit(2);
    }
    if (blob.trim().length === 0) {
        fail(`no .md member outputs found in ${runDir}`);
    }

    // Lotka-Volterra: prey x(20) in [3.5, 5.5].
    const prey = extractNumeric(blob, PREY_RE, "PREY_X20");
    inRange(prey, PREY_RANGE, "Lotka-Volterra prey x(20)");
    console.log(`  LV prey x(20) = ${prey.toFixed(4)}  (range [${PREY_RANGE[0]}, ${PREY_RANGE[1]}])`);

    // Van der Pol: limit-cycle amplitude in [1.8, 2.2].
    const amp = extractNumeric(blob, AMP_RE, "AMPLITUDE");
    inRange(amp, AMP_RANGE, "Van der Pol limit-cycle amplitude");
    console.log(`  VdP amplitude = ${amp.toFixed(4)}  (range [${AMP_RANGE[0]}, ${AMP_RANGE[1]}])`);

    // Damped oscillator: must be underdamped.
    const udMatch = blob.match(UNDERDAMPED_RE);
    if (!udMatch) {
        fail("marker <!-- UNDERDAMPED: ... --> not found in any member output");
    }
    if (udMatch[1].toLowerCase() !== "yes") {
        fail(`UNDERDAMPED = "${udMatch[1]}" expected "yes"`);
    }
    console.log("  Damped oscillator: underdamped = yes");

    console.log("PASS: all three ODE results within expected bounds.");
}

main();
