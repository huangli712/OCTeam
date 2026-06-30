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
 *   - lifecycle-shared.ts: ActivateDecision, decideActivate, defaultBounds,
 *     withOrderedLocks.
 *   - lifecycle-query.ts:   creation + read-only inspection (create, list,
 *     details, query).
 *   - lifecycle-members.ts: member management (add, remove, rename, fix).
 *   - activate.ts / deactivate.ts / cancel.ts / delete.ts: state transitions
 *     + teardown (one tool per file).
 *
 * This file re-exports every symbol the tool registry (index.ts) and the test
 * suite import, so consumers keep importing from "./lifecycle.js" unchanged.
 * There is intentionally no logic here.
 */

export { decideActivate, defaultBounds, withOrderedLocks, type ActivateDecision } from "./lifecycle-shared.js"
export { teamCreateTool, teamDetailsTool, teamListTool, teamQueryTool } from "./lifecycle-query.js"
export { teamAddMemberTool, teamFixMemberTool, teamRemoveMemberTool, teamRenameTool } from "./lifecycle-members.js"
export { teamActivateTool } from "./activate.js"
export { teamCancelTool } from "./cancel.js"
export { teamDeactivateTool } from "./deactivate.js"
export { teamDeleteTool } from "./delete.js"
