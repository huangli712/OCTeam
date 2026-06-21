/** @jsxImportSource @opentui/solid */
// @ts-nocheck

import { createSignal, createEffect, on, onCleanup, For } from "solid-js"
import { loadChildren, type SessionTreeNode } from "./session-tree"
import { loadTeams, type TeamSummary } from "./teams"

// Status colors: green=running, red=finished, purple=error
const COLOR_RUNNING = "#22c55e"
const COLOR_IDLE = "#ef4444"
const COLOR_ERRORED = "#a855f7"

export function SessionNavigatorSidebar(props: {
    api: any
    sessionID: () => string
    theme: any
    version: string
}) {
    const [sessions, setSessions] = createSignal<SessionTreeNode[]>([])
    const [loading, setLoading] = createSignal(true)
    const [teams, setTeams] = createSignal<TeamSummary[]>([])
    // Persist collapsed state in kv — survives component remount when navigating
    // to child sessions and back (sidebar unmounts/remounts)
    const [collapsed, setCollapsed] = createSignal<boolean>(
        props.api.kv.get("octeam_tasks_collapsed") ?? true
    )
    const [teamsCollapsed, setTeamsCollapsed] = createSignal<boolean>(
        props.api.kv.get("octeam_teams_collapsed") ?? false
    )
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

    const refreshTeams = async () => {
        try {
            setTeams(await loadTeams(props.sessionID()))
        } catch {
            // best-effort
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
            refreshTeams()

            const unsubs = [
                props.api.event.on("session.created", refresh),
                props.api.event.on("session.status", () => { refresh(); refreshTeams() }),
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
        const next = !collapsed()
        setCollapsed(next)
        props.api.kv.set("octeam_tasks_collapsed", next)
    }

    const toggleTeamsCollapse = () => {
        const next = !teamsCollapsed()
        setTeamsCollapsed(next)
        props.api.kv.set("octeam_teams_collapsed", next)
    }

    // Per-team expand state: default collapsed (empty set = all collapsed).
    // Clicking a team row toggles its membership in the set.
    const [expandedTeams, setExpandedTeams] = createSignal<Set<string>>(new Set())
    const toggleTeam = (name: string) => {
        const next = new Set(expandedTeams())
        if (next.has(name)) next.delete(name)
        else next.add(name)
        setExpandedTeams(next)
    }
    const isTeamExpanded = (name: string) => expandedTeams().has(name)

    // Per-team members-section expand state (nested under team expand).
    const [expandedMembers, setExpandedMembers] = createSignal<Set<string>>(new Set())
    const toggleMembers = (name: string) => {
        const next = new Set(expandedMembers())
        if (next.has(name)) next.delete(name)
        else next.add(name)
        setExpandedMembers(next)
    }
    const isMembersExpanded = (name: string) => expandedMembers().has(name)

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
            {/* Line 1: Section header — bold, themed, version right-aligned */}
            <box width="100%" flexDirection="row" justifyContent="space-between">
                <text fg={textColor()}>
                    <b>{"OCTeam"}</b>
                </text>
                <text fg={textMuted()}>{"v" + props.version}</text>
            </box>

            {/* Line 2: Collapsible "Tasks" header */}
            <box
                flexDirection="row"
                width="100%"
                onMouseDown={() => toggleCollapse()}
            >
                <text fg={textMuted()}>
                    {collapsed() ? "\u25b6 " : "\u25bc "}
                </text>
                <text fg={textMuted()}>{"Tasks"}</text>
                {!loading() && sessions().length > 0 ? (
                    <text fg={textMuted()}>{" (" + sessions().length + ")"}</text>
                ) : null}
            </box>

            {/* Expanded task list (between Tasks and Teams) */}
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
                                    <box flexDirection="row">
                                        {session.duration ? (
                                            <text fg={textMuted()}>{session.duration}</text>
                                        ) : null}
                                        {session.duration && session.startTime ? (
                                            <text fg={textMuted()}>{" "}</text>
                                        ) : null}
                                        {session.startTime ? (
                                            <text fg={textMuted()}>{"[" + session.startTime + "]"}</text>
                                        ) : null}
                                    </box>
                                </box>
                            )}
                        </For>
                    )}
                </box>
            ) : null}

            {/* Line 3: "Teams" header — collapsible, shows team info (Phase 2.9) */}
            <box
                flexDirection="row"
                width="100%"
                onMouseDown={() => toggleTeamsCollapse()}
            >
                <text fg={textMuted()}>
                    {teamsCollapsed() ? "\u25b6 " : "\u25bc "}
                </text>
                <text fg={textMuted()}>{"Teams"}</text>
                {teams().length > 0 ? (
                    <text fg={textMuted()}>{" (" + teams().length + ")"}</text>
                ) : null}
            </box>

            {!teamsCollapsed() ? (
                <box flexDirection="column" width="100%" paddingLeft={1}>
                    {teams().length === 0 ? (
                        <text fg={textMuted()}>{"No teams"}</text>
                    ) : (
                        <For each={teams()}>
                            {(team) => (
                                <box flexDirection="column" width="100%">
                                    <box
                                        flexDirection="row"
                                        width="100%"
                                        onMouseDown={() => toggleTeam(team.name)}
                                    >
                                        <text fg={textMuted()}>
                                            {isTeamExpanded(team.name) ? "\u25bc " : "\u25b6 "}
                                        </text>
                                        <text fg={textColor()}>
                                            {team.name + " [" + team.status + "]"}
                                        </text>
                                    </box>
                                    {isTeamExpanded(team.name) ? (
                                        <box flexDirection="column" width="100%">
                                            <text fg={textMuted()}>{"   Mode    : " + (team.active?.type ?? "unknown")}</text>
                                            <text fg={textMuted()}>{"   Size    : " + team.members.length}</text>
                                            <For each={team.members}>
                                                {(member) => {
                                                    const memberKey = team.name + "/" + member.name
                                                    return (
                                                        <box flexDirection="column" width="100%">
                                                            <box
                                                                flexDirection="row"
                                                                width="100%"
                                                                onMouseDown={() => toggleMembers(memberKey)}
                                                            >
                                                                <text fg={textMuted()}>
                                                                    {"   " + (isMembersExpanded(memberKey) ? "\u25bc " : "\u25b6 ")}
                                                                </text>
                                                                <text fg={textColor()}>{"Member : " + member.name}</text>
                                                            </box>
                                                            {isMembersExpanded(memberKey) ? (
                                                                <box flexDirection="column" width="100%">
                                                                    <text fg={textMuted()}>{"      Status  : " + member.status}</text>
                                                                    <text fg={textMuted()}>{"      Agent   : " + (member.agent ?? "unknown")}</text>
                                                                    <text fg={textMuted()}>{"      Model   : " + (member.model ? member.model.split("/").pop() : "unknown")}</text>
                                                                    <text fg={textMuted()}>{"      Mailbox : " + (member.unread ? member.unread + " unread" : "empty")}</text>
                                                                </box>
                                                            ) : null}
                                                        </box>
                                                    )
                                                }}
                                            </For>
                                        </box>
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
