/** @jsxImportSource @opentui/solid */
// @ts-nocheck

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"
import { version as packageVersion } from "../../package.json"
import { registerTeamCommands } from "./commands"
import { SessionNavigatorSidebar } from "./sidebar"

const tui: TuiPlugin = async (api) => {
    try {
        api.slots.register({
            order: 150,
            slots: {
                sidebar_content: (ctx, value) => {
                    const theme = createMemo(() => (ctx as any).theme.current)
                    return (
                        <SessionNavigatorSidebar
                            api={api}
                            sessionID={() => value.session_id}
                            theme={theme()}
                            version={packageVersion}
                        />
                    )
                },
            },
        })
    } catch {
        // Host may not support api.slots; skip gracefully
    }

    // Phase 2.1: slash commands (/team_create, /team_delete, /team_status,
    // /team_shutdown_request, /team_parallel, /team_pipeline, /team_loop,
    // /team_delegate). Each instructs the master session to call the tool.
    registerTeamCommands(api)
}

const id = "octeam"

export default {
    id,
    tui,
}
