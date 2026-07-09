/**
 * Named defaults for orchestration parameters. Single-sourced here so the
 * tool layer (task construction in tools/shared.ts, re-exported) and the
 * handler layer (defensive `?? N` fallbacks in orchestration/*.ts) reference
 * the same value. Previously these lived only in tools/shared.ts, which made
 * a tools-layer import from orchestration handlers a layering violation.
 */

/** Default max rounds for consensus orchestration. */
export const DEFAULT_CONSENSUS_ROUNDS = 3
/** Default max rounds for arbitrate orchestration. */
export const DEFAULT_ARBITRATE_ROUNDS = 1
/** Default max decomposition depth for recurse orchestration. */
export const DEFAULT_RECURSE_DEPTH = 3
/** Default max subtasks per decomposition for recurse orchestration. */
export const DEFAULT_RECURSE_SUBTASKS = 5
