/** @jsxImportSource @opentui/solid */
// @ts-nocheck

import { createSignal, createEffect, on, onCleanup, For } from "solid-js"
import { loadChildren, type SessionTreeNode } from "./session-tree"

// Status colors: green=running, red=finished, purple=error
const COLOR_RUNNING = "#22c55e"
const COLOR_IDLE = "#ef4444"
const COLOR_ERRORED = "#a855f7"
const COLOR_CURRENT = "#60a5fa"
const COLOR_MUTED = "#374151"
const COLOR_LABEL = "#9ca3af"

export function SessionNavigatorSidebar(props: {
    api: any
    sessionID: () => string
}) {
    const [sessions, setSessions] = createSignal<SessionTreeNode[]>([])
    const [loading, setLoading] = createSignal(true)
    const [collapsed, setCollapsed] = createSignal(true)
    // Lock root session ID so the list doesn't change when navigating to a child
    const [rootSessionId, setRootSessionId] = createSignal<string | null>(null)

    const refresh = async () => {
        try {
            const sid = rootSessionId()
            if (!sid) return
            const children = await loadChildren(props.api, sid)
            setSessions(children)
        } catch {
            // Silent fail — sidebar is best-effort
        } finally {
            setLoading(false)
        }
    }

    // On first render, lock the root session ID.
    // Subsequent sessionID changes (navigating to a child) do NOT update rootSessionId.
    createEffect(
        on(props.sessionID, (sid) => {
            if (!sid) return
            if (!rootSessionId()) {
                setRootSessionId(sid)
            }
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
        // Use selectSession (HTTP) instead of route.navigate.
        // route.navigate changes the entire route layout, causing sidebar_content slot to unmount.
        // selectSession switches the displayed session content while preserving the sidebar layout.
        props.api.client.tui.selectSession({ sessionID: sessionId })
    }

    const toggleCollapse = () => {
        setCollapsed(!collapsed())
    }

    const statusColor = (status: string): string => {
        switch (status) {
            case "running": return COLOR_RUNNING
            case "idle": return COLOR_IDLE
            case "errored": return COLOR_ERRORED
            default: return COLOR_IDLE
        }
    }

    return (
        <box flexDirection="column" width="100%">
            {/* Header — click to toggle collapse/expand */}
            <box
                flexDirection="row"
                width="100%"
                onMouseDown={() => toggleCollapse()}
            >
                <text fg={COLOR_CURRENT}>
                    {collapsed() ? "\u25b8 " : "\u25be "}
                </text>
                <text fg={COLOR_CURRENT}>{"Sessions"}</text>
                {!loading() && sessions().length > 0 && (
                    <text fg={COLOR_LABEL}>{" (" + sessions().length + ")"}</text>
                )}
            </box>

            {/* Expanded child session list */}
            {!collapsed() && (
                <box flexDirection="column" width="100%" paddingLeft={1}>
                    {loading() ? (
                        <text fg={COLOR_LABEL}>{"Loading\u2026"}</text>
                    ) : sessions().length === 0 ? (
                        <text fg={COLOR_LABEL}>{"No subagents"}</text>
                    ) : (
                        <For each={sessions()}>
                            {(session) => (
                                <box
                                    flexDirection="row"
                                    width="100%"
                                    onMouseDown={() => handleClick(session.sessionId)}
                                >
                                    <text fg={statusColor(session.status)}>{"\u25cf "}</text>
                                    <text fg={statusColor(session.status)}>{session.title}</text>
                                    {session.childCount > 0 ? (
                                        <text fg={COLOR_LABEL}>{" (" + session.childCount + ")"}</text>
                                    ) : null}
                                </box>
                            )}
                        </For>
                    )}
                </box>
            )}
        </box>
    )
}
