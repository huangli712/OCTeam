/**
 * Lifecycle tools re-export hub.
 *
 * The 12 team lifecycle tools (team_create, team_list, team_details,
 * team_query, team_add_member, team_remove_member, team_rename,
 * team_fix_member, team_activate, team_deactivate, team_cancel, team_delete)
 * and the shared helpers (decideActivate, defaultBounds, withOrderedLocks)
 * were originally defined inline here. They are now split across four focused
 * modules to keep each file navigable:
 *
 *   - shared.ts: ActivateDecision, decideActivate, defaultBounds,
 *     withOrderedLocks.
 *   - create.ts / list.ts / details.ts / query.ts: creation + read-only
 *     inspection (one tool per file).
 *   - add.ts / remove.ts / rename.ts / fix.ts: member management (one per file).
 *   - activate.ts / deactivate.ts / cancel.ts / delete.ts: state transitions
 *     + teardown (one tool per file).
 *
 * This file re-exports every symbol the tool registry (index.ts) and the test
 * suite import, so consumers keep importing from "./lifecycle.js" unchanged.
 * There is intentionally no logic here.
 */

export { decideActivate, defaultBounds, withOrderedLocks, type ActivateDecision } from "./shared.js"
export { teamCreateTool } from "./create.js"
export { teamListTool } from "./list.js"
export { teamDetailsTool } from "./details.js"
export { teamQueryTool } from "./query.js"
export { teamAddMemberTool } from "./add.js"
export { teamFixMemberTool } from "./fix.js"
export { teamRemoveMemberTool } from "./remove.js"
export { teamRenameTool } from "./rename.js"
export { teamActivateTool } from "./activate.js"
export { teamCancelTool } from "./cancel.js"
export { teamDeactivateTool } from "./deactivate.js"
export { teamDeleteTool } from "./delete.js"
