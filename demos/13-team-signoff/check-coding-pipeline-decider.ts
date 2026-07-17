/**
 * Check script: Multi-stage build pipeline with decider signoff.
 *
 * Scenario 4 (Challenge): team_pipeline (5 stages: spec → Stack → Queue →
 * tests → docs) with signoff_policy="decider", signoff_decider="frank".
 * Frank reviews all 5 stages and issues a single approval verdict.
 *
 * Usage:  bun check-coding-pipeline-decider.ts <run_dir>
 *   <run_dir>  directory containing <member>.md outputs
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SPEC_OK_RE = /<!--\s*SPEC_OK:\s*true\s*-->/;
const IMPL_STACK_RE = /<!--\s*IMPL:\s*Stack\s*-->/;
const IMPL_QUEUE_RE = /<!--\s*IMPL:\s*Queue\s*-->/;
const PASS_COUNT_RE = /<!--\s*PASS_COUNT:\s*8\s*\/\s*8\s*-->/;
const DOCS_OK_RE = /<!--\s*DOCS_OK:\s*true\s*-->/;
const SIGNOFF_RE = /<signoff>\s*(\{[\s\S]*?\})\s*<\/signoff>/g;

interface SignoffVerdict {
    approved: boolean;
    rationale: string;
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function readMember(
    runDir: string,
    member: string,
): Promise<string> {
    try {
        return await readFile(join(runDir, member), "utf8");
    } catch (err) {
        console.error(
            `IO error reading ${member}: ${(err as Error).message}`,
        );
        process.exit(2);
    }
}

async function readAllMd(runDir: string): Promise<string> {
    const files = await readdir(runDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    const contents = await Promise.all(
        mdFiles.map((f) => readFile(join(runDir, f), "utf8").catch(() => "")),
    );
    return contents.join("\n");
}

function parseSignoffTags(blob: string): SignoffVerdict[] {
    const verdicts: SignoffVerdict[] = [];
    let match: RegExpExecArray | null;
    SIGNOFF_RE.lastIndex = 0;
    while ((match = SIGNOFF_RE.exec(blob)) !== null) {
        try {
            const verdict = JSON.parse(match[1]) as SignoffVerdict;
            if (typeof verdict.approved === "boolean") {
                verdicts.push(verdict);
            }
        } catch {
            // skip malformed signoff JSON
        }
    }
    return verdicts;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-pipeline-decider.ts <run_dir>");
        process.exit(2);
    }

    // Read each pipeline stage for its own marker
    let aliceOutput: string;
    let bobOutput: string;
    let carolOutput: string;
    let daveOutput: string;
    let erinOutput: string;
    try {
        aliceOutput = await readMember(runDir, "alice.md");
        bobOutput = await readMember(runDir, "bob.md");
        carolOutput = await readMember(runDir, "carol.md");
        daveOutput = await readMember(runDir, "dave.md");
        erinOutput = await readMember(runDir, "erin.md");
    } catch {
        process.exit(2);
    }

    // Assertion 1: SPEC_OK: true (alice, Stage 1)
    if (!SPEC_OK_RE.test(aliceOutput)) {
        fail("<!-- SPEC_OK: true --> marker not found in alice.md");
    }
    console.log("  pipeline marker: SPEC_OK=true present");

    // Assertion 2: IMPL: Stack (bob, Stage 2)
    if (!IMPL_STACK_RE.test(bobOutput)) {
        fail("<!-- IMPL: Stack --> marker not found in bob.md");
    }
    console.log("  pipeline marker: IMPL: Stack present");

    // Assertion 3: IMPL: Queue (carol, Stage 3)
    if (!IMPL_QUEUE_RE.test(carolOutput)) {
        fail("<!-- IMPL: Queue --> marker not found in carol.md");
    }
    console.log("  pipeline marker: IMPL: Queue present");

    // Assertion 4: PASS_COUNT: 8/8 (dave, Stage 4)
    if (!PASS_COUNT_RE.test(daveOutput)) {
        fail("<!-- PASS_COUNT: 8/8 --> marker not found in dave.md");
    }
    console.log("  pipeline marker: PASS_COUNT=8/8 present");

    // Assertion 5: DOCS_OK: true (erin, Stage 5)
    if (!DOCS_OK_RE.test(erinOutput)) {
        fail("<!-- DOCS_OK: true --> marker not found in erin.md");
    }
    console.log("  pipeline marker: DOCS_OK=true present");

    // Assertion 6: signoff tag with approved=true (frank's verdict)
    let allBlob: string;
    try {
        allBlob = await readAllMd(runDir);
    } catch (err) {
        console.error(`IO error: ${(err as Error).message}`);
        process.exit(2);
    }

    const verdicts = parseSignoffTags(allBlob);
    const approved = verdicts.filter((v) => v.approved);

    if (approved.length === 0) {
        if (verdicts.length === 0) {
            fail("no <signoff> tag found in any member output");
        }
        const rejected = verdicts.filter((v) => !v.approved);
        fail(
            `signoff rejected: ${rejected.length} rejection(s). ` +
            `First rationale: ${rejected[0].rationale}`,
        );
    }

    console.log(
        `  signoff: ${approved.length}/${verdicts.length} approved`,
    );

    for (const v of approved) {
        if (!v.rationale || v.rationale.trim().length === 0) {
            fail("signoff approved but rationale is empty");
        }
        console.log(`    rationale: ${v.rationale}`);
    }

    console.log(
        "PASS: 5 pipeline markers present; signoff approved with rationale.",
    );
}

main();
