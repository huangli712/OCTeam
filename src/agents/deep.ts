/**
 * OCTeam's heavy-duty task executor subagent — an upgraded oct-junior for
 * long-range, highly complex, exceptionally challenging tasks that demand
 * maximum rigor and minimal error. Thinks carefully, verifies at every step,
 * and never leaves code in a broken state.
 */

import type { OcteamAgentConfig } from "./types.js"
import {
    AFT_CALLGRAPH_PERMISSION,
    AFT_DIAGNOSTICS_PERMISSION,
    AFT_READ_TOOLS_PERMISSION,
    MEMBER_TEAM_TOOLS_PERMISSION
} from "./types.js"

/** System prompt for the oct-deep agent (identity, style, principles,
 *  tool boundaries, and team context). */
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
- Use: read, grep, glob, edit, write, bash, webfetch (external references);
  prefer the structured tools when your session has them:
  aft_search/aft_read/aft_zoom for investigation,
  aft_edit/aft_apply_patch/aft_ast_replace/aft_refactor for edits,
  lsp_diagnostics for verification, aft_safety checkpoint before bulk rewrites
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
        // Team collaboration tools (shared single source of truth — includes
        // team_done, required by require_done_ack runs). They are instance-global
        // (Hooks.tool); these explicit allows keep them usable once the host SDK
        // starts honoring wildcard/unknown permission keys (v1.4.7 silently ignores
        // them, so "*": "deny" does not block team tools yet — but an SDK
        // upgrade would cut members off without these entries).
        ...MEMBER_TEAM_TOOLS_PERMISSION,
        // File tools (edit/write/patch) ask with a path RELATIVE to the worktree:
        // allow by default, block escapes ("../.."), re-allow /tmp (relative form
        // varies with worktree depth, hence the leading wildcard).
        edit: { "*": "allow", "../*": "deny", "*tmp/*": "allow" },
        // Builtin write tool follows the same file-tool rules as edit.
        write: { "*": "allow", "../*": "deny", "*tmp/*": "allow" },
        // Paths outside the worktree ALSO ask external_directory with an
        // ABSOLUTE path pattern — allow exactly /tmp there.
        external_directory: { "*": "deny", "/tmp/*": "allow" },
        // Indexed read + diagnostics tiers — forward-compatible allows
        // (member sessions expose no aft_*/lsp_* tools today; see types.ts).
        ...AFT_READ_TOOLS_PERMISSION,
        ...AFT_CALLGRAPH_PERMISSION,
        ...AFT_DIAGNOSTICS_PERMISSION,
        // Structured file tools mirror the edit rules above; workspace-wide
        // rewrite tools are deep-only, deletion asks first (forward-
        // compatible only).
        aft_edit: { "*": "allow", "../*": "deny", "*tmp/*": "allow" },
        aft_write: { "*": "allow", "../*": "deny", "*tmp/*": "allow" },
        aft_apply_patch: { "*": "allow", "../*": "deny", "*tmp/*": "allow" },
        aft_ast_search: "allow",
        aft_ast_replace: "allow",
        aft_refactor: "allow",
        aft_import: "allow",
        aft_move: "allow",
        aft_delete: "ask",
        aft_bash: "allow",
        aft_safety: "allow",
        lsp_prepare_rename: "allow",
        lsp_rename: "allow",
        task: "deny",
        bash: "allow",
        webfetch: "allow",
        read: "allow",
        glob: "allow",
        grep: "allow",
    },
    prompt: DEEP_PROMPT,
}
