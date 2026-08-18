/**
 * Structured logging over the OpenCode server-log sink (POST /log via
 * ctx.client.app.log). Fire-and-forget and crash-proof: a logging failure is
 * itself swallowed, because these calls live inside best-effort catch blocks
 * whose control flow must not change.
 *
 * Two entry points:
 *   1. logEvent(ctx, ...) / logSwallowed(ctx, ...) — for code that already
 *      holds a PluginContext (tools/, hooks/, orchestration/).
 *   2. logger.warn(message, ...) — a global object for bottom-layer modules
 *      (state/, messaging/) that do NOT carry ctx. The sink is set at server
 *      startup via initLogger(ctx); before that, logger falls back
 *      to console.warn so unit tests of those modules still see output.
 *
 * Level filtering: a module-level minLevel (default "info", overridable
 * via OCTEAM_LOG_LEVEL env var or setLogLevel()) gates every path so noisy
 * debug calls can be silenced in production without code changes.
 */

import type { PluginContext } from "./context.js"

// ---------------------------------------------------------------------------
// Level definitions
// ---------------------------------------------------------------------------

/** Structured logging severity level, from debug to error. */
export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Read the initial minimum log level from the OCTEAM_LOG_LEVEL environment
 * variable. Returns "info" when unset or invalid so production defaults to
 * a sane verbosity without requiring explicit configuration.
 */
function levelFromEnv(): LogLevel {
    const v = process.env.OCTEAM_LOG_LEVEL?.toLowerCase()
    if (v === "debug" || v === "info" || v === "warn" || v === "error") return v
    return "info"
}

// ---------------------------------------------------------------------------
// Module-level state (initialized once at server startup via initLogger)
// ---------------------------------------------------------------------------

let minLevel: LogLevel = levelFromEnv()

/** The host's app.log sink, captured by initLogger for the global logger path. */
let sink: PluginContext["client"]["app"]["log"] | null = null

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Level filter gate shared by both the ctx-based and global logger paths.
 * Returns true when the given level meets the module-level minimum.
 */
function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

/**
 * Fire-and-forget dispatch to the host's app.log sink. Never awaits and
 * swallows all errors so logging never adds latency, backpressure, or
 * thrown exceptions to the calling handler.
 *
 * The outer try/catch handles synchronous sink failures, while the attached
 * Promise catch handles asynchronous rejections.
 */
function sendToSink(
    sinkFn: PluginContext["client"]["app"]["log"],
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
): void {
    // Do not await: logging must not add latency or backpressure to handlers.
    // The try/catch guards synchronous throws from sinkFn; .catch guards async
    // rejections from the returned Promise.
    try {
        void sinkFn({ body: { service: "octeam", level, message, extra } }).catch(() => {
            // Never throw from the logger — the call sites are best-effort.
        })
    } catch {
        // Synchronous throw from sinkFn (host bug, eager validation, etc).
        // Swallow so the calling handler is never disrupted by logging.
    }
}

/**
 * Shared emit path for the global `logger` object. Routes to the captured
 * sink when available, otherwise falls back to the corresponding console
 * level so output is still visible before initLogger is called.
 */
function emitGlobal(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (!shouldLog(level)) return
    if (sink) sendToSink(sink, level, message, extra)
    else if (level === "debug") console.debug(`[octeam] ${message}`, extra ?? "")
    else if (level === "info") console.info(`[octeam] ${message}`, extra ?? "")
    else if (level === "warn") console.warn(`[octeam] ${message}`, extra ?? "")
    else console.error(`[octeam] ${message}`, extra ?? "")
}

// ---------------------------------------------------------------------------
// Init / configuration
// ---------------------------------------------------------------------------

/**
 * Initialize the global logger. Called once in server() init. Captures the
 * host's app.log sink so bottom-layer modules (state/, messaging/) can emit
 * structured logs via the `logger` object without a ctx parameter.
 *
 * Safe to call multiple times; each call replaces the sink for the current host.
 */
export function initLogger(ctx: PluginContext): void {
    // Bind the log method to preserve `this` context. The SDK's
    // App.log() may depend on `this._client`; extracting it as a bare
    // function reference and calling it without binding causes a
    // TypeError that the logger silently swallows, dropping all
    // structured logs. Binding at capture time is safe and idempotent.
    sink = ctx.client.app.log.bind(ctx.client.app)
}

/** Set the minimum log level at runtime. */
export function setLogLevel(level: LogLevel): void {
    minLevel = level
}

// ---------------------------------------------------------------------------
// ctx-based API (for code that already holds a PluginContext)
// ---------------------------------------------------------------------------

/**
 * Send a structured log event to the host's app.log sink.
 * Silently drops when the current level filters it out.
 */
export function logEvent(
    ctx: PluginContext,
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
): void {
    if (!shouldLog(level)) return
    // Bind to preserve `this` for SDK methods that depend on it.
    sendToSink(ctx.client.app.log.bind(ctx.client.app), level, message, extra)
}

/**
 * Convenience for the dominant case: a swallowed error in a catch block.
 * Defaults to "warn"; pass `level: "debug"` for expected failures (ENOENT
 * cleanup, EEXIST mkdir) to avoid warn-level noise in production.
 */
export function logSwallowed(
    ctx: PluginContext,
    message: string,
    err: unknown,
    extra?: Record<string, unknown>,
    level: LogLevel = "warn",
): void {
    try {
        logEvent(ctx, level, message, {
            ...extra,
            error: err instanceof Error ? err.message : String(err),
        })
    } catch {
        // logSwallowed must never throw — it is used exclusively in catch
        // blocks where throwing would mask the original error.
    }
}

// ---------------------------------------------------------------------------
// Global logger (for modules without ctx: state/, messaging/)
// ---------------------------------------------------------------------------

/** Method signature for each level on the global `logger` object. */
type LogMethod = (message: string, extra?: Record<string, unknown>) => void

/**
 * Global logger for bottom-layer modules that do not carry a PluginContext.
 * Uses the sink captured by initLogger; before initLogger is called (e.g. in
 * unit tests), falls back to the corresponding console level.
 */
export const logger: Record<LogLevel, LogMethod> = {
    debug: (message, extra) => emitGlobal("debug", message, extra),
    info: (message, extra) => emitGlobal("info", message, extra),
    warn: (message, extra) => emitGlobal("warn", message, extra),
    error: (message, extra) => emitGlobal("error", message, extra),
}

// ---------------------------------------------------------------------------
// Test-only API (production code must NOT use this)
// ---------------------------------------------------------------------------

/**
 * Reset the global logger state (sink + level) for unit tests.
 * @internal Exported only for test files.
 */
export const __test__ = {
    resetState(): void {
        sink = null
        minLevel = levelFromEnv()
    },
}
