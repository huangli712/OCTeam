/**
 * Check script: single-file Markdown-to-HTML converter (recursive module build).
 *
 * team_recurse spreads output across the shared task list, per-member .md
 * reports, AND member-to-member messages (team_send_message → mailbox/*.jsonl).
 * This script reads ALL member markdowns in <run_dir>/ PLUS all messages in
 * <team_dir>/mailbox/ (resolved as ../../ relative to run_dir) and verifies:
 *   (1) the decomposer's aggregated CONVERTS marker,
 *   (2) the test member's PASS_COUNT (all feature cases passing),
 *   (3) the embedded convert() function actually converts headings and bold.
 *
 * Usage:  bun check-coding-md-converter.ts <run_dir>
 *   <run_dir>  directory containing the per-member markdown outputs
 *              (expects alice.md as the decomposer, plus bob.md
 *               and carol.md). Also scans
 *              <team_dir>/mailbox/*.jsonl for markers sent via
 *              team_send_message but not present in captured .md turns.
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Decomposer member (set in the team_create config above). The root aggregator.
const DECOMPOSER = "alice";
// Test member that reports the assembled-suite pass count.
const TESTER = "carol";
// Minimum passing cases: # / ## / ### headings (3) + bold (1) + inline code (1)
// + unordered list (1) => at least 5 distinct feature cases must pass.
const MIN_PASS_COUNT = 5;

const CONVERTS_RE = /<!--\s*CONVERTS:\s*(true|false)\s*-->/;
const PASS_COUNT_RE = /<!--\s*PASS_COUNT:\s*(\d+)\s*-->/;
// A ```typescript fenced code block.
const TS_BLOCK_RE = /```typescript\s*\n([\s\S]*?)```/g;

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

/**
 * Scan all markdown docs for a ```typescript block that defines `convert`,
 * load it via the Function constructor, and return the convert function.
 * The decomposer embeds the aggregated convert(); we accept it from any member.
 */
function extractConvert(docs: MemberDoc[]): (markdown: string) => string {
    let found: { member: string; code: string } | null = null;
    for (const doc of docs) {
        TS_BLOCK_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TS_BLOCK_RE.exec(doc.raw)) !== null) {
            const code = m[1];
            // Heuristic: the aggregated convert() definition lives here.
            if (/(\bfunction\s+convert\b|\bconst\s+convert\s*=)/.test(code)) {
                found = { member: doc.name, code };
                break;
            }
        }
        if (found) break;
    }

    if (!found) {
        fail("no ```typescript block defining `convert` found in any member report");
    }

    let fn: (markdown: string) => string;
    try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const factory = new Function(
            `${found!.code}; return typeof convert === "function" ? convert : null;`,
        ) as () => ((markdown: string) => string) | null;
        const g = factory();
        if (typeof g !== "function") {
            throw new Error("code did not expose a `convert` function");
        }
        fn = g;
    } catch (err) {
        fail(`convert() from "${found!.member}" failed to load: ${(err as Error).message}`);
    }
    console.log(`  convert() extracted from member: ${found!.member}`);
    return fn!;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-md-converter.ts <run_dir>");
        process.exit(2);
    }

    let docs: MemberDoc[];
    try {
        docs = await loadAllMarkdown(runDir);
    } catch (err) {
        console.error(`IO error reading member output: ${(err as Error).message}`);
        process.exit(2);
    }

    // Merge mailbox messages: recurse members deliver markers via
    // team_send_message, which land in <team_dir>/mailbox/*.jsonl —
    // not always in the captured .md turn output.
    try {
        const teamDir = resolve(runDir, "../..");
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

    // Assertion 1: decomposer aggregated a working converter.
    const decomposer = docs.find(d => d.name === DECOMPOSER);
    if (!decomposer) {
        fail(`decomposer member "${DECOMPOSER}.md" not found in "${runDir}"`);
    }
    const convertsMatch = decomposer!.raw.match(CONVERTS_RE);
    if (!convertsMatch) {
        fail(`decomposer "${DECOMPOSER}" did not emit a <!-- CONVERTS: ... --> marker`);
    }
    console.log(`  ${DECOMPOSER} (decomposer): CONVERTS = ${convertsMatch![1]}`);
    if (convertsMatch![1] !== "true") {
        fail(`decomposer CONVERTS = ${convertsMatch![1]}, expected true`);
    }

    // Assertion 2: test member reports all feature cases passing.
    const tester = docs.find(d => d.name === TESTER);
    if (!tester) {
        fail(`test member "${TESTER}.md" not found in "${runDir}"`);
    }
    const passMatch = tester!.raw.match(PASS_COUNT_RE);
    if (!passMatch) {
        fail(`test member "${TESTER}" did not emit a <!-- PASS_COUNT: ... --> marker`);
    }
    const passCount = parseInt(passMatch![1], 10);
    console.log(`  ${TESTER} (leaf): PASS_COUNT = ${passCount}`);
    if (passCount < MIN_PASS_COUNT) {
        fail(`test member PASS_COUNT = ${passCount}, expected >= ${MIN_PASS_COUNT} (5 features must pass)`);
    }

    // Assertion 3: the embedded convert() actually converts headings and bold.
    const convert = extractConvert(docs);

    let h1Out: string;
    try {
        h1Out = convert("# Hi");
    } catch (err) {
        fail(`convert("# Hi") threw: ${(err as Error).message}`);
    }
    if (!/<h1/i.test(h1Out!)) {
        fail(`convert("# Hi") = ${JSON.stringify(h1Out)}, expected to contain <h1>`);
    }

    let boldOut: string;
    try {
        boldOut = convert("**bold**");
    } catch (err) {
        fail(`convert("**bold**") threw: ${(err as Error).message}`);
    }
    if (!/<(strong|b)[\s>]/i.test(boldOut!)) {
        fail(`convert("**bold**") = ${JSON.stringify(boldOut)}, expected to contain <strong> or <b>`);
    }

    console.log(`  convert("# Hi") -> ${JSON.stringify(h1Out)}`);
    console.log(`  convert("**bold**") -> ${JSON.stringify(boldOut)}`);

    console.log("PASS: decomposer CONVERTS=true, test suite passes, and convert() renders headings + bold.");
}

main();
