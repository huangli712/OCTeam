/**
 * OCTeam's codebase search and navigation subagent — finds implementations,
 * traces call paths, and maps module dependencies.
 */

import type { OcteamAgentConfig } from "./types.js"
import {
    AFT_CALLGRAPH_PERMISSION,
    AFT_READ_TOOLS_PERMISSION,
    AFT_WRITE_TOOLS_DENY,
    MEMBER_TEAM_TOOLS_PERMISSION
} from "./types.js"

/** System prompt for the oct-explore agent (identity, search discipline,
 *  output contract, and team context). */
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
- Use: read, grep, glob; prefer the indexed tools when your session has them
  (aft_search, aft_grep, aft_glob, aft_read, aft_outline, aft_zoom, aft_callgraph)
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
        // Team collaboration tools (shared single source of truth — includes
        // team_done, required by require_done_ack runs).
        ...MEMBER_TEAM_TOOLS_PERMISSION,
        // Indexed search tier — forward-compatible allows: member sessions
        // expose no aft_* tools today (see types.ts), so these keep the tools
        // usable once the host injects them. callgraph joins the core tier
        // for the search specialist.
        ...AFT_READ_TOOLS_PERMISSION,
        ...AFT_CALLGRAPH_PERMISSION,
        // Structured write-family tools stay denied for read-only roles even
        // if the host injects them later (the "*" wildcard may be ignored).
        ...AFT_WRITE_TOOLS_DENY,
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
