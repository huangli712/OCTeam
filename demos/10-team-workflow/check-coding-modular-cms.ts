/**
 * Check script: modular fanout CMS workflow (Scenario 4 · challenge).
 *
 * Validates the fanout task-gate chain in a team_workflow run with 6 members:
 *   - alice.md: must contain User, AuthToken, AuditEntry interface definitions
 *   - bob.md: must contain 1 PASS verdict (step 2 type verification gate)
 *   - carol.md, dave.md, erin.md: must each contain <!-- MODULE: {auth|users|audit} --> marker
 *   - frank.md: must contain 1 PASS verdict (step 5 integration gate) + aggregation evidence
 *
 * Usage:  bun check-coding-modular-cms.ts <run_dir>
 *   <run_dir>  directory containing alice/bob/carol/dave/erin/frank.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const INTERFACE_RE = /\binterface\s+(\w+)/g;
const MODULE_RE = /<!--\s*MODULE:\s*(\w+)\s*-->/;
const VERDICT_RE = /<verdict>\s*(\{[\s\S]*?\})\s*<\/verdict>/g;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

interface Verdict {
    result: string;
    rationale: string;
    diff: string;
}

function parseVerdicts(raw: string): Verdict[] {
    const verdicts: Verdict[] = [];
    let m: RegExpExecArray | null;
    while ((m = VERDICT_RE.exec(raw)) !== null) {
        try {
            const obj = JSON.parse(m[1]) as Record<string, string>;
            const result = (obj.result ?? "").trim().toUpperCase();
            if (!result) fail("verdict JSON lacks a non-empty 'result' field");
            verdicts.push({
                result,
                rationale: (obj.rationale ?? "").trim(),
                diff: (obj.diff ?? "").trim(),
            });
        } catch {
            fail(`verdict block is not valid JSON: ${m[1].substring(0, 200)}`);
        }
    }
    return verdicts;
}

function extractInterfaces(raw: string): string[] {
    const names: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = INTERFACE_RE.exec(raw)) !== null) {
        names.push(m[1]);
    }
    return names;
}

function extractModule(raw: string): string | null {
    const m = raw.match(MODULE_RE);
    return m ? m[1] : null;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-modular-cms.ts <run_dir>");
        process.exit(2);
    }

    const members = ["alice", "bob", "carol", "dave", "erin", "frank"];
    const files: Record<string, string> = {};

    for (const name of members) {
        try {
            files[name] = await readFile(join(runDir, `${name}.md`), "utf8");
        } catch (err) {
            console.error(`IO error reading ${name}.md: ${(err as Error).message}`);
            process.exit(2);
        }
    }

    // Assertion 1: alice defined all three required interfaces.
    const interfaces = extractInterfaces(files.alice);
    const requiredIfaces = ["User", "AuthToken", "AuditEntry"];
    for (const iface of requiredIfaces) {
        if (!interfaces.includes(iface)) {
            fail(`alice.md missing required interface: ${iface} (found: ${interfaces.join(", ")})`);
        }
    }
    console.log(`  alice: all ${requiredIfaces.length} interfaces defined ✓`);

    // Assertion 2: bob emitted a PASS verdict for type verification (step 2).
    const bobVerdicts = parseVerdicts(files.bob);
    if (bobVerdicts.length === 0) fail("bob.md has no verdict (step 2 gate)");
    if (bobVerdicts[0].result !== "PASS") {
        fail(`bob verdict 1 (type verification) is ${bobVerdicts[0].result}, expected PASS`);
    }
    console.log(`  bob: type verification verdict = PASS ✓`);

    // Assertion 3: each module implementor has the correct MODULE marker and >= 2 exports.
    const moduleExpectations: Record<string, string> = {
        carol: "auth",
        dave: "users",
        erin: "audit",
    };
    for (const [member, expectedModule] of Object.entries(moduleExpectations)) {
        const mod = extractModule(files[member]);
        if (!mod) fail(`${member}.md does not contain <!-- MODULE: ${expectedModule} --> marker`);
        if (mod !== expectedModule) {
            fail(`${member}.md has MODULE: ${mod}, expected ${expectedModule}`);
        }
        // Count exported function-like patterns (export function, export const fn =, function fn)
        const exportCount = (files[member].match(/\b(?:export\s+)?(?:function|const)\s+\w+/g) || []).length;
        if (exportCount < 2) {
            fail(`${member}.md has only ${exportCount} export(s), expected at least 2`);
        }
        console.log(`  ${member}: MODULE: ${mod}, ${exportCount} exports ✓`);
    }

    // Assertion 4: frank.md has a PASS verdict for the integration gate (step 5).
    const frankVerdicts = parseVerdicts(files.frank);
    if (frankVerdicts.length === 0) fail("frank.md has no verdict (step 5 gate)");
    // The integration gate is likely the last verdict.
    const integVerdict = frankVerdicts[frankVerdicts.length - 1];
    if (integVerdict.result !== "PASS") {
        fail(`frank integration verdict is ${integVerdict.result}, expected PASS`);
    }
    console.log(`  frank: integration verdict = PASS ✓`);

    // Assertion 5: frank.md contains evidence of cross-module aggregation (join reduce output).
    const aggEvidence = files.frank.match(/\b(auth|users|audit)\b/gi) || [];
    if (aggEvidence.length < 3) {
        fail(`frank.md references only ${aggEvidence.length} module(s), expected at least 3 (join reduce should aggregate all modules)`);
    }
    console.log(`  frank: references ${[...new Set(aggEvidence.map((s) => s.toLowerCase()))].sort().join(", ")} modules (aggregation evidence) ✓`);

    console.log(`PASS: all ${requiredIfaces.length} interfaces defined; 3 modules implemented; type + integration gates both PASS.`);
}

main();
