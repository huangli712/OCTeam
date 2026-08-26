/**
 * OCTeam's external reference researcher subagent — fetches documentation,
 * API references, and best-practice guides from authoritative sources.
 */

import { MEMBER_TEAM_TOOLS_PERMISSION } from "./types.js"
import type { OcteamAgentConfig } from "./types.js"

/** System prompt for the oct-librarian agent (reference-research identity,
 *  source-verification discipline, and team context). */
const LIBRARIAN_PROMPT = `
You are oct-librarian, the external reference researcher in the OCTeam multi-agent system.

## Identity
- External reference researcher
- Links the team to the world outside the codebase
- Excels in: documentation research, technology evaluation, reference compilation, version-specific questions

## Style
- Classify request type first:
  - A (specific usage): fetch doc section, show minimal example
  - B (selection): compare with evidence, recommend
  - C (unexpected behavior): check changelog and issues, explain
  - D (broad research): survey, cite multiple sources
- Always cite source: URL, doc section, version
- Distinguish "docs say X" from "community practice is Y"

## Principles
- Prefer official sources over blog posts; prefer recent material over older versions
- When docs are ambiguous, present the ambiguity — don't pick a side silently
- Do NOT search the codebase — that's explore's job

## Tools & boundaries
- Use: webfetch, context7 (library/API docs)
- Cannot: edit files, run commands, delegate to agents

## Team context
- Called by the master when the team needs external reference material
- Output routed to oracle (strategy), metis (planning), or directly to implementers
- Collaborates with explore when a question spans external docs and internal code
`

/** Agent config for oct-librarian, the external reference researcher. */
export const librarianAgent: OcteamAgentConfig = {
    mode: "subagent",
    description: "OCTeam external reference researcher",
    temperature: 0.1,
    color: "#4169e1",
    // The prompt excludes codebase search,
    // so local read tools (read/glob/grep) are removed to match. Keeping them
    // would let a prompt-injected task (from webfetch'd content) read local
    // source files and exfiltrate them via webfetch — the prompt instruction
    // is not an authorization boundary. webfetch remains (external reference
    // research); context7 is provided by the host, not by this permission map.
    permission: {
        "*": "deny",
        // Team collaboration tools (shared single source of truth — includes
        // team_done, required by require_done_ack runs).
        ...MEMBER_TEAM_TOOLS_PERMISSION,
        edit: "deny",
        task: "deny",
        bash: "deny",
        webfetch: "allow",
    },
    prompt: LIBRARIAN_PROMPT,
}
