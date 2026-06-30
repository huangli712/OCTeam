/**
 * Check script: 8 sorting algorithms benchmark (challenge scenario).
 *
 * Each coder member implemented ONE sorting algorithm and ran it on 3 datasets
 * of size 10^6: (a) uniform-random, (b) nearly-sorted, (c) reverse-sorted.
 * The member self-reports correctness (all 3 outputs match the native sort)
 * via SORT_OK and the wall-clock ms of each run via the three TIME markers.
 *
 * This script verifies the self-reported markers are present and well-formed
 * across all 8 members: 8 × SORT_OK=true and 8 × 3 = 24 TIME markers.
 *
 * Usage:  bun check-coding-sort-benchmark.ts <run_dir>
 *   <run_dir>  directory containing alice.md ... henry.md (8 files)
 *
 * Exit codes:  0 PASS  |  1 FAIL  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Members map 1:1 to algorithms, in MEMBER_NAME_POOL order.
const MEMBERS = [
    "alice", "bob", "carol", "dave", "erin", "frank", "grace", "henry",
] as const;

const ALGORITHMS: Record<string, string> = {
    alice: "quicksort",
    bob: "mergesort",
    carol: "heapsort",
    dave: "radixsort",
    erin: "timsort",
    frank: "shellsort",
    grace: "introsort",
    henry: "counting-sort",
};

// `true`/`false` captured verbatim; we assert the member reported "true".
const SORT_OK_RE = /<!--\s*SORT_OK:\s*(true|false)\s*-->/i;
// Non-negative real milliseconds (e.g. 312, 89.4, 1230).
const TIME_RANDOM_RE = /<!--\s*TIME_RANDOM:\s*([\d.]+)\s*-->/;
const TIME_NEARLY_RE = /<!--\s*TIME_NEARLY:\s*([\d.]+)\s*-->/;
const TIME_REVERSE_RE = /<!--\s*TIME_REVERSE:\s*([\d.]+)\s*-->/;

interface MemberResult {
    member: string;
    algorithm: string;
    sortOk: boolean;
    randomMs: number | null;
    nearlyMs: number | null;
    reverseMs: number | null;
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function loadMember(runDir: string, member: string): Promise<string> {
    const path = join(runDir, `${member}.md`);
    try {
        return await readFile(path, "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }
}

function extractBool(raw: string, re: RegExp, member: string, marker: string): boolean {
    const m = raw.match(re);
    if (!m) {
        fail(`member "${member}" did not emit a <!-- ${marker}: ... --> marker`);
    }
    return m![1].toLowerCase() === "true";
}

function extractMs(raw: string, re: RegExp, member: string, marker: string): number {
    const m = raw.match(re);
    if (!m) {
        fail(`member "${member}" did not emit a <!-- ${marker}: ... --> marker`);
    }
    const ms = Number(m![1]);
    if (!Number.isFinite(ms) || ms < 0) {
        fail(`member "${member}" ${marker} value "${m![1]}" is not a non-negative number`);
    }
    return ms;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-sort-benchmark.ts <run_dir>");
        process.exit(2);
    }

    const results: MemberResult[] = [];

    for (const member of MEMBERS) {
        const raw = await loadMember(runDir, member);

        // Assertion: SORT_OK marker present and equal to true.
        const sortOk = extractBool(raw, SORT_OK_RE, member, "SORT_OK");
        if (!sortOk) {
            fail(`member "${member}" reported SORT_OK=false (one or more datasets did not match the native sort)`);
        }

        // Assertion: all three TIME markers present and numeric.
        const randomMs = extractMs(raw, TIME_RANDOM_RE, member, "TIME_RANDOM");
        const nearlyMs = extractMs(raw, TIME_NEARLY_RE, member, "TIME_NEARLY");
        const reverseMs = extractMs(raw, TIME_REVERSE_RE, member, "TIME_REVERSE");

        results.push({
            member,
            algorithm: ALGORITHMS[member],
            sortOk,
            randomMs,
            nearlyMs,
            reverseMs,
        });
    }

    // Assertion: all 8 members reported SORT_OK=true (already enforced above)
    // and we have exactly 24 TIME markers (8 members x 3), which is implied by
    // the per-member extraction succeeding for all 8.
    const okCount = results.filter((r) => r.sortOk).length;
    if (okCount !== 8) {
        fail(`expected 8/8 SORT_OK=true, got ${okCount}`);
    }
    const timeMarkerCount = results.reduce(
        (acc, r) => acc + (r.randomMs !== null ? 1 : 0) + (r.nearlyMs !== null ? 1 : 0) + (r.reverseMs !== null ? 1 : 0),
        0,
    );
    if (timeMarkerCount !== 24) {
        fail(`expected 24 TIME markers, got ${timeMarkerCount}`);
    }

    // Comparison table for human inspection.
    console.log("All 8 algorithms sorted all 3 datasets correctly (SORT_OK=true).");
    console.log("");
    console.log("Benchmark (ms) — 3 datasets x 10^6 integers:");
    console.log("  member | algorithm      | random | nearly | reverse");
    console.log("  -------|----------------|--------|--------|--------");
    for (const r of results) {
        const algo = r.algorithm.padEnd(14);
        const rnd = String(r.randomMs).padStart(6);
        const nar = String(r.nearlyMs).padStart(6);
        const rev = String(r.reverseMs).padStart(6);
        console.log(`  ${r.member} | ${algo} | ${rnd} | ${nar} | ${rev}`);
    }
    console.log("");
    console.log("PASS: 8/8 SORT_OK=true; 24/24 TIME markers present.");
}

main();
