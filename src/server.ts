import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin"

import { createPluginContext } from "./core/context.js"
import type { PluginContext } from "./core/context.js"
import { createTools } from "./tools/index.js"
import {
    createCompactingHook,
    createEventHandler,
    createTransformHook,
    startSweepTimer,
} from "./hooks.js"
import { reconcileActivation, reconcileCrashedTeams } from "./orchestration/reconcile.js"
import { rebuildSessionIndex } from "./state/resolve.js"
import { logSwallowed } from "./core/log.js"
import { createConfigHook } from "./agents/index.js"

const id = "octeam"

/**
 * Server plugin module entry. Builds the PluginContext closure, rebuilds the
 * session index from disk (crash recovery), starts the sweep timer, and wires
 * all 33 tools + the event/transform hooks.
 *
 * Pipeline: tool handlers + event handler + transform hook all
 * share ctx; event handler + sweep timer drive the per-team locked state
 * machine; mailbox/tasks/store persist under ~/.octeam (or <dir>/.octeam).
 */
const server = async (input: PluginInput): Promise<Hooks> => {
    const ctx: PluginContext = createPluginContext(input)

    // Crash recovery: rebuild the sessionID -> member index from on-disk state
    // so idles/transforms resolve correctly after a plugin/OpenCode restart.
    await rebuildSessionIndex(ctx.projectStorageRoot, ctx.userStorageRoot, ctx).catch((err) => {
        logSwallowed(ctx, "rebuildSessionIndex failed", err)
    })

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
