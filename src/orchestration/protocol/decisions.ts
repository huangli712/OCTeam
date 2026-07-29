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
//
// H-15: the tag MUST appear at the END of the output (after trimming trailing
// whitespace). Pre-fix code matched anywhere in the text, so a negated context
// like "do not emit <no_issues/>, bugs remain" falsely signaled clean. A
// trailing-position anchor enforces that the tag is the decider's FINAL
// declaration, not a mid-text reference.
const NO_ISSUES_TAG = /<(?:no_issues|无问题)\s*\/?>\s*$/

/**
 * Extract and JSON.parse a `<tag>{...}</tag>` block from text. Supports an
 * optional Chinese alias for i18n-robust matching (see file header). Returns:
 *   - the parsed object on success
 *   - `null` when the tag is absent (regex does not match)
 *   - `undefined` when the tag is present but the payload fails to parse
 * 
 * H-14: the LAST tagged block is authoritative — if it is malformed, the
 * function returns `undefined` (parseFailed) rather than silently falling
 * back to an earlier parseable block. The pre-fix loop tried each block from
 * last to first, returning the first that parsed; this let a decider's final
 * malformed `<decision>{oops}</decision>` silently revert to a stale earlier
 * `<decision>{...done...}</decision>`, double-completing or double-advancing.
 * When a decider restates a prior decision, the LATEST restatement carries the
 * authoritative payload — if it cannot parse, that is a real failure.
 */
function extractTaggedJSON(
    text: string,
    en: string,
    zh?: string,
): Record<string, unknown> | null | undefined {
    const tag = zh ? `(?:${en}|${zh})` : en
    // H-14: enumerate ALL complete <tag>...</tag> pairs, not just those whose
    // inner payload contains a {...} block. Pre-fix regex required `{...}` to
    // match, so a malformed trailing block like `<decision>oops</decision>` (no
    // braces) was silently skipped, and an EARLIER parseable block won — the
    // decider's final (corrupt) restatement was ignored, double-completing or
    // double-advancing. The LATEST tag pair is authoritative: if it has no
    // parseable JSON, that is a real failure.
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")
    const matches = [...(text?.matchAll(re) ?? [])]
    if (matches.length === 0) return null
    const lastPayload = matches[matches.length - 1][1]
    // M14: extract the LAST valid JSON object from the payload. Pre-fix code
    // used a greedy /\{[\s\S]*\}/ that spanned from the first `{` to the
    // last `}`, concatenating multiple objects into invalid JSON. Now scan
    // from the last `}` backward to find the matching `{` via brace counting,
    // then JSON.parse the result. If that fails, fall back to the greedy
    // match for single-object payloads (backward compat).
    const lastClose = lastPayload.lastIndexOf("}")
    if (lastClose === -1) return undefined
    // Scan backward to find the matching open brace.
    let depth = 0
    let openIdx = -1
    for (let i = lastClose; i >= 0; i--) {
        if (lastPayload[i] === "}") depth++
        else if (lastPayload[i] === "{") {
            depth--
            if (depth === 0) { openIdx = i; break }
        }
    }
    if (openIdx === -1) return undefined
    const candidate = lastPayload.slice(openIdx, lastClose + 1)
    try {
        return JSON.parse(candidate) as Record<string, unknown>
    } catch {
        return undefined
    }
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
    // Lazy {...} + closing tag anchor: the regex expands until it finds the
    // brace that precedes </decision>, so nested braces in structured
    // nextActions parse correctly (L2).
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
 *
 * H-16: strict payload validation. If the raw value is an array, EVERY entry
 * must be a non-empty string — a single invalid entry (typo, number, null)
 * makes the ENTIRE decision parseFailed, rather than silently filtering out
 * the bad entry and routing only to the valid subset. Pre-fix code filtered
 * quietly, so ["known","typo"] became ["known"] — a partial routing that
 * hid the typo from both the router (no feedback) and the master (no error).
 */
export function parseRouteDecision(
    rawText: string,
): { targets: string[]; rationale: string; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "route", "路由")
    if (!p) return { targets: [], rationale: "", parseFailed: true }
    const raw = p.branches ?? p.targets ?? p.branch ?? p.target
    if (raw == null) return { targets: [], rationale: "", parseFailed: true }
    const arr = Array.isArray(raw) ? raw : [raw]
    // H-16: strict — every element must be a non-empty string. One bad entry
    // fails the whole decision.
    const targets: string[] = []
    for (const x of arr) {
        if (typeof x !== "string" || x.length === 0) {
            return { targets: [], rationale: "", parseFailed: true }
        }
        targets.push(x)
    }
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
    if (!ruling || !ruling.trim()) return { ruling: "", rationale: "", parseFailed: true }
    return {
        ruling: ruling.trim(),
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
        confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence) && p.confidence >= 0 && p.confidence <= 1 ? p.confidence : undefined,
        issues: parseWorkflowIssues(p.issues),
    }
}

/** Parse a reducer's <selection>{"winner":"..."}</selection> block into the winning branch name. */
export function parseSelection(
    rawText: string,
): { winner: string; rationale: string; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "selection", "选择")
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
 * entry MUST be a valid object with a string `member` — a single invalid
 * entry makes the ENTIRE scoreboard parseFailed (H-16 strict: no lossy
 * filtering). `score` and each `metrics` value are coerced to FINITE numbers
 * (non-finite values are dropped); `passed` defaults to false when absent;
 * `rationale` is optional. Duplicate `member` entries are PRESERVED (dedup is
 * a selection concern, not a parse one).
 */
export function parseScoreboard(
    rawText: string,
): { scores: ArenaCandidateScore[]; rationale: string; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "scoreboard", "评分板")
    if (!p || !Array.isArray(p.scores)) return { scores: [], rationale: "", parseFailed: true }
    const scores: ArenaCandidateScore[] = []
    for (const item of p.scores) {
        // H-16 strict: any invalid entry makes the whole scoreboard fail.
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            return { scores: [], rationale: "", parseFailed: true }
        }
        if (!("member" in item) || typeof item.member !== "string" || item.member.length === 0) {
            return { scores: [], rationale: "", parseFailed: true }
        }
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
    // R2: return the array even when empty. Pre-fix code returned undefined for
    // empty arrays, which H54's has_issue_severity fail-closed logic treated
    // as "verifier omitted issues field" (unevaluable). A legitimate
    // `issues:[]` means "no issues found" (does_not_match), NOT unevaluable.
    // Only a non-array input (field omitted) should return undefined.
    return issues
}

/**
 * Parse a member's <decompose>{...}</decompose> (or <分解>) block into the
 * proposed subtasks. Unlike parseDecision/parseRouteDecision, parseFailed is
 * NOT a failure signal: an absent tag means "solve directly" (a leaf). Only an
 * explicit tag with no valid subtasks yields parseFailed.
 *
 * H-16: strict payload validation. Every entry in the `subtasks` array MUST
 * have non-empty string `subject` and `description` — a single invalid entry
 * makes the ENTIRE decomposition parseFailed (rather than silently filtering
 * it out). Pre-fix code dropped invalid entries quietly, so a malformed
 * subtask would be lost without feedback to the decomposer.
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
        } else {
            // H-16 strict: one invalid subtask entry fails the whole decompose.
            return { subtasks: [], parseFailed: true }
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
    const parsed = extractTaggedJSON(text, "signoff", "签核")
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
export function allMembersAgree(responses: Record<string, string>, participants?: string[]): boolean {
    // When participants are provided, verify EACH one has a response.
    // Without this, an errored member (no response) is silently ignored,
    // and consensus is declared among only the responding subset.
    const names = participants ?? Object.keys(responses)
    if (names.length === 0) return false
    return names.every(name => {
        const t = responses[name]
        if (!t) return false
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
