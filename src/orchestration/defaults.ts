/**
 * Named defaults for orchestration parameters. Single-sourced here so the
 * tool layer (task construction in tools/shared.ts, re-exported) and the
 * handler layer (defensive `?? N` fallbacks in orchestration/*.ts) reference
 * the same value. Previously these lived only in tools/shared.ts, which made
 * a tools-layer import from orchestration handlers a layering violation.
 */

export const DEFAULT_CONSENSUS_ROUNDS = 3
export const DEFAULT_ARBITRATE_ROUNDS = 1
export const DEFAULT_RECURSE_DEPTH = 3
export const DEFAULT_RECURSE_SUBTASKS = 5
