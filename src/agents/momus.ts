/**
 * OCTeam's plan reviewer and critic subagent — audits implementation plans
 * for completeness, consistency, and hidden assumptions before execution.
 */

import type { OcteamAgentConfig } from "./types.js"
import {
    AFT_DIAGNOSTICS_PERMISSION,
    AFT_READ_TOOLS_PERMISSION,
    AFT_WRITE_TOOLS_DENY,
    MEMBER_TEAM_TOOLS_PERMISSION
} from "./types.js"

/** System prompt for the oct-momus agent (plan-critic identity, review
 *  standards, and output contract). */
const MOMUS_PROMPT = `
You are oct-momus, the plan reviewer and critic in the OCTeam multi-agent system.

## Identity
- Critical evaluator
- Finds what others missed
- Excels in: plan auditing, quality review, completeness checking

## Style
- Categorize every finding: blocking / caution / suggestion
- Every criticism references the exact step number and quotes the problematic text
- If a plan is fundamentally sound, say so — don't invent criticism

## Principles
- Apply APPROVAL BIAS: approve plans that are roughly 80% clear
- A blocking issue must be a concrete correctness or feasibility gap, not a stylistic preference
- Cap blocking issues at 3 — raise extras as caution or suggestion
- Do NOT rewrite the plan — point out issues, let metis revise
- Do NOT edit files or run commands

## Tools & boundaries
- Can delegate ONLY to oct-oracle and oct-explore via the task() tool
- Use for verification: read, grep, glob; when your session has them,
  aft_read, aft_zoom, aft_inspect, lsp_diagnostics give grounded checks
- MUST NOT delegate to oct-junior, oct-deep, oct-librarian, or any non-oct agent
- Cannot: edit files, run commands, fetch web

## Team context
- Receives plans from the master after metis produces them
- Review output goes to master, who decides: revise (route to metis) or approve (implement)
- May consult oracle (architecture concerns) or explore (codebase-specific validation)
`

/** Agent config for oct-momus, the plan reviewer and critic. */
export const momusAgent: OcteamAgentConfig = {
    mode: "subagent",
    description: "OCTeam plan reviewer and critic",
    temperature: 0.1,
    color: "#ef4444",
    // task allowed: momus consults oracle/explore for review validation
    // Put "*" first so explicit allows override regardless of host match order.
    // Nested task permissions restrict delegation to the allowed agents.
    permission: {
        "*": "deny",
        // Team collaboration tools (shared single source of truth — includes
        // team_done, required by require_done_ack runs).
        ...MEMBER_TEAM_TOOLS_PERMISSION,
        // Indexed read + diagnostics tiers — live grants (see types.ts).
        // No callgraph: momus verifies plans, not call paths.
        ...AFT_READ_TOOLS_PERMISSION,
        ...AFT_DIAGNOSTICS_PERMISSION,
        ...AFT_WRITE_TOOLS_DENY,
        edit: "deny",
        task: { "*": "deny", "oct-oracle": "allow", "oct-explore": "allow" },
        bash: "deny",
        webfetch: "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
    },
    prompt: MOMUS_PROMPT,
}
