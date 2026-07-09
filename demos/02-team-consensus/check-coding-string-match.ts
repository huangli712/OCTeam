/**
 * Check script: short-text string-matching consensus (3-way debate).
 *
 * Verifies the team_consensus run reached genuine agreement on a pattern
 * matching algorithm for short text (<1KB, pattern <=32): every member's
 * final-round <consensus> tag has agreed=true, names a recognized algorithm
 * (naive|kmp|boyer|sunday), and all three converged on the SAME choice.
 *
 * Usage:  bun check-coding-string-match.ts <run_dir>
 *   <run_dir>  directory containing the per-member markdown outputs
 *              (expects alice.md, bob.md, carol.md)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MEMBERS = ["alice", "bob", "carol"] as const;
const CONSENSUS_RE = /<consensus>([\s\S]*?)<\/consensus>/g;
// Recognized algorithm names for the short-text matching debate.
// (boyer-moore is included even though no member advocates it, because the
// consensus outcome may legitimately surface it via cross-concession.)
const KNOWN_RE = /^(naive|kmp|boyer|sunday)/i;

interface ConsensusTag {
    agreed: boolean;
    choice?: string;
}

interface MemberResult {
    member: string;
    tags: ConsensusTag[];
    finalTag: ConsensusTag | null;
}

async function loadConsensus(runDir: string, member: string): Promise<MemberResult> {
    const path = join(runDir, `${member}.md`);
    const raw = await readFile(path, "utf8");
    const tags: ConsensusTag[] = [];
    for (const m of raw.matchAll(CONSENSUS_RE)) {
        try {
            const parsed = JSON.parse(m[1]) as { agreed?: unknown; choice?: unknown };
            tags.push({
                agreed: parsed.agreed === true,
                choice: typeof parsed.choice === "string" ? parsed.choice : undefined,
            });
        } catch {
            // Skip malformed/intermediate consensus tags silently.
        }
    }
    const finalTag = tags.length > 0 ? tags[tags.length - 1] : null;
    return { member, tags, finalTag };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function normalize(choice: string): string {
    const m = choice.toLowerCase().match(KNOWN_RE);
    return m ? m[1] : choice.toLowerCase().trim();
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-string-match.ts <run_dir>");
        process.exit(2);
    }

    const results: MemberResult[] = [];
    try {
        for (const m of MEMBERS) {
            results.push(await loadConsensus(runDir, m));
        }
    } catch (err) {
        console.error(`IO error reading member output: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 1: every member emitted at least one <consensus> tag.
    for (const r of results) {
        if (r.tags.length === 0) {
            fail(`member "${r.member}" emitted no <consensus> tag`);
        }
    }

    // Assertion 2: every member's final-round tag has agreed=true.
    for (const r of results) {
        if (!r.finalTag!.agreed) {
            fail(`member "${r.member}" final round did not emit agreed:true (consensus not reached; max_rounds likely exhausted)`);
        }
    }

    // Assertion 3: every member's final-round choice names a recognized algorithm.
    for (const r of results) {
        const choice = r.finalTag!.choice;
        if (!choice) {
            fail(`member "${r.member}" final <consensus> tag has no "choice" field`);
        }
        if (!KNOWN_RE.test(choice!)) {
            fail(`member "${r.member}" choice "${choice}" does not match known names (naive|kmp|boyer|sunday)`);
        }
        console.log(`  ${r.member}: final choice = ${choice!}  (rounds emitted: ${r.tags.length})`);
    }

    // Assertion 4: all members converged on the same algorithm.
    const choices = results.map(r => normalize(r.finalTag!.choice!));
    const unique = new Set(choices);
    if (unique.size !== 1) {
        fail(`members did not converge on a single algorithm: [${choices.join(", ")}]`);
    }

    console.log(`PASS: consensus reached on "${[...unique][0]}"; all members agreed.`);
}

main();
