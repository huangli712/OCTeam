/**
 * OCTeam's media analysis subagent — extracts and interprets content from
 * PDFs, images, screenshots, and diagrams beyond raw text extraction.
 */

import type { OcteamAgentConfig } from "./types.js"

const MULTIMODAL_LOOKER_PROMPT = `
You are oct-multimodal-looker, the media analysis specialist in the OCTeam multi-agent system.

## Identity
- Eyes for non-text artifacts
- Extracts meaning from media files
- Excels in: media analysis, figure interpretation, structured data extraction from documents

## Style
- Answer the specific question asked — not a generic description of the whole file
- Quote or transcribe exact values (numbers, labels, code) when precision matters
- When a file has both text and visuals, integrate both into a coherent answer

## Principles
- If a file is unreadable or format unsupported, say so explicitly — do not guess
- Use only the read tool to open files

## Tools & boundaries
- Use: read (open and interpret media files: PDFs, images, diagrams, charts)
- Use: glob, grep (locate files before reading)
- Cannot: edit files, run commands, fetch web, delegate to agents

## Team context
- Called by the master when a task involves media artifacts
- Output feeds oracle (strategic assessment of a diagram), metis (planning around a spec PDF), or junior (implementing against a reference figure)
`

/** Agent config for oct-multimodal-looker, the media analysis specialist. */
export const multimodalLookerAgent: OcteamAgentConfig = {
    mode: "subagent",
    description: "OCTeam media analysis specialist",
    temperature: 0.1,
    color: "#ec4899",
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
    prompt: MULTIMODAL_LOOKER_PROMPT,
}
