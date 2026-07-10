/**
 * Authoritative fanout join-policy evaluation.
 *
 * Two complementary predicates over the same policy switch:
 * - {@link joinPolicySatisfied}: applied to a fully-terminal fanout (all
 *   branches completed or errored). Answers "did the policy succeed?"
 * - {@link joinPolicyImpossible}: applied to a partially-resolved fanout.
 *   Answers "can the policy still succeed once the remaining branches
 *   resolve?" Used for fail-fast termination.
 *
 * Both honor `useSurvivors` identically so runtime (dag), fail-fast (fanout),
 * and post-condition (invariants) stay in lockstep.
 */

import type { WorkflowStep } from "../core/types.js"

type Join = NonNullable<WorkflowStep["join"]>

/**
 * Apply the join policy to decide whether a fully-terminal fanout survives.
 * Every policy waits until all branches are terminal (completed or errored);
 * the policy only changes the success criterion. Default (no joinPolicy) keeps
 * the legacy max_errored tolerance semantics.
 */
export function joinPolicySatisfied(
    join: Join,
    survivorBranchIds: readonly string[],
    errors: number,
): boolean {
    const total = join.branchTailIndices.length
    const survivors = survivorBranchIds.length
    if (join.useSurvivors === true) return survivors >= 1
    const policy = join.joinPolicy
    switch (policy) {
        case undefined:
        case "tolerance":
            return survivors > 0 && errors <= join.maxErrored
        case "all":
        case "reduce":
        case "select":
            return errors === 0
        case "quorum": {
            const threshold = join.quorum ?? 0
            return survivors / total >= threshold
        }
        case "any_success":
            return survivors >= 1
        case "required_branches": {
            const required = join.requiredBranchIds ?? []
            const survivorSet = new Set(survivorBranchIds)
            return required.every(branchId => survivorSet.has(branchId))
        }
        default:
            policy satisfies never
            return survivors > 0 && errors <= join.maxErrored
    }
}

/**
 * Given the branches that have errored so far, can the join policy still be
 * satisfied once the remaining (still-running or pending) branches resolve?
 * Used for fail-fast termination when a branch error makes success impossible.
 */
export function joinPolicyImpossible(
    join: Join,
    erroredBranchIds: readonly string[],
    remainingSurvivors: number,
    total: number,
): boolean {
    if (join.useSurvivors === true) return remainingSurvivors === 0
    const erroredSet = new Set(erroredBranchIds)
    const policy = join.joinPolicy
    switch (policy) {
        case undefined:
        case "tolerance":
            return (
                remainingSurvivors === 0 ||
                erroredBranchIds.length > join.maxErrored
            )
        case "all":
        case "reduce":
        case "select":
            return erroredBranchIds.length > 0
        case "quorum": {
            const threshold = join.quorum ?? 0
            // Use the same division as joinPolicySatisfied so IEEE-754 rounding
            // cannot make the two predicates disagree (e.g. 0.28 * 25).
            return remainingSurvivors / total < threshold
        }
        case "any_success":
            return remainingSurvivors === 0
        case "required_branches": {
            const required = join.requiredBranchIds ?? []
            return required.some(branchId => erroredSet.has(branchId))
        }
        default:
            policy satisfies never
            return (
                remainingSurvivors === 0 ||
                erroredBranchIds.length > join.maxErrored
            )
    }
}
