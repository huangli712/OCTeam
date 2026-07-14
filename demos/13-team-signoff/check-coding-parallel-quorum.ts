/**
 * Check script: Sort implementation parallel with peer-quorum signoff.
 *
 * Scenario 2: team_parallel (cooperative) with signoff_policy="peer-quorum",
 * signoff_quorum=0.67. Three coders each implement a different sort
 * (bubble, merge, selection), then all 3 vote on the merged output.
 *
 * Usage:  bun check-coding-parallel-quorum.ts <run_dir>
 *   <run_dir>  directory containing <member>.md outputs
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const COMPLEXITY_RE = /<!--\s*COMPLEXITY:\s*(.+?)\s*-->/g;
const SIGNOFF_RE = /<signoff>\s*(\{[\s\S]*?\})\s*<\/signoff>/g;

interface SignoffVerdict {
    approved: boolean;
    rationale: string;
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
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
        console.error("Usage: bun check-coding-parallel-quorum.ts <run_dir>");
        process.exit(2);
    }

    let blob: string;
    try {
        blob = await readAllMd(runDir);
    } catch (err) {
        console.error(`IO error: ${(err as Error).message}`);
        process.exit(2);
    }

    if (blob.trim().length === 0) {
        fail("no .md member outputs found in run_dir");
    }

    // Assertion 1: 3 COMPLEXITY markers found
    const complexityMatches: string[] = [];
    let cm: RegExpExecArray | null;
    COMPLEXITY_RE.lastIndex = 0;
    while ((cm = COMPLEXITY_RE.exec(blob)) !== null) {
        complexityMatches.push(cm[1].trim());
    }

    if (complexityMatches.length < 3) {
        fail(
            `expected >= 3 COMPLEXITY markers, found ${complexityMatches.length}`,
        );
    }
    console.log(
        `  COMPLEXITY markers (${complexityMatches.length}): ${complexityMatches.join(", ")}`,
    );

    // Assertion 2: at least 2 signoff approvals (quorum 0.67 x 3 = 2 required)
    const verdicts = parseSignoffTags(blob);
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
            `quorum not met: ${approved.length}/3 approved, need >= 2 (quorum 0.67)`,
        );
    }

    console.log("PASS: 3 COMPLEXITY markers; quorum met (>=2/3 approved).");
}

main();
