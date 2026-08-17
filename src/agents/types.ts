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
