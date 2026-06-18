import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin"

import { createPluginContext } from "./context.js"
import type { PluginContext } from "./context.js"
import { createTools } from "./tools/index.js"
import {
    createEventHandler,
    createTransformHook,
    reconcileCrashedTeams,
    startSweepTimer,
} from "./hooks.js"
import { rebuildSessionIndex } from "./utils.js"

const id = "octeam"

/**
 * Server plugin module entry. Builds the PluginContext closure, rebuilds the
 * session index from disk (crash recovery), starts the sweep timer, and wires
 * all 16 tools + the event/transform hooks.
 *
 * Pipeline (design §1): tool handlers + event handler + transform hook all
 * share ctx; event handler + sweep timer drive the per-team locked state
 * machine; mailbox/tasks/store persist under ~/.octeam (or <dir>/.octeam).
 */
const server = async (input: PluginInput): Promise<Hooks> => {
    const ctx: PluginContext = createPluginContext(input)

    // Crash recovery: rebuild the sessionID -> member index from on-disk state
    // so idles/transforms resolve correctly after a plugin/OpenCode restart.
    await rebuildSessionIndex(ctx.projectStorageRoot, ctx.userStorageRoot).catch(() => {
        // best effort — unreadable teams are skipped
    })

    // Crash recovery (§3): reconcile teams left "busy"/"idle" by a crashed prior
    // process — release stale reservations, fail interrupted orchestrations.
    await reconcileCrashedTeams(ctx).catch(() => {
        // best effort — never block plugin load on recovery
    })

    // Background sweep timer: reaps stale resources, enforces termination, and
    // reconciles missed idle events. Runs for the lifetime of the plugin.
    startSweepTimer(ctx)

    return {
        tool: createTools(ctx),
        event: createEventHandler(ctx),
        "experimental.chat.messages.transform": createTransformHook(ctx),
    }
}

export default {
    id,
    server,
} satisfies PluginModule
