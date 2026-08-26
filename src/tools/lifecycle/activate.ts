/**
 * team_activate tool -- make a team the session's active team. Refuses if
 * another team is already active (auto-switching disabled).
 */

import fs from "node:fs/promises"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import { isEnoent } from "../../core/utils.js"
import {
    configPath,
    deletedMarkerPath,
    masterSentinelPath,
    statePath,
    teamDir,
} from "../../state/paths.js"
import {
    listTeamNames,
    loadTeamState,
    saveTeamState,
    type Team
} from "../../state/store.js"
import {
    clearActiveTeam,
    isIndexedMasterOf,
    setActiveTeam
} from "../../state/resolve.js"
import {
    decideActivate,
    withOrderedLocks
} from "../../state/activation.js"

/** A process-level activation mutex keyed by sessionID prevents two
 *  concurrent team_activate calls from the same session from both scanning
 *  "no active sibling" outside the lock and then activating different targets
 *  simultaneously (which would leave two teams active). */
const activationMutex = new Map<string, Promise<void>>()

/** Serialize a callback per sessionID key. */
async function withSessionMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = activationMutex.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const next = prev.then(() => gate)
    activationMutex.set(key, next)
    try {
        await prev
        return await fn()
    } finally {
        release()
        // Evict the Map entry once the chain settles so long-lived hosts
        // don't accumulate stale session keys. If another caller queued behind
        // us, they've already replaced the value; our delete is a no-op.
        if (activationMutex.get(key) === next) {
            activationMutex.delete(key)
        }
    }
}

/** Outcome of scanning one sibling team during team_activate. */
type SiblingScanResult =
    | { kind: "loaded"; team: Team }
    | { kind: "ignored" }
    | { kind: "failed" }

/**
 * Fingerprint a sibling directory whose state.json failed to load with
 * ENOENT, deciding whether it may be skipped for the active-team check.
 *
 * Ignorable = the deletion marker next to the directory exists as a regular
 * file AND all three team identity files (state.json, config.json,
 * master.sentinel) are confirmed absent. Such a directory cannot hold an
 * activatedAt value, so it cannot be the session's active team.
 *
 * This does NOT prove the directory is delete residue: the same shape occurs
 * briefly while a same-name team is being re-created (directory claimed,
 * identity files not yet written, stale marker from the previous generation
 * not yet removed by the first save). Skipping that directory is equally
 * safe — it also has no state.json, hence no activatedAt.
 *
 * Unexpected errors (permissions, I/O) propagate; the caller must fail
 * closed on them.
 */
async function isIgnorableSiblingDir(dir: string): Promise<boolean> {
    let markerIsRegularFile: boolean
    try {
        markerIsRegularFile = (await fs.lstat(deletedMarkerPath(dir))).isFile()
    } catch (err) {
        if (isEnoent(err)) return false
        throw err
    }
    if (!markerIsRegularFile) return false
    for (const p of [statePath(dir), configPath(dir), masterSentinelPath(dir)]) {
        try {
            await fs.lstat(p)
        } catch (err) {
            if (isEnoent(err)) continue
            throw err
        }
        return false
    }
    return true
}

/** Activate a team for the current session. Only one team may be active at a time. */
export function teamActivateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Make a team the session's active (available) team. At most one team is active per " +
            "session. Refuses if another team is already active — call team_deactivate on it first " +
            "(auto-switching is disabled). Idempotent: activating the already-active team is a " +
            "no-op. The master may only interact with the active team.",
        args: {
            team_id: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const leadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            let target: Team
            try {
                target = await loadTeamState(ctx.storageRoot, args.team_id, leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            if (target.leadSessionId !== context.sessionID
                || !isIndexedMasterOf(context.sessionID, target.directory)) {
                return "Error: team_activate is master-only (only the team's leader session can activate it)"
            }

            // Serialize sibling scan and activation per session so two
            // concurrent team_activate calls cannot both see "no active
            // sibling" and proceed to activate different targets.
            return await withSessionMutex(context.sessionID, async () => {
            // Find the currently-active sibling (if any) — re-scan INSIDE the
            // mutex so a concurrent activate that just landed is visible.
            let activeSibling: Team | undefined
            const siblings = await listTeamNames(ctx.storageRoot, leadSessionId)
            const scanned: SiblingScanResult[] = await Promise.all(
                siblings
                    .filter(name => name !== args.team_id)
                    .map(async (name): Promise<SiblingScanResult> => {
                        try {
                            const team = await loadTeamState(ctx.storageRoot, name, leadSessionId)
                            // A cached Team whose state.json became unreadable on
                            // disk is returned flagged instead of throwing. Its
                            // persisted activatedAt cannot be trusted, so fail closed.
                            if (team._stateUnreadable) return { kind: "failed" }
                            return { kind: "loaded", team }
                        } catch (err) {
                            // ENOENT + deletion-marker fingerprint → this
                            // directory cannot hold activatedAt, so skip it for
                            // the active-team check. Everything else fails closed.
                            if (isEnoent(err)) {
                                const dir = teamDir(ctx.storageRoot, name, leadSessionId)
                                try {
                                    if (await isIgnorableSiblingDir(dir)) {
                                        logSwallowed(
                                            ctx,
                                            "team_activate: sibling has a deletion marker and no team identity files; ignoring it for the active-team check",
                                            err,
                                            { siblingTeam: name, leadSessionId },
                                        )
                                        return { kind: "ignored" }
                                    }
                                } catch (fingerprintErr) {
                                    logSwallowed(
                                        ctx,
                                        "team_activate: sibling residue check failed (fail-closed: activation will be refused)",
                                        fingerprintErr,
                                        { siblingTeam: name, leadSessionId },
                                    )
                                    return { kind: "failed" }
                                }
                            }
                            // Record sibling-load failures for the fail-closed check
                            // below and log enough context to diagnose transient I/O
                            // or permission errors.
                            logSwallowed(
                                ctx,
                                "team_activate: sibling load failed (fail-closed: activation will be refused)",
                                err,
                                {
                                    siblingTeam: name,
                                    leadSessionId,
                                },
                            )
                            return { kind: "failed" }
                        }
                    }),
            )
            // Fail closed when a sibling state load rejects or is served from
            // the cache flagged unreadable. Treating it as inactive could allow
            // concurrent activation, so refuse activation and surface the I/O
            // issue to the operator.
            const failedSiblings = scanned.filter(r => r.kind === "failed")
            if (failedSiblings.length > 0) {
                return `Error: cannot verify sibling team states (unreadable: ${failedSiblings.length}). `
                    + `Refusing to activate to prevent concurrent activation. `
                    + `Check .octeam/ permissions and retry.`
            }
            for (const r of scanned) {
                if (
                    r.kind === "loaded"
                    && r.team.leadSessionId === context.sessionID
                    && r.team.activatedAt !== undefined
                    && r.team.directory !== target.directory
                ) {
                    activeSibling = r.team
                    break
                }
            }

            let result = ""
            await withOrderedLocks([target, activeSibling].filter((t): t is Team => t !== undefined), async () => {
                const decision = decideActivate({
                    targetIsAlreadyActive: target.activatedAt !== undefined,
                    outgoingExists: activeSibling !== undefined,
                    outgoingName: activeSibling?.teamName,
                })
                if (decision.kind === "noop") {
                    result = `Team "${args.team_id}" is already the active team.`
                    return
                }
                if (decision.kind === "error") {
                    result = decision.message
                    return
                }
                const now = Date.now()
                target.activatedAt = now
                setActiveTeam(context.sessionID, target.directory)
                try {
                    await saveTeamState(target)
                } catch (err) {
                    // Restore in-memory state to match the un-persisted disk.
                    target.activatedAt = undefined
                    clearActiveTeam(context.sessionID)
                    logSwallowed(ctx, "persist team state failed (activate)", err, { team: target.teamName })
                    result = `Error: failed to persist activation for team "${args.team_id}" (state file write failed)`
                    return
                }
                result = `Team "${args.team_id}" activated.`
            })
            return result
            }) // withSessionMutex
        },
    })
}
