/**
 * Check script: 7-member compliance committee quorum (challenge-level:
 * approve|deny|escrow with N=7 and max_errored_members=2).
 *
 * Verifies the team_quorum run on a borderline GDPR cross-border data transfer
 * case. Unlike the baseline scenarios (which expect a specific winning option),
 * this challenge-level check validates the quorum MECHANISM itself at scale:
 *
 *   - The run terminated (SUCCEEDED or FAILED_NO_QUORUM — both are acceptable
 *     for a genuinely borderline case where opinion may split).
 *   - Ballots are fully persisted in record.json for audit.
 *   - threshold and nEff are mathematically correct for N=7.
 *   - If SUCCEEDED, winner is a recognized value and reached threshold.
 *   - If FAILED, the no-majority outcome is correctly recorded.
 *   - max_errored_members tolerance is reflected (errored ballots abstain).
 *
 * This exercises quorum's distinctive contracts that consensus/arena lack:
 *   (1) strict-majority thresholding (k > N_eff/2, not unanimity)
 *   (2) abstain semantics (errored/invalid ballots excluded from denominator)
 *   (3) explicit failure terminal state (FAILED_NO_QUORUM is a valid outcome)
 *
 * Usage:  bun check-governance-compliance.ts <run_dir>
 *   <run_dir>  directory containing record.json + per-member markdown outputs
 *              (expects alice.md through grace.md — 7 members)
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

const VOTE_RE = /<(?:vote|投票)>\s*(\{[\s\S]*?\})\s*<\/(?:vote|投票)>/
const KNOWN_OPTIONS = ["approve", "deny", "escrow"]
const EXPECTED_PARTICIPANT_COUNT = 7

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
        console.error("Usage: bun check-governance-compliance.ts <run_dir>")
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

    // Assertion 1: participant count is 7 (challenge-level scale).
    if (q!.participants.length !== EXPECTED_PARTICIPANT_COUNT) {
        fail(`expected ${EXPECTED_PARTICIPANT_COUNT} participants, got ${q!.participants.length}`)
    }

    // Assertion 2: run terminated with a valid quorum terminal state.
    // Both "completed" (SUCCEEDED) and "failed" (FAILED_NO_QUORUM) are acceptable
    // for a borderline compliance case — the point is that the mechanism resolves.
    const isSucceeded = record.status === "completed" && record.reason.startsWith("quorum_succeeded:")
    const isNoQuorum = record.status === "failed" && (
        record.reason === "quorum_no_majority" || record.reason === "quorum_all_errored"
    )
    // Note: member_error (runtime failure beyond tolerance) is NOT an acceptable
    // terminal state for this scenario — max_errored_members=2 should tolerate
    // up to 2 errored members, and 5 survivors can still reach majority (k=3).
    const isMemberError = record.status === "failed" && record.reason.startsWith("member_error")

    if (!isSucceeded && !isNoQuorum) {
        if (isMemberError) {
            fail(`run failed with "${record.reason}" — max_errored_members=2 should tolerate member errors for N=7 (expected quorum to still resolve)`)
        }
        fail(`unexpected terminal state: status="${record.status}", reason="${record.reason}"`)
    }

    // Assertion 3: nEff and threshold are mathematically correct.
    const nEff = q!.nEff ?? 0
    const threshold = q!.threshold ?? 0
    const expectedThreshold = Math.floor(nEff / 2) + 1
    if (threshold !== expectedThreshold) {
        fail(`threshold=${threshold} but expected floor(${nEff}/2)+1=${expectedThreshold}`)
    }

    // Assertion 4: every participant has a ballot in record.json (audit completeness).
    for (const member of q!.participants) {
        if (!q!.ballots?.[member]) {
            fail(`participant "${member}" missing from record.json ballots — audit incomplete`)
        }
    }

    // Assertion 5: cross-validate ballots vs member.md <vote> tags.
    let validCount = 0
    let erroredCount = 0
    for (const member of q!.participants) {
        const ballot = q!.ballots?.[member]!
        const memberVote = await loadMemberVote(runDir, member, q!.voteKey)

        if (ballot.status === "valid") {
            validCount++
            if (memberVote === null) {
                fail(`member "${member}" ballot=valid but no <vote> tag in .md`)
            }
            if (memberVote !== ballot.vote) {
                fail(`member "${member}" record.json="${ballot.vote}" but .md="${memberVote}"`)
            }
            if (!KNOWN_OPTIONS.includes(ballot.vote)) {
                fail(`member "${member}" vote="${ballot.vote}" not in {${KNOWN_OPTIONS.join("|")}}`)
            }
        } else {
            erroredCount++
        }
        console.log(`  ${member}: ${ballot.status}${ballot.vote ? `=${ballot.vote}` : ""}`)
    }

    // Assertion 6: erroredCount in record matches nEff derivation.
    const expectedNEff = q!.participants.length - erroredCount
    if (nEff !== expectedNEff) {
        fail(`nEff=${nEff} but participants(${q!.participants.length}) - erroredCount(${erroredCount}) = ${expectedNEff}`)
    }

    // Assertion 7: if SUCCEEDED, winner reached threshold.
    if (isSucceeded) {
        const winner = q!.winningOption
        if (!winner) fail("run succeeded but winningOption missing")
        if (!KNOWN_OPTIONS.includes(winner!)) {
            fail(`winningOption "${winner}" not in {${KNOWN_OPTIONS.join("|")}}`)
        }
        let winnerCount = 0
        for (const member of q!.participants) {
            const b = q!.ballots?.[member]
            if (b?.status === "valid" && b.vote === winner) winnerCount++
        }
        if (winnerCount < threshold) {
            fail(`winner "${winner}" got ${winnerCount} votes but threshold=${threshold}`)
        }
        console.log(`\nVerdict: SUCCEEDED — "${winner}" (${winnerCount}/${nEff} valid ballots, threshold=${threshold})`)
    } else {
        console.log(`\nVerdict: FAILED_NO_QUORUM — no option reached threshold=${threshold} (valid=${validCount}, abstained=${erroredCount})`)
    }

    // Assertion 8 (DOWNGRADED TO WARNING): at least one member's argument references
    // a compliance keyword (confirming the debate is anchored on the GDPR scenario,
    // not generic). Downgraded because reviewers may use technical shorthand (SCC,
    // TIA, FISA, Schrems) or write in Chinese (合规/数据传输/隐私) — the keyword list
    // cannot exhaustively cover all valid forms. Reported as a warning, not a FAIL.
    let hasComplianceKeyword = false
    const KEYWORDS = ["gdpr", "compliance", "cross-border", "data transfer", "privacy"]
    for (const member of q!.participants) {
        try {
            const raw = await readFile(join(runDir, `${member}.md`), "utf8")
            const lower = raw.toLowerCase()
            if (KEYWORDS.some(k => lower.includes(k))) {
                hasComplianceKeyword = true
                break
            }
        } catch {
            // member.md may not exist for errored members — skip
        }
    }
    if (!hasComplianceKeyword) {
        console.warn(`WARNING: no member argument references compliance keywords {${KEYWORDS.join(", ")}} — reviewers may use technical shorthand (SCC/TIA/FISA) or non-English rationales`)
    }

    console.log(`\nN=${q!.participants.length}, nEff=${nEff}, threshold=${threshold}, errored/abstained=${erroredCount}`)
    console.log(`PASS: quorum mechanism correctly resolved at challenge-level scale.`)
}

main()
