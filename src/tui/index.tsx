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
    } catch (err) {
        // Host may not support api.slots; skip gracefully. But log non-trivial
        // errors so operators can distinguish "unsupported host" from a
        // real defect.
        const msg = err instanceof Error ? err.message : String(err)
        if (!/slot|register|support|not.*found/i.test(msg)) {
            console.warn(`[octeam] TUI slot registration failed: ${msg}`)
        }
    }
}

const id = "octeam"

export default {
    id,
    tui,
}
