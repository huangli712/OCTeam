/**
 * team_create tool -- define an agent team. Writes config.json + initial
 * state.json; does NOT spawn member sessions (lazy on first workflow call).
 * Includes resolveCreateModel (best-effort model resolution).
 */

import crypto from "node:crypto"
import fs from "node:fs/promises"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { initTeamState, writeTeamSpec } from "../../state/store.js"
import { indexMasterTeam, isIndexedMember } from "../../state/resolve.js"
import { teamDir, teamsDir } from "../../state/paths.js"
import { assertNoSymlinkTraversal } from "../../state/locks.js"
import { masterSentinelPath } from "../../state/paths.js"
import { normalizeRole, roleAgent } from "../../core/role.js"
import { logSwallowed } from "../../core/log.js"
import type { MemberSpec, MemberState, TeamSpec } from "../../core/types.js"
import { pickName } from "../../state/naming.js"
import { defaultBounds, validateMemberAgent, validateMemberName } from "../support.js"

/**
 * Best-effort model resolution for team_create. Resolves, in order:
 *   1. per-agent models (agents lookup),
 *   2. the configured default model,
 *   3. the leader session's most recent assistant model.
 * Each step swallows errors intentionally — members fall back to no explicit
 * model when a step is unavailable. The returned triple is merged per member as
 * `m.model ?? modelByAgent.get(agent) ?? defaultModel ?? sessionModel`.
 */
async function resolveCreateModel(
    ctx: PluginContext,
    sessionId: string,
): Promise<{
    modelByAgent: Map<string, string | undefined>
    defaultModel: string | undefined
    sessionModel: string | undefined
}> {
    const modelByAgent = new Map<string, string | undefined>()
    try {
        const agentsRes = await ctx.client.app.agents({ query: { directory: ctx.directory } })
        for (const a of agentsRes.data ?? []) {
            if (a.model) modelByAgent.set(a.name, `${a.model.providerID}/${a.model.modelID}`)
        }
    } catch (err) {
        logSwallowed(ctx, "resolveCreateModel: agents lookup failed", err)
    }
    let defaultModel: string | undefined
    try {
        defaultModel = (await ctx.client.config.get()).data?.model
    } catch (err) {
        logSwallowed(ctx, "resolveCreateModel: config.get failed", err)
    }
    // Final fallback: the leader session's active model.
    let sessionModel: string | undefined
    try {
        const msgsRes = await ctx.client.session.messages({
            path: { id: sessionId },
            query: { directory: ctx.directory, limit: 10 },
        })
        const msgs = msgsRes.data ?? []
        for (let i = msgs.length - 1; i >= 0; i--) {
            const info = msgs[i].info
            if (info.role === "assistant") {
                sessionModel = `${info.providerID}/${info.modelID}`
                break
            }
        }
    } catch (err) {
        logSwallowed(ctx, "resolveCreateModel: session.messages failed", err)
    }
    return { modelByAgent, defaultModel, sessionModel }
}

/** Define a new agent team with preset roles, writing config and state to disk. */
export function teamCreateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Define an agent team. Each member has a role, a prompt (the member's instructions), and an optional name. "
            + "role must be one of the preset roles (coder, debugger, optimizer, tester, solver, "
            + "reviewer, architect, explorer, writer, mathematician, physicist, simulator, chemist, "
            + "analyst, visualizer, researcher, author, fantast, planner, auditor, looker, almighty); "
            + "it fixes the member's agent and preset instruction, and any unknown role falls back "
            + "to \"reviewer\" (read-only). name, if given, must be one of the preset pool names; "
            + "if omitted it is auto-picked from the pool. Writes config.json + initial state.json. "
            + "Does NOT spawn member sessions — they are spawned lazily on the first workflow call "
            + "(team_parallel/pipeline/loop/delegate). The calling session becomes the team leader "
            + "(\"master\").",
        args: {
            name: tool.schema
                .string()
                .min(1)
                .max(64)
                .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens only"),
            description: tool.schema.string().max(2048).optional(),
            members: tool.schema
                .array(
                    tool.schema.object({
                        name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/).optional(),
                        role: tool.schema.string().min(1).max(64).regex(
                            /^[a-zA-Z]+$/,
                            "a single English word, letters only, e.g. \"coder\"",
                        ),
                        prompt: tool.schema.string().min(1).max(8192),
                        model: tool.schema.string().optional(),
                        agent: tool.schema.string().optional(),
                        worktree: tool.schema.boolean().optional(),
                    }),
                )
                .min(1)
                .max(12),
            bounds: tool.schema
                .object({
                    // M-11: each bound has BOTH a minimum (>=1, prevents zero/negative)
                    // AND a maximum (prevents LLM from setting absurdly large values
                    // that would disable the "hard limit" semantics).
                    maxMembers: tool.schema.number().int().min(1).max(50).optional(),
                    maxParallelMembers: tool.schema.number().int().min(1).max(50).optional(),
                    maxMessagesPerRun: tool.schema.number().int().min(1).max(100_000).optional(),
                    maxWallClockMinutes: tool.schema.number().int().min(1).max(10_080).optional(), // 1 week
                    maxMemberTurns: tool.schema.number().int().min(1).max(10_000).optional(),
                    maxTasks: tool.schema.number().int().min(1).max(10_000).optional(),
                })
                .optional(),
        },
        async execute(args, context) {
            // A member (child) session must not create its own team: indexing it
            // as master below would let it escalate to master of a new team while
            // it is still a member of its original team.
            if (isIndexedMember(context.sessionID)) {
                return "Error: a team member session cannot create a team"
            }

            // Agent override (optional): must be one of OCTeam's hardened oct-*
            // agents. A bare host agent (e.g. "build") would bypass the
            // role->agent permission-hardening chokepoint (role.ts). Validated
            // in its own early loop so it runs for EVERY member (named or not),
            // not just members that pass the name-reserved/pool checks below.
            for (const m of args.members) {
                if (m.agent !== undefined) {
                    const err = validateMemberAgent(m.agent)
                    if (err) return err
                }
            }

            // Validate explicitly-provided names; collect them so the pool picker
            // avoids collisions. Members may omit `name` — those are assigned a
            // random pool name below.
            const taken = new Set<string>()
            for (const m of args.members) {
                if (m.name === undefined) continue
                // "master" and "orchestrator" are reserved synthetic identities
                // (the leader pseudo-member and the orchestrator message sender);
                // a real member by either name would collide with them.
                const nameErr = validateMemberName(m.name)
                if (nameErr) return nameErr
                if (taken.has(m.name)) return `Error: duplicate member name "${m.name}"`
                taken.add(m.name)
            }

            // Resolve names: explicit names are kept; omitted names are drawn from
            // MEMBER_NAME_POOL at random with no reuse within this team.
            const named = args.members.map(m => {
                const name = m.name ?? pickName(taken)
                taken.add(name)
                return { ...m, name }
            })

            // Session scoping: project-scope teams are stored under
            // <storageRoot>/<leadSessionId>/teams/<name>/; user-scope teams stay
            // flat (<userStorageRoot>/teams/<name>/). leadSessionId is undefined
            // for user scope.
            const leadSessionId = ctx.scope === "project" ? context.sessionID : undefined

            // Atomically claim the team directory. mkdir with recursive:false is
            // the OS-level atomic primitive: exactly one of N concurrent callers
            // wins, the rest get EEXIST. This closes the TOCTOU window that a
            // check-then-create sequence would leave open.
            //
            // C-1: assert no symlink traversal before any mkdir. Without this,
            // a symlinked teams/ or <sid>/ ancestor can redirect both mkdir and
            // the subsequent atomicWrite of config/state outside storageRoot.
            // The check accepts not-yet-existing paths (ENOENT components are
            // fine) so legitimate first-team creation still succeeds.
            const teamsRoot = teamsDir(ctx.storageRoot, leadSessionId)
            await assertNoSymlinkTraversal(ctx.storageRoot, teamsRoot)
            await fs.mkdir(teamsRoot, { recursive: true })
            const newTeamDir = teamDir(ctx.storageRoot, args.name, leadSessionId)
            await assertNoSymlinkTraversal(ctx.storageRoot, newTeamDir)
            try {
                await fs.mkdir(newTeamDir, { recursive: false })
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                    return `Error: team name "${args.name}" already exists in this ${ctx.scope} scope`
                }
                throw err
            }

            // Auto-assign agent + model for members that omitted them.
            const modelInfo = await resolveCreateModel(ctx, context.sessionID)
            const resolved: MemberSpec[] = named.map(m => {
                const role = normalizeRole(m.role)
                const agent = m.agent ?? roleAgent(role)
                const model = m.model
                    ?? modelInfo.modelByAgent.get(agent)
                    ?? modelInfo.defaultModel
                    ?? modelInfo.sessionModel
                return { name: m.name, role, prompt: m.prompt, agent, model, worktree: m.worktree }
            })

            const now = Date.now()
            const bounds = defaultBounds(args.bounds)
            // Cross-validate: the configured member cap must fit the initial
            // members. The schema validates members.length (1-12) and
            // bounds.maxMembers (>=1) independently; without this check a team
            // can be persisted already over its cap, breaking every downstream
            // invariant (add_member's >= check, spawn loops, quota reporting).
            if (bounds.maxMembers < resolved.length) {
                // Best-effort cleanup of the just-created directory so a retry
                // doesn't hit EEXIST.
                await fs.rm(newTeamDir, {
                    recursive: true, force: true,
                }).catch(() => { /* best-effort */ })
                return `Error: bounds.maxMembers (${bounds.maxMembers}) is less than the number of initial `
                    + `members (${resolved.length}). Set maxMembers to at least ${resolved.length}.`
            }
            const spec: TeamSpec = {
                version: 1,
                name: args.name,
                description: args.description,
                createdAt: now,
                members: resolved,
            }
            const members: MemberState[] = resolved.map(m => ({
                name: m.name,
                status: "pending",
                initialized: false,
                turnCount: 0,
                model: m.model,
                agent: m.agent,
            }))

            try {
                // trustedRoot hardens atomicWrite against intermediate-dir
                // symlink redirection (assertNoSymlinkTraversal walks the full
                // ancestor chain on every write).
                await writeTeamSpec(ctx.storageRoot, spec, leadSessionId, ctx.storageRoot)

                // C-17: write a read-only master.sentinel pinning the creator's
                // leadSessionId. For user-scope teams (flat layout, no directory
                // segment), this is the trusted master source at restart instead
                // of the mutable state.json.leadSessionId. chmod 0444 raises the
                // bar against tampering (attacker needs explicit chmod first).
                try {
                    const sentinelPath = masterSentinelPath(newTeamDir)
                    await fs.writeFile(sentinelPath, leadSessionId + "\n", "utf8")
                    await fs.chmod(sentinelPath, 0o444).catch(() => { /* best-effort on platforms without chmod */ })
                } catch {
                    // Sentinel is a hardening layer; failure to write it does
                    // not block team creation. User scope will fall back to the
                    // less-secure state.json path with a startup warning.
                }

                const createdTeam = await initTeamState(ctx.storageRoot, {
                    version: 1,
                    teamRunId: crypto.randomUUID(),
                    teamName: args.name,
                    status: "live",
                    leadSessionId: context.sessionID,
                    members,
                    bounds,
                    createdAt: now,
                    // Per project rule: never auto-activate.
                    activatedAt: undefined,
                }, leadSessionId, ctx.storageRoot)

                indexMasterTeam(context.sessionID, args.name, leadSessionId, ctx.storageRoot, createdTeam.directory)
            } catch (err) {
                // Rollback the just-created directory so a transient write
                // failure does not orphan it and permanently reserve the name.
                await fs.rm(newTeamDir, {
                    recursive: true, force: true,
                }).catch(() => { /* best-effort */ })
                throw err
            }

            return `Team "${args.name}" created with ${members.length} member(s): `
                + `${members.map(m => m.name).join(", ")}. Status: live `
                + `(inactive — call team_activate to activate it). Sessions will spawn on first workflow call.`
        },
    })
}
