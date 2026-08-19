/**
 * Pure decision/output parsers and consensus/quorum predicates shared across
 * the per-mode idle handlers. Each parser can be unit-tested without pulling
 * in dispatch state.
 *
 * Conventions (i18n-safe):
 *   - Every parser accepts both the English tag and a Chinese-language alias
 *     so non-English agent output is recognized.
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
// read_only stage emits <no_issues/> or its Chinese-language alias to declare
// clean without relying on an ambiguous keyword substring.
//
// The tag MUST appear at the END of the output once trailing whitespace is
// trimmed. This makes it the decider's final declaration rather than a
// mid-text reference.
const NO_ISSUES_TAG = /<(?:no_issues|无问题)\s*\/?>\s*$/
/** Length caps for decomposed subtask fields, mirrored from the task schema. */
const TASK_SUBJECT_MAX_LENGTH = 500
const TASK_DESCRIPTION_MAX_LENGTH = 8_192

/** Detect duplicate keys that JSON.parse would otherwise resolve last-wins. */
function hasDuplicateKeys(jsonStr: string): boolean {
    const seen = new Set<string>()
    let i = 0
    const len = jsonStr.length
    let depth = 0
    while (i < len) {
        const ch = jsonStr[i]
        if (ch === '"') {
            // Read the complete string (handle escapes).
            const start = i + 1
            i++
            let esc = false
            while (i < len) {
                if (esc) { esc = false }
                else if (jsonStr[i] === '\\') { esc = true }
                else if (jsonStr[i] === '"') { break }
                i++
            }
            const strEnd = i // position of closing quote
            i++ // past closing quote
            // At depth 1, check if next non-ws char is ':' (it's a key).
            if (depth === 1) {
                let j = i
                while (j < len && /\s/.test(jsonStr[j])) j++
                if (j < len && jsonStr[j] === ':') {
                    const key = jsonStr.slice(start, strEnd)
                    if (seen.has(key)) return true
                    seen.add(key)
                }
            }
            continue
        }
        if (ch === '{' || ch === '[') { depth++; i++; continue }
        if (ch === '}' || ch === ']') { depth--; i++; continue }
        i++
    }
    return false
}

// Return a typed nextActions array, or null when any entry is invalid.
function validateNextActions(raw: unknown): string[] | null {
    if (raw === undefined) return []
    if (!Array.isArray(raw)) return null
    for (const item of raw) {
        if (typeof item !== "string") return null
    }
    return raw
}

/**
 * Extract and parse the last `<tag>{...}</tag>` block, with an optional alias.
 * Returns null for no tag and undefined for an invalid authoritative payload.
 */
export function extractTaggedJSON(
    text: string,
    en: string,
    zh?: string,
): Record<string, unknown> | null | undefined {
    const tag = zh ? `(?:${en}|${zh})` : en
    // Enumerate all complete tag pairs, including malformed payloads without
    // braces, because the last pair is authoritative. Opening and closing tags
    // must use the same language.
    const pairs: Array<[string, string]> = zh ? [[en, en], [zh, zh]] : [[en, en]]
    const allMatches: Array<RegExpMatchArray> = []
    for (const [o, c] of pairs) {
        const pairRe = new RegExp(`<${o}>([\\s\\S]*?)<\/${c}>`, "g")
        for (const m of text?.matchAll(pairRe) ?? []) allMatches.push(m)
    }
    allMatches.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const matches = allMatches
    if (matches.length === 0) {
        // Before returning null ("no tag found"), check if the text has
        // an UNCLOSED opening tag (e.g. trailing `<decision>{...` without
        // `</decision>`). If so, this is a parse failure (undefined), not
        // "no tag at all" — the model attempted to emit a decision but the
        // output was truncated. Returning null here would cause callers to
        // fall back to older complete tags or treat it as "direct answer".
        const openRe = new RegExp(`<${tag}>`)
        if (openRe.test(text ?? "")) return undefined
        return null
    }
    const lastCompleteMatch = matches[matches.length - 1]
    const lastCompleteEnd = (lastCompleteMatch.index ?? 0) + lastCompleteMatch[0].length
    const lastOpeningIndex = Math.max(
        (text ?? "").lastIndexOf(`<${en}>`),
        zh ? (text ?? "").lastIndexOf(`<${zh}>`) : -1,
    )
    if (lastOpeningIndex >= lastCompleteEnd) return undefined
    const lastPayload = matches[matches.length - 1][1]
    // Scan backward from the last closing brace to locate the matching opening
    // brace without concatenating separate JSON objects.
    const lastClose = lastPayload.lastIndexOf("}")
    if (lastClose === -1) return undefined
    // Pre-compute unescaped quote positions in forward order so the backward
    // brace scan handles escape sequences correctly.
    const unescapedQuotes = new Set<number>()
    for (let i = 0; i <= lastClose; i++) {
        if (lastPayload[i] === '"') {
            // Count preceding backslashes; odd count → escaped.
            let bsCount = 0
            let j = i - 1
            while (j >= 0 && lastPayload[j] === '\\') { bsCount++; j-- }
            if (bsCount % 2 === 0) unescapedQuotes.add(i)
        }
    }
    let depth = 0
    let openIdx = -1
    let inString = false
    for (let i = lastClose; i >= 0; i--) {
        const ch = lastPayload[i]
        // Toggle inString only on pre-computed unescaped quotes.
        if (unescapedQuotes.has(i)) { inString = !inString; continue }
        if (inString) continue
        if (ch === "}") depth++
        else if (ch === "{") {
            depth--
            if (depth === 0) { openIdx = i; break }
        }
    }
    if (openIdx === -1) return undefined
    // Reject payloads with multiple top-level JSON objects because selecting
    // only the last object would make the payload ambiguous.
    let topLevelObjects = 0
    let countDepth = 0
    let countInString = false
    for (let i = 0; i < lastPayload.length; i++) {
        if (unescapedQuotes.has(i)) { countInString = !countInString; continue }
        if (countInString) continue
        const ch = lastPayload[i]
        if (ch === "{") {
            if (countDepth === 0) topLevelObjects++
            countDepth++
        } else if (ch === "}") {
            countDepth--
            // Negative depth means an unmatched closing brace
            // precedes the first opening brace (e.g. `}{"approved":true}`).
            // The backward scanner skips leading garbage, so this payload
            // would pass the count check with only 1 object detected.
            if (countDepth < 0) return undefined
        }
    }
    // Depth must be 0 (balanced) and exactly one top-level object.
    if (countDepth !== 0 || topLevelObjects !== 1) return undefined
    const candidate = lastPayload.slice(openIdx, lastClose + 1)
    // Reject duplicate keys at the top level. JSON.parse uses
    // last-wins semantics, so {"approved":false,"approved":true} silently
    // becomes approved. Scan for duplicate keys before parsing.
    if (hasDuplicateKeys(candidate)) return undefined
    try {
        const parsed = JSON.parse(candidate)
        // Reject array-wrapped objects even when they contain one object.
        if (Array.isArray(parsed)) return undefined
        return parsed as Record<string, unknown>
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
    // extractTaggedJSON takes the last <decision> pair and brace-scans backward
    // from the payload's final `}`, so nested braces in structured nextActions
    // parse correctly.
    const parsed = extractTaggedJSON(rawText, "decision", "决策")
    if (!parsed) return fail()
    // Strictly accept only explicit "done", explicit "continue", or boolean
    // done:true. Anything else sets parseFailed for the retry/reformat path.
    const decision = parsed.decision
    if (decision !== undefined && parsed.done !== undefined) {
        if (typeof parsed.done !== "boolean" || parsed.done !== (decision === "done")) return fail()
    }
    if (decision === "done" || (decision === undefined && parsed.done === true)) {
        const nextActions = validateNextActions(parsed.nextActions)
        if (nextActions === null) return fail()
        return {
            round: 0,
            decision: "done",
            rationale: typeof parsed.rationale === "string" ? parsed.rationale : "No rationale provided",
            nextActions,
            timestamp: Date.now(),
        }
    }
    // A payload without `decision` or `done:true` is malformed, so set
    // parseFailed and let the retry/reformat budget handle it.
    if (decision === undefined) return fail()
    // If decision is present but not a recognized value, it's also a parse
    // failure (misspelling like "dnoe" or "stpo").
    if (decision !== "continue") return fail()
    const nextActions = validateNextActions(parsed.nextActions)
    if (nextActions === null) return fail()
    return {
        round: 0,
        decision: "continue",
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "No rationale provided",
        nextActions,
        timestamp: Date.now(),
    }
}

/**
 * Parse a router's <route>{...}</route> block or its Chinese-language alias
 * into selected branch names. Branch existence is validated in
 * handleRouteIdle. Returns parseFailed:true when no tag or no names are found.
 * Accepts branch/branches/target/targets aliases for LLM robustness.
 *
 * Strict payload validation requires every array entry to be a non-empty
 * string. One invalid entry makes the entire decision parseFailed so routing
 * never proceeds with a lossy subset.
 */
export function parseRouteDecision(
    rawText: string,
): { targets: string[]; rationale: string; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "route", "路由")
    if (!p) return { targets: [], rationale: "", parseFailed: true }
    // Detect conflicting alias values. If the LLM provides
    // multiple aliases with different values, fail rather than silently
    // picking one.
    const aliasSources: Array<[string, unknown]> = [
        ["branches", p.branches], ["targets", p.targets],
        ["branch", p.branch], ["target", p.target],
    ].filter(([, v]) => v != null) as Array<[string, unknown]>
    if (aliasSources.length === 0) return { targets: [], rationale: "", parseFailed: true }
    const normalizedAliases: string[][] = []
    for (const [, value] of aliasSources) {
        const values = Array.isArray(value) ? value : [value]
        if (values.length === 0 || values.some(x => typeof x !== "string" || x.length === 0)) {
            return { targets: [], rationale: "", parseFailed: true }
        }
        normalizedAliases.push(values as string[])
    }
    // If multiple aliases are present, compare them as sets while preserving
    // the first alias's order for the returned route targets.
    const targets = normalizedAliases[0]!
    const canonicalTargets = [...targets].sort()
    for (let i = 1; i < normalizedAliases.length; i++) {
        const aliasTargets = [...normalizedAliases[i]!].sort()
        if (canonicalTargets.length !== aliasTargets.length
            || !canonicalTargets.every((target, index) => target === aliasTargets[index])) {
            return { targets: [], rationale: "", parseFailed: true }
        }
    }
    return {
        targets,
        rationale: typeof p.rationale === "string" ? p.rationale : "",
    }
}

/**
 * Parse an arbiter's <ruling>{...}</ruling> block or its Chinese-language alias
 * into the binding ruling and rationale. Accepts decision/ruling aliases; a non-empty
 * ruling is required, else parseFailed. Single ruling (no retry counting,
 * unlike loop's parseDecision).
 */
export function parseArbitrationDecision(
    rawText: string,
): { ruling: string; rationale: string; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "ruling", "裁决")
    if (!p) return { ruling: "", rationale: "", parseFailed: true }
    // Detect conflicting decision/ruling aliases.
    if (p.decision !== undefined && p.ruling !== undefined
        && typeof p.decision === "string" && typeof p.ruling === "string"
        && p.decision.trim() !== p.ruling.trim()) {
        return { ruling: "", rationale: "", parseFailed: true }
    }
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
 * Parse a verifier's <verdict>{...}</verdict> block or its Chinese-language alias into the
 * three-valued verdict (PASS/FAIL/INVALID) plus rationale and diff. Mirrors
 * parseArbitrationDecision's regex/JSON shape but owns a DISTINCT <verdict>
 * tag. It MUST NOT reuse the <ruling> tag owned by
 * parseArbitrationDecision because a shared tag would cross-wire parsers.
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
        score: typeof p.score === "number" && Number.isFinite(p.score) && p.score >= 0 && p.score <= 10 ? p.score : undefined,
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
 * Parse an evaluator's <scoreboard>{...}</scoreboard> block or its
 * Chinese-language alias into per-candidate scores. An absent tag or
 * malformed JSON returns parseFailed. `scores` must be a non-empty array; each
 * entry MUST be a valid object with a string `member` — a single invalid
 * entry makes the entire scoreboard parseFailed without lossy filtering.
 * `score` and each `metrics` value must be finite numbers; a non-finite value
 * makes the entire scoreboard parseFailed. `passed` defaults to false when
 * absent; `rationale` is optional. Duplicate `member` entries make the entire
 * scoreboard parseFailed so selection never sees ambiguous candidates.
 */
export function parseScoreboard(
    rawText: string,
): { scores: ArenaCandidateScore[]; rationale: string; parseFailed?: boolean } {
    const p = extractTaggedJSON(rawText, "scoreboard", "评分板")
    if (!p || !Array.isArray(p.scores)) return { scores: [], rationale: "", parseFailed: true }
    const scores: ArenaCandidateScore[] = []
    const seenMembers = new Set<string>()
    for (const item of p.scores) {
        // Any invalid entry makes the whole scoreboard fail.
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            return { scores: [], rationale: "", parseFailed: true }
        }
        if (!("member" in item) || typeof item.member !== "string" || item.member.length === 0) {
            return { scores: [], rationale: "", parseFailed: true }
        }
        // Reject duplicate member entries.
        if (seenMembers.has(item.member)) {
            return { scores: [], rationale: "", parseFailed: true }
        }
        seenMembers.add(item.member)
        // The optional passed field must be boolean before constructing the entry.
        let passed: boolean
        if ("passed" in item) {
            if (typeof item.passed !== "boolean") {
                return { scores: [], rationale: "", parseFailed: true }
            }
            passed = item.passed
        } else {
            passed = false
        }
        const entry: ArenaCandidateScore = {
            member: item.member,
            passed,
        }
        // If score is present but not a finite number, the
        // evaluator's output is malformed — fail the ENTIRE scoreboard
        // rather than silently dropping the invalid score and changing
        // the winner selection.
        if ("score" in item) {
            if (typeof item.score !== "number" || !Number.isFinite(item.score)) {
                return { scores: [], rationale: "", parseFailed: true }
            }
            entry.score = item.score
        }
        if (typeof item.metrics === "object" && item.metrics !== null && !Array.isArray(item.metrics)) {
            // If metrics exists, all values must be finite numbers so winner
            // selection cannot ignore malformed values. Use a null prototype to
            // prevent prototype pollution.
            const metrics: Record<string, number> = Object.create(null)
            for (const [key, value] of Object.entries(item.metrics)) {
                if (typeof value !== "number" || !Number.isFinite(value)) {
                    return { scores: [], rationale: "", parseFailed: true }
                }
                metrics[key] = value
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
 * objects. Any malformed entry (non-object, missing severity, or unknown
 * severity label) makes the whole field unevaluable: returns undefined.
 * Returns [] for a legitimate empty issues array, and undefined when input is
 * not an array.
 */
function parseWorkflowIssues(raw: unknown): WorkflowIssue[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const issues: WorkflowIssue[] = []
    let hadInvalidSeverity = false
    for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            // Flag non-object entries as invalid so an all-malformed
            // issues array returns undefined (unevaluable), not [] (no issues).
            hadInvalidSeverity = true
            continue
        }
        if (!("severity" in item)) {
            // An entry missing severity (e.g. {message:"critical"})
            // tried to report an issue but forgot the required field. Flag it
            // so the result is unevaluable, not silently empty.
            hadInvalidSeverity = true
            continue
        }
        if (!isWorkflowIssueSeverity(item.severity)) {
            // Track entries with invalid severity labels. If all entries
            // are malformed, the verifier attempted to report issues but used
            // unknown labels — treat as unevaluable (undefined), not "no
            // qualifying issues" ([]).
            hadInvalidSeverity = true
            continue
        }
        const issue: WorkflowIssue = { severity: item.severity }
        if ("message" in item && typeof item.message === "string") issue.message = item.message
        issues.push(issue)
    }
    // Return the array even when empty for a legitimate `issues:[]`. Any
    // malformed entry makes the entire field unevaluable so quality gates do
    // not silently ignore invalid entries in a mixed payload.
    if (hadInvalidSeverity) return undefined
    return issues
}

/**
 * Parse a member's <decompose>{...}</decompose> block or its Chinese-language
 * alias into proposed subtasks. Unlike parseDecision/parseRouteDecision, parseFailed is
 * NOT a failure signal: an absent tag means "solve directly" (a leaf). Only an
 * explicit tag with no valid subtasks yields parseFailed.
 *
 * Strict payload validation requires every subtask to have non-empty string
 * `subject` and `description` fields. One invalid entry makes the entire
 * decomposition parseFailed instead of dropping work without feedback.
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
        if (typeof item !== "object" || item === null
            || !("subject" in item) || typeof item.subject !== "string"
            || !("description" in item) || typeof item.description !== "string") {
            return { subtasks: [], parseFailed: true }
        }
        const subject = item.subject.trim()
        const description = item.description.trim()
        if (subject.length === 0 || subject.length > TASK_SUBJECT_MAX_LENGTH
            || description.length === 0 || description.length > TASK_DESCRIPTION_MAX_LENGTH) {
            return { subtasks: [], parseFailed: true }
        }
        subtasks.push({ subject, description })
    }
    if (subtasks.length === 0) return { subtasks: [], parseFailed: true }
    return { subtasks }
}

/**
 * Parse a <signoff>{"approved": true|false, "rationale": "..."}</signoff> block
 * from a reviewer's output. Returns null only when no signoff tag is present.
 */
export function parseSignoff(text: string): { approved: boolean; rationale: string; parseFailed?: boolean } | null {
    const parsed = extractTaggedJSON(text, "signoff", "签核")
    if (parsed === null) return null
    if (parsed === undefined) return { approved: false, rationale: "", parseFailed: true }
    // Distinguish malformed output from explicit rejection. Missing or
    // non-boolean approval sets parseFailed so the caller can retry parsing
    // instead of failing the quality gate as an explicit rejection.
    if (typeof parsed.approved !== "boolean") {
        return {
            approved: false,
            rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
            parseFailed: true,
        }
    }
    return {
        approved: parsed.approved,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    }
}

/** Loop exit condition 2: every read_only stage emitted a <no_issues/> tag. */
export function allReadOnlyStagesReportNoIssues(task: ActiveTask): boolean {
    const roStages = task.stages.filter(s => s.action === "read_only")
    if (roStages.length === 0) return false
    return roStages.every(s => NO_ISSUES_TAG.test(task.responses[s.member] ?? ""))
}

/** Outcome of parsing a consensus turn: either a valid agreed flag or a
 *  classified parse failure (tag missing, bad JSON, or agreed not boolean). */
type ConsensusParseResult =
    | { readonly agreed: boolean; readonly parseFailed: false }
    | {
        readonly agreed: false
        readonly parseFailed: true
        readonly reason: "tag_not_found" | "json_parse_error" | "agreed_not_boolean"
    }

/** Parse a consensus response and classify missing, invalid, or valid payloads. */
export function parseConsensus(text: string): ConsensusParseResult {
    const parsed = extractTaggedJSON(text, "consensus", "共识")
    if (parsed === null) {
        return { agreed: false, parseFailed: true, reason: "tag_not_found" }
    }
    if (parsed === undefined) {
        return { agreed: false, parseFailed: true, reason: "json_parse_error" }
    }
    if (typeof parsed.agreed !== "boolean") {
        return { agreed: false, parseFailed: true, reason: "agreed_not_boolean" }
    }
    return { agreed: parsed.agreed, parseFailed: false }
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
        return parseConsensus(t).agreed
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
