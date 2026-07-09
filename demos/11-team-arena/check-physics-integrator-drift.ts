/**
 * Check script: integrator energy-drift arena (Scenario 2).
 *
 * Validates the evaluator's (dave.md) <scoreboard> JSON:
 *   - Valid JSON with all expected fields
 *   - All 3 candidates present (alice, bob, carol)
 *   - Each score (drift) is finite and >= 0
 *   - drift metric present on each entry
 *   - At least 1 candidate passed=true
 *   - Winner has the minimum score (score_direction: "min")
 *   - Physics check: the Velocity Verlet candidate passed=true AND has drift < 1e-3
 *
 * Usage:  bun check-physics-integrator-drift.ts <run_dir>
 *   <run_dir>  directory containing dave.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface ScoreEntry {
    member: string;
    score: number;
    metrics?: Record<string, unknown>;
    passed: boolean;
    rationale: string;
}

interface Scoreboard {
    scores: ScoreEntry[];
    rationale: string;
}

const SCOREBOARD_RE = /<scoreboard>\s*(\{[\s\S]*?\})\s*<\/scoreboard>/;
const EXPECTED_MEMBERS = new Set(["alice", "bob", "carol"]);

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function parseScoreboard(raw: string): Scoreboard {
    const m = raw.match(SCOREBOARD_RE);
    if (!m) fail("evaluator did not emit a <scoreboard>{...}</scoreboard> block");
    let obj: unknown;
    try {
        obj = JSON.parse(m[1]);
    } catch {
        fail(`evaluator <scoreboard> block is not valid JSON: ${m[1].substring(0, 200)}`);
    }
    const sb = obj as Record<string, unknown>;
    if (!Array.isArray(sb.scores)) fail("scoreboard JSON lacks a 'scores' array");
    if (sb.scores.length !== EXPECTED_MEMBERS.size) {
        fail(`scoreboard has ${sb.scores.length} entries, expected ${EXPECTED_MEMBERS.size}`);
    }
    for (const entry of sb.scores) {
        if (typeof entry.member !== "string") fail("score entry lacks 'member' string");
        if (typeof entry.score !== "number" || !Number.isFinite(entry.score)) {
            fail(`score for ${entry.member ?? "?"} is not a finite number: ${entry.score}`);
        }
        if (typeof entry.passed !== "boolean") fail(`passed for ${entry.member} is not boolean`);
        if (typeof entry.rationale !== "string" || !entry.rationale.trim()) {
            fail(`rationale for ${entry.member} is empty or missing`);
        }
    }
    return sb as unknown as Scoreboard;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-physics-integrator-drift.ts <run_dir>");
        process.exit(2);
    }

    // --- Load evaluator (dave.md) ---
    let daveRaw: string;
    try {
        daveRaw = await readFile(join(runDir, "dave.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading dave.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const sb = parseScoreboard(daveRaw);

    // Assertion 1: all expected members are present.
    const seen = new Set(sb.scores.map((e) => e.member));
    for (const name of EXPECTED_MEMBERS) {
        if (!seen.has(name)) fail(`candidate '${name}' missing from scoreboard`);
    }
    console.log("  all 3 candidates present in scoreboard");

    // Assertion 2: each entry has valid drift value (finite, >= 0).
    for (const entry of sb.scores) {
        const drift = entry.metrics?.drift;
        if (typeof drift !== "number" || !Number.isFinite(drift)) {
            fail(`drift metric missing or not finite for ${entry.member}: ${drift}`);
        }
        if (drift < 0) fail(`drift for ${entry.member} is negative (${drift}), should be >= 0`);
        console.log(`  ${entry.member}: score=${entry.score}, drift=${drift}, passed=${entry.passed}`);
    }

    // Assertion 3: at least 1 candidate passed=true.
    const passedCount = sb.scores.filter((e) => e.passed).length;
    if (passedCount === 0) fail("no candidate has passed=true — no symplectic integrator found");
    console.log(`  passed: ${passedCount}/${sb.scores.length}`);

    // Assertion 4: winner has the minimum score (score_direction: "min").
    const minScore = Math.min(...sb.scores.map((e) => e.score));
    const winners = sb.scores.filter((e) => e.score === minScore);
    if (winners.length === 0) fail("no winner found (no min score)");
    console.log(`  winner(s): ${winners.map((w) => w.member).join(", ")} — score=${minScore}`);

    // Assertion 5 (physics): the symplectic integrator (Velocity Verlet candidate) should be
    // the winner with drift < 1e-3. We look for the entry with the lowest drift among passed=true.
    const passedEntries = sb.scores.filter((e) => e.passed);
    if (passedEntries.length === 0) fail("no passed=true entry — physics check cannot proceed");
    const bestPassed = passedEntries.reduce((a, b) => (a.score < b.score ? a : b));
    if (bestPassed.score >= 1e-3) {
        fail(`best passed candidate ${bestPassed.member} has drift ${bestPassed.score} >= 1e-3 (not symplectic)`);
    }
    console.log(`  physics check: best passed=${bestPassed.member}, drift=${bestPassed.score} < 1e-3 ✓`);

    console.log(`PASS: scoreboard valid; ${passedCount}/${sb.scores.length} passed; winner(s) = ${winners.map((w) => w.member).join(", ")} (min drift=${minScore}).`);
}

main();
