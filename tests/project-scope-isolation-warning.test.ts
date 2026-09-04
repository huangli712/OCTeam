/**
 * Regression test for project scope control-state isolation: it must be
 * surfaced to operators at startup.
 *
 * The default storage scope is "project": control state lives under
 * <input.directory>/.octeam/, which member agents with edit/bash tools can
 * also write to. This is the root cause behind the symlink/auth/mailbox
 * attack vectors hardened earlier. Without host-level isolation
 * (denying member agents write access to .octeam/), a malicious member can
 * tamper with control state directly.
 *
 * The plugin cannot enforce filesystem permissions on its own — that is a
 * host-level concern. What the plugin CAN do is surface the threat model
 * prominently at startup so operators:
 *   1. Know the risk exists when project scope is active.
 *   2. Know the available mitigation (switch to user scope via config, or
 *      restrict member write paths via OpenCode permissions).
 *
 * This test verifies the warning fires on project scope and does NOT fire
 * on user scope.
 */

import { describe, expect, test } from "bun:test"

describe("project scope startup warning", () => {
    test("project scope emits a threat-model warning at startup", async () => {
        const warnings: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = []
        const fakeCtx = {
            client: {
                app: {
                    log: (payload: { body: { level: string; message: string; extra?: Record<string, unknown> } }) => {
                        warnings.push({
                            level: payload.body.level,
                            message: payload.body.message,
                            extra: payload.body.extra,
                        })
                        return Promise.resolve()
                    },
                },
            },
        }
        // Import the helper directly.
        const { warnIfProjectScopeLacksIsolation } = await import("../src/core/context.js")
        warnIfProjectScopeLacksIsolation(fakeCtx as any, "project", "/some/project/.octeam")
        expect(warnings.length).toBeGreaterThanOrEqual(1)
        const has = warnings.some(w =>
            typeof w.message === "string"
            && /project scope|threat model|member.*write|isolation/i.test(w.message),
        )
        expect(has).toBe(true)
    })

    test("user scope does NOT emit the warning", async () => {
        const warnings: Array<{ level: string; message: string }> = []
        const fakeCtx = {
            client: {
                app: {
                    log: (payload: { body: { level: string; message: string } }) => {
                        warnings.push({ level: payload.body.level, message: payload.body.message })
                        return Promise.resolve()
                    },
                },
            },
        }
        const { warnIfProjectScopeLacksIsolation } = await import("../src/core/context.js")
        warnIfProjectScopeLacksIsolation(fakeCtx as any, "user", "/home/user/.octeam")
        expect(warnings.length).toBe(0)
    })
})
