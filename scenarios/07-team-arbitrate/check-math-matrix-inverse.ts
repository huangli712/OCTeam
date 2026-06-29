/**
 * Check script: 4x4 matrix inverse debate arbitration (direct vs iterative).
 *
 * Two mathematician debaters argue whether a dense, well-conditioned 4x4 matrix
 * (condition number ~10) should be inverted via direct Gaussian elimination or
 * an iterative method (e.g. Jacobi). A reviewer arbiter issues a binding ruling.
 *
 * This script verifies:
 *   1. Both debaters emitted an <!-- ARG: ... --> marker.
 *   2. The arbiter emitted a <!-- RULING: ... --> marker matching the expected
 *      choice ("direct").
 *   3. The arbiter emitted a non-empty <!-- REASON: ... --> marker containing a
 *      key term ("condition" or "dense").
 *
 * Usage:  bun check-math-matrix-inverse.ts <run_dir>
 *   <run_dir>  directory containing alice.md,
 *              bob.md, carol.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEBATERS = ["alice", "bob"] as const;
const ARBITER = "carol";

const EXPECTED_RULING = "direct";
// The arbiter's rationale must reference the matrix class that makes the
// winner dominate: small/dense structure or the low condition number.
const REASON_KEY_TERMS = ["condition", "dense"] as const;

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
        console.error("Usage: bun check-math-matrix-inverse.ts <run_dir>");
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
        fail(`arbiter ruled "${ruling}", expected "${EXPECTED_RULING}" (small dense well-conditioned matrices favor direct elimination)`);
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

    console.log("PASS: arbiter ruled direct with a sound rationale; both debaters argued.");
}

main();
