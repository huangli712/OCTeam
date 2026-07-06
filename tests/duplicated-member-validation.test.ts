/**
 * Regression test for finding duplicated-member-validation:
 *   src/tools/create.ts:117 and src/tools/add.ts:55 duplicate the member
 *   reserved-name / name-pool / agent-override validation rules.
 *
 * The duplication is itself the defect. Two inline copies of the same rules
 * can drift: a rule tightened (or loosened, or renamed) in one path silently
 * diverges from the other, so team creation and team_add_member enforce
 * different membership invariants. The fix is to centralize the rules in a
 * single shared helper that both tools delegate to.
 *
 * A behavioural test cannot catch this — both tools currently agree on the
 * same inputs, so any "both reject X" assertion passes today AND after an
 * accidental drift in just one file. The only way to lock the de-duplication
 * invariant is source inspection (same approach as
 * orchestration-type-switch-invariant.test.ts): the identifying substring of
 * each validation rule must NOT be copy-pasted into BOTH create.ts and
 * add.ts. On the unfixed code every marker is literally present in both
 * files, so the test fails; once the rules are centralized in one shared
 * module, each marker appears in at most one of the two tool files, so the
 * test passes.
 */
import { describe, expect, test } from "bun:test"

import { readFile } from "node:fs/promises"
import path from "node:path"

const CREATE_PATH = path.resolve("src/tools/create.ts")
const ADD_PATH = path.resolve("src/tools/add.ts")

async function readSource(rel: string): Promise<string> {
    return readFile(rel, "utf8")
}

/**
 * Each entry identifies one of the member-validation rules the finding flags
 * as duplicated. The substring is the stable, unique fragment of the rule's
 * rejection message — it is identical across create.ts and add.ts today
 * because the message text was copy-pasted along with the rule logic. If the
 * rule is centralized, this marker lives only in the shared helper (in
 * neither tool file, or in just one if the helper is co-located); the drift
 * defect is present iff the marker is in BOTH tool files.
 */
const DUPLICATED_RULE_MARKERS: Array<{ rule: string; marker: string }> = [
    {
        rule: "reserved-name (master/orchestrator) rejection",
        marker: "is a reserved name and cannot be a member name",
    },
    {
        rule: "name-pool (MEMBER_NAME_POOL membership) rejection",
        marker: "is not a preset pool name",
    },
    {
        rule: "agent-override (oct-* allowlist) rejection",
        marker: "is not a hardened oct-* agent",
    },
]

describe("duplicated-member-validation: create.ts and add.ts must not inline the same member-validation rules", () => {
    test("no rule marker is copy-pasted into both create.ts and add.ts", async () => {
        const [createSrc, addSrc] = await Promise.all([
            readSource(CREATE_PATH),
            readSource(ADD_PATH),
        ])

        const drifted: Array<{ rule: string; marker: string }> = []
        for (const { rule, marker } of DUPLICATED_RULE_MARKERS) {
            const inCreate = createSrc.includes(marker)
            const inAdd = addSrc.includes(marker)
            // The defect: the rule is duplicated across both files. A single
            // source of truth means at most one of them carries the marker.
            if (inCreate && inAdd) {
                drifted.push({ rule, marker })
            }
        }

        expect(
            drifted,
            `Member-validation rules are copy-pasted into both create.ts and ` +
                `add.ts, so they can drift. Centralize each rule in one shared ` +
                `helper and have both tools call it. Duplicated: ` +
                drifted.map(d => `"${d.rule}" (${JSON.stringify(d.marker)})`).join("; "),
        ).toEqual([])
    })
})
