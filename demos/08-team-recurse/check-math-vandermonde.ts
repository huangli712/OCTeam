/**
 * Check script: Vandermonde identity multi-layer proof (challenge-level, 6 members, depth 4).
 *
 * team_recurse spreads output across the shared task list, per-member .md
 * reports, AND member-to-member messages (team_send_message → mailbox/*.jsonl).
 * This script reads ALL member markdowns in <run_dir>/ PLUS all messages in
 * <team_dir>/mailbox/ (resolved as ../../ relative to run_dir) and verifies:
 *   1. The decomposer (alice) emitted the root aggregation marker
 *      <!-- VANDERMONDE_PROVEN: true -->.
 *   2. Across all leaf sub-tasks, at least 2 distinct <!-- APPROACH: <name> -->
 *      markers appear, and both "algebraic" and "combinatorial" are present
 *      (independent proof paths converged).
 *   3. Every <!-- LEMMA_HOLDS: <bool> --> marker that appears is "true"
 *      (no leaf disproved its lemma).
 *   4. Run terminal state: <run_dir>/record.json status === "completed"
 *      (guards against shallow passes on failed/stalled runs).
 *   5. Tree shape: the root task (depth 0) has >= 2 depth-1 subtasks and is
 *      completed — real recursive decomposition happened (guards against
 *      degenerate direct-solve completions).
 *   6. Participation: >= 3 distinct members produced substantive output
 *      (>= 200 chars) — guards against single-member pseudo-collaboration.
 *
 * Usage:  bun check-math-vandermonde.ts <run_dir>
 *   <run_dir>  directory containing the per-member markdown outputs
 *             (expects alice.md as the decomposer, plus bob/carol/dave/erin/
 *              frank.md as solver members distributed across three proof paths).
 *             Also scans <team_dir>/mailbox/*.jsonl for markers sent via
 *             team_send_message but not present in captured .md turns.
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Decomposer member (set in the team_create config above). The root aggregator.
const DECOMPOSER = "alice";

// Non-global: single root-aggregation marker on the decomposer.
const VANDERMONDE_RE = /<!--\s*VANDERMONDE_PROVEN:\s*(true|false)\s*-->/;
// Global: many leaf markers may appear across all member reports.
const APPROACH_RE = /<!--\s*APPROACH:\s*([A-Za-z0-9_-]+)\s*-->/g;
const LEMMA_RE = /<!--\s*LEMMA_HOLDS:\s*(true|false)\s*-->/g;

// Minimum-required distinct proof paths; algebraic + combinatorial must be among them.
const REQUIRED_APPROACHES = ["algebraic", "combinatorial"];

// Vocabulary normalization for APPROACH values: members drift between
// synonyms and separator styles (generating_function, double-counting, ...).
// Fold natural variants onto the canonical enum before membership checks.
const APPROACH_ALIASES: Record<string, string> = {
    "generating": "generating-function",
    "gf": "generating-function",
    "generatingfunction": "generating-function",
    "double-counting": "combinatorial",
    "double-count": "combinatorial",
    "bijective": "combinatorial",
    "counting": "combinatorial",
};

function normalizeApproach(raw: string): string {
    const folded = raw.toLowerCase().replace(/[_\s]+/g, "-");
    return APPROACH_ALIASES[folded] ?? folded;
}

interface MemberDoc {
    name: string; // markdown basename without extension
    raw: string;
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function loadAllMarkdown(runDir: string): Promise<MemberDoc[]> {
    let entries: string[];
    try {
        entries = await readdir(runDir);
    } catch (err) {
        console.error(`IO error reading run_dir "${runDir}": ${(err as Error).message}`);
        process.exit(2);
    }
    const docs: MemberDoc[] = [];
    for (const entry of entries.filter(e => e.endsWith(".md"))) {
        const raw = await readFile(join(runDir, entry), "utf8");
        docs.push({ name: entry.replace(/\.md$/, ""), raw });
    }
    return docs;
}

/**
 * Recurse members often deliver markers via team_send_message rather than in
 * their captured .md turn output. Each mailbox/*.jsonl line is a JSON message
 * with `from` (sender) and `body` (content). This aggregates all message
 * bodies by sender into pseudo MemberDocs so those markers are not missed.
 */
async function loadMailboxMessages(teamDir: string): Promise<MemberDoc[]> {
    const mailboxDir = join(teamDir, "mailbox");
    let entries: string[];
    try {
        entries = await readdir(mailboxDir);
    } catch {
        return []; // no mailbox dir (parallel/other modes) — nothing to merge
    }
    const bySender = new Map<string, string>();
    for (const entry of entries.filter(e => e.endsWith(".jsonl"))) {
        const raw = await readFile(join(mailboxDir, entry), "utf8");
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const msg = JSON.parse(trimmed);
                if (typeof msg.from === "string" && typeof msg.body === "string") {
                    bySender.set(msg.from, (bySender.get(msg.from) ?? "") + "\n" + msg.body);
                }
            } catch {
                // skip malformed JSONL lines
            }
        }
    }
    return Array.from(bySender.entries()).map(([name, raw]) => ({ name, raw }));
}

/** Extract every capture group 1 from a (possibly global) regex against `raw`. */
function collectMatches(raw: string, re: RegExp): string[] {
    const out: string[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        out.push(m[1]);
    }
    return out;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-vandermonde.ts <run_dir>");
        process.exit(2);
    }

    let docs: MemberDoc[];
    try {
        docs = await loadAllMarkdown(runDir);
    } catch (err) {
        console.error(`IO error reading member output: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 4 (terminal state): the run itself must have completed.
    // A shallow pass (markers present but run failed/stalled) is not a pass.
    const teamDir = resolve(runDir, "../..");  // also used for mailbox below
    try {
        const recordRaw = await readFile(join(runDir, "record.json"), "utf8");
        const record = JSON.parse(recordRaw) as { status?: string; reason?: string };
        console.log(`  run terminal state: status=${record.status ?? "?"} reason=${record.reason ?? "?"}`);
        if (record.status !== "completed") {
            fail(`run did not complete (status=${String(record.status)}, reason=${String(record.reason)})`);
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            fail(`record.json not found in "${runDir}" — cannot verify run terminal state`);
        }
        fail(`could not parse record.json in "${runDir}"`);
    }

    // Assertion 5 (tree shape): read the team's task files and verify the
    // root (depth 0) has >= 2 depth-1 subtasks and is completed. A completed
    // root with no depth-1 children is a degenerate direct-solve.
    interface TaskShape { id: string; status: string; depth: number; subject: string }
    try {
        const tasksDir = join(teamDir, "tasks");
        const taskFiles = (await readdir(tasksDir)).filter(e => e.endsWith(".json"));
        const taskShapes: TaskShape[] = [];
        for (const f of taskFiles) {
            try {
                const t = JSON.parse(await readFile(join(tasksDir, f), "utf8")) as Partial<TaskShape>;
                if (typeof t.id === "string" && typeof t.status === "string") {
                    taskShapes.push({
                        id: t.id,
                        status: t.status,
                        depth: typeof t.depth === "number" ? t.depth : 0,
                        subject: typeof t.subject === "string" ? t.subject : "",
                    });
                }
            } catch {
                // skip unparsable task files
            }
        }
        const roots = taskShapes.filter(t => t.depth === 0);
        if (roots.length === 0) {
            fail(`no root (depth 0) task found in "${tasksDir}" — cannot verify decomposition`);
        }
        const depthOne = taskShapes.filter(t => t.depth === 1 && t.status !== "deleted");
        console.log(`  task tree: root=${roots[0]!.status}, depth-1 subtasks=${depthOne.length}`);
        if (depthOne.length < 2) {
            fail(`root has only ${depthOne.length} depth-1 subtask(s); real decomposition requires >= 2`);
        }
        if (!roots.every(r => r.status === "completed")) {
            fail(`root task(s) not completed: ${roots.map(r => r.status).join(", ")}`);
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            fail(`tasks directory not found under "${teamDir}" — cannot verify tree shape`);
        }
        fail(`could not verify tree shape: ${(err as Error).message}`);
    }

    // Merge mailbox messages: recurse members deliver markers via
    // team_send_message, which land in <team_dir>/mailbox/*.jsonl —
    // not always in the captured .md turn output.
    try {
        const mailboxDocs = await loadMailboxMessages(teamDir);
        for (const md of mailboxDocs) {
            const existing = docs.find(d => d.name === md.name);
            if (existing) {
                existing.raw += "\n" + md.raw;
            } else {
                docs.push(md);
            }
        }
    } catch {
        // mailbox is best-effort; .md files are the primary source
    }

    if (docs.length === 0) {
        fail(`no member markdown files found in "${runDir}"`);
    }

    // Assertion 1: the decomposer's report carries the root aggregation marker.
    const decomposer = docs.find(d => d.name === DECOMPOSER);
    if (!decomposer) {
        fail(`decomposer member "${DECOMPOSER}.md" not found in "${runDir}"`);
    }
    const provenMatch = decomposer!.raw.match(VANDERMONDE_RE);
    if (!provenMatch) {
        fail(`decomposer "${DECOMPOSER}" did not emit a <!-- VANDERMONDE_PROVEN: ... --> marker`);
    }
    console.log(`  ${DECOMPOSER} (decomposer): VANDERMONDE_PROVEN = ${provenMatch![1]}`);
    if (provenMatch![1] !== "true") {
        fail(`decomposer VANDERMONDE_PROVEN = ${provenMatch![1]}, expected true`);
    }

    // Assertion 2: collect APPROACH markers across ALL members; require >=2 distinct
    // and require every name in REQUIRED_APPROACHES to be present.
    const approaches = new Set<string>();
    for (const d of docs) {
        for (const a of collectMatches(d.raw, APPROACH_RE)) {
            approaches.add(normalizeApproach(a));
        }
    }
    console.log(`  leaf APPROACH markers: ${JSON.stringify([...approaches])}`);
    if (approaches.size < 2) {
        fail(`only ${approaches.size} distinct APPROACH name(s) across leaves; need >=2 (saw: ${JSON.stringify([...approaches])})`);
    }
    for (const required of REQUIRED_APPROACHES) {
        if (!approaches.has(required)) {
            fail(`required APPROACH "${required}" not found among leaves (saw: ${JSON.stringify([...approaches])})`);
        }
    }

    // Assertion 6 (participation): >= 3 distinct members with substantive
    // output. A single-member run (direct-solve / pseudo-collaboration where
    // "teammate" results are cited but never produced) must not pass.
    const substantive = docs.filter(d => d.raw.trim().length >= 200);
    console.log(`  substantive contributors (>=200 chars): ${substantive.map(d => d.name).join(", ")}`);
    if (substantive.length < 3) {
        fail(`only ${substantive.length} member(s) produced substantive output; require >= 3`);
    }

    // Assertion 3: every LEMMA_HOLDS marker that appears must be "true".
    const lemmaByMember: Record<string, string[]> = {};
    let anyLemma = false;
    for (const d of docs) {
        const ms = collectMatches(d.raw, LEMMA_RE);
        if (ms.length > 0) {
            lemmaByMember[d.name] = ms;
            anyLemma = true;
        }
    }
    if (!anyLemma) {
        fail(`no <!-- LEMMA_HOLDS: ... --> markers found in any member report`);
    }
    let allHold = true;
    for (const [member, vals] of Object.entries(lemmaByMember)) {
        for (const v of vals) {
            console.log(`  ${member} (leaf): LEMMA_HOLDS = ${v}`);
            if (v !== "true") allHold = false;
        }
    }
    if (!allHold) {
        fail(`at least one leaf reported LEMMA_HOLDS = false; all must be true`);
    }

    console.log("PASS: VANDERMONDE_PROVEN=true, >=2 distinct APPROACH (incl. algebraic + combinatorial), all LEMMA_HOLDS=true.");
}

main();
