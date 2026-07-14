/**
 * Check script: proof ensemble verification workflow (Scenario 2).
 *
 * Validates the ensemble verifier gate in a team_workflow run:
 *   - alice.md contains a proof with <!-- PROOF_OK: true --> marker
 *   - bob.md, carol.md, dave.md each contain one <verdict> gate decision
 *   - At least 2 of 3 verdicts are PASS (majority rule)
 *
 * Usage:  bun check-math-proof-ensemble.ts <run_dir>
 *   <run_dir>  directory containing alice.md, bob.md, carol.md, dave.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/;
const PROOF_OK_RE = /<!--\s*PROOF_OK:\s*true\s*-->/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

interface Verdict {
    result: string;
    rationale: string;
    diff: string;
}

function parseVerdict(raw: string): Verdict | null {
    const m = raw.match(VERDICT_RE);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[1]) as Record<string, string>;
        const result = (obj.result ?? "").trim().toUpperCase();
        if (!result) return null;
        return {
            result,
            rationale: (obj.rationale ?? "").trim(),
            diff: (obj.diff ?? "").trim(),
        };
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-proof-ensemble.ts <run_dir>");
        process.exit(2);
    }

    // --- Load all four member files ---
    const reviewerNames = ["bob", "carol", "dave"];
    const members = ["alice", ...reviewerNames];
    const files: Record<string, string> = {};

    for (const name of members) {
        try {
            files[name] = await readFile(join(runDir, `${name}.md`), "utf8");
        } catch (err) {
            console.error(`IO error reading ${name}.md: ${(err as Error).message}`);
            process.exit(2);
        }
    }

    // Assertion 1: alice.md contains the PROOF_OK marker.
    if (!PROOF_OK_RE.test(files.alice)) {
        fail("alice.md does not contain <!-- PROOF_OK: true --> marker");
    }
    console.log("  alice: PROOF_OK: true marker found ✓");

    // Assertion 2: each reviewer emitted exactly one verdict.
    const verdicts: Record<string, Verdict> = {};
    for (const name of reviewerNames) {
        const v = parseVerdict(files[name]);
        if (!v) {
            fail(`${name}.md has no valid <verdict> block`);
        }
        verdicts[name] = v;
    }
    console.log("  all 3 reviewers: verdict found ✓");

    // Assertion 3: at least 2 of 3 are PASS (majority rule).
    const passCount = reviewerNames.filter((name) => verdicts[name].result === "PASS").length;
    const failCount = reviewerNames.filter((name) => verdicts[name].result === "FAIL").length;

    console.log("  --- Reviewer Verdicts ---");
    for (const name of reviewerNames) {
        const v = verdicts[name];
        console.log(`  ${name}: ${v.result} - ${v.rationale}`);
    }

    if (passCount < 2) {
        fail(`ensemble majority not reached: ${passCount} PASS, ${failCount} FAIL (need >= 2 PASS)`);
    }
    console.log(`  ensemble: ${passCount}/${reviewerNames.length} PASS → majority reached ✓`);

    console.log(`PASS: proof is marked PROOF_OK; ${passCount} of ${reviewerNames.length} reviewers voted PASS.`);
}

main();
