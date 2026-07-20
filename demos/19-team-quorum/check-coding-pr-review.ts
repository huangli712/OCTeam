/**
 * Check script: PR merge approval quorum vote (3-way: ship/hold/block).
 *
 * Verifies the team_quorum run reached a valid verdict on whether to merge
 * a bugfix PR: the run terminated with a SUCCEEDED status, the winning
 * option is a recognized value (ship|hold|block), and record.json's quorum
 * block ballots are consistent with the <vote> tags in each member's .md.
 *
 * Usage:  bun check-coding-pr-review.ts <run_dir>
 *   <run_dir>  directory containing record.json + per-member markdown outputs
 *              (expects alice.md, bob.md, carol.md)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

const VOTE_RE = /<(?:vote|投票)>\s*(\{[\s\S]*?\})\s*<\/(?:vote|投票)>/
const KNOWN_OPTIONS = ["ship", "hold", "block"]

interface QuorumBallot {
    vote: string
    rationale?: string
    status: "valid" | "invalid" | "errored"
}

interface RunRecord {
    type: string
    status: string
    reason: string
    quorum?: {
        task: string
        voteKey: string
        voteOptions?: string[]
        participants: string[]
        ballots?: Record<string, QuorumBallot>
        erroredCount?: number
        nEff?: number
        threshold?: number
        winningOption?: string
    }
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
}

async function loadRecord(runDir: string): Promise<RunRecord> {
    const raw = await readFile(join(runDir, "record.json"), "utf8")
    return JSON.parse(raw) as RunRecord
}

async function loadMemberVote(
    runDir: string,
    member: string,
    voteKey: string,
): Promise<{ vote: string | null; raw: string }> {
    try {
        const raw = await readFile(join(runDir, `${member}.md`), "utf8")
        const match = raw.match(VOTE_RE)
        if (!match) return { vote: null, raw }
        const obj = JSON.parse(match[1]) as Record<string, unknown>
        const val = obj[voteKey]
        return { vote: typeof val === "string" ? val : null, raw }
    } catch {
        return { vote: null, raw: "" }
    }
}

async function main(): Promise<void> {
    const runDir = process.argv[2]
    if (!runDir) {
        console.error("Usage: bun check-coding-pr-review.ts <run_dir>")
        process.exit(2)
    }

    let record: RunRecord
    try {
        record = await loadRecord(runDir)
    } catch (err) {
        console.error(`IO error reading record.json: ${(err as Error).message}`)
        process.exit(2)
    }

    // Assertion 1: record type is quorum.
    if (record.type !== "quorum") {
        fail(`record.type is "${record.type}", expected "quorum"`)
    }

    // Assertion 2: quorum block exists.
    const q = record.quorum
    if (!q) fail("record has no quorum block")

    // Assertion 3: run succeeded (a winning option was determined).
    if (record.status !== "completed") {
        fail(`run status is "${record.status}", expected "completed" (a clean PR should reach majority)`)
    }

    // Assertion 4: winning option is a recognized value.
    const winner = q!.winningOption
    if (!winner) fail("no winningOption set (run succeeded but winningOption is missing)")
    if (!KNOWN_OPTIONS.includes(winner!)) {
        fail(`winningOption "${winner}" not in recognized set {${KNOWN_OPTIONS.join("|")}}`)
    }

    // Assertion 5: threshold and nEff are consistent.
    const nEff = q!.nEff ?? 0
    const threshold = q!.threshold ?? 0
    const expectedThreshold = Math.floor(nEff / 2) + 1
    if (threshold !== expectedThreshold) {
        fail(`threshold=${threshold} but expected floor(${nEff}/2)+1=${expectedThreshold}`)
    }

    // Assertion 6: cross-validate record.json ballots against member.md <vote> tags.
    for (const member of q!.participants) {
        const memberResult = await loadMemberVote(runDir, member, q!.voteKey)
        const ballot = q!.ballots?.[member]
        if (!ballot) {
            fail(`participant "${member}" has no ballot in record.json`)
        }
        // Errored/invalid ballots may not have a member.md <vote> tag — skip cross-check.
        if (ballot!.status === "valid") {
            if (memberResult.vote === null) {
                fail(`member "${member}" ballot says valid vote="${ballot!.vote}" but no <vote> tag found in ${member}.md`)
            }
            if (memberResult.vote !== ballot!.vote) {
                fail(`member "${member}" record.json vote="${ballot!.vote}" but member.md vote="${memberResult.vote}"`)
            }
        }
        console.log(`  ${member}: ${ballot!.status}${ballot!.vote ? `=${ballot!.vote}` : ""}`)
    }

    // Assertion 7: winner's vote count actually reached threshold.
    let winnerCount = 0
    for (const member of q!.participants) {
        const b = q!.ballots?.[member]
        if (b?.status === "valid" && b.vote === winner) winnerCount++
    }
    if (winnerCount < threshold) {
        fail(`winner "${winner}" got ${winnerCount} votes but threshold=${threshold}`)
    }

    console.log(`\nnEff=${nEff}, threshold=${threshold}, winner="${winner}" (${winnerCount} votes)`)
    console.log(`PASS: quorum reached majority on "${winner}".`)
}

main()
