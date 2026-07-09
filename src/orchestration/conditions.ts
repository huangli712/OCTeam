import type { WorkflowCondition, WorkflowIssue, WorkflowIssueSeverity } from "../core/types.js"

type ConditionInput = {
    score?: number
    confidence?: number
    issues?: WorkflowIssue[]
}

type ParsedCondition =
    | { condition: WorkflowCondition }
    | { error: string }

function assertNever(value: never): never {
    throw new Error(`unhandled workflow condition: ${String(value)}`)
}

export function isWorkflowIssueSeverity(value: unknown): value is WorkflowIssueSeverity {
    return value === "low" || value === "medium" || value === "high" || value === "critical"
}

function severityRank(severity: WorkflowIssueSeverity): number {
    switch (severity) {
        case "low": return 0
        case "medium": return 1
        case "high": return 2
        case "critical": return 3
        default: return assertNever(severity)
    }
}

function isConditionKey(key: string): key is WorkflowCondition["kind"] {
    return key === "score_gte" || key === "score_lt" || key === "confidence_gte" || key === "has_issue_severity"
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseWorkflowCondition(raw: unknown): ParsedCondition {
    if (!isRecord(raw)) return { error: "where must be an object" }
    const conditionKeys = Object.keys(raw).filter(isConditionKey)
    if (conditionKeys.length !== 1 || Object.keys(raw).some(key => key !== conditionKeys[0])) {
        return { error: "where must contain exactly one supported condition" }
    }
    const key = conditionKeys[0]
    if (key === undefined) return { error: "where must contain exactly one supported condition" }
    const value = raw[key]
    switch (key) {
        case "score_gte":
        case "score_lt":
        case "confidence_gte":
            return typeof value === "number" && Number.isFinite(value)
                ? { condition: { kind: key, value } }
                : { error: `where.${key} must be a finite number` }
        case "has_issue_severity":
            return isWorkflowIssueSeverity(value)
                ? { condition: { kind: key, value } }
                : { error: "where.has_issue_severity must be one of low, medium, high, critical" }
        default:
            return assertNever(key)
    }
}

export function matchesWorkflowCondition(condition: WorkflowCondition, input: ConditionInput): boolean {
    switch (condition.kind) {
        case "score_gte": return input.score !== undefined && input.score >= condition.value
        case "score_lt": return input.score !== undefined && input.score < condition.value
        case "confidence_gte": return input.confidence !== undefined && input.confidence >= condition.value
        case "has_issue_severity":
            return (input.issues ?? []).some(issue => severityRank(issue.severity) >= severityRank(condition.value))
        default:
            return assertNever(condition)
    }
}

export function formatWorkflowCondition(condition: WorkflowCondition): string {
    return `${condition.kind} ${condition.value}`
}
