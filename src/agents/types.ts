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
