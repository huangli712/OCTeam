/** @jsxImportSource @opentui/solid */
// @ts-nocheck

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

/**
 * Slash command registration (design §4.0, §10). Slash commands do NOT bypass
 * the master agent — each command instructs the current (master) session via
 * promptAsync, and the master agent calls the corresponding tool itself.
 *
 * onSelect/run take no args and the prompt buffer is not exposed on the API, so
 * commands that need free-text input collect it via DialogPrompt first.
 *
 * Registers via the modern keymap.registerLayer (OpenCode >= 1.14.42) when
 * available, falling back to the legacy command.register otherwise.
 */

type ApiAny = {
    keymap?: {
        registerLayer?: (layer: {
            commands: Array<Record<string, unknown>>
            bindings: Array<Record<string, unknown>>
        }) => unknown
    }
    command?: {
        register?: (cb: () => Array<Record<string, unknown>>) => unknown
    }
}

/** Current (master) session ID — the slash command's target. */
function currentSessionId(api: TuiPluginApi): string | undefined {
    const params = (api.route.current as { params?: Record<string, unknown> } | undefined)?.params
    const sid = params?.sessionID
    if (typeof sid === "string") return sid
    // Some hosts expose it directly on current.
    const direct = (api.route.current as unknown as { sessionID?: string }).sessionID
    return typeof direct === "string" ? direct : undefined
}

/** Send an instruction to the master session so it calls the right tool. */
async function dispatchToMaster(api: TuiPluginApi, instruction: string): Promise<void> {
    const sid = currentSessionId(api)
    if (!sid) {
        api.ui.toast({ variant: "error", title: "OCTeam", message: "No active session", duration: 3000 })
        return
    }
    try {
        await api.client.session.promptAsync({
            path: { id: sid },
            body: { parts: [{ type: "text", text: instruction, synthetic: true }] },
        })
    } catch (err) {
        api.ui.toast({
            variant: "error",
            title: "OCTeam",
            message: `dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
            duration: 4000,
        })
    }
}

/** Collect free text via dialog, then dispatch. */
function promptThenDispatch(api: TuiPluginApi, title: string, placeholder: string, build: (text: string) => string): void {
    api.ui.dialog.replace(() =>
        api.ui.DialogPrompt({
            title,
            placeholder,
            onConfirm: (text: string) => {
                api.ui.dialog.clear()
                void dispatchToMaster(api, build(text))
            },
            onCancel: () => api.ui.dialog.clear(),
        }),
    )
}

type Cmd = {
    namespace: string
    name: string
    title: string
    category: string
    slashName: string
    run: () => void
}

function buildCommands(api: TuiPluginApi): Cmd[] {
    return [
        {
            namespace: "palette",
            name: "octeam.create",
            title: "OCTeam: Create Team",
            category: "OCTeam",
            slashName: "team_create",
            run: () =>
                void dispatchToMaster(
                    api,
                    "[System] User invoked /team_create. Ask the user for a team name and members (each member: name, role, optional model/agent), then call the team_create tool.",
                ),
        },
        {
            namespace: "palette",
            name: "octeam.list",
            title: "OCTeam: List Teams",
            category: "OCTeam",
            slashName: "team_list",
            run: () =>
                void dispatchToMaster(api, "[System] User invoked /team_list. Call the team_list tool and report the teams."),
        },
        {
            namespace: "palette",
            name: "octeam.status",
            title: "OCTeam: Team Status",
            category: "OCTeam",
            slashName: "team_status",
            run: () =>
                void dispatchToMaster(
                    api,
                    "[System] User invoked /team_status. Call team_list, then team_status for the active team, and report the result.",
                ),
        },
        {
            namespace: "palette",
            name: "octeam.delete",
            title: "OCTeam: Delete All Teams",
            category: "OCTeam",
            slashName: "team_delete",
            run: () =>
                api.ui.dialog.replace(() =>
                    api.ui.DialogConfirm({
                        title: "Delete all teams?",
                        message: "This force-deletes every team in the current scope. Session history is preserved.",
                        onConfirm: () => {
                            api.ui.dialog.clear()
                            void dispatchToMaster(
                                api,
                                "[System] User confirmed /team_delete. For each team returned by team_list, call team_delete with force:true.",
                            )
                        },
                        onCancel: () => api.ui.dialog.clear(),
                    }),
                ),
        },
        {
            namespace: "palette",
            name: "octeam.shutdown",
            title: "OCTeam: Request Shutdown",
            category: "OCTeam",
            slashName: "team_shutdown_request",
            run: () =>
                void dispatchToMaster(
                    api,
                    "[System] User invoked /team_shutdown_request. Identify the active team and call team_shutdown_request for each member to begin cooperative shutdown.",
                ),
        },
        {
            namespace: "palette",
            name: "octeam.parallel",
            title: "OCTeam: Parallel Workflow",
            category: "OCTeam",
            slashName: "team_parallel",
            run: () =>
                promptThenDispatch(
                    api,
                    "team_parallel",
                    "Describe the task to run in parallel across all members...",
                    (text) =>
                        `[System] User invoked /team_parallel with task: ${text}. Call team_parallel with mode "isolated" and this task.`,
                ),
        },
        {
            namespace: "palette",
            name: "octeam.pipeline",
            title: "OCTeam: Pipeline Workflow",
            category: "OCTeam",
            slashName: "team_pipeline",
            run: () =>
                void dispatchToMaster(
                    api,
                    "[System] User invoked /team_pipeline. Ask the user for the team and an ordered list of stages (member + task each), then call team_pipeline.",
                ),
        },
        {
            namespace: "palette",
            name: "octeam.loop",
            title: "OCTeam: Loop Workflow",
            category: "OCTeam",
            slashName: "team_loop",
            run: () =>
                void dispatchToMaster(
                    api,
                    "[System] User invoked /team_loop. Ask the user for the team, stages (member/task/action), decider member, max_rounds, and initial_task, then call team_loop.",
                ),
        },
        {
            namespace: "palette",
            name: "octeam.delegate",
            title: "OCTeam: Delegate Workflow",
            category: "OCTeam",
            slashName: "team_delegate",
            run: () =>
                promptThenDispatch(
                    api,
                    "team_delegate",
                    "Describe the tasks to publish (one per line)...",
                    (text) =>
                        `[System] User invoked /team_delegate with tasks: ${text}. Parse these into task objects (subject/description) and call team_delegate.`,
                ),
        },
    ]
}

export function registerTeamCommands(api: TuiPluginApi): void {
    const apiAny = api as unknown as ApiAny
    const commands = buildCommands(api)

    // Prefer keymap.registerLayer (OpenCode >= 1.14.42)
    if (typeof apiAny.keymap?.registerLayer === "function") {
        apiAny.keymap.registerLayer({
            commands: commands.map((c) => ({
                namespace: c.namespace,
                name: c.name,
                title: c.title,
                category: c.category,
                slashName: c.slashName,
                run: c.run,
            })),
            bindings: [],
        })
        return
    }

    // Fallback: legacy command.register
    if (typeof apiAny.command?.register === "function") {
        apiAny.command.register(() =>
            commands.map((c) => ({
                title: c.title,
                value: c.name,
                category: c.category,
                slash: { name: c.slashName },
                onSelect: c.run,
            })),
        )
    }
}
