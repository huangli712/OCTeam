/**
 * Regression test for confirmed finding "task-schema-guard-incomplete".
 *
 * Bug: src/state/tasks.ts:94-102 — isValidTask validates only that id, subject,
 * and status are strings. It does NOT validate that `blockedBy` is an array.
 * But callers dereference it as an array:
 *   - delegate.ts:62: t.blockedBy.every(id => ...)
 *   - updateTask (tasks.ts:207): Object.assign with patch
 *   - listAllTasks returns tasks that downstream code iterates over
 *
 * A corrupt or hand-edited tasks/{id}.json with `blockedBy` as a string,
 * number, null, or missing entirely passes isValidTask (id/subject/status are
 * fine), gets cast to Task, and propagates to delegate.ts:62 where
 * `.every(...)` throws TypeError (string/number has no .every) or crashes on
 * undefined. This wedges delegate orchestration.
 *
 * Fix: isValidTask must also validate that `blockedBy` is an Array when present
 * (and ideally that it contains only strings), rejecting corrupt entries at
 * the read boundary so readTaskFile returns null (the not-found path).
 *
 * This test writes a corrupt task file with blockedBy as a non-array (string),
 * loads it via listAllTasks, and asserts it is REJECTED (filtered out). On
 * UNFIXED code the task passes the guard, is returned, and a downstream
 * `.every(...)` call throws → test FAILS. On FIXED code the corrupt task is
 * rejected → listAllTasks skips it → no crash → test PASSES.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { listAllTasks } from "../src/state/tasks.js"
import { taskPath } from "../src/state/paths.js"
import { tmpRoot } from "./helpers.js"

/** Ensure the tasks/ dir exists, then write a task JSON file. */
async function writeTaskFile(teamDir: string, taskId: string, obj: unknown): Promise<void> {
    const p = taskPath(teamDir, taskId)
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(obj, null, 2), "utf8")
}

afterAll(() => {
    // tmpRoot cleanup is process-global; nothing extra here.
})

describe("task schema guard incomplete (finding: task-schema-guard-incomplete)", () => {
    test("a corrupt task with non-array blockedBy must be rejected by isValidTask, not crash callers", async () => {
        const teamDir = tmpRoot("task-schema-guard")

        // --- Write a corrupt task file: valid id/subject/status, but
        //     blockedBy is a STRING (not an array). This passes the current
        //     isValidTask guard (which checks id/subject/status only). ---
        const corruptId = "12345678-1234-1234-1234-123456789abc"
        const corruptTask = {
            version: 1,
            id: corruptId,
            subject: "corrupt-task",
            description: "desc",
            status: "pending",
            owner: undefined,
            blockedBy: "not-an-array-but-a-string",  // ← the corruption
            createdAt: Date.now(),
            updatedAt: Date.now(),
            depth: 0,
        }
        await writeTaskFile(teamDir, corruptId, corruptTask)

        // Also write one valid task so listAllTasks has a known-good entry.
        const validId = "87654321-4321-4321-4321-cba987654321"
        const validTask = {
            version: 1,
            id: validId,
            subject: "valid-task",
            description: "desc",
            status: "pending",
            owner: undefined,
            blockedBy: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            depth: 0,
        }
        await writeTaskFile(teamDir, validId, validTask)

        // --- Load tasks. On UNFIXED code, the corrupt task passes isValidTask
        //     and is returned. On FIXED code, it is rejected (skipped). ---
        const tasks = await listAllTasks(teamDir)

        // --- ASSERT: the corrupt task must NOT appear in the list ---
        // On UNFIXED code: isValidTask passes (blockedBy not checked) → corrupt
        // task is included → FAIL.
        // On FIXED code: isValidTask rejects (blockedBy not an array) → corrupt
        // task skipped → only the valid task appears → PASS.
        const corruptInList = tasks.some(t => t.id === corruptId)
        expect(corruptInList).toBe(false)

        // The valid task should always be present (control).
        expect(tasks.some(t => t.id === validId)).toBe(true)
    })

    test("downstream harm: a corrupt task passing the guard crashes delegate's blockedBy.every(...)", async () => {
        // Demonstrates the crash that the incomplete guard allows. We simulate
        // exactly what delegate.ts:58-62 does with a corrupt blockedBy.
        const teamDir = tmpRoot("task-schema-harm")

        const corruptId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        const corruptTask = {
            version: 1,
            id: corruptId,
            subject: "crash-task",
            description: "desc",
            status: "pending",
            blockedBy: 42,  // ← number, has no .every
            createdAt: Date.now(),
            updatedAt: Date.now(),
            depth: 0,
        }
        await writeTaskFile(teamDir, corruptId, corruptTask)

        const tasks = await listAllTasks(teamDir)

        // On UNFIXED code: the corrupt task is in the list. Calling
        // delegate.ts:62's predicate on it crashes (TypeError).
        const corrupt = tasks.find(t => t.id === corruptId)
        if (corrupt) {
            // This is the exact predicate from delegate.ts:59-62:
            //   t.blockedBy.every(id => tasks.find(x => x.id === id)?.status === "completed")
            // blockedBy is 42 (a number) → (42).every is undefined → calling it
            // throws TypeError. delegate.ts does NOT use optional chaining.
            expect(() => {
                ;(corrupt.blockedBy as unknown as { every: (fn: (id: string) => boolean) => boolean }).every(
                    (id: string) => tasks.find(x => x.id === id)?.status === "completed",
                )
            }).toThrow()
        }

        // On FIXED code: corrupt task is rejected → corrupt is undefined →
        // the if-block is skipped → no crash. The assertion above only runs
        // when the guard is incomplete (bug present), proving the crash path.
        // When fixed, corrupt === undefined and this passes trivially.
        if (!corrupt) {
            expect(corrupt).toBeUndefined()
        }
    })
})
