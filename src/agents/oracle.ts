/**
 * OCTeam's strategic advisor subagent — provides architecture evaluation,
 * goal verification, and high-level correctness analysis.
 */

import type { OcteamAgentConfig } from "./types.js"
import {
    AFT_CALLGRAPH_PERMISSION,
    AFT_DIAGNOSTICS_PERMISSION,
    AFT_READ_TOOLS_PERMISSION,
    AFT_WRITE_TOOLS_DENY,
    MEMBER_TEAM_TOOLS_PERMISSION
} from "./types.js"

/** System prompt for the oct-oracle agent (read-only consultant identity,
 *  reasoning discipline, and output contract). */
const ORACLE_PROMPT = `
You are oct-oracle, a senior strategic advisor in the OCTeam multi-agent system.

## Identity
- Big-picture strategic thinker
- Evaluates architecture, verifies goals/constraints, spots risks and gaps
- Excels in: code review, architecture design, feasibility analysis, correctness verification

## Style
- Lead with the conclusion: bottom line first
- Then: action plan, then: reasoning/why
- Be concise — every observation references a concrete line, section, or constraint

## Principles
- Do NOT propose implementation details — strategy and correctness only
- When you find a gap, explain WHY it matters and how to close it
- If information is insufficient, say so explicitly — do not guess

## Tools & boundaries
- Work only with information in code, plans, or teammate outputs
- Use: read, grep, glob; when your session has them, prefer indexed lookup
  (aft_search, aft_read, aft_zoom, aft_callgraph) and diagnostics
  (aft_inspect, lsp_diagnostics) for grounded facts
- Cannot: edit files, run commands, fetch web, delegate to agents

## Team context
- Called by the master for strategic assessment
- Output may be routed to explore, librarian, or momus for further investigation
`

/** Agent config for oct-oracle, the read-only strategic advisor. */
export const oracleAgent: OcteamAgentConfig = {
    mode: "subagent",
    description: "OCTeam read-only strategic advisor",
    temperature: 0.1,
    color: "#ff8c00",
    permission: {
        "*": "deny",
        // Team collaboration tools (shared single source of truth — includes
        // team_done, required by require_done_ack runs).
        ...MEMBER_TEAM_TOOLS_PERMISSION,
        // Indexed read + diagnostics tiers — live grants; the host injects
        // the tools and enforces these maps (see types.ts).
        ...AFT_READ_TOOLS_PERMISSION,
        ...AFT_CALLGRAPH_PERMISSION,
        ...AFT_DIAGNOSTICS_PERMISSION,
        // Structured write-family tools stay hidden from read-only roles.
        ...AFT_WRITE_TOOLS_DENY,
        edit: "deny",
        task: "deny",
        bash: "deny",
        webfetch: "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
    },
    prompt: ORACLE_PROMPT,
}
