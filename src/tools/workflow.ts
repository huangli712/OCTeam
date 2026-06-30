/**
 * Workflow tools re-export hub.
 *
 * The nine orchestration tools (team_parallel, team_consensus, team_pipeline,
 * team_loop, team_delegate, team_route, team_arbitrate, team_tollgate,
 * team_recurse) and buildRouterPrompt were originally defined inline here.
 * They are now split across three focused modules to keep each file
 * navigable:
 *
 *   - workflow-shared.ts: shared helpers + constants (startOrchestration,
 *     baseTaskFields, validateSignoff, signoffTaskFields, assertMember,
 *     effectiveTimeoutMs, DEFAULT_*).
 *   - parallel.ts / consensus.ts / pipeline.ts / loop.ts: single-track tools
 *     (one tool definition per file).
 *   - workflow-advanced.ts: multi-track tools (delegate, route, arbitrate,
 *     tollgate, recurse) + buildRouterPrompt.
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
} from "./workflow-shared.js"

export { teamConsensusTool } from "./consensus.js"
export { teamLoopTool } from "./loop.js"
export { teamParallelTool } from "./parallel.js"
export { teamPipelineTool } from "./pipeline.js"

export {
    buildRouterPrompt,
    teamArbitrateTool,
    teamDelegateTool,
    teamRecurseTool,
    teamRouteTool,
    teamTollgateTool,
} from "./workflow-advanced.js"
