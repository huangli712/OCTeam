/** @jsxImportSource @opentui/solid */
// @ts-nocheck

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { SessionNavigatorSidebar } from "./sidebar"

const tui: TuiPlugin = async (api) => {
    try {
        api.slots.register({
            order: 150,
            slots: {
                sidebar_content: (ctx, value) => {
                    return (
                        <SessionNavigatorSidebar
                            api={api}
                            sessionID={() => value.session_id}
                        />
                    )
                },
            },
        })
    } catch {
        // Host may not support api.slots; skip gracefully
    }
}

const id = "octeam"

export default {
    id,
    tui,
}
