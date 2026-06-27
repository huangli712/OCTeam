import fs from "node:fs/promises"
import path from "node:path"

/** Default stale-lock TTL: a lock older than this is treated as dead (30s). */
export const LOCK_TTL_MS = 30_000

/** Default mailbox reservation TTL (30s). Covers crash-between-reserve-and-ack. */
export const RESERVATION_TTL_MS = 30_000

/** Default task claim TTL (30s). Stale claims are reaped by the sweep timer. */
export const CLAIM_TTL_MS = 30_000

const LOCK_POLL_MS = 50
const LOCK_MAX_WAIT_MS = 30_000

/**
 * Heartbeat interval for refreshing a held lock's mtime. Set to LOCK_TTL_MS / 3
 * so a long-running critical section is refreshed up to three times per TTL
 * window and is never misjudged as stale (defect 1 fix). Internal constant.
 */
const LOCK_HEARTBEAT_MS = LOCK_TTL_MS / 3

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Per-team async mutex. Serializes event-handler state mutations within a
 * single process.
 *
 * CRITICAL: the mutex instance MUST be a process-level singleton keyed by
 * teamName (see teamRegistry in store.ts). If loadTeamState returned a fresh
 * object with a fresh mutex each call, concurrent idles would grab different
 * mutexes and serialization would silently break, corrupting state.
 */
export class AsyncMutex {
    private chain: Promise<void> = Promise.resolve()

    /**
     * Run `fn` exclusively. Resolves with fn's result. A rejected run is
     * swallowed from the chain so it does not poison subsequent runs (the
     * caller still receives the rejection).
     */
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(fn, fn)
        this.chain = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }
}

/**
 * Cross-process exclusive file lock built on exclusive-create (fs.open 'wx')
 * with stale-TTL detection. Acquires <lockPath>; if it already exists and is
 * older than LOCK_TTL_MS, unlinks and retries. While the lock is held a
 * heartbeat refreshes its mtime so a long critical section is not reaped as
 * stale (defect 1); release verifies pid ownership before unlinking so a slow
 * holder never deletes another process's lock (defect 2). Used to guard
 * state.json writes and mailbox reservations.
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
    await acquireLock(lockPath)
    // Defect 1 fix: refresh the lock's mtime on a heartbeat so a critical
    // section longer than LOCK_TTL_MS is never misjudged as stale and reaped
    // by another process while we still hold it.
    const heartbeat = setInterval(() => {
        const now = new Date()
        fs.utimes(lockPath, now, now).catch(() => {
            // Lock vanished or refresh raced — release handles ownership.
        })
    }, LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    try {
        return await fn()
    } finally {
        clearInterval(heartbeat)
        await releaseLock(lockPath)
    }
}

async function acquireLock(lockPath: string): Promise<void> {
    await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {
        // parent may already exist
    })
    const deadline = Date.now() + LOCK_MAX_WAIT_MS
    for (;;) {
        try {
            const fh = await fs.open(lockPath, "wx")
            await fh.writeFile(String(process.pid))
            await fh.close()
            return
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code
            if (code !== "EEXIST") throw err
            // Lock exists — check whether it is stale.
            try {
                const stat = await fs.stat(lockPath)
                if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
                    await fs.unlink(lockPath).catch(() => {
                        // raced — another process already reaped it
                    })
                    continue // retry immediately
                }
            } catch {
                // Lock vanished between open and stat — retry.
                continue
            }
            if (Date.now() > deadline) {
                throw new Error(`withLock: timed out acquiring ${lockPath}`)
            }
            await sleep(LOCK_POLL_MS)
        }
    }
}

/**
 * Release a lock previously acquired by this process. Reads the pid recorded in
 * the lock file and unlinks ONLY when it matches the current process: this
 * prevents a slow holder from blindly deleting a lock that another process has
 * already, legitimately, re-acquired (defect 2 fix). A missing or unreadable
 * lock file is treated as already released.
 */
async function releaseLock(lockPath: string): Promise<void> {
    let owner: string
    try {
        owner = await fs.readFile(lockPath, "utf8")
    } catch {
        // Lock file already gone or unreadable — nothing to release.
        return
    }
    if (owner.trim() !== String(process.pid)) {
        // Lock now belongs to another process — must not delete it.
        return
    }
    await fs.unlink(lockPath).catch(() => {
        // Raced with a reaper or another release — already gone.
    })
}

/**
 * Atomic write: content -> <path>.tmp.<pid> then fs.rename to <path>. Prevents
 * partial reads on crash. Ensures the parent directory exists.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {
        // parent may already exist
    })
    const tmp = `${filePath}.tmp.${process.pid}`
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, filePath)
}

/**
 * Append a line to a file (creating it + parent dir if needed). Used for the
 * append-only run event log (events.jsonl). fs.appendFile opens with O_APPEND,
 * so concurrent appends do not corrupt a line; readers sort by timestamp rather
 * than trusting file order.
 */
export async function appendJsonl(filePath: string, line: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {
        // parent may already exist
    })
    await fs.appendFile(filePath, line, "utf8")
}

/**
 * Check whether a lock/claim file is fresh (exists and within TTL). Used by the
 * stale-claim reaper to reconcile claim-lock TTL with Task.status.
 */
export async function lockFresh(
    lockPath: string,
    ttlMs: number = LOCK_TTL_MS,
): Promise<boolean> {
    try {
        const stat = await fs.stat(lockPath)
        return Date.now() - stat.mtimeMs <= ttlMs
    } catch {
        return false
    }
}
