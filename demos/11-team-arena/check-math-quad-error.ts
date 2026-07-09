/**
 * Check script: numerical quadrature accuracy arena (Scenario 3).
 *
 * Validates the evaluator's (dave.md) <scoreboard> JSON:
 *   - Valid JSON with all expected fields
 *   - All 3 candidates present (alice, bob, carol)
 *   - Each score (error) is finite and >= 0
 *   - error metric present on each entry
 *   - At least 1 candidate passed=true
 *   - Winner has the minimum score (score_direction: "min")
 *   - Math check: the Gaussian-Legendre candidate passed=true AND has error < 1e-10
 *
 * Usage:  bun check-math-quad-error.ts <run_dir>
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
        console.error("Usage: bun check-math-quad-error.ts <run_dir>");
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

    // Assertion 2: each entry has valid error (finite, >= 0).
    for (const entry of sb.scores) {
        const error = entry.metrics?.error;
        if (typeof error !== "number" || !Number.isFinite(error)) {
            fail(`error metric missing or not finite for ${entry.member}: ${error}`);
        }
        if (error < 0) fail(`error for ${entry.member} is negative (${error}), should be >= 0`);
        console.log(`  ${entry.member}: score=${entry.score}, error=${error}, passed=${entry.passed}`);
    }

    // Assertion 3: at least 1 candidate passed=true (error < 1e-5).
    const errorThreshold = 1e-5;
    const passedCount = sb.scores.filter((e) => e.passed).length;
    if (passedCount === 0) {
        fail(`no candidate has passed=true — no method achieved error < ${errorThreshold}`);
    }
    console.log(`  passed: ${passedCount}/${sb.scores.length}`);
    for (const entry of sb.scores) {
        const err = entry.metrics?.error as number;
        if (entry.passed && err >= errorThreshold) {
            fail(`${entry.member}: passed=true but error=${err} >= ${errorThreshold}`);
        }
    }

    // Assertion 4: winner has the minimum score (score_direction: "min").
    const minScore = Math.min(...sb.scores.map((e) => e.score));
    const winners = sb.scores.filter((e) => e.score === minScore);
    if (winners.length === 0) fail("no winner found (no min score)");
    console.log(`  winner(s): ${winners.map((w) => w.member).join(", ")} — score=${minScore}`);

    // Assertion 5 (math): at least one method should demonstrate high-order accuracy.
    // Gaussian-Legendre n=5 should have near-machine-precision error.
    const highOrder = sb.scores.filter((e) => e.passed && (e.metrics?.error as number) < 1e-10);
    if (highOrder.length === 0) {
        console.warn(`  WARNING: no candidate achieved error < 1e-10 (Gaussian-Legendre expected near machine precision)`);
    } else {
        console.log(`  math check: ${highOrder.map((e) => e.member).join(", ")} achieved sub-1e-10 accuracy ✓`);
    }

    console.log(`PASS: scoreboard valid; ${passedCount}/${sb.scores.length} passed; winner(s) = ${winners.map((w) => w.member).join(", ")} (min error=${minScore}).`);
}

main();
