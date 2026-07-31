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
import type { OcteamAgentConfig, OcteamAgentPermission, OcteamPermissionAction } from "./types.js"

/**
 * OCTeam's built-in subagents. No `model` field is pinned here on purpose:
 * OCTeam is a provider-agnostic plugin and cannot assume which models the host
 * environment has installed (hardcoding e.g. "claude-sonnet-4" would break for
 * OpenAI-only or local-model users). Model selection is delegated to the user,
 * resolved at team-creation time via MemberSpec.model, then the user's global
 * default config, then the leader session's model (see resolveCreateModel in
 * tools/lifecycle/create.ts).
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
 * Monotonically merge user permissions over OCTeam presets: the user may
 * only TIGHTEN (allow → ask → deny), never loosen. Preset permissions act
 * as a security floor — user config can restrict further but cannot open
 * tools the preset denies. The wildcard "*" key (if present in the preset)
 * serves as the effective baseline for any tool the preset does not name
 * explicitly.
 */
function mergePermissionsMonotonic(
    preset: OcteamAgentPermission | undefined,
    userPerm?: unknown,
): OcteamAgentPermission {
    const result: OcteamAgentPermission = { ...(preset ?? {}) }
    if (!userPerm || typeof userPerm !== "object") return result
    const rank: Record<string, number> = { allow: 0, ask: 1, deny: 2 }
    const wildcardAction = result["*"]
    for (const [tool, action] of Object.entries(userPerm as Record<string, unknown>)) {
        // #2: handle both scalar and nested (Record<string,Action>) values.
        // SDK supports bash: { "*": "deny", "git status": "allow" }.
        if (action === "allow" || action === "deny" || action === "ask") {
            const presetAction = result[tool]
            const effectiveBaseline = typeof presetAction === "string" ? presetAction : wildcardAction
            if (effectiveBaseline === undefined || rank[action] >= rank[effectiveBaseline]) {
                result[tool] = action
            }
        } else if (action !== null && typeof action === "object" && !Array.isArray(action)) {
            // Nested permission map (e.g. bash: { "git push": "deny" }).
            // CRIT #5: preserve the preset's wildcard baseline so the nested
            // map doesn't weaken the default-deny posture. Pre-fix code
            // replaced the scalar entirely, losing the "*":"deny" floor.
            const presetScalar = typeof result[tool] === "string" ? result[tool] as string : wildcardAction
            const nested: Record<string, OcteamPermissionAction> = {}
            // Always seed with the preset baseline so unlisted sub-keys inherit it.
            if (presetScalar !== undefined) {
                nested["*"] = presetScalar as OcteamPermissionAction
            }
            for (const [subTool, subAction] of Object.entries(action as Record<string, unknown>)) {
                if (subAction !== "allow" && subAction !== "deny" && subAction !== "ask") continue
                if (presetScalar === undefined || rank[subAction] >= rank[presetScalar]) {
                    nested[subTool] = subAction
                }
            }
            if (Object.keys(nested).length > 0) {
                result[tool] = nested as unknown as OcteamPermissionAction
            }
        }
    }
    return result
}

/** Recursively freeze an object and all nested objects (deep freeze). */
function deepFreeze<T>(obj: T): T {
    if (obj === null || typeof obj !== "object") return obj
    Object.freeze(obj)
    for (const value of Object.values(obj as Record<string, unknown>)) {
        if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
            deepFreeze(value)
        }
    }
    return obj
}

/**
 * Create the config hook that registers OCTeam's built-in subagents into
 * opencode's agent registry. For oct-* names (security-hardened presets)
 * the security-critical fields — mode, prompt, permission, description — are
 * ALWAYS overridden with OCTeam's definitions; user values for these fields
 * are ignored because a user (or attacker with config write access) could
 * otherwise replace `permission: { edit: "allow", bash: "allow" }` or inject
 * a malicious prompt, completely bypassing the hardened permission map that
 * role.ts promises. Non-security fields (model, temperature, color, ...) are
 * preserved so users can still pin a model or tune cosmetic values.
 */
export function createConfigHook(): NonNullable<Hooks["config"]> {
    return async (cfg) => {
        if (!cfg.agent) cfg.agent = {}
        for (const [name, def] of Object.entries(OCTEAM_AGENTS)) {
            const existing = cfg.agent[name]
            if (!existing) {
                // User did not define this agent — apply OCTeam preset verbatim.
                // HIGH-G: clone the preset so a later mutation by another config
                // hook (or by reference to cfg.agent[...]) does not leak back
                // into OCTEAM_AGENTS (shared reference bug).
                // H1: freeze the permission object so a LATER plugin's config
                // hook cannot in-place weaken it (e.g. flip edit to "allow").
                // A later hook that REPLACES the whole permission object still
                // can (visible operation), but silent field mutation is blocked.
                const perm = deepFreeze(mergePermissionsMonotonic(def.permission))
                cfg.agent[name] = { ...def, permission: perm }
                continue
            }
            // User pre-defined an oct-* entry. Preserve ONLY the non-security
            // fields users may legitimately tune (model, temperature, color).
            // HIGH-G: pre-fix code spread `...existing`, which kept arbitrary
            // user-defined fields like `tools`, `top_p`, `maxSteps`, `disable` —
            // any of these could weaken the hardened preset (e.g. extra tools
            // bypass the permission map; disable:false resurrects a deprecated
            // preset). Explicit allowlist closes the gap.
            const allowed: Record<string, unknown> = {}
            if (typeof existing.model === "string") allowed.model = existing.model
            if (typeof existing.temperature === "number") allowed.temperature = existing.temperature
            if (typeof existing.color === "string") allowed.color = existing.color
            // H2: preserve `variant` (OpenCode model reasoning variant, e.g.
            // "max"). Pre-fix allowlist omitted it, silently dropping the
            // user's chosen reasoning variant on every config hook pass.
            if (typeof existing.variant === "string") allowed.variant = existing.variant
            // L1: preserve top_p (sampling parameter).
            if (typeof existing.top_p === "number") allowed.top_p = existing.top_p
            // M3: preserve `steps` (conversation step limit) and `hidden`
            // (UI visibility). Both are user preferences, not security
            // fields — dropping them silently resets user configuration.
            if (typeof existing.steps === "number") allowed.steps = existing.steps
            if (typeof existing.maxSteps === "number") allowed.maxSteps = existing.maxSteps
            if (typeof existing.hidden === "boolean") allowed.hidden = existing.hidden
            cfg.agent[name] = {
                ...def,
                // H1: freeze the permission object so later hooks cannot mutate
                // it in-place. Re-asserted after the allowed merge for the same
                // reason as mode/description/prompt below.
                permission: deepFreeze(mergePermissionsMonotonic(def.permission, existing?.permission)),
                ...allowed,
                // Security-critical overrides (OCTeam wins) — re-asserted AFTER
                // the allowed merge above so a stray `mode` in `existing` (which
                // we did not copy) cannot sneak in via the spread of `def`.
                mode: def.mode,
                description: def.description,
                prompt: def.prompt,
            }
        }
    }
}
