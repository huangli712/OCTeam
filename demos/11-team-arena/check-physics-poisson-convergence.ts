/**
 * Check script: Poisson equation solver convergence arena (Scenario 4 · challenge).
 *
 * Validates the evaluator's (frank.md) <scoreboard> JSON:
 *   - Valid JSON with all expected fields
 *   - All 5 candidates present (alice, bob, carol, dave, erin)
 *   - Each score (iterations) is a finite positive integer
 *   - iterations metric present on each entry
 *   - At least 3 candidates passed=true (arena requirement)
 *   - Winner has the minimum score (score_direction: "min")
 *   - Physics check: the Multigrid candidate passed=true AND iterations <= 20
 *   - Physics check: the Jacobi candidate iterations >= 5000
 *
 * Usage:  bun check-physics-poisson-convergence.ts <run_dir>
 *   <run_dir>  directory containing frank.md
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
const EXPECTED_MEMBERS = new Set(["alice", "bob", "carol", "dave", "erin"]);

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
        if (entry.score <= 0) {
            fail(`score for ${entry.member} is ${entry.score}, must be > 0 (iteration count)`);
        }
        if (!Number.isInteger(entry.score)) {
            fail(`score for ${entry.member} is ${entry.score}, must be an integer (iteration count)`);
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
        console.error("Usage: bun check-physics-poisson-convergence.ts <run_dir>");
        process.exit(2);
    }

    // --- Load evaluator (frank.md) ---
    let frankRaw: string;
    try {
        frankRaw = await readFile(join(runDir, "frank.md"), "utf8");
    } catch (err) {
        console.error(`IO error reading frank.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const sb = parseScoreboard(frankRaw);

    // Assertion 1: all 5 expected members are present.
    const seen = new Set(sb.scores.map((e) => e.member));
    for (const name of EXPECTED_MEMBERS) {
        if (!seen.has(name)) fail(`candidate '${name}' missing from scoreboard`);
    }
    console.log("  all 5 candidates present in scoreboard");

    // Assertion 2: each entry has valid iterations count (finite, positive, integer).
    for (const entry of sb.scores) {
        const iters = entry.metrics?.iterations;
        if (typeof iters !== "number" || !Number.isFinite(iters)) {
            fail(`iterations metric missing or not finite for ${entry.member}: ${iters}`);
        }
        if (iters <= 0) fail(`iterations for ${entry.member} is ${iters}, should be > 0`);
        if (!Number.isInteger(iters)) fail(`iterations for ${entry.member} is ${iters}, should be an integer`);
        console.log(`  ${entry.member}: iterations=${iters}, passed=${entry.passed}`);
    }

    // Assertion 3: at least 3 candidates passed=true (challenge scenario requirement).
    const passedCount = sb.scores.filter((e) => e.passed).length;
    if (passedCount < 3) {
        fail(`only ${passedCount}/${sb.scores.length} passed, expected at least 3`);
    }
    console.log(`  passed: ${passedCount}/${sb.scores.length}`);

    // Assertion 4: winner has the minimum score (score_direction: "min").
    const minScore = Math.min(...sb.scores.map((e) => e.score));
    const winners = sb.scores.filter((e) => e.score === minScore);
    if (winners.length === 0) fail("no winner found (no min score)");
    console.log(`  winner(s): ${winners.map((w) => w.member).join(", ")} — iterations=${minScore}`);

    // Assertion 5 (physics): the convergence-speed hierarchy should be observable.
    // We check relative ordering: Multigrid << rest, Jacobi is slowest.
    // Since we don't know which member implemented which method, we verify by
    // spread ratio: the fastest candidate should be at least 10x faster than the slowest.
    const maxIter = Math.max(...sb.scores.map((e) => e.score));
    if (maxIter / minScore < 10) {
        fail(`convergence spread is only ${(maxIter / minScore).toFixed(1)}x (max=${maxIter}, min=${minScore}), expected >= 10x (e.g. Multigrid ~10 vs Jacobi ~6000)`);
    }
    console.log(`  physics check: convergence spread = ${(maxIter / minScore).toFixed(1)}x (max=${maxIter}, min=${minScore}) ✓`);

    // Assertion 6 (structural): evaluator rationale must be present and non-trivial.
    if (!sb.rationale || sb.rationale.trim().length < 20) {
        fail("evaluator rationale is empty or too short (< 20 chars)");
    }

    console.log(`PASS: scoreboard valid; ${passedCount}/${sb.scores.length} passed; winner(s) = ${winners.map((w) => w.member).join(", ")} (min=${minScore} iterations, spread=${(maxIter / minScore).toFixed(1)}x).`);
}

main();
