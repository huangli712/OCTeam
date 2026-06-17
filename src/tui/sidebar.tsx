/** @jsxImportSource @opentui/solid */
// @ts-nocheck

import { createSignal, createEffect, on, onCleanup, For } from "solid-js"
import { loadChildren, type SessionTreeNode } from "./session-tree"

const SEP = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"

const COLOR_RUNNING = "#facc15"
const COLOR_IDLE = "#6b7280"
const COLOR_CURRENT = "#60a5fa"
const COLOR_MUTED = "#374151"
const COLOR_LABEL = "#9ca3af"

export function SessionNavigatorSidebar(props: {
    api: any
    sessionID: () => string
}) {
    const [sessions, setSessions] = createSignal<SessionTreeNode[]>([])
    const [loading, setLoading] = createSignal(true)

    const refresh = async () => {
        try {
            const sid = props.sessionID()
            if (!sid) return
            const children = await loadChildren(props.api, sid)
            setSessions(children)
        } catch {
            // Silent fail — sidebar is best-effort
        } finally {
            setLoading(false)
        }
    }

    // Re-fetch when session changes; subscribe to live events
    createEffect(
        on(props.sessionID, (sid) => {
            if (!sid) return
            setLoading(true)
            refresh()

            const unsubs = [
                props.api.event.on("session.created", refresh),
                props.api.event.on("session.status", refresh),
                props.api.event.on("session.updated", refresh),
                props.api.event.on("session.deleted", refresh),
            ]

            onCleanup(() => {
                for (const u of unsubs) {
                    try { u() } catch { /* best effort */ }
                }
            })
        }),
    )

    const handleClick = (sessionId: string) => {
        props.api.route.navigate("session", { sessionID: sessionId })
    }

    const statusColor = (status: string): string => {
        return status === "running" ? COLOR_RUNNING : COLOR_IDLE
    }

    return (
        <box flexDirection="column" width="100%">
            {/* Current session */}
            <box flexDirection="row" width="100%">
                <text fg={COLOR_CURRENT}>{"\u25b6 "}</text>
                <text fg={COLOR_CURRENT}>{"current"}</text>
            </box>

            {/* Separator */}
            <text fg={COLOR_MUTED}>{SEP}</text>

            {/* Child sessions */}
            <box flexDirection="column" width="100%">
                {loading() ? (
                    <text fg={COLOR_IDLE}>{"Loading\u2026"}</text>
                ) : sessions().length === 0 ? (
                    <text fg={COLOR_IDLE}>{"No subagents"}</text>
                ) : (
                    <For each={sessions()}>
                        {(session) => (
                            <box
                                flexDirection="row"
                                width="100%"
                                onMouseDown={() => handleClick(session.sessionId)}
                            >
                                <text fg={statusColor(session.status)}>{"\u25cb "}</text>
                                <text fg={statusColor(session.status)}>{session.title}</text>
                                {session.childCount > 0 ? (
                                    <text fg={COLOR_LABEL}>{" (" + session.childCount + ")"}</text>
                                ) : null}
                            </box>
                        )}
                    </For>
                )}
            </box>
        </box>
    )
}
