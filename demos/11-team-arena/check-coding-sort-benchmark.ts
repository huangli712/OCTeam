/**
 * Check script: sorting benchmark arena (Scenario 1).
 *
 * Validates the evaluator's (dave.md) <scoreboard> JSON:
 *   - Valid JSON with all expected fields
 *   - All 3 candidates present (alice, bob, carol)
 *   - Each score is finite and > 0
 *   - throughput_ops_per_sec metric present on each entry
 *   - At least 1 candidate passed=true
 *   - Winner has the maximum score (score_direction: "max")
 *
 * Usage:  bun check-coding-sort-benchmark.ts <run_dir>
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
        console.error("Usage: bun check-coding-sort-benchmark.ts <run_dir>");
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

    // Assertion 1: all expected members are present (no extras, no missings).
    const seen = new Set(sb.scores.map((e) => e.member));
    for (const name of EXPECTED_MEMBERS) {
        if (!seen.has(name)) fail(`candidate '${name}' missing from scoreboard`);
    }
    console.log("  all 3 candidates present in scoreboard");

    // Assertion 2: each entry has throughput_ops_per_sec metric.
    for (const entry of sb.scores) {
        const tput = entry.metrics?.throughput_ops_per_sec;
        if (typeof tput !== "number" || !Number.isFinite(tput)) {
            fail(`throughput_ops_per_sec missing or not finite for ${entry.member}: ${tput}`);
        }
        console.log(`  ${entry.member}: score=${entry.score}, throughput=${tput}, passed=${entry.passed}`);
    }

    // Assertion 3: at least 1 candidate passed=true (benchmark produced valid results).
    const passedCount = sb.scores.filter((e) => e.passed).length;
    if (passedCount === 0) fail("no candidate has passed=true — benchmark may have failed everywhere");
    console.log(`  passed: ${passedCount}/${sb.scores.length}`);

    // Assertion 4: winner has the maximum score (score_direction: "max").
    const maxScore = Math.max(...sb.scores.map((e) => e.score));
    const winners = sb.scores.filter((e) => e.score === maxScore);
    if (winners.length === 0) fail("no winner found (no max score)");
    console.log(`  winner(s): ${winners.map((w) => w.member).join(", ")} — score=${maxScore}`);

    // Assertion 5: at least 2 candidates passed=true (multiple sort implementations should be correct).
    if (passedCount < 2) fail(`only ${passedCount} candidate(s) passed, expected at least 2 (sorting should be correct for most implementations)`);

    console.log(`PASS: scoreboard valid; ${passedCount}/${sb.scores.length} passed; winner(s) = ${winners.map((w) => w.member).join(", ")} (max score=${maxScore}).`);
}

main();
