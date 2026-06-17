import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin"

import { createPluginContext } from "./context.js"
import type { PluginContext } from "./context.js"

const id = "octeam"

/**
 * Server plugin module entry. Builds the PluginContext closure and returns the
 * Hooks surface.
 *
 * Phase 2.0 status: scaffolds only. The tool map is empty and the event /
 * transform hooks are intentional no-ops. This satisfies Phase 2.0's acceptance
 * criteria — "server module loads, tool/event/transform hooks register, file
 * state store persists to disk" (the store is exercised by later tool
 * handlers). Real implementations land in subsequent phases:
 *   - Phase 2.2: team_create / team_delete / team_list tools + config/state writes
 *   - Phase 2.3: mailbox + Transform hook content injection
 *   - Phase 2.5: workflow tools + locked event-handler state machine
 *
 * The ctx closure value is captured here so future phases can extend each hook
 * without changing the module boundary.
 */
const server = async (input: PluginInput): Promise<Hooks> => {
    const ctx: PluginContext = createPluginContext(input)

    return {
        // Phase 2.2+: team_create, team_parallel, team_pipeline, team_loop,
        // team_delegate, team_send_message, team_task_*, team_status/list/delete.
        // Empty map means "no tools registered yet" — the host still sees the
        // tool hook as present.
        tool: {},

        // Phase 2.5+: single handler dispatching session.idle / session.status
        // into the per-team locked state machine (processIdle). No-op until then.
        event: async (_input) => {
            void ctx
        },

        // Phase 2.3+: resolve the session to a team member, poll its mailbox,
        // and inject unread messages as a synthetic user message before the
        // last user message. No-op until then.
        "experimental.chat.messages.transform": async (_input, _output) => {
            void ctx
        },
    }
}

export default {
    id,
    server,
} satisfies PluginModule
