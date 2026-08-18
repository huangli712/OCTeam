/**
 * OCTeam's strategic advisor subagent — provides architecture evaluation,
 * goal verification, and high-level correctness analysis.
 */

import type { OcteamAgentConfig } from "./types.js"

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
    prompt: ORACLE_PROMPT,
}
