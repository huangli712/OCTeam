/** @jsxImportSource @opentui/solid */
// @ts-nocheck

import { createSignal, createEffect, on, onCleanup, For } from "solid-js"
import { loadChildren, type SessionTreeNode } from "./session-tree"

// Status colors: green=running, red=finished, purple=error
const COLOR_RUNNING = "#22c55e"
const COLOR_IDLE = "#ef4444"
const COLOR_ERRORED = "#a855f7"

export function SessionNavigatorSidebar(props: {
    api: any
    sessionID: () => string
    theme: any
}) {
    const [sessions, setSessions] = createSignal<SessionTreeNode[]>([])
    const [loading, setLoading] = createSignal(true)
    const [collapsed, setCollapsed] = createSignal(true)
    const [rootSessionId, setRootSessionId] = createSignal<string | null>(null)

    const t = () => props.theme
    const textColor = () => t()?.text ?? "#000000"
    const textMuted = () => t()?.textMuted ?? "#6b7280"

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
            {/* Line 1: Section header — bold, themed */}
            <box width="100%">
                <text fg={textColor()}>
                    <b>{"OCTeam"}</b>
                </text>
            </box>

            {/* Line 2: Collapsible "Tasks" header */}
            <box
                flexDirection="row"
                width="100%"
                onMouseDown={() => toggleCollapse()}
            >
                <text fg={textMuted()}>
                    {collapsed() ? "\u25b8 " : "\u25be "}
                </text>
                <text fg={textMuted()}>{"Tasks"}</text>
                {!loading() && sessions().length > 0 ? (
                    <text fg={textMuted()}>{" (" + sessions().length + ")"}</text>
                ) : null}
            </box>

            {/* Expanded task list */}
            {!collapsed() ? (
                <box flexDirection="column" width="100%" paddingLeft={1}>
                    {loading() ? (
                        <text fg={textMuted()}>{"Loading\u2026"}</text>
                    ) : sessions().length === 0 ? (
                        <text fg={textMuted()}>{"No subagents"}</text>
                    ) : (
                        <For each={sessions()}>
                            {(session) => (
                                <box
                                    flexDirection="row"
                                    width="100%"
                                    justifyContent="space-between"
                                    onMouseDown={() => handleClick(session.sessionId)}
                                >
                                    <text fg={statusColor(session.status)}>
                                        {"\u25cf " + session.agentName}
                                    </text>
                                    {session.startTime ? (
                                        <text fg={textMuted()}>{session.startTime}</text>
                                    ) : null}
                                </box>
                            )}
                        </For>
                    )}
                </box>
            ) : null}
        </box>
    )
}
