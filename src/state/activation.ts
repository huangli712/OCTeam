/**
 * Team activation concern: activation decision, master-only interaction gate,
 * and ordered-lock acquisition. Co-locates all activation-related logic so it
 * is auditable independently from the workflow/task-construction helpers.
 */

import type { Team } from "./store.js"

/**
 * Pure decision for team_activate (exported for unit tests). Auto-switching
 * is disabled: the decision refuses when another team is already active (the
 * user must team_deactivate it first). Activating an already-active team is a
 * no-op.
 */
export type ActivateDecision =
    | { kind: "noop" }
    | { kind: "ok" }
    | { kind: "error"; message: string }

/** Determine whether team_activate should proceed, be a no-op, or fail. */
export function decideActivate(opts: {
    targetIsAlreadyActive: boolean
    outgoingExists: boolean
    outgoingName?: string
}): ActivateDecision {
    if (opts.targetIsAlreadyActive) return { kind: "noop" }
    if (opts.outgoingExists) {
        return {
            kind: "error",
            message: `Cannot activate: team "${opts.outgoingName}" is currently active. Call team_deactivate("${opts.outgoingName}") first — auto-switching is disabled.`,
        }
    }
    return { kind: "ok" }
}

/** Run fn while holding every team's mutex, acquired in a deterministic order
 * (by directory string) to prevent deadlock between racing switches. */
export async function withOrderedLocks(teams: Team[], fn: () => Promise<void>): Promise<void> {
    const ordered = [...teams].sort((a, b) => a.directory.localeCompare(b.directory))
    const run = async (i: number): Promise<void> => {
        if (i >= ordered.length) return fn()
        await ordered[i].mutex.runExclusive(() => run(i + 1))
    }
    await run(0)
}

// --- interaction gates (moved from core/utils.ts) ---

/**
 * Master-only activation gate (pure predicate). Members always pass — a member's
 * team is necessarily active while it is busy (busy ⟹ active), so the gate would
 * never legitimately block a member. A master may only interact with its active
 * team, so an inactive target (activatedAt === undefined) is forbidden.
 */
export function isInteractionForbidden(
    callerIsMaster: boolean,
    targetTeamActivatedAt: number | undefined,
): boolean {
    if (!callerIsMaster) return false
    return targetTeamActivatedAt === undefined
}

/**
 * Actionable error string for a master interacting with an inactive team, or
 * null when the team is active. Centralizes the message used by master-only
 * mutating tools (workflow / team_fix_member).
 */
export function activationError(
    teamName: string,
    activatedAt: number | undefined,
): string | null {
    return activatedAt === undefined
        ? `Error: team "${teamName}" is not the active team. Call team_activate(team_id="${teamName}") first.`
        : null
}
