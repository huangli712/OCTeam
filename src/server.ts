/**
 * OpenCode team orchestration plugin entry point. Builds the PluginContext,
 * rebuilds session index from disk, starts the sweep timer, and wires all
 * tools plus the event/transform hooks into the plugin framework.
 */

import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin"

import { createPluginContext, warnIfProjectScopeLacksIsolation } from "./core/context.js"
import type { PluginContext, StorageScope } from "./core/context.js"
import { createTools } from "./tools/index.js"
import {
    createCompactingHook,
    createEventHandler,
    createTransformHook,
    startSweepTimer,
} from "./hooks.js"
import { reconcileActivation, reconcileCrashedTeams } from "./orchestration/lifecycle/reconcile.js"
import { rebuildSessionIndex } from "./state/resolve.js"
import { initLogger, logSwallowed } from "./core/log.js"
import { createConfigHook } from "./agents/index.js"

const id = "octeam"

/**
 * Server plugin module entry. Builds the PluginContext closure, rebuilds the
 * session index from disk (crash recovery), starts the sweep timer, and wires
 * all 42 tools + the event/transform hooks.
 *
 * Pipeline: tool handlers + event handler + transform hook all
 * share ctx; event handler + sweep timer drive the per-team locked state
 * machine; mailbox/tasks/store persist under ~/.octeam (or <dir>/.octeam).
 *
 * H7 fix: accept PluginOptions so users can select storage scope via the
 * plugin config (e.g. ["octeam", { scope: "user" }]). Pre-fix code ignored
 * options entirely, making the "switch to user scope" mitigation in the
 * startup warning unreachable.
 */
const server = async (input: PluginInput, options?: Record<string, unknown>): Promise<Hooks> => {
    // H7: read storage scope from plugin options. Default to "project".
    // Accept "user" or "project" (case-insensitive); anything else falls
    // back to "project" for safety.
    const rawScope = options?.scope
    let scope: StorageScope
    if (rawScope === undefined) {
        scope = "project"
    } else if (typeof rawScope === "string") {
        const normalized = rawScope.toLowerCase()
        if (normalized === "user") scope = "user"
        else if (normalized === "project") scope = "project"
        else throw new Error(`octeam: invalid scope "${rawScope}" — must be "user" or "project"`)
    } else {
        throw new Error(`octeam: scope must be a string ("user" or "project"), got ${typeof rawScope}`)
    }
    const ctx: PluginContext = createPluginContext(input, scope)

    // Initialize the global logger sink so bottom-layer modules (state/,
    // messaging/) can emit structured logs without a ctx parameter.
    initLogger(ctx)

    // C-11: surface the control-state isolation threat model when project
    // scope is active. One-time startup warning; user scope is a no-op.
    warnIfProjectScopeLacksIsolation(ctx, ctx.scope, ctx.projectStorageRoot)

    // Crash recovery: rebuild the sessionID -> member index from on-disk state
    // so idles/transforms resolve correctly after a plugin/OpenCode restart.
    // FAIL-CLOSED: if the index cannot be rebuilt, the plugin must not start —
    // master-only authorization depends on this index, and a missing index
    // would cause legitimate sessions to be denied or, worse, inconsistent
    // partial indexes to authorize the wrong sessions.
    try {
        await rebuildSessionIndex(ctx.projectStorageRoot, ctx.userStorageRoot, ctx)
    } catch (err) {
        logSwallowed(ctx, "rebuildSessionIndex failed; aborting plugin startup", err)
        throw new Error(
            `octeam: rebuildSessionIndex failed — session authorization index is unavailable. `
            + `Plugin startup aborted to prevent inconsistent authorization.`,
            { cause: err },
        )
    }

    // Restart invariant: clear all teams' activatedAt so none is auto-active
    // after a restart. Users must team_activate explicitly.
    // H27 fix: recovery failures are critical — continuing with stale
    // activatedAt, busy runs, or unreleased reservations causes state
    // conflicts. Fail-closed instead of fail-open.
    try {
        await reconcileActivation(ctx)
    } catch (err) {
        throw new Error(
            `octeam: reconcileActivation failed — team activation state may be inconsistent. `
            + `Plugin startup aborted.`,
            { cause: err },
        )
    }

    // Crash recovery: reconcile teams left "busy"/"idle" by a crashed prior
    // process — release stale reservations, fail interrupted orchestrations.
    try {
        await reconcileCrashedTeams(ctx)
    } catch (err) {
        throw new Error(
            `octeam: reconcileCrashedTeams failed — crashed team recovery incomplete. `
            + `Plugin startup aborted.`,
            { cause: err },
        )
    }

    // Background sweep timer: reaps stale resources, enforces termination, and
    // reconciles missed idle events. Runs for the lifetime of the plugin.
    // M-28: retain the handle so a future plugin-reload path could
    // clearInterval(sweepHandle) to prevent duplicate sweep timers.
    const sweepTimer = startSweepTimer(ctx)
    void sweepTimer // retained for future teardown; .unref() prevents loop keepalive

    return {
        tool: createTools(ctx),
        event: createEventHandler(ctx),
        "experimental.chat.messages.transform": createTransformHook(ctx),
        "experimental.session.compacting": createCompactingHook(),
        config: createConfigHook(),
    }
}

export default {
    id,
    server,
} satisfies PluginModule
