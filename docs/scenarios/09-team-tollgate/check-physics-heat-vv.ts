/**
 * Check script: 2D heat-equation solver V&V certification (3-gate tollgate).
 *
 * Verifies the three independent V&V dimensions of the FTCS solver:
 *   G1 (correctness)   producer alice   -> max-error < 1e-3  verifier bob
 *   G2 (convergence)   producer carol   -> order     >= 2    verifier dave
 *   G3 (conservation)  producer erin    -> drift     < 1e-4  verifier frank
 *
 * Cross-checks the producer's reported numeric against the threshold AND
 * confirms every gate verifier emitted PASS — i.e. all three tollgates
 * let the solver through to release.
 *
 * Usage:  bun check-physics-heat-vv.ts <run_dir>
 *   <run_dir>  directory containing {alice,bob,carol,dave,erin,frank}.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// V&V thresholds (match the gate criteria in the README).
const G1_MAX_ERROR = 1e-3; // manufactured-solution correctness
const G2_MIN_ORDER = 2; // centered-space: 2nd-order spatial convergence
const G3_MAX_DRIFT = 1e-4; // total-heat conservation under Neumann BC

// Generic markers: GATE<n>_RESULT (producer) and VERDICT<n> (verifier).
function gateResultRe(n: number): RegExp {
    return new RegExp(`<!--\\s*GATE${n}_RESULT:\\s*([\\d.eE+-]+)\\s*-->`);
}
// The verifier emits a tagged-JSON verdict block (aligned with the
// orchestration's parseVerdict convention) rather than numbered HTML comments:
//   <verdict>{"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."}</verdict>
// Each verifier's .md contains exactly one such block (one per gate).
const VERDICT_TAG_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/;

function parseVerdict(raw: string): { result: string; rationale: string; diff: string } {
    const m = raw.match(VERDICT_TAG_RE);
    if (!m) fail("verifier did not emit a <verdict>{...}</verdict> decision block");
    let obj: { result?: string; rationale?: string; diff?: string };
    try {
        obj = JSON.parse(m![1]) as { result?: string; rationale?: string; diff?: string };
    } catch {
        fail(`verifier <verdict> block is not valid JSON: ${m![1]}`);
    }
    const result = (obj!.result ?? "").trim().toUpperCase();
    if (!result) fail('verifier <verdict> JSON lacks a non-empty "result" field');
    return { result, rationale: (obj!.rationale ?? "").trim(), diff: (obj!.diff ?? "").trim() };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function loadMember(runDir: string, member: string): Promise<string> {
    try {
        return await readFile(join(runDir, `${member}.md`), "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }
}

function extractNumber(raw: string, re: RegExp, label: string): number {
    const m = raw.match(re);
    if (!m) {
        fail(`${label}: did not emit a ${re.source} marker`);
    }
    const val = parseFloat(m[1]);
    if (!Number.isFinite(val)) {
        fail(`${label}: value "${m[1]}" is not a finite number`);
    }
    return val;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-heat-vv.ts <run_dir>");
        process.exit(2);
    }

    // --- Load all 6 member outputs ---
    const alice = await loadMember(runDir, "alice");
    const bob = await loadMember(runDir, "bob");
    const carol = await loadMember(runDir, "carol");
    const dave = await loadMember(runDir, "dave");
    const erin = await loadMember(runDir, "erin");
    const frank = await loadMember(runDir, "frank");

    // --- G1: correctness (manufactured-solution max-error) ---
    const g1Error = extractNumber(alice, gateResultRe(1), "G1 producer (alice)");
    const g1Verdict = parseVerdict(bob).result;
    console.log(
        `  G1 max-error = ${g1Error.toExponential(4)} ` +
            `(threshold < ${G1_MAX_ERROR.toExponential(0)}); verdict = ${g1Verdict}`,
    );
    if (g1Error >= G1_MAX_ERROR) {
        fail(
            `G1 max-error ${g1Error.toExponential(3)} >= ${G1_MAX_ERROR.toExponential(0)} ` +
                `(correctness gate failed)`,
        );
    }
    if (g1Verdict !== "PASS") {
        fail(`G1 verdict is ${g1Verdict}, expected PASS`);
    }

    // --- G2: grid-convergence order ---
    const g2Order = extractNumber(carol, gateResultRe(2), "G2 producer (carol)");
    const g2Verdict = parseVerdict(dave).result;
    console.log(
        `  G2 order     = ${g2Order.toFixed(4)} ` +
            `(threshold >= ${G2_MIN_ORDER}); verdict = ${g2Verdict}`,
    );
    if (g2Order < G2_MIN_ORDER) {
        fail(`G2 convergence order ${g2Order.toFixed(3)} < ${G2_MIN_ORDER} (not 2nd-order)`);
    }
    if (g2Verdict !== "PASS") {
        fail(`G2 verdict is ${g2Verdict}, expected PASS`);
    }

    // --- G3: heat conservation drift ---
    const g3Drift = extractNumber(erin, gateResultRe(3), "G3 producer (erin)");
    const g3Verdict = parseVerdict(frank).result;
    console.log(
        `  G3 drift     = ${g3Drift.toExponential(4)} ` +
            `(threshold < ${G3_MAX_DRIFT.toExponential(0)}); verdict = ${g3Verdict}`,
    );
    if (g3Drift >= G3_MAX_DRIFT) {
        fail(
            `G3 heat drift ${g3Drift.toExponential(3)} >= ${G3_MAX_DRIFT.toExponential(0)} ` +
                `(conservation violated)`,
        );
    }
    if (g3Verdict !== "PASS") {
        fail(`G3 verdict is ${g3Verdict}, expected PASS`);
    }

    console.log(
        "PASS: all 3 gates verified (correctness, convergence, conservation); " +
            "solver cleared for release.",
    );
}

main();
