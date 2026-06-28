/**
 * Check script: cache eviction debate arbitration (LRU vs LFU).
 *
 * Two coder debaters argue whether a single-process, capacity-8 cache under
 * strong temporal locality and uniform frequencies should use LRU or LFU
 * eviction. A reviewer arbiter issues a binding ruling.
 *
 * This script verifies:
 *   1. Both debaters emitted an <!-- ARG: ... --> marker.
 *   2. The arbiter emitted a <!-- RULING: ... --> marker matching the expected
 *      choice ("lru"). Temporal locality favors recency-based eviction.
 *   3. The arbiter emitted a non-empty <!-- REASON: ... --> marker containing a
 *      key term ("temporal" or "recency").
 *
 * Usage:  bun check-coding-cache-eviction.ts <run_dir>
 *   <run_dir>  directory containing alice.md, bob.md, carol.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEBATERS = ["alice", "bob"] as const;
const ARBITER = "carol";

const EXPECTED_RULING = "lru";
// The arbiter's rationale must reference temporal locality or recency as the
// signal that tracks the access pattern under uniform frequencies.
const REASON_KEY_TERMS = ["temporal", "recency"] as const;

const ARG_RE = /<!--\s*ARG:\s*(.+?)\s*-->/;
const RULING_RE = /<!--\s*RULING:\s*(\w[\w-]*)\s*-->/;
const REASON_RE = /<!--\s*REASON:\s*(.+?)\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function readMember(runDir: string, member: string): Promise<string> {
    const path = join(runDir, `${member}.md`);
    try {
        return await readFile(path, "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-cache-eviction.ts <run_dir>");
        process.exit(2);
    }

    // Assertion 1: each debater emitted an ARG marker.
    for (const debater of DEBATERS) {
        const raw = await readMember(runDir, debater);
        const match = raw.match(ARG_RE);
        if (!match) {
            fail(`debater "${debater}" did not emit an <!-- ARG: ... --> marker`);
        }
        console.log(`  ${debater}: ARG = ${match![1].trim()}`);
    }

    const arbiterRaw = await readMember(runDir, ARBITER);

    // Assertion 2: arbiter's RULING matches the expected choice.
    const rulingMatch = arbiterRaw.match(RULING_RE);
    if (!rulingMatch) {
        fail(`arbiter did not emit an <!-- RULING: ... --> marker`);
    }
    const ruling = rulingMatch![1].trim();
    console.log(`  arbiter RULING = ${ruling}`);
    if (ruling !== EXPECTED_RULING) {
        fail(`arbiter ruled "${ruling}", expected "${EXPECTED_RULING}" (temporal locality favors recency-based eviction)`);
    }

    // Assertion 3: arbiter's REASON is non-empty and references a key term.
    const reasonMatch = arbiterRaw.match(REASON_RE);
    if (!reasonMatch) {
        fail(`arbiter did not emit an <!-- REASON: ... --> marker`);
    }
    const reason = reasonMatch![1].trim();
    if (reason.length === 0) {
        fail("arbiter REASON is empty");
    }
    const lower = reason.toLowerCase();
    const hasKeyTerm = REASON_KEY_TERMS.some(term => lower.includes(term));
    if (!hasKeyTerm) {
        fail(`arbiter REASON lacks a key term (${REASON_KEY_TERMS.join(" / ")}): "${reason}"`);
    }
    console.log(`  arbiter REASON = ${reason}`);

    console.log("PASS: arbiter ruled lru with a sound rationale; both debaters argued.");
}

main();
