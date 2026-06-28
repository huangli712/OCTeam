/**
 * Check script: complex-boundary PDE five-way method debate arbitration
 * (FEM vs FDM vs FVM vs Spectral vs BEM).
 *
 * Five physicist debaters argue which numerical method should solve a PDE with
 * a complex curved boundary, advection-dominated transport, and a nonlinear
 * source term. A reviewer arbiter issues a binding ruling.
 *
 * This script verifies:
 *   1. All five debaters emitted an <!-- ARG: ... --> marker.
 *   2. The arbiter emitted a <!-- RULING: ... --> marker naming one of the
 *      five candidate methods (fem, fdm, fvm, spectral, bem).
 *   3. The arbiter emitted a non-empty <!-- REASON: ... --> marker referencing
 *      at least two of the governing aspects (curved, boundary, advection,
 *      nonlinear, flux, mesh). Physically FEM or FVM is expected to win -- both
 *      conform to curved boundaries via unstructured meshes and tame advection
 *      via stabilization / flux-limiting -- but any of the five is accepted as
 *      a well-formed ruling; BEM is physically disqualified by the nonlinear
 *      source term.
 *
 * Usage:  bun check-physics-pde-arbitrate.ts <run_dir>
 *   <run_dir>  directory containing alice.md, bob.md, carol.md,
 *              dave.md, erin.md, frank.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEBATERS = ["alice", "bob", "carol", "dave", "erin"] as const;
const ARBITER = "frank";

// The ruling must name one of the five candidate methods.
const ALLOWED_RULINGS = ["fem", "fdm", "fvm", "spectral", "bem"] as const;
// The rationale must reference at least MIN_KEY_TERMS of these physical /
// numerical aspects of the problem.
const REASON_KEY_TERMS = ["curved", "boundary", "advection", "nonlinear", "flux", "mesh"] as const;
const MIN_KEY_TERMS = 2;

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
        console.error("Usage: bun check-physics-pde-arbitrate.ts <run_dir>");
        process.exit(2);
    }

    // Assertion 1: each of the five debaters emitted an ARG marker.
    for (const debater of DEBATERS) {
        const raw = await readMember(runDir, debater);
        const match = raw.match(ARG_RE);
        if (!match) {
            fail(`debater "${debater}" did not emit an <!-- ARG: ... --> marker`);
        }
        console.log(`  ${debater}: ARG = ${match![1].trim()}`);
    }

    const arbiterRaw = await readMember(runDir, ARBITER);

    // Assertion 2: arbiter's RULING names one of the five candidate methods.
    const rulingMatch = arbiterRaw.match(RULING_RE);
    if (!rulingMatch) {
        fail(`arbiter did not emit an <!-- RULING: ... --> marker`);
    }
    const ruling = rulingMatch![1].trim().toLowerCase();
    console.log(`  arbiter RULING = ${ruling}`);
    if (!ALLOWED_RULINGS.some(r => r === ruling)) {
        fail(`arbiter ruled "${ruling}", expected one of [${ALLOWED_RULINGS.join(", ")}]`);
    }

    // Assertion 3: arbiter's REASON is non-empty and references enough key terms.
    const reasonMatch = arbiterRaw.match(REASON_RE);
    if (!reasonMatch) {
        fail(`arbiter did not emit an <!-- REASON: ... --> marker`);
    }
    const reason = reasonMatch![1].trim();
    if (reason.length === 0) {
        fail("arbiter REASON is empty");
    }
    const lower = reason.toLowerCase();
    const matchedTerms = REASON_KEY_TERMS.filter(term => lower.includes(term));
    if (matchedTerms.length < MIN_KEY_TERMS) {
        fail(`arbiter REASON references ${matchedTerms.length} of the key terms [${REASON_KEY_TERMS.join(" / ")}], need at least ${MIN_KEY_TERMS}: "${reason}"`);
    }
    console.log(`  matched key terms: ${matchedTerms.join(", ")}`);
    console.log(`  arbiter REASON = ${reason}`);

    console.log("PASS: arbiter delivered a well-formed ruling with a sound rationale; all five debaters argued.");
}

main();
