import type { Hooks } from "@opencode-ai/plugin"

import { oracleAgent } from "./oracle.js"
import { librarianAgent } from "./librarian.js"
import { exploreAgent } from "./explore.js"
import { metisAgent } from "./metis.js"
import { momusAgent } from "./momus.js"
import { juniorAgent } from "./junior.js"
import type { OcteamAgentConfig } from "./types.js"

export const OCTEAM_AGENTS: Record<string, OcteamAgentConfig> = {
    "oct-oracle": oracleAgent,
    "oct-librarian": librarianAgent,
    "oct-explore": exploreAgent,
    "oct-metis": metisAgent,
    "oct-momus": momusAgent,
    "oct-junior": juniorAgent,
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
