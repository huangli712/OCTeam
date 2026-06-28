/**
 * Check script: damped pendulum small-angle recursive model (3 sub-models).
 *
 * team_recurse spreads output across the shared task list + per-member reports.
 * This script reads ALL member markdowns in <run_dir>/ and verifies the root
 * aggregation marker from the decomposer plus at least one independent leaf
 * marker (the damping-envelope decay constant) from another member.
 *
 * For the underdamped small-angle oscillator theta'' + gamma*theta' + w0^2*theta = 0
 * with gamma = 0.2, w0 = 1, the solution envelope is exp(-(gamma/2)*t); the decay
 * constant in the exponent is gamma/2 = 0.1.
 *
 * Usage:  bun check-physics-damped-pendulum.ts <run_dir>
 *   <run_dir>  directory containing the per-member markdown outputs
 *              (expects alice.md as the decomposer, plus bob.md /
 *               carol.md as solver members)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Decomposer member (set in the team_create config above). The root aggregator.
const DECOMPOSER = "alice";
// Decay constant gamma/2 in the envelope exp(-(gamma/2)*t) for gamma = 0.2.
const EXPECTED_DECAY = 0.1;
const DECAY_TOLERANCE = 0.01;

const MODEL_VALID_RE = /<!--\s*MODEL_VALID:\s*(true|false)\s*-->/;
const ENVELOPE_DECAY_RE = /<!--\s*ENVELOPE_DECAY:\s*([\d.eE+-]+)\s*-->/;

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
        console.error("Usage: bun check-physics-damped-pendulum.ts <run_dir>");
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

    // Assertion 1: the decomposer's aggregated model is marked valid.
    const decomposer = docs.find(d => d.name === DECOMPOSER);
    if (!decomposer) {
        fail(`decomposer member "${DECOMPOSER}.md" not found in "${runDir}"`);
    }
    const validMatch = decomposer!.raw.match(MODEL_VALID_RE);
    if (!validMatch) {
        fail(`decomposer "${DECOMPOSER}" did not emit a <!-- MODEL_VALID: ... --> marker`);
    }
    console.log(`  ${DECOMPOSER} (decomposer): MODEL_VALID = ${validMatch![1]}`);
    if (validMatch![1] !== "true") {
        fail(`decomposer MODEL_VALID = ${validMatch![1]}, expected true`);
    }

    // Assertion 2: at least one OTHER member independently reports the envelope
    // decay constant gamma/2 = 0.1 (within tolerance).
    const others = docs.filter(d => d.name !== DECOMPOSER);
    const independent = others.filter(d => {
        const m = d.raw.match(ENVELOPE_DECAY_RE);
        if (!m) return false;
        const v = parseFloat(m[1]);
        return !Number.isNaN(v) && Math.abs(v - EXPECTED_DECAY) <= DECAY_TOLERANCE;
    });
    if (independent.length === 0) {
        const seen = others.map(d => {
            const m = d.raw.match(ENVELOPE_DECAY_RE);
            return `${d.name}=${m ? m[1] : "none"}`;
        });
        fail(`no non-decomposer member emitted <!-- ENVELOPE_DECAY: ~${EXPECTED_DECAY} --> (saw: ${seen.join(", ") || "none"})`);
    }
    for (const d of independent) {
        const m = d.raw.match(ENVELOPE_DECAY_RE)!;
        console.log(`  ${d.name} (leaf): ENVELOPE_DECAY = ${m[1]}`);
    }

    console.log("PASS: decomposer MODEL_VALID=true and >=1 independent leaf confirms envelope decay gamma/2=0.1.");
}

main();
