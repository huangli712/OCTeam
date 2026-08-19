/**
 * General-purpose primitives with no team-orchestration domain knowledge:
 * polling and fs error classification. Domain-specific helpers
 * (output extraction, role prompts, activation gates) live in their respective
 * layers — see orchestration/protocol/output.ts and state/activation.ts.
 */

// --- fs error helpers ---

/**
 * Returns true iff `err` is a Node.js ENOENT ("no such file or directory")
 * error. Centralizes the cast-and-check pattern used at every fs.* catch site
 * so the NodeJS.ErrnoException cast lives in one place.
 */
export function isEnoent(err: unknown): boolean {
    return err !== null
        && typeof err === "object"
        && "code" in err
        && err.code === "ENOENT"
}

// --- polling primitive ---

/** Resolve when predicate is true; reject on timeout. Polls every pollMs.
 * Validates timeoutMs is a finite non-negative number. NaN/Infinity/
 * negative values would cause an infinite loop (NaN comparison is always
 * false) or immediate spurious rejection. */
export function waitUntil(
    predicate: () => boolean,
    opts: { timeoutMs: number; pollMs?: number; signal?: AbortSignal },
): Promise<void> {
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) {
        return Promise.reject(new Error(
            `waitUntil: invalid timeoutMs ${opts.timeoutMs} (must be finite and >= 0)`,
        ))
    }
    // Check AbortSignal for early cancellation.
    if (opts.signal?.aborted) {
        return Promise.reject(new Error("waitUntil: aborted"))
    }
    const rawPollMs = opts.pollMs ?? 250
    const pollMs = Number.isFinite(rawPollMs) && rawPollMs > 0 ? rawPollMs : 250
    return new Promise<void>((resolve, reject) => {
        // Use performance.now() for monotonic timing. Date.now()
        // can jump backward on NTP sync, causing premature timeout or
        // indefinite waiting.
        const start = performance.now()
        const deadline = start + opts.timeoutMs
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
            if (timer) clearTimeout(timer)
            if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
        }
        const onAbort = () => {
            cleanup()
            reject(new Error("waitUntil: aborted"))
        }
        if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true })
        const tick = () => {
            try {
                if (predicate()) {
                    cleanup()
                    resolve()
                    return
                }
            } catch (err) {
                cleanup()
                reject(err)
                return
            }
            const remaining = deadline - performance.now()
            if (opts.signal?.aborted) {
                cleanup()
                reject(new Error("waitUntil: aborted"))
                return
            }
            if (remaining <= 0) {
                cleanup()
                reject(new Error(`waitUntil: timed out after ${opts.timeoutMs}ms`))
                return
            }
            timer = setTimeout(tick, Math.min(pollMs, remaining))
        }
        tick()
    })
}
