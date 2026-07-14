/**
 * Check script: integration method arbitrate (Gauss-Legendre vs Simpson) with HITL.
 *
 * Two mathematician debaters argue which quadrature method to use for
 * integrating e^(-x^2) on [0,1]. A reviewer arbiter issues a binding ruling.
 * Human approval pauses before the arbitration phase so the leader can
 * inspect the debate before the ruling.
 *
 * This script verifies:
 *   1. Both debaters emitted an <!-- ARG: ... --> marker.
 *   2. The arbiter emitted a <ruling>{"decision":"...","rationale":"..."}</ruling>
 *      block whose decision is "gauss-legendre". Gauss quadrature achieves
 *      exponential convergence for smooth integrands like e^(-x^2).
 *   3. The rationale is non-empty and contains a key term.
 *
 * Usage:  bun check-math-integration-arbitrate.ts <run_dir>
 *   <run_dir>  directory containing alice.md, bob.md, carol.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEBATERS = ["alice", "bob"] as const;
const ARBITER = "carol";

const EXPECTED_RULING = "gauss-legendre";
const REASON_KEY_TERMS = ["accuracy", "exponential", "smooth", "nodes"] as const;

const ARG_RE = /<!--\s*ARG:\s*(.+?)\s*-->/;
const RULING_TAG_RE = /<ruling>\s*(\{[\s\S]*?\})\s*<\/ruling>/;

function parseRuling(raw: string): { decision: string; rationale: string } {
    const m = raw.match(RULING_TAG_RE);
    if (!m) fail("arbiter did not emit a <ruling>{...}</ruling> decision block");
    let obj: { decision?: string; rationale?: string };
    try {
        obj = JSON.parse(m![1]) as { decision?: string; rationale?: string };
    } catch {
        fail(`arbiter <ruling> block is not valid JSON: ${m![1]}`);
    }
    const decision = (obj!.decision ?? "").trim();
    const rationale = (obj!.rationale ?? "").trim();
    if (!decision) fail('arbiter <ruling> JSON lacks a non-empty "decision" field');
    return { decision, rationale };
}

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function readMember(runDir: string, member: string): Promise<string> {
    const path = join(runDir, `${member}.md`);
    try {
        return await readFile(path, "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-integration-arbitrate.ts <run_dir>");
        process.exit(2);
    }

    // Assertion 1: each debater emitted an ARG marker.
    for (const debater of DEBATERS) {
        const raw = await readMember(runDir, debater);
        const match = raw.match(ARG_RE);
        if (!match) {
            fail(`debater "${debater}" did not emit an <!-- ARG: ... --> marker`);
        }
        console.log(`  ${debater}: ARG = ${match![1].trim()}`);
    }

    const arbiterRaw = await readMember(runDir, ARBITER);

    // Assertion 2+3: arbiter ruling is "gauss-legendre" with a sound rationale.
    const { decision: ruling, rationale: reason } = parseRuling(arbiterRaw);
    console.log(`  arbiter RULING = ${ruling}`);
    if (ruling !== EXPECTED_RULING) {
        fail(`arbiter ruled "${ruling}", expected "${EXPECTED_RULING}" (Gauss quadrature converges exponentially for smooth integrands)`);
    }
    if (reason.length === 0) {
        fail("arbiter rationale is empty");
    }
    const lower = reason.toLowerCase();
    const hasKeyTerm = REASON_KEY_TERMS.some(term => lower.includes(term));
    if (!hasKeyTerm) {
        fail(`arbiter rationale lacks a key term (${REASON_KEY_TERMS.join(" / ")}): "${reason}"`);
    }
    console.log(`  arbiter REASON = ${reason}`);

    console.log("PASS: arbiter ruled gauss-legendre with a sound rationale; both debaters argued.");
}

main();
