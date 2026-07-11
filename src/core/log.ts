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
 *      (state/, messaging/) that do NOT carry ctx. The sink is captured once
 *      at server startup via initLogger(ctx); before that, logger falls back
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

function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

function sendToSink(
    sinkFn: PluginContext["client"]["app"]["log"],
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
): void {
    // Do not await: logging must not add latency or backpressure to handlers.
    void sinkFn({ body: { service: "octeam", level, message, extra } }).catch(() => {
        // Never throw from the logger — the call sites are best-effort.
    })
}

/**
 * Shared emit path for the global `logger` object. Routes to the captured
 * sink when available, otherwise falls back to console.warn so output is
 * still visible (e.g. in unit tests before initLogger is called).
 */
function emitGlobal(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (!shouldLog(level)) return
    if (sink) sendToSink(sink, level, message, extra)
    else console.warn(`[octeam] ${message}`, extra ?? "")
}

// ---------------------------------------------------------------------------
// Init / configuration
// ---------------------------------------------------------------------------

/**
 * Initialize the global logger. Called once in server() init. Captures the
 * host's app.log sink so bottom-layer modules (state/, messaging/) can emit
 * structured logs via the `logger` object without a ctx parameter.
 *
 * Safe to call multiple times (only the first call captures the sink).
 */
export function initLogger(ctx: PluginContext): void {
    if (sink === null) sink = ctx.client.app.log
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
    sendToSink(ctx.client.app.log, level, message, extra)
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
    logEvent(ctx, level, message, {
        ...extra,
        error: err instanceof Error ? err.message : String(err),
    })
}

// ---------------------------------------------------------------------------
// Global logger (for modules without ctx: state/, messaging/)
// ---------------------------------------------------------------------------

/** Method signature for each level on the global `logger` object. */
type LogMethod = (message: string, extra?: Record<string, unknown>) => void

/**
 * Global logger for bottom-layer modules that do not carry a PluginContext.
 * Uses the sink captured by initLogger; before initLogger is called (e.g. in
 * unit tests), falls back to console.warn so output is still visible.
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
