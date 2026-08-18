/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createSignal, createEffect, on, onCleanup, For } from "solid-js"
import { loadChildren, type SessionTreeNode } from "./tree.js"
import { loadTeams, type LoadState, type TeamSummary } from "./teams.js"

// Status colors: green=running, red=idle, purple=errored
const COLOR_RUNNING = "#22c55e"
const COLOR_IDLE = "#ef4444"
const COLOR_ERRORED = "#a855f7"
const COLOR_RETRYING = "#eab308"
const COLOR_UNKNOWN = "#6b7280"
const COLOR_ACTIVE = "#22c55e"
const COLOR_INACTIVE = "#ef4444"

/** SolidJS sidebar component showing session tree and team status. */
export function SessionNavigatorSidebar(props: {
    api: TuiPluginApi
    sessionID: () => string
    theme: TuiThemeCurrent
    version: string
}) {
    const [sessions, setSessions] = createSignal<LoadState<SessionTreeNode[]>>({ status: "unknown" })
    const [teams, setTeams] = createSignal<LoadState<TeamSummary[]>>({ status: "unknown" })
    // Persist collapsed state in kv — survives component remount when navigating
    // to child sessions and back (sidebar unmounts/remounts)
    const [collapsed, setCollapsed] = createSignal<boolean>(
        props.api.kv.get<boolean>("octeam_tasks_collapsed") ?? true
    )
    const [teamsCollapsed, setTeamsCollapsed] = createSignal<boolean>(
        props.api.kv.get<boolean>("octeam_teams_collapsed") ?? false
    )
    const [rootSessionId, setRootSessionId] = createSignal<string | null>(null)

    const t = () => props.theme
    const textColor = () => t()?.text ?? "#000000"
    const textMuted = () => t()?.textMuted ?? "#6b7280"

    // Request generations guard against the last-write-wins race: concurrent
    // refreshes can resolve out of order, so a slow earlier call must not
    // overwrite a newer result. Each async refresh captures its generation and
    // discards its result if a newer refresh has since started. refresh and
    // refreshTeams update different signals and run concurrently, so they need
    // independent counters (a shared one would make them invalidate each other).
    let refreshGeneration = 0
    const refresh = async () => {
        const gen = ++refreshGeneration
        try {
            const sid = rootSessionId()
            if (!sid) return
            const children = await loadChildren(props.api, sid)
            if (gen !== refreshGeneration) return  // newer refresh started; discard stale result
            setSessions(children)
        } catch (err) {
            if (gen === refreshGeneration) {
                setSessions({
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }
    }

    let refreshTeamsGeneration = 0
    const refreshTeams = async () => {
        const gen = ++refreshTeamsGeneration
        try {
            const result = await loadTeams(props.api.state.path.directory, props.sessionID())
            if (gen !== refreshTeamsGeneration) return  // newer refresh started; discard stale result
            setTeams(result)
        } catch (err) {
            if (gen === refreshTeamsGeneration) {
                setTeams({
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }
    }

    // Debounce refreshes by 300 ms to coalesce bursts. Each refresh performs
    // N+1 HTTP calls plus O(n^2) child-count work, so batching reduces load.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
        clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
            refresh()
            refreshTeams()
        }, 300)
    }

    createEffect(
        on(props.sessionID, (sid) => {
            if (!sid) return
            if (!rootSessionId()) {
                setRootSessionId(sid)
            }
            setSessions({ status: "unknown" })
            setTeams({ status: "unknown" })
            refresh()
            refreshTeams()

            const unsubs = [
                props.api.event.on("session.created", scheduleRefresh),
                props.api.event.on("session.status", scheduleRefresh),
                props.api.event.on("session.updated", scheduleRefresh),
                props.api.event.on("session.deleted", scheduleRefresh),
            ]

            onCleanup(() => {
                clearTimeout(refreshTimer)
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

    const sessionRows = (): SessionTreeNode[] => {
        const state = sessions()
        return state.status === "unknown" ? [] : state.data ?? []
    }

    const teamRows = (): TeamSummary[] => {
        const state = teams()
        return state.status === "unknown" ? [] : state.data ?? []
    }

    const statusColor = (status: string): string => {
        switch (status) {
            case "running": return COLOR_RUNNING
            case "idle": return COLOR_IDLE
            case "retrying": return COLOR_RETRYING
            case "errored": return COLOR_ERRORED
            default: return COLOR_UNKNOWN
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
                {sessions().status === "ok" && sessionRows().length > 0 ? (
                    <text fg={textMuted()}>{" (" + sessionRows().length + ")"}</text>
                ) : null}
            </box>

            {/* Expanded task list (between Tasks and Teams) */}
            {!collapsed() ? (
                <box flexDirection="column" width="100%" paddingLeft={1}>
                    {sessions().status === "unknown" ? (
                        <text fg={textMuted()}>{"Loading\u2026"}</text>
                    ) : sessions().status === "error" ? (
                        <text fg={COLOR_UNKNOWN}>{"Unavailable"}</text>
                    ) : sessionRows().length === 0 ? (
                        <text fg={textMuted()}>{"No tasks"}</text>
                    ) : (
                        <For each={sessionRows()}>
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

            {/* Line 3: "Teams" header, collapsible with team info */}
            <box
                flexDirection="row"
                width="100%"
                onMouseDown={() => toggleTeamsCollapse()}
            >
                <text fg={textMuted()}>
                    {teamsCollapsed() ? "\u25b6 " : "\u25bc "}
                </text>
                <text fg={textMuted()}>{"Teams"}</text>
                {teams().status === "ok" && teamRows().length > 0 ? (
                    <text fg={textMuted()}>{" (" + teamRows().length + ")"}</text>
                ) : null}
            </box>

            {!teamsCollapsed() ? (
                <box flexDirection="column" width="100%" paddingLeft={1}>
                    {teams().status === "unknown" ? (
                        <text fg={textMuted()}>{"Loading\u2026"}</text>
                    ) : teams().status === "error" ? (
                        <text fg={COLOR_UNKNOWN}>{"Unavailable"}</text>
                    ) : teamRows().length === 0 ? (
                        <text fg={textMuted()}>{"No teams"}</text>
                    ) : (
                        <For each={teamRows()}>
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
                                        <box flexDirection="row">
                                            <text fg={textColor()}>{team.name}</text>
                                            <text fg={textMuted()}> [</text>
                                            <text fg={team.activated ? COLOR_ACTIVE : COLOR_INACTIVE}>
                                                {team.activated ? "active" : "inactive"}
                                            </text>
                                            <text fg={textMuted()}>]</text>
                                            <text fg={textMuted()}>{" [" + team.status + "]"}</text>
                                        </box>
                                    </box>
                                    {isTeamExpanded(team.name) ? (
                                        <box flexDirection="column" width="100%">
                                            <text fg={textMuted()}>{"   Mode    : " + (team.active?.type ?? "unknown") + (team.active?.type === "parallel" && team.active?.mode ? " / " + team.active.mode : "")}</text>
                                            <text fg={textMuted()}>{"   Size    : " + team.members.length}</text>
                                            <For each={team.members}>
                                                {(member) => {
                                                    const memberKey = team.name + "/" + member.name
                                                    const mailbox = member.mailbox.status === "ok"
                                                        ? `${member.mailbox.data.unread} / ${member.mailbox.data.total}`
                                                        : member.mailbox.status === "error" ? "unavailable" : "unknown"
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
                                                                <box
                                                                    flexDirection="column"
                                                                    width="100%"
                                                                     onMouseDown={() => member.sessionId ? handleClick(member.sessionId) : undefined}
                                                                 >
                                                                     <text fg={textMuted()}>{"      Role    : " + (member.role ?? "unknown")}</text>
                                                                     <text fg={textMuted()}>{"      Agent   : " + (member.agent ?? "unknown")}</text>
                                                                    <text fg={textMuted()}>{"      Model   : " + (member.model ? member.model.split("/").pop() : "unknown")}</text>
                                                                    <text fg={textMuted()}>{"      Mailbox : " + mailbox}</text>
                                                                     <text fg={textMuted()}>{"      Turn    : " + (member.turnCount ?? 0)}</text>
                                                                     <text fg={textMuted()}>{"      Tokens  : " + (member.tokens ?? 0)}</text>
                                                                     <text fg={textMuted()}>{"      Status  : " + member.status}</text>
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
