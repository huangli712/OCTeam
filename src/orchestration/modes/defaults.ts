/**
 * Named defaults for orchestration parameters. Single-sourced here so tool
 * construction and orchestration handlers reference the same values without
 * introducing a dependency on the tools layer.
 */

/** Default max rounds for consensus orchestration. */
export const DEFAULT_CONSENSUS_ROUNDS = 3
/** Default max rounds for arbitrate orchestration. */
export const DEFAULT_ARBITRATE_ROUNDS = 1
/** Default max decomposition depth for recurse orchestration. */
export const DEFAULT_RECURSE_DEPTH = 3
/** Default max subtasks per decomposition for recurse orchestration. */
export const DEFAULT_RECURSE_SUBTASKS = 5
