/**
 * team_done tool. Member-side explicit barrier acknowledgement for
 * `require_done_ack` parallel runs.
 *
 * When a parallel orchestration is started with `require_done_ack: true`,
 * the all-idle barrier is replaced by an all-acked barrier: a member only
 * counts as "ready to finish" after calling this tool. Members that go idle
 * without acking receive an automatic re-prompt from processIdle (Step 6).
 *
 * No-op (returns an explanatory error) when:
 *   - caller is not a team member
 *   - the team has no active task
 *   - the active task did not enable `require_done_ack`
 *   - the active task is not parallel isolated/cooperative
 *
 * Idempotent: calling team_done twice in one run returns the same ack.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { loadTeamState, saveTeamState } from "../../state/store.js"

/** Acknowledge member completion in a require_done_ack parallel run. */
export function teamDoneTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Acknowledge that your work on the current parallel task is complete. Only meaningful "
            + "when the orchestrator started the run with require_done_ack=true; the all-idle "
            + "barrier is replaced by an all-acked barrier so premature idle does not end the "
            + "orchestration. Call this exactly once when you have finished every step in your "
            + "task (including required messages and self-verification). Idempotent.",
        args: {
            team_id: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            if (caller.isMaster) {
                return "Error: team_done is a member-only acknowledgement; the master does not call it"
            }

            let team
            try {
                team = await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }

            const task = team.activeTask
            if (!task) {
                return "Error: no active orchestration on this team — nothing to acknowledge"
            }
            if (task.type !== "parallel") {
                return `Error: team_done does not apply to ${task.type} orchestrations (parallel only)`
            }
            if (task.mode !== "isolated" && task.mode !== "cooperative") {
                return `Error: team_done does not apply to parallel/${task.mode} (isolated/cooperative only)`
            }
            if (!task.requireDoneAck) {
                return "Error: this run did not enable require_done_ack; just stop producing tool "
                    + "calls and the barrier will fire normally on idle"
            }

            // Bind this ack to the current run's identity. The active run may
            // change between the outside-mutex read above and the critical
            // section below (startOrchestration commits a new activeTask and
            // resets declaredDone under this same mutex); a stale ack from a
            // prior run must not bleed into the new run's barrier.
            const ackedRunId = task.runId

            let alreadyAcked = false
            let staleRun = false
            await team.mutex.runExclusive(async () => {
                const member = team.members.find(m => m.name === caller.name)
                if (!member) return
                // Revalidate run identity inside the mutex: if the active run
                // changed since the outside-mutex validation, refuse the ack
                // rather than letting it count toward the wrong run's barrier.
                const active = team.activeTask
                if (!active || active.runId !== ackedRunId) {
                    staleRun = true
                    return
                }
                if (member.declaredDone) {
                    alreadyAcked = true
                    return
                }
                member.declaredDone = true
                await saveTeamState(team)
            })

            if (staleRun) {
                return "Error: the active run changed before this acknowledgement was applied; "
                    + "re-evaluate the current run and ack again if appropriate"
            }
            if (alreadyAcked) {
                return `Already acknowledged. ${caller.name} is declared done; waiting for the rest of the team.`
            }
            return `Acknowledged. ${caller.name} marked done. The barrier will fire when every `
                + `participant has acked (or earlier via timeout/turn-cap).`
        },
    })
}
