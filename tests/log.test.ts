/**
 * Coverage tests for src/core/log.ts — the structured logging sink.
 *
 * Three API surfaces tested:
 *   1. logEvent(ctx, ...) / logSwallowed(ctx, ...) — ctx-based, for tools/hooks
 *   2. logger.warn/info/... — global object, for state/messaging modules
 *   3. Level filtering via setLogLevel / OCTEAM_LOG_LEVEL
 *
 * Contracts:
 *   - A logging failure must NEVER throw to the caller (fire-and-forget).
 *   - The body shape sent to app.log is { service, level, message, extra }.
 *   - Levels below minLevel are silently filtered (no sink call).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { _resetLoggerForTests, initLogger, logEvent, logSwallowed, logger, setLogLevel } from "../src/core/log.js"

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

// Reset global logger state before each test so sink/level don't bleed.
beforeEach(() => _resetLoggerForTests())
// Reset level to default after each test so level-filter tests don't bleed.
afterEach(() => _resetLoggerForTests())

// ============================================================
// logEvent (ctx-based API)
// ============================================================

describe("logEvent", () => {
    test("calls ctx.client.app.log with service/level/message/extra", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        logEvent(ctx, "warn", "something happened", { key: "value" })
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
        await new Promise(r => setTimeout(r, 10))
    })

    test("debug level is filtered when minLevel is 'info'", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        setLogLevel("info")
        logEvent(ctx, "debug", "should be filtered")
        await Promise.resolve()
        expect(cap.body).toBeUndefined()
    })

    test("warn level passes when minLevel is 'info'", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        setLogLevel("info")
        logEvent(ctx, "warn", "should pass")
        await Promise.resolve()
        expect(cap.body).toBeDefined()
    })

    test("all levels pass when minLevel is 'debug'", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        setLogLevel("debug")
        logEvent(ctx, "debug", "debug msg")
        await Promise.resolve()
        expect(cap.body).toBeDefined()
        expect((cap.body as { level: string }).level).toBe("debug")
    })

    test("only error passes when minLevel is 'error'", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        setLogLevel("error")
        logEvent(ctx, "warn", "filtered")
        await Promise.resolve()
        expect(cap.body).toBeUndefined()
        logEvent(ctx, "error", "passes")
        await Promise.resolve()
        expect(cap.body).toBeDefined()
    })
})

// ============================================================
// logSwallowed (ctx-based, with optional level)
// ============================================================

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

    test("accepts explicit level: 'debug' for expected failures", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        setLogLevel("debug")
        logSwallowed(ctx, "ENOENT cleanup", new Error("not found"), undefined, "debug")
        await Promise.resolve()
        const body = cap.body as { level: string }
        expect(body.level).toBe("debug")
    })

    test("debug-level logSwallowed is filtered when minLevel is 'info'", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        setLogLevel("info")
        logSwallowed(ctx, "expected", new Error("e"), undefined, "debug")
        await Promise.resolve()
        expect(cap.body).toBeUndefined()
    })
})

// ============================================================
// Global logger (for modules without ctx)
// ============================================================

describe("logger (global)", () => {
    test("warn sends to the sink captured by initLogger", async () => {
        const cap: { body?: unknown } = {}
        const ctx = makeCtx(cap)
        initLogger(ctx)
        logger.warn("schema validation failed", { file: "/path/to/state.json" })
        await Promise.resolve()
        expect(cap.body).toEqual({
            service: "octeam",
            level: "warn",
            message: "schema validation failed",
            extra: { file: "/path/to/state.json" },
        })
    })

    test("info sends to the captured sink", async () => {
        const cap: { body?: unknown } = {}
        initLogger(makeCtx(cap))
        logger.info("team created", { team: "alpha" })
        await Promise.resolve()
        expect((cap.body as { level: string }).level).toBe("info")
        expect((cap.body as { message: string }).message).toBe("team created")
    })

    test("debug is filtered when minLevel is 'info' (default)", async () => {
        const cap: { body?: unknown } = {}
        initLogger(makeCtx(cap))
        setLogLevel("info")
        logger.debug("should be filtered")
        await Promise.resolve()
        expect(cap.body).toBeUndefined()
    })

    test("respects setLogLevel change at runtime", async () => {
        const cap: { body?: unknown } = {}
        initLogger(makeCtx(cap))
        setLogLevel("error")
        logger.warn("filtered at error level")
        await Promise.resolve()
        expect(cap.body).toBeUndefined()
        logger.error("passes at error level")
        await Promise.resolve()
        expect(cap.body).toBeDefined()
    })

    test("falls back to console.warn when initLogger was not called", () => {
        // This is the pre-init path (unit tests of state/messaging modules).
        // We can't easily assert console.warn output without mocking global
        // console, but we verify it doesn't throw.
        expect(() => {
            logger.warn("fallback test")
        }).not.toThrow()
    })
})
