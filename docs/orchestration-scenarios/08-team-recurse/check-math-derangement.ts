/**
 * Check script: derangement D_n recursive derivation (3 proof methods).
 *
 * team_recurse spreads output across the shared task list + per-member reports.
 * This script reads ALL member markdowns in <run_dir>/ and verifies the root
 * aggregation marker from the decomposer plus at least one independent leaf
 * marker from another member (proving two paths converged on D_4 = 9).
 *
 * Usage:  bun check-math-derangement.ts <run_dir>
 *   <run_dir>  directory containing the per-member markdown outputs
 *              (expects inc-exc.md as the decomposer, plus recurrence.md /
 *               gen-func.md as solver members)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Decomposer member (set in the team_create config above). The root aggregator.
const DECOMPOSER = "inc-exc";
const EXPECTED_D4 = 9;

const D4_FINAL_RE = /<!--\s*D4_FINAL:\s*(\d+)\s*-->/;
const D4_VALUE_RE = /<!--\s*D4_VALUE:\s*(\d+)\s*-->/;

interface MemberDoc {
    name: string; // markdown basename without extension
    raw: string;
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function loadAllMarkdown(runDir: string): Promise<MemberDoc[]> {
    let entries: string[];
    try {
        entries = await readdir(runDir);
    } catch (err) {
        console.error(`IO error reading run_dir "${runDir}": ${(err as Error).message}`);
        process.exit(2);
    }
    const docs: MemberDoc[] = [];
    for (const entry of entries.filter(e => e.endsWith(".md"))) {
        const raw = await readFile(join(runDir, entry), "utf8");
        docs.push({ name: entry.replace(/\.md$/, ""), raw });
    }
    return docs;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-derangement.ts <run_dir>");
        process.exit(2);
    }

    let docs: MemberDoc[];
    try {
        docs = await loadAllMarkdown(runDir);
    } catch (err) {
        console.error(`IO error reading member output: ${(err as Error).message}`);
        process.exit(2);
    }

    if (docs.length === 0) {
        fail(`no member markdown files found in "${runDir}"`);
    }

    // Assertion 1: the decomposer's report carries the aggregated D4_FINAL marker.
    const decomposer = docs.find(d => d.name === DECOMPOSER);
    if (!decomposer) {
        fail(`decomposer member "${DECOMPOSER}.md" not found in "${runDir}"`);
    }
    const finalMatch = decomposer!.raw.match(D4_FINAL_RE);
    if (!finalMatch) {
        fail(`decomposer "${DECOMPOSER}" did not emit a <!-- D4_FINAL: ... --> marker`);
    }
    const finalD4 = parseInt(finalMatch![1], 10);
    console.log(`  ${DECOMPOSER} (decomposer): D4_FINAL = ${finalD4}`);
    if (finalD4 !== EXPECTED_D4) {
        fail(`decomposer D4_FINAL = ${finalD4}, expected ${EXPECTED_D4}`);
    }

    // Assertion 2: at least one OTHER member independently computed D_4 = 9.
    const others = docs.filter(d => d.name !== DECOMPOSER);
    const independent = others.filter(d => {
        const m = d.raw.match(D4_VALUE_RE);
        return m !== null && parseInt(m[1], 10) === EXPECTED_D4;
    });
    if (independent.length === 0) {
        const seen = others.map(d => {
            const m = d.raw.match(D4_VALUE_RE);
            return `${d.name}=${m ? m[1] : "none"}`;
        });
        fail(`no non-decomposer member emitted <!-- D4_VALUE: ${EXPECTED_D4} --> (saw: ${seen.join(", ") || "none"})`);
    }
    for (const d of independent) {
        console.log(`  ${d.name} (leaf): D4_VALUE = ${EXPECTED_D4}`);
    }

    console.log("PASS: decomposer aggregated D4_FINAL=9 and >=1 independent leaf confirms D_4=9.");
}

main();
