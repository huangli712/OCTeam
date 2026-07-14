/**
 * Check script: Sum-of-squares pipeline with peer-quorum signoff.
 *
 * Scenario 3: team_pipeline (3 stages: derive → verify → prove) with
 * signoff_policy="peer-quorum" (default quorum 0.5 = majority).
 * After the pipeline completes, all 3 members vote on the full chain.
 *
 * Usage:  bun check-math-pipeline-quorum.ts <run_dir>
 *   <run_dir>  directory containing <member>.md outputs
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const FORMULA_RE = /<!--\s*FORMULA:\s*n\(n\+1\)\(2n\+1\)\/6\s*-->/;
const VERIFY_RE = /<!--\s*VERIFY:\s*true\s*-->/;
const PROOF_RE = /<!--\s*PROOF_OK:\s*true\s*-->/;
const SIGNOFF_RE = /<signoff>\s*(\{[\s\S]*?\})\s*<\/signoff>/g;

const PIPELINE_LAST_STAGE = "carol.md";

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
        console.error("Usage: bun check-math-pipeline-quorum.ts <run_dir>");
        process.exit(2);
    }

    // Read the last pipeline stage (carol.md) for pipeline markers
    let carolOutput: string;
    try {
        carolOutput = await readMember(runDir, PIPELINE_LAST_STAGE);
    } catch {
        // readMember already exits on error, but catch for type safety
        process.exit(2);
    }

    // Assertion 1: formula marker in pipeline output
    if (!FORMULA_RE.test(carolOutput)) {
        fail("<!-- FORMULA: n(n+1)(2n+1)/6 --> marker not found in carol.md");
    }
    console.log("  pipeline marker: FORMULA present");

    // Assertion 2: verify marker in pipeline output
    if (!VERIFY_RE.test(carolOutput)) {
        fail("<!-- VERIFY: true --> marker not found in carol.md");
    }
    console.log("  pipeline marker: VERIFY=true present");

    // Assertion 3: proof marker in pipeline output
    if (!PROOF_RE.test(carolOutput)) {
        fail("<!-- PROOF_OK: true --> marker not found in carol.md");
    }
    console.log("  pipeline marker: PROOF_OK=true present");

    // Assertion 4: at least 2 signoff approvals (majority of 3)
    let allBlob: string;
    try {
        allBlob = await readAllMd(runDir);
    } catch (err) {
        console.error(`IO error: ${(err as Error).message}`);
        process.exit(2);
    }

    const verdicts = parseSignoffTags(allBlob);
    const approved = verdicts.filter((v) => v.approved);
    const rejected = verdicts.filter((v) => !v.approved);

    console.log(
        `  signoff votes: ${approved.length} approved, ${rejected.length} rejected, ${verdicts.length} total`,
    );

    for (let i = 0; i < verdicts.length; i++) {
        const status = verdicts[i].approved ? "APPROVED" : "REJECTED";
        console.log(`    voter ${i + 1} [${status}]: ${verdicts[i].rationale}`);
    }

    if (approved.length < 2) {
        fail(
            `quorum not met: ${approved.length}/3 approved, need >= 2 (majority)`,
        );
    }

    console.log(
        "PASS: 3 pipeline markers present; quorum met (>=2/3 approved).",
    );
}

main();
