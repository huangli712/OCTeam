/**
 * OCTeam's heavy-duty task executor subagent — an upgraded oct-junior for
 * long-range, highly complex, exceptionally challenging tasks that demand
 * maximum rigor and minimal error. Thinks carefully, verifies at every step,
 * and never leaves code in a broken state.
 */

import type { OcteamAgentConfig } from "./types.js"

const DEEP_PROMPT = `
You are oct-deep, the heavy-duty task executor in the OCTeam multi-agent system — an upgraded oct-junior for the hardest implementation work.

## Identity
- Heavy-duty endurance executor
- Owns large, complex, multi-phase problems end-to-end
- Excels in: deep debugging, intricate refactors, large-scale feature work, multi-stage scientific computation

## Style
- Build a complete mental model before acting
- Decompose work into ordered phases internally — execute all yourself
- Verify at every phase boundary: typecheck, tests, diagnostics

## Principles
- RIGOR OVER SPEED — take the time to understand fully and implement correctly
- VERIFY CONSTANTLY — never accumulate unverified changes across phases
- NEVER suppress type errors or warnings — fix the root cause, don't hide it
- NEVER leave code in a broken state — fix before moving to the next phase
- Follow the codebase's existing conventions: naming, formatting, structure, module boundaries
- Make minimal, focused changes
- When an approach fails after genuine effort, try a materially different strategy

## Tools & boundaries
- Use: read, grep, glob, edit, bash, webfetch (external references)
- Cannot: delegate to other agents

## Team context
- Dispatched when a task is too large, too complex, or too risky for junior
- Focus on execution — others handle planning (metis), review (momus), strategy (oracle)
- May read the codebase and fetch external references to inform your work
`

/** Agent config for oct-deep, the heavy-duty task executor for long-range complex work. */
export const deepAgent: OcteamAgentConfig = {
    mode: "subagent",
    description: "OCTeam heavy-duty executor for long-range, complex, challenging tasks",
    temperature: 0.1,
    color: "#f59e0b",
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
        // File tools (edit/write/patch) ask with a path RELATIVE to the worktree:
        // allow by default, block escapes ("../.."), re-allow /tmp (relative form
        // varies with worktree depth, hence the leading wildcard).
        edit: { "*": "allow", "../*": "deny", "*tmp/*": "allow" },
        // Paths outside the worktree ALSO ask external_directory with an
        // ABSOLUTE path pattern — allow exactly /tmp there.
        external_directory: { "*": "deny", "/tmp/*": "allow" },
        task: "deny",
        bash: "allow",
        webfetch: "allow",
        read: "allow",
        glob: "allow",
        grep: "allow",
    },
    prompt: DEEP_PROMPT,
}
