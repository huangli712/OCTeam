/**
 * team_delegate tool -- publish tasks to a shared tasklist; idle members
 * self-claim, execute, and report to master. Supports blockedBy dependencies.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import { createTask, listAllTasks, updateTask } from "../../state/tasks.js"
import {
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    signoffTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { signoffSchemaFields } from "../schema.js"
import { validateSignoff } from "../support.js"

/**
 * Detect a cycle in the blocked_by dependency graph declared by a delegate
 * call. Nodes are task refs; an edge ref -> dep means the ref'd task is
 * blocked_by dep. Returns the offending cycle path (e.g. ["A","B","A"]) or null
 * when the graph is acyclic. Only ref-bearing tasks can be dependency targets,
 * so a ref-less task is a pure source that cannot close a cycle. Callers must
 * have already validated that every blocked_by entry is a declared ref.
 */
export function detectBlockedByCycle(
    tasks: { ref?: string; blocked_by?: string[] }[],
): string[] | null {
    // Adjacency keyed by ref: ref -> refs it is blocked_by. Every blocked_by
    // entry is a declared ref (caller-validated), hence always a key here.
    const adjacency = new Map<string, string[]>()
    for (const t of tasks) {
        if (t.ref) adjacency.set(t.ref, t.blocked_by ?? [])
    }
    const UNVISITED = 0
    const IN_PATH = 1
    const DONE = 2
    const state = new Map<string, number>()
    const path: string[] = []

    const walk = (node: string): string[] | null => {
        state.set(node, IN_PATH)
        path.push(node)
        for (const dep of adjacency.get(node) ?? []) {
            const s = state.get(dep) ?? UNVISITED
            if (s === IN_PATH) {
                // Back-edge: close the cycle from dep's first occurrence.
                return [...path.slice(path.indexOf(dep)), dep]
            }
            if (s === UNVISITED) {
                const cycle = walk(dep)
                if (cycle) return cycle
            }
        }
        path.pop()
        state.set(node, DONE)
        return null
    }

    for (const node of adjacency.keys()) {
        if ((state.get(node) ?? UNVISITED) === UNVISITED) {
            const cycle = walk(node)
            if (cycle) return cycle
        }
    }
    return null
}

/** Delegate mode tool: publish tasks to a shared tasklist for self-claiming members. */
export function teamDelegateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Delegate mode: publish tasks to a shared tasklist; idle members self-claim, "
            + "execute, and report to master. Supports blockedBy dependencies via "
            + "human-readable refs.",
        args: {
            team_id: tool.schema.string().min(1),
            tasks: tool.schema
                .array(
                    tool.schema.object({
                        ref: tool.schema.string().optional().describe("human-readable id for blockedBy references"),
                        subject: tool.schema.string().min(1).max(500),
                        description: tool.schema.string().min(1).max(8192),
                        blocked_by: tool.schema.array(tool.schema.string()).optional(),
                    }),
                )
                .min(1)
                .max(200),
            ...signoffSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema
                .number()
                .min(1)
                .optional()
                .describe("optional token cap; orchestration fails if exceeded"),
            max_errored_members: tool.schema
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    "tolerate up to N terminally-errored members and still deliver "
                    + "survivors' work. Default 0 (any member error fails the run).",
                ),
            max_retries: tool.schema
                .number()
                .int()
                .min(0)
                .max(5)
                .optional()
                .describe(
                    "re-dispatch grace windows before a sustained-retry member "
                    + "is marked errored. Default 0.",
                ),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_delegate",
                // validate
                (team) => {
                    // Pre-validate blockedBy refs against declared refs (before
                    // activeTask is set) so an invalid ref cannot leave the
                    // team in a dirty state.
                    const declaredRefs = new Set(args.tasks.filter(t => t.ref).map(t => t.ref!))
                    for (const t of args.tasks) {
                        if (!t.blocked_by) continue
                        for (const dep of t.blocked_by) {
                            if (!declaredRefs.has(dep)) {
                                return `Error: unknown blockedBy ref "${dep}"`
                            }
                        }
                    }
                    // Reject blocked_by cycles. The ref-existence
                    // check above only proves each dependency target exists; a
                    // cycle (A blocked_by B, B blocked_by A) still passes it
                    // but leaves every task in the cycle permanently
                    // unclaimable until the wall-clock deadlock backstop
                    // fires. Catch it here with a precise error instead.
                    const cycle = detectBlockedByCycle(args.tasks)
                    if (cycle) {
                        return `Error: blocked_by cycle detected: ${cycle.join(" -> ")}`
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask: enforce the task cap BEFORE creating any task, then
                // create all tasks BEFORE committing activeTask/status
                // (a mid-loop failure leaves the team idle rather than
                // wedged in "busy" with an unpersisted activeTask). Counting +
                // creating both run under the mutex so the count cannot be
                // raced by a concurrent create.
                async (team) => {
                    const liveTaskCount = (await listAllTasks(team.directory)).filter(
                        t => t.status !== "deleted",
                    ).length
                    if (liveTaskCount + args.tasks.length > team.bounds.maxTasks) {
                        return {
                            error: `Error: team task limit reached (${team.bounds.maxTasks}). `
                                + `${liveTaskCount} live task(s) exist; cannot add ${args.tasks.length} more.`,
                        }
                    }

                    // Create all tasks, building ref -> uuid and index -> uuid
                    // maps, then resolve blockedBy. The index map keys every
                    // task by its position so blocked_by is applied even to
                    // tasks without their own ref (a ref is only needed to be
                    // a dependency *target*, not to *have* dependencies).
                    const refToUuid = new Map<string, string>()
                    const indexToUuid = new Map<number, string>()
                    for (let i = 0; i < args.tasks.length; i++) {
                        const t = args.tasks[i]
                        const created = await createTask(team.directory, {
                            subject: t.subject,
                            description: t.description,
                        })
                        indexToUuid.set(i, created.id)
                        if (t.ref) refToUuid.set(t.ref, created.id)
                    }
                    for (let i = 0; i < args.tasks.length; i++) {
                        const t = args.tasks[i]
                        const uuid = indexToUuid.get(i)
                        if (!uuid) continue
                        const blockedBy = (t.blocked_by ?? [])
                            .map(r => refToUuid.get(r)!)
                        if (blockedBy.length > 0) {
                            await updateTask(team.directory, uuid, { blockedBy })
                        }
                    }

                    return {
                        type: "delegate",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        maxErroredMembers: args.max_errored_members,
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: prompt every member to start pulling from the
                // tasklist.
                async (team) => {
                    for (const m of team.members.filter(x => !x.isMaster)) {
                    const text =
                        `[Team Orchestrator] You are on team "${team.teamName}" in delegate mode. `
                        + `${args.tasks.length} task(s) published. `
                        + `Use team_task_list to view, team_task_update (status "claimed") to claim, `
                        + `execute, then team_send_message to report results to master. `
                        + `Repeat until no tasks remain.`
                        await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_delegate started on "${args.team_id}" with ${args.tasks.length} task(s).`,
            )
        },
    })
}
