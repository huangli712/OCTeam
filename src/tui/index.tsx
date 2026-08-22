/** @jsxImportSource @opentui/solid */

/**
 * TUI plugin entry: registers the OCTeam session-navigator sidebar into the
 * host's sidebar_content slot (teams/members/mailbox live in ./teams.ts,
 * rendering in ./sidebar.tsx). Hosts without slot support fail registration
 * gracefully; any error whose message matches the support/slot patterns is
 * treated as an unsupported host (a real defect with a coincidentally
 * matching message would also be swallowed here), other errors are logged.
 */

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
