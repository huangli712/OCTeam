/**
 * Construct the shared PluginContext from host-provided PluginInput — the
 * single context object passed to every tool handler, event handler, and
 * transform hook.
 */

import os from "node:os"
import path from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"
import type { OpencodeClient, Project } from "@opencode-ai/sdk"

import type { StorageScope } from "./types.js"

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
