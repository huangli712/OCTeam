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
        const start = Date.now()
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
            if (Date.now() - start >= opts.timeoutMs) {
                reject(new Error(`waitUntil: timed out after ${opts.timeoutMs}ms`))
                return
            }
            setTimeout(tick, pollMs)
        }
        tick()
    })
}

/** Split the array into batches of size n.
 * M6: validates n is a finite positive integer. NaN (n <= 0 is false for NaN)
 * would cause i += NaN → infinite loop. */
export function chunk<T>(arr: T[], n: number): T[][] {
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return []
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
    return out
}
