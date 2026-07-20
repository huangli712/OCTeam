/**
 * Check script: iterative simulation convergence verdict quorum (5-way:
 * converged|diverged|inconclusive).
 *
 * Verifies the team_quorum run reached a valid verdict on whether an iterative
 * numerical simulation (with a monotonically decreasing residual sequence)
 * has converged. The residual data is designed to clearly indicate
 * convergence (R_n drops from 1e2 to 1e-10 over 20 iterations), so the
 * expected quorum winner is "converged".
 *
 * Usage:  bun check-physics-convergence.ts <run_dir>
 *   <run_dir>  directory containing record.json + per-member markdown outputs
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

const VOTE_RE = /<(?:vote|投票)>\s*(\{[\s\S]*?\})\s*<\/(?:vote|投票)>/
const KNOWN_OPTIONS = ["converged", "diverged", "inconclusive"]
const EXPECTED_VERDICT = "converged"

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
): Promise<string | null> {
    try {
        const raw = await readFile(join(runDir, `${member}.md`), "utf8")
        const match = raw.match(VOTE_RE)
        if (!match) return null
        const obj = JSON.parse(match[1]) as Record<string, unknown>
        const val = obj[voteKey]
        return typeof val === "string" ? val : null
    } catch {
        return null
    }
}

async function main(): Promise<void> {
    const runDir = process.argv[2]
    if (!runDir) {
        console.error("Usage: bun check-physics-convergence.ts <run_dir>")
        process.exit(2)
    }

    let record: RunRecord
    try {
        record = await loadRecord(runDir)
    } catch (err) {
        console.error(`IO error reading record.json: ${(err as Error).message}`)
        process.exit(2)
    }

    if (record.type !== "quorum") fail(`record.type is "${record.type}", expected "quorum"`)

    const q = record.quorum
    if (!q) fail("record has no quorum block")

    // Assertion 1: run succeeded.
    if (record.status !== "completed") {
        fail(`run status is "${record.status}", expected "completed"`)
    }

    // Assertion 2: winning verdict is a recognized value.
    const winner = q!.winningOption
    if (!winner) fail("no winningOption set")
    if (!KNOWN_OPTIONS.includes(winner!)) {
        fail(`winningOption "${winner}" not in {${KNOWN_OPTIONS.join("|")}}`)
    }

    // Assertion 3: for clearly-convergent residuals, verdict must be "converged".
    if (winner !== EXPECTED_VERDICT) {
        fail(`quorum chose "${winner}" but the residual sequence monotonically decreases from 1e2 to 1e-10 — expected "${EXPECTED_VERDICT}"`)
    }

    // Assertion 4: threshold/nEff consistency.
    const nEff = q!.nEff ?? 0
    const threshold = q!.threshold ?? 0
    const expectedThreshold = Math.floor(nEff / 2) + 1
    if (threshold !== expectedThreshold) {
        fail(`threshold=${threshold} but expected floor(${nEff}/2)+1=${expectedThreshold}`)
    }

    // Assertion 5: cross-validate ballots vs member.md.
    for (const member of q!.participants) {
        const memberVote = await loadMemberVote(runDir, member, q!.voteKey)
        const ballot = q!.ballots?.[member]
        if (!ballot) fail(`participant "${member}" has no ballot`)
        if (ballot!.status === "valid") {
            if (memberVote === null) fail(`member "${member}" valid ballot but no <vote> tag`)
            if (memberVote !== ballot!.vote) {
                fail(`member "${member}" record.json="${ballot!.vote}" but .md="${memberVote}"`)
            }
        }
        console.log(`  ${member}: ${ballot!.status}${ballot!.vote ? `=${ballot!.vote}` : ""}`)
    }

    // Assertion 6: winner count >= threshold.
    let winnerCount = 0
    for (const member of q!.participants) {
        const b = q!.ballots?.[member]
        if (b?.status === "valid" && b.vote === winner) winnerCount++
    }
    if (winnerCount < threshold) {
        fail(`winner got ${winnerCount} votes but threshold=${threshold}`)
    }

    console.log(`\nnEff=${nEff}, threshold=${threshold}, winner="${winner}" (${winnerCount} votes)`)
    console.log(`PASS: quorum correctly identified the simulation as "${EXPECTED_VERDICT}".`)
}

main()
