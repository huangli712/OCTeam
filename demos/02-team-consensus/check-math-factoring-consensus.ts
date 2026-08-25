/**
 * Check script: 60-digit RSA modulus factoring algorithm consensus
 * (6-way challenge debate).
 *
 * Verifies the team_consensus run reached genuine agreement on the best
 * practical classical factoring algorithm for a ~60-digit (~200-bit) RSA
 * modulus: every member's final-round <consensus> tag has agreed=true and a
 * choice drawn from the recognized factoring-method set, and at least one
 * member's rationale references a key domain term
 * (sub-exponential | 60-digit | rsa | quantum).
 *
 * Usage:  bun check-math-factoring-consensus.ts <run_dir>
 *   <run_dir>  directory containing the per-member markdown outputs
 *              (expects alice.md, bob.md, carol.md, dave.md, erin.md, frank.md)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MEMBERS = ["alice", "bob", "carol", "dave", "erin", "frank"] as const;
// matchAll requires the global flag; each call clones the regex so reuse is safe.
const CONSENSUS_RE = /<consensus>([\s\S]*?)<\/consensus>/g;
// Recognized factoring-method choice tokens for the 60-digit RSA debate.
const ALLOWED_CHOICES = new Set([
    "nfs",
    "number-field-sieve",
    "quadratic-sieve",
    "qs",
    "pollard-rho",
    "ecm",
    "shor",
    "trial-division",
]);
// Key domain terms the debate rationale should reference at least once.
const KEY_TERM_RES: RegExp[] = [
    /sub-?exponential/i,
    /60[\s-]?digit/i,
    /\brsa\b/i,
    /quantum/i,
];

interface ConsensusTag {
    agreed: boolean;
    choice?: string;
}

interface MemberResult {
    member: string;
    raw: string;
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
    return { member, raw, tags, finalTag };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

// Normalize a choice so "Number Field Sieve", "NFS", "Shor's algorithm",
// "Pollard's rho", "Lenstra ECM" all collapse to a canonical allowed token.
function normalize(choice: string): string {
    const c = choice
        .toLowerCase()
        .replace(/\b(algorithm|method|factorization|factoring)\b/g, " ")
        .replace(/['']/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const MAP: Record<string, string> = {
        "pollards-rho": "pollard-rho",
        "lenstra-ecm": "ecm",
        "elliptic-curve": "ecm",
        "shors": "shor",
        "trial": "trial-division",
        "quadratic": "quadratic-sieve",
        // "Full Name (ABBREV)" variants: the parenthesized abbreviation
        // duplicates the spelled-out method and must not block the match.
        "number-field-sieve-nfs": "nfs",
        "quadratic-sieve-qs": "quadratic-sieve",
    };
    return MAP[c] ?? c;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-factoring-consensus.ts <run_dir>");
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

    // Assertion 2: every member's final-round tag has agreed=true
    // (genuine consensus, not max_rounds exhaustion).
    for (const r of results) {
        if (!r.finalTag!.agreed) {
            fail(`member "${r.member}" final round did not emit agreed:true (consensus not reached; max_rounds likely exhausted)`);
        }
    }

    // Assertion 3: every member's final-round choice is in the allowed
    // factoring-method set (after canonical normalization).
    for (const r of results) {
        const choice = r.finalTag!.choice;
        if (!choice) {
            fail(`member "${r.member}" final <consensus> tag has no "choice" field`);
        }
        const norm = normalize(choice!);
        if (!ALLOWED_CHOICES.has(norm)) {
            fail(`member "${r.member}" choice "${choice}" (normalized "${norm}") is not in the allowed factoring-method set (nfs|number-field-sieve|quadratic-sieve|qs|pollard-rho|ecm|shor|trial-division)`);
        }
        console.log(`  ${r.member}: final choice = ${choice!}  (rounds emitted: ${r.tags.length})`);
    }

    // Assertion 4: at least one member's rationale mentions a key domain term,
    // confirming the debate stayed anchored on the RSA-modulus factoring problem.
    const termsFound: string[] = [];
    for (const r of results) {
        for (const re of KEY_TERM_RES) {
            const m = r.raw.match(re);
            if (m) {
                termsFound.push(`${r.member}:${m[0]}`);
                break; // one term per member is enough
            }
        }
    }
    if (termsFound.length === 0) {
        fail(`no member rationale mentions any key term (sub-exponential | 60-digit | rsa | quantum)`);
    }

    console.log(`PASS: all 6 members agreed; key terms referenced: ${termsFound.join(", ")}.`);
}

main();
