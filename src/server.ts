/**
 * OpenCode team orchestration plugin entry point. Builds the PluginContext,
 * rebuilds session index from disk, starts the sweep timer, and wires all
 * tools plus the event/transform hooks into the plugin framework.
 */

import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin"

import { createPluginContext, warnIfProjectScopeLacksIsolation } from "./core/context.js"
import type { PluginContext } from "./core/context.js"
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
 */
const server = async (input: PluginInput): Promise<Hooks> => {
    const ctx: PluginContext = createPluginContext(input)

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
            + `Plugin startup aborted to prevent inconsistent authorization. Error: ${
                err instanceof Error ? err.message : String(err)
            }`,
        )
    }

    // Restart invariant: clear all teams' activatedAt so none is auto-active
    // after a restart. Users must team_activate explicitly.
    await reconcileActivation(ctx).catch((err) => {
        logSwallowed(ctx, "reconcileActivation failed", err)
    })

    // Crash recovery: reconcile teams left "busy"/"idle" by a crashed prior
    // process — release stale reservations, fail interrupted orchestrations.
    await reconcileCrashedTeams(ctx).catch((err) => {
        logSwallowed(ctx, "reconcileCrashedTeams failed", err)
    })

    // Background sweep timer: reaps stale resources, enforces termination, and
    // reconciles missed idle events. Runs for the lifetime of the plugin.
    startSweepTimer(ctx)

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
