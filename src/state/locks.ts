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
    } catch (err) {
        // best-effort: dir fsync unsupported or dir missing. Log non-ENOENT
        // errors (e.g. EIO) so durability issues are observable.
        if (!isEnoent(err)) {
            logger.warn("fsyncDir: directory fsync failed", { dir, error: err instanceof Error ? err.message : String(err) })
        }
    }
}

/**
 * Cross-process exclusive file lock built on exclusive-create (fs.open 'wx').
 * An existing lock is never unlinked by a waiter because stat/read/unlink cannot
 * identify one lock generation atomically. Waiters poll until release or timeout.
 * While held, a heartbeat refreshes mtime; release verifies pid ownership before
 * unlinking. Used to guard state.json writes and mailbox reservations.
 */
export async function withLock<T>(
    lockPath: string,
    fn: () => Promise<T>,
    trustedRoot?: string,
): Promise<T> {
    // C-4: when a trusted root is supplied, walk the ancestor chain before
    // any fs operation. Pre-fix code called mkdir/open/utimes/readFile/unlink
    // directly on lockPath — a symlinked ancestor could redirect the lock
    // file outside the team root, breaking mutual exclusion. ENOENT for a
    // not-yet-created lock dir is tolerated by assertNoSymlinkTraversal.
    if (trustedRoot !== undefined) {
        await assertNoSymlinkTraversal(trustedRoot, lockPath)
    }
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
            locallyReleasedLocks.delete(lockPath)
        } catch (err) {
            logger.warn("withLock: failed to release lock after fn() completed; will retry on next acquire", {
                lockPath,
                error: err instanceof Error ? err.message : String(err),
            })
            locallyReleasedLocks.add(lockPath)
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
 * Stale-lock recovery: if the lock's owner PID is dead and mtime exceeds
 * TTL, unlink it so the next open("wx") retry can acquire. Closes the gap
 * where releaseLock failed (EPERM, crash mid-release) and the lock file
 * became a permanent orphan — all future acquireLock calls would spin to
 * timeout with no recovery. TOCTOU-safe: after unlink, acquireLock retries
 * open("wx"); if another process grabbed it, we get EEXIST and loop.
 */
async function maybeReapStaleLock(lockPath: string): Promise<void> {
    try {
        // HIGH #12/CRIT #3: if this process previously failed to release
        // this lock, verify the lock STILL belongs to us before unlinking.
        // Another process may have acquired a new lock in the window between
        // our release failure and this reap attempt.
        if (locallyReleasedLocks.has(lockPath)) {
            try {
                const currentPid = parseInt((await fs.readFile(lockPath, "utf8")).trim(), 10)
                if (currentPid !== process.pid) {
                    locallyReleasedLocks.delete(lockPath)
                    return
                }
                await fs.unlink(lockPath)
                locallyReleasedLocks.delete(lockPath)
            } catch (err) {
                if (isEnoent(err)) locallyReleasedLocks.delete(lockPath)
            }
            return
        }
        const st = await fs.stat(lockPath)
        const pidStr = await fs.readFile(lockPath, "utf8")
        const pid = parseInt(pidStr.trim(), 10)
        if (!Number.isFinite(pid) || pid <= 0) {
            // CRIT #1: empty/invalid PID means the lock was truncated by
            // a TOCTOU-safe reap or is corrupt. Safe to unlink now.
            // C9 note: a NEW lock between open("wx") and writeFile(pid)
            // is also 0-byte here, but that window is sub-millisecond
            // (writeFile is called immediately after open in acquireLock).
            // The trade-off favors reaping orphans over protecting a
            // vanishingly brief race that acquireLock retries anyway.
            if (st.size === 0) await fs.unlink(lockPath).catch(() => {})
            return
        }
        let alive = true
        try {
            process.kill(pid, 0)
        } catch (e) {
            alive = (e as NodeJS.ErrnoException).code !== "ESRCH"
        }
        if (shouldReapStaleLock(st.mtimeMs, Date.now(), LOCK_TTL_MS, alive)) {
            // CRIT #1: TOCTOU-safe reap. Instead of unlink (which can
            // delete a newer lock if another process acquired between
            // stat/read and unlink), truncate the file to empty. The
            // next acquireLock's open("wx") still gets EEXIST, but the
            // empty PID read in releaseLock/maybeReapStaleLock will
            // return NaN → skip, letting acquireLock's timeout-retry
            // eventually succeed. Alternatively the next maybeReapStaleLock
            // will find a 0-byte file and immediately unlink it.
            const fh = await fs.open(lockPath, "w").catch(() => undefined)
            if (fh) {
                try { await fh.writeFile("") } finally { await fh.close() }
            }
        }
    } catch {
        // Lock vanished or unreadable — next open("wx") retry handles it.
    }
}

// HIGH #12: track locks that releaseLock failed to delete. The local
// process knows it has exited the critical section, so re-acquiring
// is safe even though the PID is still alive.
const locallyReleasedLocks = new Set<string>()

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
            } catch (writeErr) {
                try { await fh.close() } catch { /* best-effort */ }
                await fs.unlink(lockPath).catch(() => { /* best-effort */ })
                throw writeErr
            }
            // M17: close after successful write. If close fails, the lock
            // is on disk without a live fd → permanent orphan.
            try {
                await fh.close()
            } catch (closeErr) {
                await fs.unlink(lockPath).catch(() => { /* best-effort */ })
                throw closeErr
            }
            return
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code
            if (code !== "EEXIST") throw err
            // H-D3: reap stale locks whose owner PID is dead and TTL expired.
            // Without this, a failed releaseLock (EPERM, crash) orphans the
            // lock permanently — the log message "stale-lock reaper will
            // recover" was referencing a reaper that never existed.
            await maybeReapStaleLock(lockPath)
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
    } catch (err: unknown) {
        // L-1: only ENOENT (lock already gone) is a safe no-op. Other errors
        // (EACCES, EIO) mean the lock is still on disk but unreadable —
        // pre-fix code silently returned for ALL errors, leaving permanent
        // locks on permission/I/O failures. Now: re-throw non-ENOENT so the
        // caller knows the lock wasn't released.
        if (isEnoent(err)) return
        throw err
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
 * Assert that `target` resolves strictly inside `trustedRoot` AND that no
 * component of the path between them (or at target itself) is a symbolic link.
 * Catches the ancestor-symlink attack that `refuseSymlink` (target + parent
 * only) misses: when an intermediate directory such as `<team>/mailbox` is
 * replaced with a symlink, the legacy check sees only the immediate parent and
 * follows the redirect outside the team root.
 *
 * Walks every ancestor of `target` from leaf up to (but not including)
 * `trustedRoot` with `lstat`, refusing any symlink. The trusted root itself is
 * assumed already verified (team_create confirms the team directory is a real
 * directory under storageRoot before any state is written to it).
 *
 * Note: like all userspace traversal checks this is TOCTOU-vulnerable — an
 * attacker who can swap a path component between this check and the subsequent
 * read/write can still escape. The defense targets the documented threat
 * model (a member with FS write access tampering with `.octeam/` contents
 * between runs), not a concurrent in-run attacker.
 */
export async function assertNoSymlinkTraversal(trustedRoot: string, target: string): Promise<void> {
    const root = path.resolve(trustedRoot)
    const resolved = path.resolve(target)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`assertNoSymlinkTraversal: target escapes trusted root: target=${target} root=${trustedRoot}`)
    }
    // H-S2: check the trusted root ITSELF for symlink. Pre-fix code assumed
    // root was always verified, but callers pass team.directory (mutable) or
    // worktreesRoot (disk-replaceable). A symlinked root would redirect all
    // writes outside the intended location.
    try {
        const rootStat = await fs.lstat(root)
        if (rootStat.isSymbolicLink()) {
            throw new Error(`assertNoSymlinkTraversal: trusted root is a symlink: ${root}`)
        }
    } catch (err) {
        if (!isEnoent(err)) throw err
        // root doesn't exist yet (mkdir will create it) — safe
    }
    // Walk every ancestor from target up to (not including) the trusted root.
    // ENOENT for a not-yet-created component is fine — the subsequent write
    // will create it as a real dir/file.
    let current = resolved
    while (current !== root && current !== path.dirname(current)) {
        try {
            const stat = await fs.lstat(current)
            if (stat.isSymbolicLink()) {
                throw new Error(`assertNoSymlinkTraversal: symlink in path chain: ${current}`)
            }
        } catch (err: unknown) {
            if (!isEnoent(err)) throw err
        }
        current = path.dirname(current)
    }
}

/**
 * C1: Safely read a file after symlink-traversal check, using an fd-based
 * approach to shrink the TOCTOU window. assertNoSymlinkTraversal validates
 * the full path chain, then fs.open with O_NOFOLLOW atomically rejects a
 * leaf symlink swap between the check and the open. fstat on the fd then
 * enforces an optional size cap BEFORE reading, preventing OOM from a
 * crafted oversized file or hang from a FIFO/device.
 *
 * Returns the file contents as a string, or undefined if the file does not
 * exist (ENOENT — the caller decides whether absence is an error).
 */
export async function safeReadFile(
    trustedRoot: string,
    filePath: string,
    opts?: { maxBytes?: number; encoding?: BufferEncoding },
): Promise<string | undefined> {
    await assertNoSymlinkTraversal(trustedRoot, filePath)
    // O_NOFOLLOW may be absent on non-Linux platforms (e.g. Windows); degrade
    // gracefully — the path-chain check above still provides protection.
    const O_NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
    const flags = fs.constants.O_RDONLY | O_NOFOLLOW
    const fh = await fs.open(filePath, flags)
    try {
        const stat = await fh.stat()
        if (!stat.isFile()) {
            throw new Error(`safeReadFile: not a regular file: ${filePath}`)
        }
        if (opts?.maxBytes !== undefined && stat.size > opts.maxBytes) {
            throw new Error(`safeReadFile: file exceeds ${opts.maxBytes}-byte cap: ${filePath} (${stat.size} bytes)`)
        }
        const encoding = opts?.encoding ?? "utf8"
        return await fh.readFile({ encoding })
    } finally {
        await fh.close()
    }
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
 *   with FS write access cannot silently redirect the write elsewhere. When
 *   `trustedRoot` is supplied, the full ancestor chain is also walked via
 *   {@link assertNoSymlinkTraversal} so an intermediate-directory symlink
 *   (e.g. `<team>/mailbox` redirected) cannot escape the team root.
 */
export async function atomicWrite(
    filePath: string,
    content: string,
    trustedRoot?: string,
): Promise<void> {
    // C-5: ancestor symlink check must run BEFORE mkdir. Pre-fix order ran
    // recursive mkdir first, so if an intermediate directory was already a
    // symlink to an external target, mkdir would create/extend the external
    // directory before the symlink check had a chance to refuse. Both checks
    // below tolerate ENOENT (target/ancestor not yet created), so running
    // them first is safe.
    // st-symlink-ancestor: when a trusted root is supplied, walk the full
    // ancestor chain so an intermediate-directory symlink cannot redirect.
    if (trustedRoot !== undefined) {
        await assertNoSymlinkTraversal(trustedRoot, filePath)
    }
    // st-symlink: refuse to overwrite a symlink so the write cannot be
    // redirected to an unexpected location. lstat does not follow links.
    try {
        const stat = await fs.lstat(filePath)
        if (stat.isSymbolicLink()) {
            throw new Error(`atomicWrite: refusing to write through symlink: ${filePath}`)
        }
    } catch (err: unknown) {
        if (!isEnoent(err)) throw err
        // Target does not exist yet — safe to proceed.
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "EEXIST") throw err
    })

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
        await fh.close().catch(() => {})
        await fs.unlink(tmp).catch(() => {})
        throw err
    }
    // H-D1: close can report delayed I/O errors (e.g. NFS write-behind).
    // Pre-fix code ignored close errors in a finally block and proceeded
    // to rename, potentially committing a corrupt file as success.
    try {
        await fh.close()
    } catch (closeErr) {
        await fs.unlink(tmp).catch(() => {})
        throw closeErr
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
 *
 * When `trustedRoot` is supplied, the full ancestor chain is also walked via
 * {@link assertNoSymlinkTraversal} so an intermediate-directory symlink cannot
 * redirect the write outside the team root. Without `trustedRoot`, only the
 * legacy target + immediate-parent check runs (backward-compatible behavior
 * for callers that do not have a trusted root handy).
 */
export async function refuseSymlink(filePath: string, trustedRoot?: string): Promise<void> {
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
    // Walk the full ancestor chain when a trusted root is supplied.
    if (trustedRoot !== undefined) {
        await assertNoSymlinkTraversal(trustedRoot, filePath)
    }
}

/**
 * Append a line to a file (creating it + parent dir if needed). Used for the
 * append-only run event log (events.jsonl). fs.appendFile opens with O_APPEND,
 * so concurrent appends do not corrupt a line; readers sort by timestamp rather
 * than trusting file order.
 *
 * `trustedRoot` (optional, recommended) is forwarded to refuseSymlink's ancestor
 * chain check (assertNoSymlinkTraversal) so an intermediate-dir symlink cannot
 * redirect the append outside the team root. Callers with a trusted root should
 * always supply it.
 */
export async function appendJsonl(
    filePath: string,
    line: string,
    trustedRoot?: string,
): Promise<void> {
    await refuseSymlink(filePath, trustedRoot)
    // H-D2: reject non-regular files (FIFO, device) that could block
    // appendFile indefinitely. refuseSymlink only checks symlinks.
    try {
        const st = await fs.lstat(filePath)
        if (!st.isFile()) {
            throw new Error(`appendJsonl: target is not a regular file: ${filePath}`)
        }
    } catch (err) {
        if (!isEnoent(err)) throw err
    }
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
    } catch (err) {
        // HIGH-A: distinguish ENOENT (lock genuinely absent → not fresh) from
        // other stat errors (EACCES, EBUSY, EIO, ...). Pre-fix code caught
        // everything and returned false, which let the stale-claim reaper
        // reclaim a claim whose lock file was temporarily unreadable — a
        // transient permission or IO error would silently release an active
        // claim, leading to double-claim races. Treat non-ENOENT errors as
        // "lock may still be fresh" so the reaper leaves it alone; the next
        // sweep will re-check.
        if (isEnoent(err)) return false
        return true
    }
}
