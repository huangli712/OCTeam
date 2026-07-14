/**
 * Check script: definite integral cross-validation (isolated mode).
 *
 * Verifies that at least 2 of 3 independently computed integral values
 * agree within tolerance, and the median is close to the analytic answer.
 *
 * Usage:  bun check-math-isolated-integral.ts <run_dir>
 *   <run_dir>  directory containing per-member markdown outputs
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ANALYTIC_ANSWER = 0.6466; // 2 - 10/e^2
const CROSS_TOLERANCE = 0.01;
const ANALYTIC_TOLERANCE = 0.05;
const INTEGRAL_RE = /<!--\s*INTEGRAL:\s*([\d.eE+-]+)\s*-->/;

async function readAllMd(runDir: string): Promise<Map<string, string>> {
    const files = await readdir(runDir);
    const mdFiles = files.filter(f => f.endsWith(".md"));
    const result = new Map<string, string>();
    for (const f of mdFiles) {
        try {
            const content = await readFile(join(runDir, f), "utf8");
            result.set(f.replace(".md", ""), content);
        } catch { /* skip unreadable files */ }
    }
    return result;
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-isolated-integral.ts <run_dir>");
        process.exit(2);
    }

    const mdFiles = await readAllMd(runDir).catch((err: Error) => {
        console.error(`IO error reading run dir: ${err.message}`);
        process.exit(2);
    });

    if (mdFiles.size === 0) {
        console.error("IO error: no .md files found in run directory");
        process.exit(2);
    }

    // Extract all integral values
    const values: number[] = [];
    for (const [member, content] of mdFiles) {
        const match = content.match(INTEGRAL_RE);
        if (match) {
            const v = parseFloat(match[1]);
            if (!Number.isNaN(v)) {
                console.log(`  ${member}: integral = ${v.toFixed(6)}`);
                values.push(v);
            }
        }
    }

    if (values.length < 2) {
        fail(`only ${values.length} parseable INTEGRAL markers found; need at least 2 for cross-validation`);
    }

    // Assertion 1: at least 2 values agree within CROSS_TOLERANCE
    let crossValid = false;
    for (let i = 0; i < values.length && !crossValid; i++) {
        for (let j = i + 1; j < values.length; j++) {
            if (Math.abs(values[i] - values[j]) <= CROSS_TOLERANCE) {
                crossValid = true;
                break;
            }
        }
    }
    if (!crossValid) {
        fail(`no pair of values agrees within ${CROSS_TOLERANCE}; values: [${values.join(", ")}]`);
    }

    // Assertion 2: median is within ANALYTIC_TOLERANCE of analytic answer
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const err = Math.abs(median - ANALYTIC_ANSWER);
    if (err >= ANALYTIC_TOLERANCE) {
        fail(`median ${median.toFixed(6)} differs from analytic ${ANALYTIC_ANSWER} by ${err.toExponential(3)} >= ${ANALYTIC_TOLERANCE}`);
    }

    console.log(`PASS: cross-validation ok; median=${median.toFixed(6)} within ${ANALYTIC_TOLERANCE} of ${ANALYTIC_ANSWER}.`);
}

main();
