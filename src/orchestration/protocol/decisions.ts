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

import type {
    ActiveTask,
    ArenaCandidateScore,
    DecisionRecord,
    Verdict,
    WorkflowIssue,
    WorkflowIssueSeverity,
} from "../../core/types.js"

// Structured, i18n-consistent "no issues" signal for loop read_only stages. A
// read_only stage emits <no_issues/> (or the Chinese <无问题/>) to declare clean.
// Replaces the old English keyword-substring heuristic, which both false-matched
// negated contexts ("there are no issues with X, but bugs in Y") and never fired
// for non-English agents.
const NO_ISSUES_TAG = /<(?:no_issues|无问题)\s*\/?>/

/**
 * Extract and JSON.parse a `<tag>{...}</tag>` block from text. Supports an
 * optional Chinese alias for i18n-robust matching (see file header). Returns:
 *   - the parsed object on success
 *   - `null` when the tag is absent (regex does not match)
 *   - `undefined` when the tag is present but the payload fails to parse
 * Most parsers conflate both failure modes via `!p`; parseDecompose is the
 * exception that distinguishes absent (leaf) from malformed (parseFailed).
 */
function extractTaggedJSON(
    text: string,
    en: string,
    zh?: string,
): Record<string, unknown> | null | undefined {
    const tag = zh ? `(?:${en}|${zh})` : en
    // Lazy quantifier so each tag block captures only its own {...} payload,
    // not spanning across multiple same-named tags. Match ALL occurrences and
    // return the LAST parseable one: when a decider restates a prior decision
    // before issuing a new one, the latest (last) block is authoritative.
    const re = new RegExp(`<${tag}>\\s*(\\{[\\s\\S]*?\\})\\s*</${tag}>`, "g")
    const matches = [...(text?.matchAll(re) ?? [])]
    if (matches.length === 0) return null
    for (let i = matches.length - 1; i >= 0; i--) {
        try {
            return JSON.parse(matches[i][1]) as Record<string, unknown>
        } catch {
            // this block's payload didn't parse — try earlier blocks
        }
    }
    return undefined
}

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
    const parsed = extractTaggedJSON(rawText, "decision", "决策")
    if (!parsed) return fail()
    return {
        round: 0,
        decision: parsed.decision === "done" || parsed.done === true ? "done" : "continue",
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "No rationale provided",
        nextActions: Array.isArray(parsed.nextActions)
            ? parsed.nextActions.filter((a): a is string => typeof a === "string")
            : [],
        timestamp: Date.now(),
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
    const p = extractTaggedJSON(rawText, "route", "路由")
    if (!p) return { targets: [], rationale: "", parseFailed: true }
    const raw = p.branches ?? p.targets ?? p.branch ?? p.target
    const targets = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
        .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
    if (targets.length === 0) return { targets: [], rationale: "", parseFailed: true }
    return {
        targets,
        rationale: typeof p.rationale === "string" ? p.rationale : "",
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
    const p = extractTaggedJSON(rawText, "ruling", "裁决")
    if (!p) return { ruling: "", rationale: "", parseFailed: true }
    const ruling = typeof p.decision === "string"
        ? p.decision
        : typeof p.ruling === "string" ? p.ruling : ""
    if (!ruling) return { ruling: "", rationale: "", parseFailed: true }
    return {
        ruling,
        rationale: typeof p.rationale === "string" ? p.rationale : "",
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
): { verdict?: Verdict; rationale: string; diff: string; score?: number; confidence?: number; issues?: WorkflowIssue[]; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "verdict", "判定")
    if (!p) return { rationale: "", diff: "", parseFailed: true }
    const raw = typeof p.result === "string" ? p.result.trim().toUpperCase() : ""
    if (raw !== "PASS" && raw !== "FAIL" && raw !== "INVALID") {
        return { rationale: "", diff: "", parseFailed: true }
    }
    return {
        verdict: raw as Verdict,
        rationale: typeof p.rationale === "string" ? p.rationale : "",
        diff: typeof p.diff === "string" ? p.diff : "",
        score: typeof p.score === "number" && Number.isFinite(p.score) ? p.score : undefined,
        confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence) ? p.confidence : undefined,
        issues: parseWorkflowIssues(p.issues),
    }
}

/** Parse a reducer's <selection>{"winner":"..."}</selection> block into the winning branch name. */
export function parseSelection(
    rawText: string,
): { winner: string; rationale: string; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "selection")
    if (!p || typeof p.winner !== "string" || p.winner.length === 0) {
        return { winner: "", rationale: "", parseFailed: true }
    }
    return {
        winner: p.winner,
        rationale: typeof p.rationale === "string" ? p.rationale : "",
    }
}

/**
 * Parse an evaluator's <scoreboard>{...}</scoreboard> (or <评分板>) block into
 * the per-candidate scores. Mirrors parseVerdict/parseSelection's tagged-JSON
 * shape but owns a DISTINCT tag: <scoreboard>/<评分板>. An absent tag or
 * malformed JSON returns parseFailed. `scores` must be a non-empty array; each
 * retained entry needs a string `member`; `score` and each `metrics` value are
 * coerced to FINITE numbers (non-finite values are dropped); `passed` defaults
 * to false when absent; `rationale` is optional. Invalid entries are dropped;
 * duplicate `member` entries are PRESERVED (dedup is a selection concern, not a
 * parse one). Empty or all-invalid `scores` yields parseFailed.
 */
export function parseScoreboard(
    rawText: string,
): { scores: ArenaCandidateScore[]; rationale: string; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "scoreboard", "评分板")
    if (!p || !Array.isArray(p.scores)) return { scores: [], rationale: "", parseFailed: true }
    const scores: ArenaCandidateScore[] = []
    for (const item of p.scores) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue
        if (!("member" in item) || typeof item.member !== "string" || item.member.length === 0) continue
        const entry: ArenaCandidateScore = {
            member: item.member,
            passed: "passed" in item && item.passed === true,
        }
        if (typeof item.score === "number" && Number.isFinite(item.score)) entry.score = item.score
        if (typeof item.metrics === "object" && item.metrics !== null && !Array.isArray(item.metrics)) {
            const metrics: Record<string, number> = {}
            for (const [key, value] of Object.entries(item.metrics)) {
                if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value
            }
            if (Object.keys(metrics).length > 0) entry.metrics = metrics
        }
        if (typeof item.rationale === "string") entry.rationale = item.rationale
        scores.push(entry)
    }
    if (scores.length === 0) return { scores: [], rationale: "", parseFailed: true }
    return {
        scores,
        rationale: typeof p.rationale === "string" ? p.rationale : "",
    }
}

/**
 * Parse a raw `issues` array from a verdict payload into typed WorkflowIssue
 * objects. Drops entries missing a valid severity. Returns undefined when the
 * input is not an array or no valid issues remain.
 */
function parseWorkflowIssues(raw: unknown): WorkflowIssue[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const issues: WorkflowIssue[] = []
    for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue
        if (!("severity" in item) || !isWorkflowIssueSeverity(item.severity)) continue
        const issue: WorkflowIssue = { severity: item.severity }
        if ("message" in item && typeof item.message === "string") issue.message = item.message
        issues.push(issue)
    }
    return issues.length > 0 ? issues : undefined
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
    const p = extractTaggedJSON(rawText, "decompose", "分解")
    if (p === null) return { subtasks: [] }
    if (p === undefined) return { subtasks: [], parseFailed: true }
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
}

/**
 * Parse a <signoff>{"approved": true|false, "rationale": "..."}</signoff> block
 * from a reviewer's output. Returns null if no valid signoff tag found.
 */
export function parseSignoff(text: string): { approved: boolean; rationale: string } | null {
    const parsed = extractTaggedJSON(text, "signoff")
    if (!parsed) return null
    return {
        approved: parsed.approved === true,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
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
        const parsed = extractTaggedJSON(t, "consensus", "共识")
        return parsed?.agreed === true
    })
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

/** Type guard for valid workflow issue severity literals. */
export function isWorkflowIssueSeverity(value: unknown): value is WorkflowIssueSeverity {
    return value === "low" || value === "medium" || value === "high" || value === "critical"
}
