/**
 * Workflow tools re-export hub.
 *
 * The nine orchestration tools (team_parallel, team_consensus, team_pipeline,
 * team_loop, team_delegate, team_route, team_arbitrate, team_tollgate,
 * team_recurse) and buildRouterPrompt were originally defined inline here.
 * They are now split across three focused modules to keep each file
 * navigable:
 *
 *   - shared.ts: shared helpers + constants (startOrchestration,
 *     baseTaskFields, validateSignoff, signoffTaskFields, assertMember,
 *     effectiveTimeoutMs, DEFAULT_*).
 *   - parallel.ts / consensus.ts / pipeline.ts / loop.ts: single-track tools
 *     (one tool definition per file).
 *   - delegate.ts / router.ts / arbitrate.ts / tollgate.ts / recurse.ts:
 *     multi-track tools (one tool definition per file).
 *
 * This file re-exports every symbol the tool registry (index.ts) and the test
 * suite import, so consumers keep importing from "./workflow.js" unchanged.
 * There is intentionally no logic here.
 */

export {
    DEFAULT_LOOP_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    assertMember,
    baseTaskFields,
    effectiveTimeoutMs,
    startOrchestration,
    validateSignoff,
    signoffTaskFields,
} from "./shared.js"

export { teamConsensusTool } from "./consensus.js"
export { teamLoopTool } from "./loop.js"
export { teamParallelTool } from "./parallel.js"
export { teamPipelineTool } from "./pipeline.js"

export { buildRouterPrompt, teamRouteTool } from "./router.js"
export { teamArbitrateTool } from "./arbitrate.js"
export { teamDelegateTool } from "./delegate.js"
export { teamRecurseTool } from "./recurse.js"
export { teamTollgateTool } from "./tollgate.js"
