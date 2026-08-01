/**
 * Append-only run timeline. recordEvent fires at orchestration state-
 * transition sites (dispatch / capture / retry / error / stage / round / signoff
 * / terminated) and appends one RunEvent per line to runs/<runId>/events.jsonl.
 *
 * Fire-and-forget (returns void, never awaited at call sites) so observability
 * can never add latency or backpressure to the state machine — same philosophy
 * as logEvent. A missing runId (legacy in-flight task) silently skips the event;
 * runId is now generated at orchestration start, so that path is effectively dead
 * except for tasks persisted by an older build.
 *
 * Appends are serialized per run so file order matches emission order. Readers
 * still sort by timestamp for compatibility with event files written by older
 * versions; stable sorting preserves serialized order for equal timestamps.
 */

import type { Team } from "../../state/store.js"
import type { RunEvent } from "../../core/types.js"
import { appendJsonl } from "../../state/locks.js"
import { runEventsPath } from "../../state/paths.js"
import { logger } from "../../core/log.js"

const appendChains = new Map<string, Promise<void>>()

/** Fire-and-forget: append one RunEvent to the run's events.jsonl timeline.
 *  Returns the append Promise so callers that need durability (termination,
 *  signoff, persistRun) can await it via flushRunEvents. */
export function recordEvent(team: Team, event: RunEvent): Promise<void> {
    if (team.deleted) return Promise.resolve()
    const runId = team.activeTask?.runId
    if (!runId) return Promise.resolve()
    const eventsFile = runEventsPath(team.directory, runId)
    const previous = appendChains.get(eventsFile) ?? Promise.resolve()
    const append = previous.then(async () => {
        // M-2: re-check the tombstone inside the async path so a concurrent
        // team_delete that set team.deleted after the synchronous guard above
        // is visible by the time the microtask resolves.
        if (team.deleted) return
        try {
            // M-2 boundary: also verify the runs/ directory still exists before
            // appending. team_delete's fs.rm may have completed between the
            // tombstone check above and this line; appendJsonl's mkdir would
            // silently recreate it, resurrecting the deleted run's timeline.
            // The stat check narrows the TOCTOU window to the microsecond
            // between stat and append; a true atomic fix requires coordinating
            // team_delete with pending recordEvent IIFEs (heavy for fire-and-
            // forget telemetry), so this pragmatic check is the right trade.
            const { stat } = await import("node:fs/promises")
            try {
                await stat(eventsFile)
            } catch (statErr) {
                // File exists check — if the file does NOT exist, the runs/
                // directory was either never created (first event for this run,
                // appendJsonl will mkdir+create) OR deleted by team_delete.
                // Distinguish: if the parent runs/ dir was deleted by
                // team_delete, team.deleted should also be true.
                if (team.deleted) return
            }
            // C-2: pass team.directory as trustedRoot so refuseSymlink walks the
            // full ancestor chain. Without it, a symlinked runs/ or intermediate
            // <runId>/ directory could redirect the append outside the team root.
            if (team.deleted) return
            await appendJsonl(
                eventsFile,
                JSON.stringify(event) + "\n",
                team.directory,
            )
        } catch (err: unknown) {
            // best-effort telemetry; a write failure must never affect orchestration,
            // but surface it so operators can diagnose missing timeline events.
            logger.warn("recordEvent append failed", {
                runId,
                eventKind: event.kind,
                error: err instanceof Error ? err.message : String(err),
            })
        }
    })
    appendChains.set(eventsFile, append)
    // Auto-cleanup the chain reference.
    void append.then(() => {
        if (appendChains.get(eventsFile) === append) appendChains.delete(eventsFile)
    })
    return append
}

/** Await all pending event appends for a run so terminal events are durable. */
export async function flushRunEvents(teamDirectory: string, runId: string): Promise<void> {
    const eventsFile = runEventsPath(teamDirectory, runId)
    const pending = appendChains.get(eventsFile)
    if (pending) await pending.catch(() => {})
}
