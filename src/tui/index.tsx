/** @jsxImportSource @opentui/solid */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"
import pkg from "../../package.json" with { type: "json" }
import { SessionNavigatorSidebar } from "./sidebar.jsx"

const tui: TuiPlugin = async (api) => {
    try {
        api.slots.register({
            order: 150,
            slots: {
                sidebar_content: (ctx, value) => {
                    const theme = createMemo(() => ctx.theme.current)
                    return (
                        <SessionNavigatorSidebar
                            api={api}
                            sessionID={() => value.session_id}
                            theme={theme()}
                            version={pkg.version}
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
