/**
 * Check script: Number-theory puzzle suite (5 independent tasks).
 *
 * In delegate mode any of the 3 mathematician members may claim any of the
 * 5 tasks, so we scan every <run_dir>/*.md file and collect all ANSWER
 * markers. Pass iff the union of reported answers contains all 5 expected
 * values (25, 21, true, 56, 4).
 *
 * Usage:  bun check-math-number-theory.ts <run_dir>
 *   <run_dir>  directory containing <member>.md outputs from all claimers
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

interface Expected {
    label: string;
    value: number | string;
}

// Ground-truth answers for the 5 number-theory puzzles.
const EXPECTED: Expected[] = [
    { label: "primes<100", value: 25 },
    { label: "gcd(1071,462)", value: 21 },
    { label: "is-997-prime", value: "true" },
    { label: "sum-divisors-28", value: 56 },
    { label: "modinv-3-mod-11", value: 4 },
];

const ANSWER_RE = /<!--\s*ANSWER:\s*(.+?)\s*-->/g;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function valuesMatch(reported: string, expected: number | string): boolean {
    if (typeof expected === "number") {
        const n = Number(reported);
        return !Number.isNaN(n) && n === expected;
    }
    return reported.trim().toLowerCase() === expected.toLowerCase();
}

/**
 * Delegate members deliver markers via team_send_message, which land in
 * <team_dir>/mailbox/*.jsonl (not in the captured .md turn output). Each
 * JSONL line has a `body` field carrying the message content. This returns
 * all message bodies so their markers are not missed.
 */
async function loadMailboxBodies(teamDir: string): Promise<string[]> {
    const mailboxDir = join(teamDir, "mailbox");
    let entries: string[];
    try {
        entries = await readdir(mailboxDir);
    } catch {
        return []; // no mailbox dir (non-delegate modes) — nothing to merge
    }
    const bodies: string[] = [];
    for (const entry of entries.filter((e) => e.endsWith(".jsonl"))) {
        const raw = await readFile(join(mailboxDir, entry), "utf8");
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const msg = JSON.parse(trimmed);
                if (typeof msg.body === "string") {
                    bodies.push(msg.body);
                }
            } catch {
                // skip malformed JSONL lines
            }
        }
    }
    return bodies;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-number-theory.ts <run_dir>");
        process.exit(2);
    }

    let files: string[];
    try {
        files = (await readdir(runDir)).filter((f) => f.endsWith(".md"));
    } catch (err) {
        console.error(`IO error reading run dir: ${(err as Error).message}`);
        process.exit(2);
    }
    if (files.length === 0) {
        fail(`no .md member outputs found in ${runDir}`);
    }

    // Collect every ANSWER marker across all member outputs.
    const reported: string[] = [];
    try {
        for (const f of files) {
            const raw = await readFile(join(runDir, f), "utf8");
            for (const m of raw.matchAll(ANSWER_RE)) {
                reported.push(m[1].trim());
            }
        }
        // Merge mailbox messages: delegate members deliver markers via
        // team_send_message, which land in <team_dir>/mailbox/*.jsonl —
        // not in the captured .md turn output.
        const teamDir = resolve(runDir, "../..");
        const mailboxBodies = await loadMailboxBodies(teamDir);
        for (const body of mailboxBodies) {
            for (const m of body.matchAll(ANSWER_RE)) {
                reported.push(m[1].trim());
            }
        }
    } catch (err) {
        console.error(`IO error reading member output: ${(err as Error).message}`);
        process.exit(2);
    }

    console.log(
        `  collected ${reported.length} ANSWER marker(s) from ${files.length} file(s): [${reported.join(", ")}]`,
    );

    // Assertion: each expected answer is present at least once.
    for (const exp of EXPECTED) {
        const found = reported.some((r) => valuesMatch(r, exp.value));
        if (!found) {
            fail(`expected answer "${exp.value}" (${exp.label}) not found in any member output`);
        }
    }

    console.log(`PASS: all ${EXPECTED.length} expected answers present.`);
}

main();
