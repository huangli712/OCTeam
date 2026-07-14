/**
 * Check script: Velocity Verlet energy conservation with INVALID escalation.
 *
 * Verifies the producer's (alice.md) Velocity Verlet energy drift is below
 * the symplectic threshold (1e-3) and that the FINAL verifier verdict (from
 * bob.md or carol.md, after any INVALID->escalate->re-verify cycles) is PASS.
 *
 * The tollgate's escalate_to: "carol" dispatches carol to fix the verifier
 * side on INVALID verdicts; max_invalid_cycles: 2 caps the ping-pong.
 * The producer is NEVER penalized for INVALID — only the verifier side is
 * repaired. This check reads the LAST verdict across both bob.md and carol.md,
 * since carol (escalation handler) is chronologically later if dispatched.
 *
 * Usage:  bun check-physics-energy-escalate.ts <run_dir>
 *   <run_dir>  directory containing alice.md, bob.md, and possibly carol.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Velocity Verlet is symplectic: over 1000 steps at h=0.01 on the harmonic
// oscillator, the relative energy drift stays well below 1e-3 (it oscillates
// in a bounded band rather than drifting systematically).
const DRIFT_TOLERANCE = 1e-3;

const DRIFT_RE = /<!--\s*DRIFT:\s*([\d.eE+-]+)\s*-->/;
// Global regex so we can grab the LAST verdict (after escalation cycles).
// The verifier emits a tagged-JSON verdict block:
//   <verdict>{"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."}</verdict>
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;

function parseLastVerdict(raw: string): { result: string; rationale: string } {
    const matches = [...raw.matchAll(VERDICT_RE)];
    if (matches.length === 0) fail("no <verdict> tag found in verifier output");
    const last = matches[matches.length - 1];
    let obj: { result?: string; rationale?: string };
    try {
        obj = JSON.parse(last[1]) as { result?: string; rationale?: string };
    } catch {
        fail(`final <verdict> block is not valid JSON: ${last[1]}`);
    }
    const result = (obj!.result ?? "").trim().toUpperCase();
    if (!result) fail('final <verdict> JSON lacks a non-empty "result" field');
    return { result, rationale: (obj!.rationale ?? "").trim() };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-energy-escalate.ts <run_dir>");
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

    const driftMatch = aliceRaw.match(DRIFT_RE);
    if (!driftMatch) {
        fail(`producer (alice.md) did not emit a <!-- DRIFT: ... --> marker`);
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

    // --- Load verifier outputs (bob.md and possibly carol.md) ---
    // The FINAL verdict: carol.md (escalation handler) is chronologically
    // later if she was dispatched after an INVALID from bob. If carol.md
    // exists and contains verdicts, use it; otherwise fall back to bob.md.
    let bobRaw: string | null = null;
    let carolRaw: string | null = null;

    try {
        bobRaw = await readFile(join(runDir, "bob.md"), "utf8");
    } catch {
        // ok — bob might not have saved if the run terminated early
    }

    try {
        carolRaw = await readFile(join(runDir, "carol.md"), "utf8");
    } catch {
        // ok — carol may not have been dispatched (no INVALID occurred)
    }

    const verdictRaw = carolRaw ?? bobRaw;
    if (!verdictRaw) {
        fail("neither bob.md nor carol.md found; no verifier output to check");
    }

    const { result: verdict } = parseLastVerdict(verdictRaw);

    // Assertion 3: final verifier verdict is PASS (gate resolved).
    if (verdict !== "PASS") {
        fail(
            `final verifier verdict is ${verdict}, expected PASS` +
                (verdictRaw === carolRaw ? " (escalation handler)" : " (primary verifier)"),
        );
    }

    console.log("PASS: drift within symplectic tolerance; final verifier verdict = PASS.");
}

main();
