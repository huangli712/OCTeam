/**
 * Structured logging over the OpenCode server-log sink (POST /log via
 * ctx.client.app.log). Fire-and-forget and crash-proof: a logging failure is
 * itself swallowed, because these calls live inside best-effort catch blocks
 * whose control flow must not change.
 */
import type { PluginContext } from "./context.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

export function logEvent(
    ctx: PluginContext,
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
): void {
    // Do not await: logging must not add latency or backpressure to handlers.
    void ctx.client.app
        .log({ body: { service: "octeam", level, message, extra } })
        .catch(() => {
            // Never throw from the logger — the call sites are best-effort.
        })
}

/** Convenience for the dominant case: a swallowed error in a catch block. */
export function logSwallowed(
    ctx: PluginContext,
    message: string,
    err: unknown,
    extra?: Record<string, unknown>,
): void {
    logEvent(ctx, "warn", message, {
        ...extra,
        error: err instanceof Error ? err.message : String(err),
    })
}
