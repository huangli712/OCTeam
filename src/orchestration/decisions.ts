/**
 * Pure decision/output parsers and consensus/quorum predicates shared across
 * the per-mode idle handlers. Extracted from the original god-file so each
 * parser can be unit-tested without dragging in dispatch state.
 *
 * Conventions (i18n-safe):
 *   - Every parser accepts both the English tag and its Chinese alias so a
 *     non-English agent emitting <决策>/<裁决>/<判定>/<分解>/<共识> is recognized.
 *   - `parseFailed` semantics differ per parser (see each docstring): for some
 *     it is a hard failure (loop aborts at 3 parse failures), for others an
 *     explicit tag-with-no-payload, and for parseDecompose it is NOT a failure
 *     signal at all (absent tag = solve directly = leaf).
 */

import type { ActiveTask, DecisionRecord, Verdict } from "../core/types.js"

// Structured, i18n-consistent "no issues" signal for loop read_only stages. A
// read_only stage emits <no_issues/> (or the Chinese <无问题/>) to declare clean.
// Replaces the old English keyword-substring heuristic, which both false-matched
// negated contexts ("there are no issues with X, but bugs in Y") and never fired
// for non-English agents.
const NO_ISSUES_TAG = /<(?:no_issues|无问题)\s*\/?>/

/**
 * Parse a decider's <decision>{...}</decision> block. On missing/invalid JSON,
 * returns parseFailed:true so handleLoopIdle can count consecutive failures
 * (loop aborts at 3). Defaults to "continue" on failure.
 */
export function parseDecision(rawText: string): DecisionRecord & { parseFailed?: boolean } {
    const fail = (): DecisionRecord & { parseFailed: boolean } => ({
        round: 0,
        decision: "continue",
        rationale: "Decision parse failed; defaulting to continue",
        nextActions: [],
        timestamp: Date.now(),
        parseFailed: true,
    })
    // Greedy {...} so nested braces (e.g. structured nextActions) parse correctly (L2).
    const match = rawText?.match(/<(?:decision|决策)>\s*(\{[\s\S]*\})\s*<\/(?:decision|决策)>/)
    if (!match) return fail()
    try {
        const parsed = JSON.parse(match[1])
        return {
            round: 0,
            decision: parsed.decision === "done" || parsed.done === true ? "done" : "continue",
            rationale: parsed.rationale ?? "No rationale provided",
            nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions : [],
            timestamp: Date.now(),
        }
    } catch {
        return fail()
    }
}

/**
 * Parse a router's <route>{...}</route> (or <路由>) decision block into the
 * selected branch names. Pure extraction — branch existence is validated in
 * handleRouteIdle. Returns parseFailed:true when no tag or no names are found.
 * Accepts branch/branches/target/targets aliases for LLM robustness.
 */
export function parseRouteDecision(
    rawText: string,
): { targets: string[]; rationale: string; parseFailed?: boolean } {
    const match = rawText?.match(/<(?:route|路由)>\s*(\{[\s\S]*\})\s*<\/(?:route|路由)>/)
    if (!match) return { targets: [], rationale: "", parseFailed: true }
    try {
        const p = JSON.parse(match[1]) as Record<string, unknown>
        const raw = p.branches ?? p.targets ?? p.branch ?? p.target
        const targets = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
            .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
        if (targets.length === 0) return { targets: [], rationale: "", parseFailed: true }
        return {
            targets,
            rationale: typeof p.rationale === "string" ? p.rationale : "",
        }
    } catch {
        return { targets: [], rationale: "", parseFailed: true }
    }
}

/**
 * Parse an arbiter's <ruling>{...}</ruling> (or <裁决>) decision block into the
 * binding ruling and rationale. Accepts decision/ruling aliases; a non-empty
 * ruling is required, else parseFailed. Single ruling (no retry counting,
 * unlike loop's parseDecision).
 */
export function parseArbitrationDecision(
    rawText: string,
): { ruling: string; rationale: string; parseFailed?: boolean } {
    const match = rawText?.match(/<(?:ruling|裁决)>\s*(\{[\s\S]*\})\s*<\/(?:ruling|裁决)>/)
    if (!match) return { ruling: "", rationale: "", parseFailed: true }
    try {
        const p = JSON.parse(match[1]) as Record<string, unknown>
        const ruling = typeof p.decision === "string"
            ? p.decision
            : typeof p.ruling === "string" ? p.ruling : ""
        if (!ruling) return { ruling: "", rationale: "", parseFailed: true }
        return {
            ruling,
            rationale: typeof p.rationale === "string" ? p.rationale : "",
        }
    } catch {
        return { ruling: "", rationale: "", parseFailed: true }
    }
}

/**
 * Parse a verifier's <verdict>{...}</verdict> (or <判定>) block into the
 * three-valued verdict (PASS/FAIL/INVALID) plus rationale and diff. Mirrors
 * parseArbitrationDecision's regex/JSON shape but owns a DISTINCT tag:
 * <verdict>/<判定>. It MUST NOT reuse <裁决>, which parseArbitrationDecision
 * owns (a shared tag would cross-wire arbitrate and tollgate parsing).
 * An absent/invalid tag returns parseFailed so handleTollgateIdle treats the
 * response as INVALID (the verifier could not evaluate), NOT a producer FAIL.
 */
export function parseVerdict(
    rawText: string,
): { verdict?: Verdict; rationale: string; diff: string; parseFailed?: boolean } {
    const match = rawText?.match(/<(?:verdict|判定)>\s*(\{[\s\S]*\})\s*<\/(?:verdict|判定)>/)
    if (!match) return { rationale: "", diff: "", parseFailed: true }
    try {
        const p = JSON.parse(match[1]) as Record<string, unknown>
        const raw = typeof p.result === "string" ? p.result.toUpperCase() : ""
        if (raw !== "PASS" && raw !== "FAIL" && raw !== "INVALID") {
            return { rationale: "", diff: "", parseFailed: true }
        }
        return {
            verdict: raw as Verdict,
            rationale: typeof p.rationale === "string" ? p.rationale : "",
            diff: typeof p.diff === "string" ? p.diff : "",
        }
    } catch {
        return { rationale: "", diff: "", parseFailed: true }
    }
}

/**
 * Parse a member's <decompose>{...}</decompose> (or <分解>) block into the
 * proposed subtasks. Unlike parseDecision/parseRouteDecision, parseFailed is
 * NOT a failure signal: an absent tag means "solve directly" (a leaf). Only an
 * explicit tag with no valid subtasks yields parseFailed.
 */
export function parseDecompose(
    rawText: string,
): { subtasks: { subject: string; description: string }[]; parseFailed?: boolean } {
    const match = rawText?.match(/<(?:decompose|分解)>\s*(\{[\s\S]*\})\s*<\/(?:decompose|分解)>/)
    if (!match) return { subtasks: [] }
    try {
        const p = JSON.parse(match[1]) as { subtasks?: unknown }
        const arr = Array.isArray(p.subtasks) ? p.subtasks : []
        const subtasks: { subject: string; description: string }[] = []
        for (const item of arr) {
            if (
                typeof item === "object" && item !== null
                && "subject" in item && typeof item.subject === "string" && item.subject.length > 0
                && "description" in item && typeof item.description === "string" && item.description.length > 0
            ) {
                subtasks.push({ subject: item.subject, description: item.description })
            }
        }
        if (subtasks.length === 0) return { subtasks: [], parseFailed: true }
        return { subtasks }
    } catch {
        return { subtasks: [], parseFailed: true }
    }
}

/** Loop exit condition 2: every read_only stage emitted a <no_issues/> tag. */
export function allReadOnlyStagesReportNoIssues(task: ActiveTask): boolean {
    const roStages = task.stages.filter(s => s.action === "read_only")
    if (roStages.length === 0) return false
    return roStages.every(s => NO_ISSUES_TAG.test(task.responses[s.member] ?? ""))
}

/** Consensus: every participant must emit agreed consensus. */
export function allMembersAgree(responses: Record<string, string>): boolean {
    const texts = Object.values(responses)
    if (texts.length === 0) return false
    return texts.every(t => {
        // Bilingual tag, aligned with parseDecision's <(?:decision|决策)> so a
        // non-English agent emitting <共识> is recognized.
        const m = t.match(/<(?:consensus|共识)>\s*(\{[\s\S]*\})\s*<\/(?:consensus|共识)>/)
        if (!m) return false
        try {
            return JSON.parse(m[1]).agreed === true
        } catch {
            return false
        }
    })
}

/**
 * Parse a <signoff>{"approved": true|false, "rationale": "..."}</signoff> block
 * from a reviewer's output. Returns null if no valid signoff tag found.
 */
export function parseSignoff(text: string): { approved: boolean; rationale: string } | null {
    const m = text?.match(/<signoff>\s*(\{[\s\S]*\})\s*<\/signoff>/)
    if (!m) return null
    try {
        const parsed = JSON.parse(m[1])
        return {
            approved: parsed.approved === true,
            rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
        }
    } catch {
        return null
    }
}

/**
 * Check peer-quorum signoff status. Returns whether all reviewers have
 * responded, whether the quorum threshold was reached, and the approval count.
 * Exported for unit testing.
 */
export function isQuorumReached(
    approvals: Record<string, boolean>,
    reviewerCount: number,
    quorum: number,
): { allResponded: boolean; reached: boolean; approvedCount: number } {
    const responses = Object.keys(approvals).length
    const allResponded = responses >= reviewerCount
    const approvedCount = Object.values(approvals).filter(Boolean).length
    const reached = allResponded && reviewerCount > 0 && approvedCount / reviewerCount >= quorum
    return { allResponded, reached, approvedCount }
}
