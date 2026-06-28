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
 *   - workflow-basic.ts:   single-track tools (parallel, consensus, pipeline,
 *     loop).
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

export {
    teamConsensusTool,
    teamLoopTool,
    teamParallelTool,
    teamPipelineTool,
} from "./workflow-basic.js"

export {
    buildRouterPrompt,
    teamArbitrateTool,
    teamDelegateTool,
    teamRecurseTool,
    teamRouteTool,
    teamTollgateTool,
} from "./workflow-advanced.js"
