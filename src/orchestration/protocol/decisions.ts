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
/**
 * Validate nextActions array: must be absent or an array of all strings.
 * Returns the typed array, or null if any element is non-string (caller
 * should treat as parseFailed). Pre-fix code filtered out non-string
 * entries silently, so `["fix A", 7]` became `["fix A"]` without signaling
 * a malformed payload.
 */
function validateNextActions(raw: unknown): string[] | null {
    if (raw === undefined) return []
    if (!Array.isArray(raw)) return null
    for (const item of raw) {
        if (typeof item !== "string") return null
    }
    return raw
}

export function extractTaggedJSON(
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
    // HIGH: require same-language open/close pairs.
    const pairs: Array<[string, string]> = zh ? [[en, en], [zh, zh]] : [[en, en]]
    const allMatches: Array<RegExpMatchArray> = []
    for (const [o, c] of pairs) {
        const pairRe = new RegExp(`<${o}>([\\s\\S]*?)<\/${c}>`, "g")
        for (const m of text?.matchAll(pairRe) ?? []) allMatches.push(m)
    }
    allMatches.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const matches = allMatches
    if (matches.length === 0) {
        // H39: before returning null ("no tag found"), check if the text has
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
    // M14: extract the LAST valid JSON object from the payload. Pre-fix code
    // used a greedy /\{[\s\S]*\}/ that spanned from the first `{` to the
    // last `}`, concatenating multiple objects into invalid JSON. Now scan
    // from the last `}` backward to find the matching `{` via brace counting,
    // then JSON.parse the result. If that fails, fall back to the greedy
    // match for single-object payloads (backward compat).
    const lastClose = lastPayload.lastIndexOf("}")
    if (lastClose === -1) return undefined
    // M3: pre-compute unescaped quote positions by scanning FORWARD.
    // The backward scanner (M7) correctly toggles inString on unescaped
    // quotes, but got the escape direction wrong for backward traversal —
    // `\"` seen backward encounters `"` before `\`, toggling inString
    // prematurely. A forward scan correctly handles escape ordering.
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
        // M3: toggle inString ONLY on pre-computed unescaped quotes.
        // Pre-fix code toggled on every `"` and used a broken escape
        // tracker for backward order.
        if (unescapedQuotes.has(i)) { inString = !inString; continue }
        if (inString) continue
        if (ch === "}") depth++
        else if (ch === "{") {
            depth--
            if (depth === 0) { openIdx = i; break }
        }
    }
    if (openIdx === -1) return undefined
    // CRITICAL: reject payloads with multiple top-level JSON objects.
    // Pre-fix backward brace-counting extracted the LAST object, so
    // `{"approved":false}{"approved":true}` silently became approved.
    // Now count top-level objects (depth 0, outside strings) and reject
    // if more than one exists — the payload is ambiguous.
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
            // HIGH #21: negative depth means an unmatched closing brace
            // precedes the first opening brace (e.g. `}{"approved":true}`).
            // The backward scanner skips leading garbage, so this payload
            // would pass the count check with only 1 object detected.
            if (countDepth < 0) return undefined
        }
    }
    // Depth must be 0 (balanced) and exactly one top-level object.
    if (countDepth !== 0 || topLevelObjects !== 1) return undefined
    const candidate = lastPayload.slice(openIdx, lastClose + 1)
    try {
        const parsed = JSON.parse(candidate)
        // HIGH: reject array-wrapped objects. Pre-fix code accepted
        // [{"approved":true}] as valid because the brace counter
        // found exactly one object inside the array.
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
    // Lazy {...} + closing tag anchor: the regex expands until it finds the
    // brace that precedes </decision>, so nested braces in structured
    // nextActions parse correctly (L2).
    const parsed = extractTaggedJSON(rawText, "decision", "决策")
    if (!parsed) return fail()
    // L3: strictly validate the decision value. Pre-fix code normalized any
    // non-"done" value (including misspellings like "dnoe" and missing keys)
    // to "continue" silently, and never set parseFailed. Now: "done" explicit,
    // "continue" explicit, or boolean done:true are the only accepted values.
    // Anything else sets parseFailed so the retry/reformat path can fire.
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
    // M22 fix: if `decision` key is absent AND no `done:true`, this is a
    // malformed payload — the model emitted a <decision> tag but didn't
    // include the required decision field. Pre-fix code silently defaulted
    // to "continue", wasting an entire loop round. Now: set parseFailed so
    // the retry/reformat budget can fire.
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
    // MEDIUM #27: detect conflicting alias values. If the LLM provides
    // multiple aliases with different values, fail rather than silently
    // picking one.
    const aliasSources: Array<[string, unknown]> = [
        ["branches", p.branches], ["targets", p.targets],
        ["branch", p.branch], ["target", p.target],
    ].filter(([, v]) => v != null) as Array<[string, unknown]>
    if (aliasSources.length === 0) return { targets: [], rationale: "", parseFailed: true }
    // If multiple aliases present, verify they are consistent.
    const raw = aliasSources[0][1]
    for (let i = 1; i < aliasSources.length; i++) {
        const [, v] = aliasSources[i]!
        const a = Array.isArray(raw) ? raw : [raw]
        const b = Array.isArray(v) ? v : [v]
        if (a.length !== b.length || !a.every((x, idx) => x === b[idx])) {
            return { targets: [], rationale: "", parseFailed: true }
        }
    }
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
    // MEDIUM: detect conflicting decision/ruling aliases.
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
    const seenMembers = new Set<string>()
    for (const item of p.scores) {
        // H-16 strict: any invalid entry makes the whole scoreboard fail.
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            return { scores: [], rationale: "", parseFailed: true }
        }
        if (!("member" in item) || typeof item.member !== "string" || item.member.length === 0) {
            return { scores: [], rationale: "", parseFailed: true }
        }
        // MEDIUM #29: reject duplicate member entries.
        if (seenMembers.has(item.member)) {
            return { scores: [], rationale: "", parseFailed: true }
        }
        seenMembers.add(item.member)
        const entry: ArenaCandidateScore = {
            member: item.member,
            // MEDIUM: strict validate passed — must be boolean if provided.
            passed: (() => {
                if ("passed" in item) {
                    if (typeof item.passed !== "boolean") {
                        return null as unknown as boolean // signal invalid
                    }
                    return item.passed
                }
                return false
            })(),
        }
        // If passed was provided but invalid, fail.
        if (entry.passed === null) {
            return { scores: [], rationale: "", parseFailed: true }
        }
        // HIGH #22: if score is present but not a finite number, the
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
    let hadInvalidSeverity = false
    for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            // H-2/N: flag non-object entries as invalid so an all-malformed
            // issues array returns undefined (unevaluable), not [] (no issues).
            hadInvalidSeverity = true
            continue
        }
        if (!("severity" in item)) {
            // H-2/N: an entry missing severity (e.g. {message:"critical"})
            // tried to report an issue but forgot the required field. Flag it
            // so the result is unevaluable, not silently empty.
            hadInvalidSeverity = true
            continue
        }
        if (!isWorkflowIssueSeverity(item.severity)) {
            // H9: track entries with invalid severity labels. If ALL entries
            // are malformed, the verifier attempted to report issues but used
            // unknown labels — treat as unevaluable (undefined), not "no
            // qualifying issues" ([]). Pre-fix code silently skipped these.
            hadInvalidSeverity = true
            continue
        }
        const issue: WorkflowIssue = { severity: item.severity }
        if ("message" in item && typeof item.message === "string") issue.message = item.message
        issues.push(issue)
    }
    // R2: return the array even when empty for legit `issues:[]`.
    // H40 fix: ANY malformed entry makes the entire issues field unevaluable.
    // Pre-fix code only returned undefined when ALL entries were malformed
    // (issues.length === 0). A mix of valid + invalid entries silently dropped
    // the invalid ones, which is fail-open for quality gates — e.g. a
    // `["low", "CRITICALL"]` payload would keep only "low" and a
    // `has_issue_severity:"critical"` condition would not match.
    if (hadInvalidSeverity) return undefined
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
 * from a reviewer's output. Returns null only when no signoff tag is present.
 */
export function parseSignoff(text: string): { approved: boolean; rationale: string; parseFailed?: boolean } | null {
    const parsed = extractTaggedJSON(text, "signoff", "签核")
    if (parsed === null) return null
    if (parsed === undefined) return { approved: false, rationale: "", parseFailed: true }
    // H-3/N: distinguish malformed output from explicit rejection. Pre-fix
    // code returned approved:false for ANY parsed object with missing or
    // non-boolean approved — the caller couldn't tell a malformed response
    // (missing approved field) from an explicit rejection (approved:false).
    // Now: set parseFailed when approved is absent or non-boolean, so the
    // caller can trigger a parse retry instead of immediately failing the
    // quality gate.
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
