/**
 * Check script: Leibniz pi estimation with golden reference comparison.
 *
 * Verifies the producer's (alice.md) Leibniz-series pi estimate is within 0.05
 * of the golden reference (3.14159265358979) and that the verifier (bob.md)
 * emitted a PASS verdict — i.e. the reference-backed gate let it through.
 *
 * Demonstrates the `reference` field for Compare-style numerical verdicts,
 * where the golden value is appended to the verifier's prompt so it can
 * compute |estimate - reference| without the value being hard-coded in criteria.
 *
 * Usage:  bun check-math-pi-reference.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PI_REF = 3.14159265358979;
const PI_TOLERANCE = 0.05;

const PI_EST_RE = /<!--\s*PI_EST:\s*([\d.eE+-]+)\s*-->/;
// The verifier emits a tagged-JSON verdict block (aligned with the
// orchestration's parseVerdict convention) rather than HTML comments, so the
// orchestration layer can also parse the gate result:
//   <verdict>{"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."}</verdict>
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

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-pi-reference.ts <run_dir>");
        process.exit(2);
    }

    // --- Load producer (alice.md) ---
    let aliceRaw: string;
    try {
        aliceRaw = await readFile(join(runDir, "alice.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading alice.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const estMatch = aliceRaw.match(PI_EST_RE);
    if (!estMatch) {
        fail(`producer (alice.md) did not emit a <!-- PI_EST: ... --> marker`);
    }

    const piEst = parseFloat(estMatch[1]);

    // Assertion 1: pi estimate is a finite number.
    if (!Number.isFinite(piEst)) {
        fail(`producer PI_EST "${estMatch[1]}" is not a finite number`);
    }

    console.log(`  producer pi estimate = ${piEst}`);

    // Assertion 2: estimate within tolerance of golden reference.
    const diff = Math.abs(piEst - PI_REF);
    if (diff >= PI_TOLERANCE) {
        fail(
            `|pi_est - pi_ref| = ${diff.toExponential(3)} >= tolerance ${PI_TOLERANCE} ` +
                `(estimate: ${piEst.toFixed(12)}, reference: ${PI_REF})`,
        );
    }
    console.log(`  |pi_est - pi_ref| = ${diff.toExponential(4)} (ok, within ${PI_TOLERANCE})`);

    // --- Load verifier (bob.md) ---
    let bobRaw: string;
    try {
        bobRaw = await readFile(join(runDir, "bob.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading bob.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const { result: verdict } = parseVerdict(bobRaw);

    // Assertion 3: verifier verdict is PASS (reference comparison passed).
    if (verdict !== "PASS") {
        fail(`verifier verdict is ${verdict}, expected PASS`);
    }

    console.log("PASS: pi estimate within reference tolerance; verifier verdict = PASS.");
}

main();
