/**
 * Coverage tests for src/core/log.ts — the structured logging sink.
 *
 * logEvent and logSwallowed are fire-and-forget over ctx.client.app.log. The
 * dominant contract: a logging failure must NEVER throw to the caller (these
 * calls live inside best-effort catch blocks whose control flow must not
 * change). These tests pin that behavior and verify the body shape.
 */
import { describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { logEvent, logSwallowed } from "../src/core/log.js"

/** Minimal ctx stub: captures the last app.log call. */
function makeCtx(capture: { body?: unknown }): PluginContext {
    return {
        client: {
            app: {
                log: mock(async (args: unknown) => {
                    capture.body = (args as { body?: unknown }).body
                    return { data: {} }
                }),
            },
        },
    } as unknown as PluginContext
}

describe("logEvent", () => {
    test("calls ctx.client.app.log with service/level/message/extra", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        logEvent(ctx, "warn", "something happened", { key: "value" })
        // logEvent is fire-and-forget (void); await a microtask for the mock to fire.
        await Promise.resolve()
        expect(cap.body).toEqual({
            service: "octeam",
            level: "warn",
            message: "something happened",
            extra: { key: "value" },
        })
    })

    test("extra is optional (omitted → undefined)", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        logEvent(ctx, "error", "boom")
        await Promise.resolve()
        expect(cap.body).toEqual({
            service: "octeam",
            level: "error",
            message: "boom",
            extra: undefined,
        })
    })

    test("does NOT throw when app.log rejects", async () => {
        const ctx = {
            client: { app: { log: mock(async () => { throw new Error("sink down") }) } },
        } as unknown as PluginContext
        expect(() => logEvent(ctx, "info", "test")).not.toThrow()
        // The rejection is swallowed internally; let it drain.
        await new Promise(r => setTimeout(r, 10))
    })
})

describe("logSwallowed", () => {
    test("delegates to logEvent at level 'warn' with error field extracted from Error", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        logSwallowed(ctx, "operation failed", new Error("disk full"), { team: "alpha" })
        await Promise.resolve()
        expect(cap.body).toEqual({
            service: "octeam",
            level: "warn",
            message: "operation failed",
            extra: { team: "alpha", error: "disk full" },
        })
    })

    test("extracts String(err) for non-Error values", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        logSwallowed(ctx, "weird failure", "string error")
        await Promise.resolve()
        const body = cap.body as { extra?: { error?: string } }
        expect(body.extra?.error).toBe("string error")
    })

    test("extracts String(err) for numbers and objects", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        logSwallowed(ctx, "num failure", 42)
        await Promise.resolve()
        const body = cap.body as { extra?: { error?: string } }
        expect(body.extra?.error).toBe("42")
    })

    test("extra is optional", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        logSwallowed(ctx, "no extra", new Error("e"))
        await Promise.resolve()
        const body = cap.body as { extra?: { error?: string; team?: string } }
        expect(body.extra?.error).toBe("e")
        expect(body.extra?.team).toBeUndefined()
    })
})
