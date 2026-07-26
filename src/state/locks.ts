/**
 * File-system locking, atomic writes, and inter-process synchronization
 * primitives.
 */

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { logger } from "../core/log.js"
import { isEnoent } from '../core/utils.js';

/** Default stale-lock age threshold and heartbeat basis (30s). */
export const LOCK_TTL_MS = 30_000

/** Default mailbox reservation TTL (30s). Covers crash-between-reserve-and-ack. */
export const RESERVATION_TTL_MS = 30_000

/** Default task claim TTL (30s). Stale claims are reaped by the sweep timer. */
export const CLAIM_TTL_MS = 30_000

/** Poll interval (50ms) between lock acquisition retries. */
const LOCK_POLL_MS = 50
/** Maximum time (30s) to wait for lock acquisition before timing out. */
const LOCK_MAX_WAIT_MS = 30_000

/**
 * Heartbeat interval for refreshing a held lock's mtime. Set to LOCK_TTL_MS / 3
 * so a long-running critical section refreshes its lock metadata up to three
 * times per TTL window. Internal constant.
 */
const LOCK_HEARTBEAT_MS = LOCK_TTL_MS / 3

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

/** Promise-based delay. */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Best-effort fsync of a directory's entries. Used by atomicWrite after rename
 * so the directory-entry change is durable across an OS crash (file content is
 * already fsync'd). Some platforms/filesystems don't support opening a dir for
 * fsync; errors are swallowed.
 */
async function fsyncDir(dir: string): Promise<void> {
    try {
        const dirFd = await fs.open(dir, "r")
        try {
            await dirFd.sync()
        } finally {
            await dirFd.close().catch(() => {})
        }
    } catch {
        // best-effort: dir fsync unsupported or dir missing
    }
}

/**
 * Cross-process exclusive file lock built on exclusive-create (fs.open 'wx').
 * An existing lock is never unlinked by a waiter because stat/read/unlink cannot
 * identify one lock generation atomically. Waiters poll until release or timeout.
 * While held, a heartbeat refreshes mtime; release verifies pid ownership before
 * unlinking. Used to guard state.json writes and mailbox reservations.
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
    await acquireLock(lockPath)
    // Keep the held lock's metadata current for diagnostics and consumers.
    const heartbeat = setInterval(() => {
        const now = new Date()
        fs.utimes(lockPath, now, now).catch((err) => {
            if (isEnoent(err)) return // lock vanished or refresh raced — release() handles ownership cleanup
            // Non-vanish errors are best-effort. Exclusive-create correctness
            // does not depend on mtime because waiters never unlink held locks.
        })
    }, LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    try {
        return await fn()
    } finally {
        clearInterval(heartbeat)
        // releaseLock failure after fn() completed must NOT propagate: the
        // caller would misinterpret a release error as a work failure and
        // roll back in-memory state that correctly matches disk. The stale-
        // lock reaper (LOCK_TTL_MS) will eventually clean up a stuck lock.
        try {
            await releaseLock(lockPath)
        } catch (err) {
            logger.warn("withLock: failed to release lock after fn() completed; stale-lock reaper will recover", {
                lockPath,
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }
}

/**
 * Pure stale-lock policy helper retained for callers and direct tests. acquireLock
 * deliberately does not use it: deciding from stat/read and then unlinking has a
 * TOCTOU window in which a waiter can delete a newer lock generation.
 */
export function shouldReapStaleLock(
    mtimeMs: number,
    now: number,
    ttl: number,
    ownerAlive: boolean,
): boolean {
    return now - mtimeMs > ttl && !ownerAlive
}

/**
 * Cross-process lock acquisition via exclusive-create (fs.open "wx").
 * Spins with polling until the lock is acquired or LOCK_MAX_WAIT_MS elapses.
 * Writes the current PID into the lock file for ownership tracking.
 */
async function acquireLock(lockPath: string): Promise<void> {
    await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch((err: unknown) => {
        // EEXIST is benign (parent already exists); any other errno
        // (EACCES, ENOSPC, EROFS) is a real failure that the open("wx")
        // below would also hit — let it surface with the real root cause.
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "EEXIST") throw err
    })
    const deadline = Date.now() + LOCK_MAX_WAIT_MS
    for (;;) {
        try {
            const fh = await fs.open(lockPath, "wx")
            try {
                await fh.writeFile(String(process.pid))
            } catch (err) {
                // The creator removes its incomplete lock so later callers do
                // not wait until the acquisition timeout.
                await fs.unlink(lockPath).catch(() => { /* best-effort */ })
                throw err
            } finally {
                await fh.close()
            }
            return
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code
            if (code !== "EEXIST") throw err
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
    await fs.unlink(lockPath).catch((err: unknown) => {
        // ENOENT is the benign race (manual cleanup or another release won).
        // Any other errno (EPERM, EBUSY, EROFS, ...) is a real release failure
        // that would leave a fresh live-owner lock wedging the next caller for
        // LOCK_MAX_WAIT_MS; surface it through withLock's finally.
        if (!isEnoent(err)) throw err
    })
}

/**
 * Atomic write: content -> <path>.tmp.<pid>.<rand> then fs.rename to <path>.
 * Prevents partial reads on crash. Ensures the parent directory exists.
 *
 * Hardening:
 * - st-tmpname: tmp name carries a random suffix so concurrent writes from
 *   the same process (same pid) cannot collide on the same tmp path.
 * - st-fsync: tmp data is fsync'd to disk before the rename lands, so an OS
 *   crash after rename cannot leave a zero-byte or stale state file.
 * - st-symlink: a symlink at the target path is refused, so a local attacker
 *   with FS write access cannot silently redirect the write elsewhere.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "EEXIST") throw err
    })

    // st-symlink: refuse to overwrite a symlink so the write cannot be
    // redirected to an unexpected location. lstat does not follow links, so
    // a symlink is reported as-is rather than its target.
    try {
        const stat = await fs.lstat(filePath)
        if (stat.isSymbolicLink()) {
            throw new Error(`atomicWrite: refusing to write through symlink: ${filePath}`)
        }
    } catch (err: unknown) {
        if (!isEnoent(err)) throw err
        // Target does not exist yet — safe to proceed.
    }

    // st-tmpname: random suffix prevents same-process tmp collisions.
    const rand = crypto.randomBytes(4).toString("hex")
    const tmp = `${filePath}.tmp.${process.pid}.${rand}`

    // st-fsync: open the tmp file explicitly so we can fsync its data before
    // rename, guaranteeing the bytes are on disk when the rename lands. The
    // tmp file is cleaned up on any write/fsync failure.
    const fh = await fs.open(tmp, "w")
    try {
        await fh.writeFile(content, "utf8")
        await fh.sync()
    } catch (err) {
        await fs.unlink(tmp).catch(() => {
            // best-effort cleanup of a partial tmp file
        })
        throw err
    } finally {
        await fh.close().catch(() => {
            // best-effort close even on failure
        })
    }

    try {
        await fs.rename(tmp, filePath)
        // st-dirfsync: persist the directory-entry change so an OS crash after
        // rename cannot lose the new file (content is already durable above).
        await fsyncDir(path.dirname(filePath))
    } catch (err) {
        await fs.unlink(tmp).catch(() => {
            // best-effort cleanup of a leftover tmp file on rename failure
        })
        throw err
    }
}

/**
 * Refuse to write through a symlink (defense-in-depth against symlink
 * redirection on a hostile .octeam/). A no-op when the path does not exist yet
 * or is a regular file. Mirrors the lstat guard inside atomicWrite so that
 * appendJsonl / truncateFile callers are not exploitable as symlink-following
 * sinks (atomicWrite already refuses symlinks, but fs.appendFile/writeFile
 * follow them by default).
 */
export async function refuseSymlink(filePath: string): Promise<void> {
    // Check both the target file and its immediate parent directory.
    // The parent-dir check prevents the common attack of symlinking the
    // containing directory to redirect writes outside the team root.
    for (const p of [filePath, path.dirname(filePath)]) {
        try {
            const stat = await fs.lstat(p)
            if (stat.isSymbolicLink()) {
                throw new Error(`refuseSymlink: refusing to write through symlink: ${p}`)
            }
        } catch (err: unknown) {
            if (!isEnoent(err)) throw err
        }
    }
}

/**
 * Append a line to a file (creating it + parent dir if needed). Used for the
 * append-only run event log (events.jsonl). fs.appendFile opens with O_APPEND,
 * so concurrent appends do not corrupt a line; readers sort by timestamp rather
 * than trusting file order.
 */
export async function appendJsonl(filePath: string, line: string): Promise<void> {
    await refuseSymlink(filePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "EEXIST") throw err
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
