/**
 * The shared PluginContext built from host-provided PluginInput, plus the
 * StorageScope type and its scope-warning helper.
 */

import os from "node:os"
import path from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"
import type { OpencodeClient, Project } from "@opencode-ai/sdk"

import { logEvent } from "./log.js"

/** Storage scope for team state: user (~/.octeam) or project (<dir>/.octeam). */
export type StorageScope = "user" | "project"

/**
 * Context object shared by every tool handler, event handler, and transform
 * hook. A thin capture of the host-provided SDK client, project directory,
 * and resolved storage roots.
 */
export type PluginContext = {
    readonly client: OpencodeClient
    /** Current project working directory (from PluginInput.directory). */
    readonly directory: string
    /** Project metadata (from PluginInput.project). */
    readonly project: Project
    /** Active scope root: <directory>/.octeam (project) or ~/.octeam (user). */
    readonly storageRoot: string
    /** ~/.octeam — always available regardless of active scope. */
    readonly userStorageRoot: string
    /** <directory>/.octeam — always available regardless of active scope. */
    readonly projectStorageRoot: string
    /** Which scope is active for new teams. */
    readonly scope: StorageScope
}

/**
 * Construct a PluginContext from the host-provided PluginInput.
 *
 * Default scope is "project": team state co-locates with the project
 * directory (<dir>/.octeam); pass "user" to store teams under ~/.octeam
 * instead (shared across projects). Project scope places control state in a
 * member-writable directory — see {@link warnIfProjectScopeLacksIsolation}
 * for the threat model and mitigations.
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
 * Emit a one-time startup warning when project scope is active. No-op for
 * user scope. The full threat model and mitigation guidance live in the
 * warning text itself (see the logEvent payload below).
 */
export function warnIfProjectScopeLacksIsolation(
    ctx: PluginContext,
    scope: StorageScope,
    projectStorageRoot: string,
): void {
    if (scope !== "project") return
    logEvent(ctx, "warn", "project scope: control state lives inside the member-writable project directory", {
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
