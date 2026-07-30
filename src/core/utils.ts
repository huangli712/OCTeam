/**
 * General-purpose primitives with no team-orchestration domain knowledge:
 * polling, array batching, and fs error classification. Domain-specific helpers
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
 * M6: validates timeoutMs is a finite positive number. NaN/Infinity/
 * negative values would cause an infinite loop (NaN comparison is always
 * false) or immediate spurious rejection. */
export function waitUntil(
    predicate: () => boolean,
    opts: { timeoutMs: number; pollMs?: number },
): Promise<void> {
    // M6: reject invalid timeoutMs early instead of looping forever.
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) {
        return Promise.reject(new Error(`waitUntil: invalid timeoutMs ${opts.timeoutMs} (must be finite and >= 0)`))
    }
    // M-POLLMS: validate pollMs is a finite positive number. NaN/Infinity/
    // negative would cause tight polling or setTimeout warnings.
    const rawPollMs = opts.pollMs ?? 250
    const pollMs = Number.isFinite(rawPollMs) && rawPollMs > 0 ? rawPollMs : 250
    return new Promise<void>((resolve, reject) => {
        // MEDIUM: use monotonic deadline and cap each poll interval by the
        // remaining time so the function never overshoots timeoutMs by more
        // than one poll interval. Pre-fix code waited the full pollMs even
        // when the deadline had almost been reached.
        const start = Date.now()
        const deadline = start + opts.timeoutMs
        const tick = () => {
            try {
                if (predicate()) {
                    resolve()
                    return
                }
            } catch (err) {
                reject(err)
                return
            }
            const remaining = deadline - Date.now()
            if (remaining <= 0) {
                reject(new Error(`waitUntil: timed out after ${opts.timeoutMs}ms`))
                return
            }
            setTimeout(tick, Math.min(pollMs, remaining))
        }
        tick()
    })
}

/** Split the array into batches of size n.
 * M5 fix: throw RangeError on invalid n instead of silently returning [].
 * Pre-fix code returned [] which was indistinguishable from an empty input,
 * causing callers (e.g. maxParallelMembers bounds) to silently skip members
 * and wait ~2 minutes before timing out. */
export function chunk<T>(arr: T[], n: number): T[][] {
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        throw new RangeError(`chunk: batch size must be a finite positive integer, got ${n}`)
    }
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
    return out
}
