/**
 * Check script: projectile motion RK4 workflow (Scenario 3).
 *
 * Validates the task-gate chain in a team_workflow run:
 *   - alice.md: extracts <!-- ENERGY: <drift> --> and <!-- DRAG: <term_vel> --> markers
 *   - bob.md: extracts two <verdict> gate decisions, verifies both are PASS
 *   - Physics checks: energy drift < 1e-3; terminal velocity ≈ sqrt(mg/k) ≈ 9.9 m/s
 *
 * Usage:  bun check-physics-projectile.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ENERGY_RE = /<!--\s*ENERGY:\s*([\d.eE+-]+)\s*-->/;
const DRAG_RE = /<!--\s*DRAG:\s*([\d.eE+-]+)\s*-->/;
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

interface Verdict {
    result: string;
    rationale: string;
    diff: string;
}

function parseVerdicts(raw: string): Verdict[] {
    const verdicts: Verdict[] = [];
    let m: RegExpExecArray | null;
    while ((m = VERDICT_RE.exec(raw)) !== null) {
        try {
            const obj = JSON.parse(m[1]) as Record<string, string>;
            const result = (obj.result ?? "").trim().toUpperCase();
            if (!result) fail("verdict JSON lacks a non-empty 'result' field");
            verdicts.push({
                result,
                rationale: (obj.rationale ?? "").trim(),
                diff: (obj.diff ?? "").trim(),
            });
        } catch {
            fail(`verdict block is not valid JSON: ${m[1].substring(0, 200)}`);
        }
    }
    return verdicts;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-projectile.ts <run_dir>");
        process.exit(2);
    }

    // --- Load alice.md ---
    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // --- Load bob.md ---
    let bobRaw: string;
    try {
        bobRaw = await readFile(join(runDir, "bob.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading bob.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: energy drift marker present and valid.
    const energyMatch = aliceRaw.match(ENERGY_RE);
    if (!energyMatch) fail("alice.md does not contain <!-- ENERGY: <drift> --> marker (step 1)");
    const drift = parseFloat(energyMatch[1]);
    if (!Number.isFinite(drift)) fail(`energy drift is not a finite number: ${energyMatch[1]}`);
    if (drift < 0) fail(`energy drift is negative (${drift}), should be >= 0`);

    // Assertion 2: energy drift < 1e-3 (RK4 on short integration should conserve energy well).
    if (drift >= 1e-3) fail(`energy drift ${drift} >= 1e-3 (RK4 should conserve energy better on this short integration)`);
    console.log(`  drift = ${drift.toExponential(3)} < 1e-3 ✓`);

    // Assertion 3: drag terminal velocity marker present and valid.
    const dragMatch = aliceRaw.match(DRAG_RE);
    if (!dragMatch) fail("alice.md does not contain <!-- DRAG: <term_vel> --> marker (step 3)");
    const termVel = parseFloat(dragMatch[1]);
    if (!Number.isFinite(termVel)) fail(`terminal velocity is not a finite number: ${dragMatch[1]}`);
    if (termVel <= 0) fail(`terminal velocity is ${termVel}, must be > 0`);

    // Assertion 4: terminal velocity ≈ sqrt(mg/k) = sqrt(9.81/0.1) ≈ 9.9 m/s (within 20%).
    const expectedTermVel = Math.sqrt(9.81 / 0.1); // ≈ 9.9045
    const relErr = Math.abs(termVel - expectedTermVel) / expectedTermVel;
    if (relErr >= 0.2) {
        fail(`terminal velocity ${termVel} is ${(relErr * 100).toFixed(1)}% off expected ${expectedTermVel.toFixed(2)} (must be within 20%)`);
    }
    console.log(`  terminal velocity = ${termVel.toFixed(2)} m/s (expected ≈ ${expectedTermVel.toFixed(2)}, error=${(relErr * 100).toFixed(1)}%) ✓`);

    // Assertion 5: bob emitted at least 2 verdicts (step 2 + step 4).
    const verdicts = parseVerdicts(bobRaw);
    if (verdicts.length < 2) {
        fail(`bob.md has only ${verdicts.length} verdict(s), expected at least 2`);
    }

    // Assertion 6: at least 2 PASS verdicts (one per gate's final state).
    // When on_fail:"retry" fires, intermediate FAIL verdicts accumulate in bob.md;
    // workflow_complete guarantees each gate's LAST verdict is PASS.
    const passCount = verdicts.filter((v) => v.result === "PASS").length;
    if (passCount < 2) {
        fail(`only ${passCount} PASS verdict(s), expected at least 2 (one per gate's final state); got ${verdicts.length} total verdicts`);
    }
    console.log(`  bob: ${passCount}/${verdicts.length} verdicts are PASS (>=2 required)`);

    console.log(`PASS: energy drift=${drift.toExponential(3)} < 1e-3; terminal velocity=${termVel.toFixed(2)} ≈ expected; bob has ${passCount} PASS verdicts (${verdicts.length} total).`);
}

main();
