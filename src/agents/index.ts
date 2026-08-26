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

/** A scalar tool action or a per-subtool permission map. */
export type MergedPermissionValue = OcteamPermissionAction | Record<string, OcteamPermissionAction>

/** Merged permissions keyed by tool name. */
export type MergedAgentPermission = Record<string, MergedPermissionValue | undefined>

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

/** Return whether a value is a supported scalar permission action. */
function isPermissionAction(value: unknown): value is OcteamPermissionAction {
    return value === "allow" || value === "deny" || value === "ask"
}

/**
 * Monotonically merge user permissions over OCTeam presets: the user may
 * only TIGHTEN (allow → ask → deny), never loosen. Preset permissions act
 * as a security floor — user config can restrict further but cannot open
 * tools the preset denies. The wildcard "*" key (if present in the preset)
 * serves as the effective baseline for any tool the preset does not name
 * explicitly.
 */
export function mergePermissionsMonotonic(
    preset: OcteamAgentPermission | undefined,
    userPerm?: unknown,
): MergedAgentPermission {
    const result: MergedAgentPermission = { ...(preset ?? {}) }
    if (!userPerm || typeof userPerm !== "object" || Array.isArray(userPerm)) return result
    const rank: Record<OcteamPermissionAction, number> = { allow: 0, ask: 1, deny: 2 }
    const wildcardAction = result["*"]
    for (const [tool, action] of Object.entries(userPerm)) {
        // Handle both scalar and nested permission values.
        // SDK supports bash: { "*": "deny", "git status": "allow" }.
        if (isPermissionAction(action)) {
            const presetAction = result[tool]
            const effectiveBaseline = isPermissionAction(presetAction)
                ? presetAction
                : isPermissionAction(wildcardAction) ? wildcardAction : undefined
            if (effectiveBaseline === undefined || rank[action] >= rank[effectiveBaseline]) {
                result[tool] = action
            }
        } else if (action !== null && typeof action === "object" && !Array.isArray(action)) {
            // Nested permission map (e.g. bash: { "git push": "deny" }).
            // Preserve the preset's wildcard baseline so the nested map does
            // not weaken the default-deny posture.
            //
            // Existing nested subtool rules seed the result before user
            // entries are applied.
            const presetValue = result[tool]
            const presetScalar = isPermissionAction(presetValue)
                ? presetValue
                : isPermissionAction(wildcardAction) ? wildcardAction : undefined
            const nested: Record<string, OcteamPermissionAction> = {}
            // Inherit existing nested preset entries first.
            if (presetValue !== undefined && typeof presetValue === "object" && !Array.isArray(presetValue)) {
                for (const [k, v] of Object.entries(presetValue)) {
                    if (isPermissionAction(v)) nested[k] = v
                }
            } else if (presetScalar !== undefined) {
                // Preset is scalar — seed the baseline wildcard.
                nested["*"] = presetScalar
            }
            const nestedEntries = Object.entries(action)
            if (nestedEntries.length === 0 || nestedEntries.some(([, value]) => !isPermissionAction(value))) {
                continue
            }
            // Apply user entries, respecting monotonic tightening.
            const nestedWildcardBaseline = isPermissionAction(nested["*"])
                ? nested["*"]
                : isPermissionAction(wildcardAction) ? wildcardAction : undefined
            for (const [subTool, subAction] of nestedEntries) {
                if (!isPermissionAction(subAction)) continue
                const existingNested = nested[subTool]
                const baseline = isPermissionAction(existingNested)
                    ? existingNested
                    : nestedWildcardBaseline
                if (baseline === undefined || rank[subAction] >= rank[baseline]) {
                    nested[subTool] = subAction
                }
            }
            if (Object.keys(nested).length > 0) {
                result[tool] = nested
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
 * the security-critical fields — mode, prompt, description — are ALWAYS
 * overridden with OCTeam's definitions and user values for them are ignored,
 * because a user (or attacker with config write access) could otherwise
 * inject a malicious prompt. Permission is always rebuilt from OCTeam's
 * preset; user permission entries are honored only where they TIGHTEN the
 * preset (monotonic merge via mergePermissionsMonotonic — never loosen).
 * Non-security fields (model, temperature, color, ...) are
 * preserved so users can still pin a model or tune cosmetic values.
 */
export function createConfigHook(): NonNullable<Hooks["config"]> {
    return async (cfg) => {
        if (!cfg.agent) cfg.agent = {}
        for (const [name, def] of Object.entries(OCTEAM_AGENTS)) {
            const existing = cfg.agent[name]
            if (!existing) {
                // No user-defined agent exists for this name — apply the
                // OCTeam preset verbatim.
                // Clone the preset so a later mutation by another config
                // hook (or by reference to cfg.agent[...]) does not leak back
                // into OCTEAM_AGENTS (shared reference bug).
                // Freeze the permission object so a later plugin's config
                // hook cannot in-place weaken it (e.g. flip edit to "allow").
                // A later hook that REPLACES the whole permission object still
                // can (visible operation), but silent field mutation is blocked.
                const perm = deepFreeze(mergePermissionsMonotonic(def.permission))
                cfg.agent[name] = { ...def, permission: perm }
                continue
            }
            // A user-defined oct-* entry exists. Preserve ONLY the non-security
            // fields users may legitimately tune (e.g. model, temperature,
            // color). The explicit allowlist excludes unknown user-defined
            // fields that could weaken the hardened preset.
            const allowed: Record<string, unknown> = {}
            if (typeof existing.model === "string") allowed.model = existing.model
            if (typeof existing.temperature === "number") allowed.temperature = existing.temperature
            if (typeof existing.color === "string") allowed.color = existing.color
            // Preserve the user's model reasoning variant, for example "max".
            if (typeof existing.variant === "string") allowed.variant = existing.variant
            // Preserve the user's sampling parameter.
            if (typeof existing.top_p === "number") allowed.top_p = existing.top_p
            // Preserve conversation limits and UI visibility because they do
            // not affect the security boundary.
            if (typeof existing.steps === "number") allowed.steps = existing.steps
            if (typeof existing.maxSteps === "number") allowed.maxSteps = existing.maxSteps
            if (typeof existing.hidden === "boolean") allowed.hidden = existing.hidden
            cfg.agent[name] = {
                ...def,
                // Freeze the permission object so later hooks cannot mutate
                // it in-place. Re-asserted over the `...def` spread for the same
                // reason as mode/description/prompt below.
                permission: deepFreeze(mergePermissionsMonotonic(def.permission, existing?.permission)),
                ...allowed,
                // Security-critical overrides (OCTeam wins) — re-asserted LAST
                // so no user-derived value (now or via future allowlist
                // additions) can override OCTeam's definitions.
                mode: def.mode,
                description: def.description,
                prompt: def.prompt,
            }
        }
    }
}
