/**
 * Permission action for an OCTeam agent — mirrors opencode's
 * PermissionActionConfig ("ask" | "allow" | "deny").
 */
export type OcteamPermissionAction = "ask" | "allow" | "deny"

/**
 * Permission map for an OCTeam agent. Explicitly includes `task` (subtask
 * delegation), which the installed v1 AgentConfig.permission type omits — this
 * local type lets us author `task: "deny"` without a tsc excess-property error.
 * Every key is structurally assignable to the v1 AgentConfig.permission object,
 * so each agent definition assigns cleanly into opencode's live `cfg.agent`.
 */
export interface OcteamAgentPermission {
    edit?: OcteamPermissionAction
    task?: OcteamPermissionAction
    bash?: OcteamPermissionAction
    webfetch?: OcteamPermissionAction
    read?: OcteamPermissionAction
    glob?: OcteamPermissionAction
    grep?: OcteamPermissionAction
    // Index signature: allows wildcard "*": "deny" to close default-allow
    // gaps where unlisted tools (MCP, plugins) inherit allow from OpenCode.
    [key: string]: OcteamPermissionAction | undefined
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
    /**
     * C7: when permission.task is "allow", restrict delegation to these agent
     * names. Enforced as a prompt-level constraint; full runtime enforcement
     * awaits opencode framework support for per-tool argument validation.
     */
    taskTargets?: readonly string[]
    [key: string]: unknown
}
