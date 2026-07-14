/**
 * Check script: Utility function delegate with decider signoff.
 *
 * Scenario 1: team_delegate with signoff_policy="decider" (carol).
 * Three coders self-claim tasks (toCamelCase, slugify, capitalize),
 * then carol reviews all outputs and emits a signoff verdict.
 *
 * Usage:  bun check-coding-delegate-decider.ts <run_dir>
 *   <run_dir>  directory containing <member>.md outputs
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const IMPL_CAMEL_RE = /<!--\s*IMPL:\s*toCamelCase\s*-->/;
const IMPL_SLUG_RE = /<!--\s*IMPL:\s*slugify\s*-->/;
const IMPL_CAP_RE = /<!--\s*IMPL:\s*capitalize\s*-->/;
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
        console.error("Usage: bun check-coding-delegate-decider.ts <run_dir>");
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

    // Assertion 1: all 3 implementation markers present
    if (!IMPL_CAMEL_RE.test(blob)) {
        fail("<!-- IMPL: toCamelCase --> marker not found");
    }
    console.log("  IMPL marker: toCamelCase present");

    if (!IMPL_SLUG_RE.test(blob)) {
        fail("<!-- IMPL: slugify --> marker not found");
    }
    console.log("  IMPL marker: slugify present");

    if (!IMPL_CAP_RE.test(blob)) {
        fail("<!-- IMPL: capitalize --> marker not found");
    }
    console.log("  IMPL marker: capitalize present");

    // Assertion 2: at least one signoff with approved=true
    const verdicts = parseSignoffTags(blob);
    const approved = verdicts.filter((v) => v.approved);

    if (approved.length === 0) {
        if (verdicts.length === 0) {
            fail("no <signoff> tag found in any member output");
        }
        const rejected = verdicts.filter((v) => !v.approved);
        fail(
            `signoff rejected by all ${verdicts.length} voters. ` +
            `First rationale: ${rejected[0].rationale}`,
        );
    }

    console.log(`  signoff: ${approved.length}/${verdicts.length} approved`);
    for (const v of approved) {
        console.log(`    rationale: ${v.rationale}`);
    }

    console.log("PASS: 3 IMPL markers present; signoff approved.");
}

main();
