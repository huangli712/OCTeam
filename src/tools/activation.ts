/**
 * Team activation decision logic. Extracted from shared.ts so the activation
 * concern (can this team be activated? is another team blocking it?) is
 * auditable independently from the workflow/task-construction helpers.
 *
 * Used exclusively by tools/activate.ts (the team_activate tool).
 */

import type { Team } from "../state/store.js"

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
