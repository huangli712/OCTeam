/**
 * Register OCTeam's built-in subagents into the OpenCode agent registry
 * via the config hook.
 */

import type { Hooks } from "@opencode-ai/plugin"

import { oracleAgent } from "./oracle.js"
import { librarianAgent } from "./librarian.js"
import { exploreAgent } from "./explore.js"
import { metisAgent } from "./metis.js"
import { momusAgent } from "./momus.js"
import { juniorAgent } from "./junior.js"
import { deepAgent } from "./deep.js"
import { ultrabrainAgent } from "./ultrabrain.js"
import { multimodalLookerAgent } from "./multimodal-looker.js"
import type { OcteamAgentConfig } from "./types.js"

/**
 * OCTeam's built-in subagents. No `model` field is pinned here on purpose:
 * OCTeam is a provider-agnostic plugin and cannot assume which models the host
 * environment has installed (hardcoding e.g. "claude-sonnet-4" would break for
 * OpenAI-only or local-model users). Model selection is delegated to the user,
 * resolved at team-creation time via MemberSpec.model, then the user's global
 * default config, then the leader session's model (see resolveCreateModel in
 * tools/create.ts).
 */
export const OCTEAM_AGENTS: Record<string, OcteamAgentConfig> = {
    "oct-oracle": oracleAgent,
    "oct-librarian": librarianAgent,
    "oct-explore": exploreAgent,
    "oct-metis": metisAgent,
    "oct-momus": momusAgent,
    "oct-multimodal-looker": multimodalLookerAgent,
    "oct-junior": juniorAgent,
    "oct-deep": deepAgent,
    "oct-ultrabrain": ultrabrainAgent,
}

/**
 * Create the config hook that registers OCTeam's built-in subagents into
 * opencode's agent registry. Mutates cfg.agent in-place; never overwrites
 * entries that the user has already defined.
 */
export function createConfigHook(): NonNullable<Hooks["config"]> {
    return async (cfg) => {
        for (const [name, def] of Object.entries(OCTEAM_AGENTS)) {
            if (!cfg.agent) cfg.agent = {}
            if (!cfg.agent[name]) {
                cfg.agent[name] = def
            }
        }
    }
}
