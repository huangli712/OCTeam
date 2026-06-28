/**
 * Check script: Vandermonde identity multi-layer proof (challenge-level, 6 members, depth 4).
 *
 * team_recurse spreads output across the shared task list + per-member reports.
 * This script reads ALL member markdowns in <run_dir>/ and verifies:
 *   1. The decomposer (alice) emitted the root aggregation marker
 *      <!-- VANDERMONDE_PROVEN: true -->.
 *   2. Across all leaf sub-tasks, at least 2 distinct <!-- APPROACH: <name> -->
 *      markers appear, and both "algebraic" and "combinatorial" are present
 *      (independent proof paths converged).
 *   3. Every <!-- LEMMA_HOLDS: <bool> --> marker that appears is "true"
 *      (no leaf disproved its lemma).
 *
 * Usage:  bun check-math-vandermonde.ts <run_dir>
 *   <run_dir>  directory containing the per-member markdown outputs
 *             (expects alice.md as the decomposer, plus bob/carol/dave/erin/
 *              frank.md as solver members distributed across three proof paths)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Decomposer member (set in the team_create config above). The root aggregator.
const DECOMPOSER = "alice";

// Non-global: single root-aggregation marker on the decomposer.
const VANDERMONDE_RE = /<!--\s*VANDERMONDE_PROVEN:\s*(true|false)\s*-->/;
// Global: many leaf markers may appear across all member reports.
const APPROACH_RE = /<!--\s*APPROACH:\s*([A-Za-z0-9_-]+)\s*-->/g;
const LEMMA_RE = /<!--\s*LEMMA_HOLDS:\s*(true|false)\s*-->/g;

// Minimum-required distinct proof paths; algebraic + combinatorial must be among them.
const REQUIRED_APPROACHES = ["algebraic", "combinatorial"];

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

/** Extract every capture group 1 from a (possibly global) regex against `raw`. */
function collectMatches(raw: string, re: RegExp): string[] {
    const out: string[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        out.push(m[1]);
    }
    return out;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-vandermonde.ts <run_dir>");
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

    // Assertion 1: the decomposer's report carries the root aggregation marker.
    const decomposer = docs.find(d => d.name === DECOMPOSER);
    if (!decomposer) {
        fail(`decomposer member "${DECOMPOSER}.md" not found in "${runDir}"`);
    }
    const provenMatch = decomposer!.raw.match(VANDERMONDE_RE);
    if (!provenMatch) {
        fail(`decomposer "${DECOMPOSER}" did not emit a <!-- VANDERMONDE_PROVEN: ... --> marker`);
    }
    console.log(`  ${DECOMPOSER} (decomposer): VANDERMONDE_PROVEN = ${provenMatch![1]}`);
    if (provenMatch![1] !== "true") {
        fail(`decomposer VANDERMONDE_PROVEN = ${provenMatch![1]}, expected true`);
    }

    // Assertion 2: collect APPROACH markers across ALL members; require >=2 distinct
    // and require every name in REQUIRED_APPROACHES to be present.
    const approaches = new Set<string>();
    for (const d of docs) {
        for (const a of collectMatches(d.raw, APPROACH_RE)) {
            approaches.add(a);
        }
    }
    console.log(`  leaf APPROACH markers: ${JSON.stringify([...approaches])}`);
    if (approaches.size < 2) {
        fail(`only ${approaches.size} distinct APPROACH name(s) across leaves; need >=2 (saw: ${JSON.stringify([...approaches])})`);
    }
    for (const required of REQUIRED_APPROACHES) {
        if (!approaches.has(required)) {
            fail(`required APPROACH "${required}" not found among leaves (saw: ${JSON.stringify([...approaches])})`);
        }
    }

    // Assertion 3: every LEMMA_HOLDS marker that appears must be "true".
    const lemmaByMember: Record<string, string[]> = {};
    let anyLemma = false;
    for (const d of docs) {
        const ms = collectMatches(d.raw, LEMMA_RE);
        if (ms.length > 0) {
            lemmaByMember[d.name] = ms;
            anyLemma = true;
        }
    }
    if (!anyLemma) {
        fail(`no <!-- LEMMA_HOLDS: ... --> markers found in any member report`);
    }
    let allHold = true;
    for (const [member, vals] of Object.entries(lemmaByMember)) {
        for (const v of vals) {
            console.log(`  ${member} (leaf): LEMMA_HOLDS = ${v}`);
            if (v !== "true") allHold = false;
        }
    }
    if (!allHold) {
        fail(`at least one leaf reported LEMMA_HOLDS = false; all must be true`);
    }

    console.log("PASS: VANDERMONDE_PROVEN=true, >=2 distinct APPROACH (incl. algebraic + combinatorial), all LEMMA_HOLDS=true.");
}

main();
