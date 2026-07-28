/**
 * Construct the shared PluginContext from host-provided PluginInput — the
 * single context object passed to every tool handler, event handler, and
 * transform hook. Also defines StorageScope, the storage scope enum consumed
 * by PluginContext.
 */

import os from "node:os"
import path from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"
import type { OpencodeClient, Project } from "@opencode-ai/sdk"

import { logEvent } from "./log.js"

/** Storage scope for team state: user (~/.octeam) or project (<dir>/.octeam). */
export type StorageScope = "user" | "project"

/**
 * Closure-style context shared by every tool handler, event handler, and the
 * transform hook. Built once per plugin load from the host-provided PluginInput
 * and captured in the server module's Hooks closures.
 *
 * Design note: PluginInput already provides the SDK client directly (no need to
 * construct one or discover the server URL), so PluginContext is a thin capture
 * of client + directory + the resolved storage roots.
 */
export type PluginContext = {
    client: OpencodeClient
    /** Current project working directory (from PluginInput.directory). */
    directory: string
    /** Project metadata (from PluginInput.project). */
    project: Project
    /** Active scope root: <directory>/.octeam (project) or ~/.octeam (user). */
    storageRoot: string
    /** ~/.octeam — always available regardless of active scope. */
    userStorageRoot: string
    /** <directory>/.octeam — always available regardless of active scope. */
    projectStorageRoot: string
    /** Which scope is active for new teams. */
    scope: StorageScope
}

/**
 * Construct a PluginContext from the host-provided PluginInput.
 *
 * Default scope is "project": teams are bound to the project working directory
 * (members operate in that dir, so co-locating state under <dir>/.octeam keeps
 * everything portable and per-repo). Pass "user" to store teams under ~/.octeam
 * instead (shared across projects).
 *
 * C-11 threat-model note: project scope places control state under
 * <input.directory>/.octeam/ — the same project directory that member agents
 * (oct-junior, oct-deep) can write to via their edit/bash tools. A malicious
 * member can tamper with mailbox JSONL, state.json, workflow_file, etc. The
 * plugin's in-process defenses (assertNoSymlinkTraversal, directive auth,
 * master-identity-from-directory, agent-preset hardening, etc.) raise the bar
 * but cannot fully prevent FS-level tampering from a same-process agent. The
 * robust mitigation is host-side: exclude .octeam/ from member write paths
 * via the OpenCode permission layer. When that is not possible, prefer user
 * scope (~/.octeam, outside the project dir) — see {@link warnIfProjectScopeLacksIsolation}.
 */
export function createPluginContext(
    input: PluginInput,
    scope: StorageScope = "project",
): PluginContext {
    const home = os.homedir()
    const userStorageRoot = path.join(home, ".octeam")
    const projectStorageRoot = path.join(input.directory, ".octeam")
    return {
        client: input.client,
        directory: input.directory,
        project: input.project,
        storageRoot: scope === "project" ? projectStorageRoot : userStorageRoot,
        userStorageRoot,
        projectStorageRoot,
        scope,
    }
}

/**
 * Emit a one-time startup warning when project scope is active, surfacing the
 * control-state isolation threat model. The warning explains that .octeam/
 * lives inside the project directory that member agents can write to, points
 * to the available mitigations (switch to user scope, or restrict member
 * write paths at the host level), and notes that the plugin's in-process
 * defenses (C-1 through C-10) raise the bar but are not a substitute for
 * filesystem-level isolation.
 *
 * No-op for user scope (control state is already outside the project dir).
 */
export function warnIfProjectScopeLacksIsolation(
    ctx: PluginContext,
    scope: StorageScope,
    projectStorageRoot: string,
): void {
    if (scope !== "project") return
    logEvent(ctx, "warn", "C-11 project scope: control state lives inside the member-writable project directory", {
        projectStorageRoot,
        threatModel: "Member agents (oct-junior, oct-deep) with edit/bash tools can write to .octeam/. "
            + "A malicious member can tamper with mailbox JSONL, state.json, workflow_file, etc. "
            + "The plugin's in-process defenses (symlink traversal, directive auth, master identity, "
            + "agent preset hardening, resource limits) raise the bar but cannot fully prevent FS-level "
            + "tampering from a same-process agent.",
        mitigations: [
            "Preferred: restrict member write paths at the OpenCode permission layer to exclude .octeam/.",
            "Alternative: switch to user scope (~/.octeam, outside the project dir) via the plugin config.",
        ],
    })
}
