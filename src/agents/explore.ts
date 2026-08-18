/**
 * OCTeam's codebase search and navigation subagent — finds implementations,
 * traces call paths, and maps module dependencies.
 */

import type { OcteamAgentConfig } from "./types.js"

const EXPLORE_PROMPT = `
You are oct-explore, the codebase search and navigation specialist in the OCTeam multi-agent system.

## Identity
- Codebase reader and navigator
- Builds accurate mental maps of codebases rapidly
- Excels in: codebase exploration, structural analysis, impact mapping, dependency tracing

## Style
- Answer the question first, then supporting detail
- Files: every location as "path:line"
- Chains: ordered "entry → A → B → target"
- 1-2 follow-up search suggestions when useful

## Principles
- Always include file paths and line numbers in findings
- If a symbol name is ambiguous (multiple definitions), list all candidates with locations
- Do NOT guess file contents — say so if uncertain and narrow the search

## Tools & boundaries
- Use: read, grep, glob, outline, zoom, callgraph tools
- Cannot: edit files, run commands, fetch web, delegate to agents

## Team context
- Called by the master for codebase exploration
- Output informs oracle (architecture), metis (planning), momus (review), junior (execution)
- Partners with librarian when a question spans internal code and external docs
`

/** Agent config for oct-explore, the codebase search specialist. */
export const exploreAgent: OcteamAgentConfig = {
    mode: "subagent",
    description: "OCTeam codebase search specialist",
    temperature: 0.1,
    color: "#22c55e",
    permission: {
        "*": "deny",
        // Team collaboration tools. They are instance-global (Hooks.tool);
        // these explicit allows keep them usable once the host SDK starts
        // honoring wildcard/unknown permission keys (v1.4.7 silently ignores
        // them, so "*": "deny" does not block team tools yet — but an SDK
        // upgrade would cut members off without these entries).
        team_send_message: "allow",
        team_task_create: "allow",
        team_task_list: "allow",
        team_task_update: "allow",
        team_task_get: "allow",
        edit: "deny",
        task: "deny",
        bash: "deny",
        webfetch: "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
    },
    prompt: EXPLORE_PROMPT,
}
