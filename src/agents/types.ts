/**
 * Shared type definitions for OCTeam's built-in agent configurations and
 * permission maps.
 */

/**
 * Member-reachable team collaboration tools. EVERY member-reachable preset
 * MUST spread this into its permission map alongside "*": "deny" — a missing
 * key cuts members off from that tool (e.g. team_done, which require_done_ack
 * runs depend on). Locked by tests/agents.test.ts (table-driven: preset ×
 * member team tool).
 */
export const MEMBER_TEAM_TOOLS_PERMISSION: OcteamAgentPermission = {
    team_send_message: "allow",
    team_task_create: "allow",
    team_task_list: "allow",
    team_task_update: "allow",
    team_task_get: "allow",
    team_done: "allow",
}

/**
 * Indexed read/search tier (host "AFT bridge" tools). The host injects
 * these into member sessions and enforces the permission maps — an allow
 * entry surfaces the tool, a deny entry hides it — so these are live
 * grants, and naming them explicitly still matters because the host SDK
 * may silently ignore the "*" wildcard (same pattern as
 * MEMBER_TEAM_TOOLS_PERMISSION). Spread by every preset whose role
 * includes direct code reading. Locked by tests/agents.test.ts
 * (table-driven: preset x tier).
 */
export const AFT_READ_TOOLS_PERMISSION: OcteamAgentPermission = {
    aft_search: "allow",
    aft_grep: "allow",
    aft_glob: "allow",
    aft_read: "allow",
    aft_outline: "allow",
    aft_zoom: "allow",
}

/**
 * Single-key call-graph tier. Kept separate because its grant set
 * (oracle, explore, junior, deep) matches no other tier: explore takes
 * callgraph without diagnostics, while the analysis presets (metis,
 * momus) deliberately stay light without it. Locked by tests/agents.test.ts.
 */
export const AFT_CALLGRAPH_PERMISSION: OcteamAgentPermission = {
    aft_callgraph: "allow",
}

/**
 * Read-only diagnostics tier (codebase health + LSP navigation).
 * lsp_rename is deliberately absent: it applies workspace edits and is a
 * WRITE tool (see AFT_WRITE_TOOLS_DENY). Locked by tests/agents.test.ts.
 */
export const AFT_DIAGNOSTICS_PERMISSION: OcteamAgentPermission = {
    aft_inspect: "allow",
    lsp_diagnostics: "allow",
    lsp_symbols: "allow",
    lsp_goto_definition: "allow",
    lsp_find_references: "allow",
    lsp_status: "allow",
}

/**
 * Write-family deny for non-executor presets (read-only + analysis agents).
 * The host hides denied tools from the member session entirely, so this is
 * the live enforcement keeping structured write tools out of read-only
 * roles — defense in depth beyond "*": "deny", and effective even while
 * the host SDK ignores the "*" wildcard.
 * Executors (oct-junior, oct-deep) must NOT spread this.
 */
export const AFT_WRITE_TOOLS_DENY: OcteamAgentPermission = {
    aft_edit: "deny",
    aft_write: "deny",
    aft_apply_patch: "deny",
    aft_ast_replace: "deny",
    aft_refactor: "deny",
    aft_import: "deny",
    aft_move: "deny",
    aft_delete: "deny",
    aft_bash: "deny",
    lsp_rename: "deny",
}

/**
 * Permission action for an OCTeam agent — mirrors opencode's
 * PermissionActionConfig ("ask" | "allow" | "deny").
 */
export type OcteamPermissionAction = "ask" | "allow" | "deny"

/**
 * Nested permission object matching the SDK v2 PermissionObjectConfig.
 * Used for tools like `task` that support per-argument rules, e.g.
 * `task: { "*": "deny", "oct-librarian": "allow" }`.
 */
export type OcteamPermissionObject = {
    [key: string]: OcteamPermissionAction
}

/**
 * Permission map for an OCTeam agent. Explicitly includes `task` (subtask
 * delegation), which the installed v1 AgentConfig.permission type omits — this
 * local type lets us author `task: "deny"` without a tsc excess-property error.
 * Every key is structurally assignable to the v1 AgentConfig.permission object,
 * so each agent definition assigns cleanly into opencode's live `cfg.agent`.
 */
export interface OcteamAgentPermission {
    edit?: OcteamPermissionAction | OcteamPermissionObject
    task?: OcteamPermissionAction | OcteamPermissionObject
    bash?: OcteamPermissionAction | OcteamPermissionObject
    webfetch?: OcteamPermissionAction
    read?: OcteamPermissionAction
    glob?: OcteamPermissionAction
    grep?: OcteamPermissionAction
    // Index signature: allows wildcard "*": "deny" to close default-allow
    // gaps where unlisted tools (MCP, plugins) inherit allow from OpenCode.
    [key: string]: OcteamPermissionAction | OcteamPermissionObject | undefined
}

/**
 * Minimal AgentConfig for OCTeam's built-in agents — a deliberately narrow
 * subset of opencode's AgentConfig (only the fields OCTeam sets), kept
 * structurally assignable to the plugin's v1 AgentConfig.
 */
export interface OcteamAgentConfig {
    mode: "subagent"
    description: string
    prompt: string
    temperature?: number
    color?: string
    permission?: OcteamAgentPermission
    [key: string]: unknown
}
