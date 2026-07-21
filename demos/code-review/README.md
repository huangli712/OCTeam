# Comprehensive Scenario: OCTeam Multi-Team Code Review

A 3-stage code review chain (**Audit → Confirm Defects → Fix**), completed by 3 independent teams × 3 orchestration primitives chained together. Audit runs once; triage and fix loop in **groups of 5** (each group first debates via triage, then fixes one by one) until all findings are processed. Master acts as the integration hub, teams are isolated from each other with hand-to-hand data passing. **fix-team creates a fresh instance per group** (to avoid performance degradation from accumulated tollgate runs in a single instance).

**Self-use template**: not bound to a specific target, no check scripts included. Replace `<TARGET>` with the code you want to review (file / module / directory), run using the quick-start prompt at the end of this document; the validity of findings and correctness of fixes are **for you to judge**.

## Workflow Overview

| Phase | Team | Orchestration Primitive | Input | Output (handoff marker) |
|------|------|---------|------|---------------------|
| ① Audit (once) | **audit-team** | `team_parallel` | `<TARGET>` source code | `<!-- FINDING: <id>:<dim>:<severity> -->` |
| ② Confirm Defects (once per group, ≤5 items) | **triage-team** | `team_arbitrate` | Current group's findings | `<!-- CONFIRMED: <id> -->` |
| ③ Fix (one-by-one gating, serial for current group CONFIRMED) | **fix-team** | `team_tollgate` | One pipeline per CONFIRMED in current group | `<!-- FIXED: <id> -->` + patches |

②③ loop G=⌈N/5⌉ times in groups of 5 (last group may have fewer than 5). After audit deduplication and merging, **do not filter by severity**; high/medium/low are all kept.

Uses 3 orchestration primitives: **parallel / arbitrate / tollgate**. Each tollgate stage has an independent verifier (different verifiers for the two gates). FAIL rolls back the producer, INVALID escalates to the arbiter, and the signoff decider signs off at the end.

```
<TARGET> ──► audit-team (parallel)  ──findings──► master
                                                     │ Deduplicate+merge + group (5 per group, last group may have fewer than 5)
                                                     ▼
                           ┌─── loop G groups ───────────────────────┐
                           │                                         │
                           │  triage-team (arbitrate)                │
                           │    ◄── current group findings (≤5) ──  │
                           │    └── confirmed (current group) ──► master │
                           │                                         │
                           │  fix-team (tollgate)                    │
                           │    ◄── confirmed (current group) ──     │
                           │    └── fixed+patches ──► master         │
                           └─────────────────────────────────────────┘
                                                     │ All groups done
                                                     ▼
                                                     master ──► you judge
```

## How to Use

1. **Determine `<TARGET>`**: the code path you want to review (single file / directory / module name).
2. **Run 3 teams in sequence** (§1–§3). Each team goes through its full lifecycle: `team_create` → `team_activate` → `team_<mode>` → collect output → `team_deactivate`.
3. **Handoff**: audit findings are deduplicated and merged by master then **grouped in batches of 5** (no severity filtering); each group's findings → current group's arbitrate topic; current group's confirmed → current group's individual tollgate run tasks. Triage→fix alternates between groups.
4. **Judge**: you read the fix-team's FIXED markers and patches, and decide the outcome yourself. This scenario **has no regression gate / no check scripts**.

## Team Switching

Only **one team** active at a time. `team_activate` will be rejected if another team is already active — **you must `team_deactivate` before `team_activate` the next**. Each team section's master steps explicitly include deactivate.

---

## §1 audit-team (`team_parallel`) — Audit

### 1.1 Phase Description

8 reviewers **audit** `<TARGET>` in parallel, each with a dedicated dimension (dimension is baked into the member prompt, parallel runs isolated). Coverage: correctness/boundaries, logic/algorithms, concurrency/races, security/input validation, error handling/resource cleanup, performance/efficiency, API contracts/type safety, maintainability/code smells.

### 1.2 Team Configuration

```json
{
  "name": "cr-audit",
  "description": "Code review audit team: 8 reviewers scan <TARGET> in parallel, each a dedicated dimension",
  "members": [
    {
      "name": "alice",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in CORRECTNESS & BOUNDARIES. Audit the code at the given <TARGET> for: off-by-one errors, wrong operators (e.g. < vs <=, == vs ===), boundary-condition bugs, numeric/comparison errors, capacity/limit checks gone wrong. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:correctness:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id (e.g. tasks-off-by-one-capacity). Report every issue — do not self-censor."
    },
    {
      "name": "sam",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in LOGIC & ALGORITHMS. Audit the code at the given <TARGET> for: incorrect algorithms, wrong control flow, logic that does not match intent, missed edge cases (null/empty/extreme input), state-machine errors. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:logic:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in CONCURRENCY & RACES. Audit the code at the given <TARGET> for: mutex/lock coverage gaps, TOCTOU (time-of-check-to-time-of-use), data races, async ordering bugs, deadlock potential. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:concurrency:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in SECURITY & INPUT VALIDATION. Audit the code at the given <TARGET> for: injection, path traversal, auth/authz gaps, untrusted-input handling, unsafe deserialization, symlink/rename races on filesystem paths. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:security:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "dave",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in ERROR HANDLING & RESOURCE CLEANUP. Audit the code at the given <TARGET> for: swallowed errors, empty/over-broad catch blocks, resource leaks (unclosed handles), partial-failure cleanup gaps, unhandled promise rejections. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:errorhandling:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "nina",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in PERFORMANCE & EFFICIENCY. Audit the code at the given <TARGET> for: hot-path inefficiencies, unnecessary allocations, O(n^2) or worse complexity where O(n) suffices, redundant work, sync I/O on hot paths, missing caching where beneficial. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:performance:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "omar",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in API CONTRACTS & TYPE SAFETY. Audit the code at the given <TARGET> for: unsafe type assertions (as any / @ts-ignore), missing input validation at trust boundaries, broken invariants/contracts, schema validation gaps, public API misuse. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:apicontracts:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "pat",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in MAINTAINABILITY & CODE SMELL. Audit the code at the given <TARGET> for: duplicated logic, excessive cyclomatic complexity, magic numbers, dead code, unclear naming, overly long functions. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:maintainability:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    }
  ]
}
```

**Role selection**: `reviewer` is a read-only role (audits should not modify code), 8 symmetric members, differences come from dimension prompts.

### 1.3 Master Launch Call

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "cr-audit",
    "mode": "isolated",
    "task": "Audit the code at <TARGET> for actionable issues strictly within YOUR ASSIGNED DIMENSION (see your role brief). For each issue, emit the <!-- FINDING: <id>:<dim>:<severity> --> marker exactly as your brief specifies, followed by a short description. Report every issue you find.",
    "reduce_policy": "merge",
    "reducer_member": "pat",
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- `mode: isolated` + dimension baked into member prompts — 8 parallel lanes each scan one dimension, with no overlap.
- `reduce_policy: merge` + `reducer_member: pat` — 8 lane outputs are **merged** into one (preserving all dimension findings, no summary/selection), giving the triage-team the complete findings list. The reducer must be a team member (looked up by the tool via `team.members.find()`); pat is chosen because the maintainability dimension naturally fits the perspective of "aggregating global findings", and the reduce phase prompt is fixed as mechanical merging (no conflict with the audit dimension prompt).
- No `signoff_policy` set — parallel defaults to no signoff, results are collected when done.

### 1.4 Lifecycle Steps (master)

```
team_create(cr-audit)         # Use §1.2 JSON
team_activate(cr-audit)       # Activate (confirm no other active team currently)
team_parallel(...)            # Use §1.3 JSON
# Wait for 8 reviewers' output → team_results for the summary
team_deactivate(cr-audit)     # Release, make way for next team
```

### 1.5 Output and Handoff

- Master extracts all `<!-- FINDING: <id>:<dim>:<severity> -->` from the 8 member outputs, **compiles a findings list** (id + dim + severity + description), and also maintains an **id → description map** (needed later for §3 tollgate task expansion).
- **Deduplication and merge (no severity filtering)**: deduplicate by id, merge multi-dimension findings with the same id into one entry; **keep all severity levels** (high / medium / low all retained), do not discard any low-level findings. Severity is only used as context info for triage debaters, not for filtering.
- If after deduplication there are **0 findings** (no findings from any dimension), master reports truthfully and **aborts the workflow**.
- **Grouping (5 per group)**: split the deduplicated list in merge order into groups of 5; the last group may have fewer than 5. Group count G = ⌈total count / 5⌉.
- These groups enter the §2 → §3 loop **strictly serially**: each group first goes through triage discussion, then fix repair; **you must wait until the current group's triage→fix is fully completed before entering the next group** — groups are **not parallelized**, no interleaving. Intra-group and inter-group ordering follows merge order, **no reordering by severity**.

---

## §2 triage-team (`team_arbitrate`) — Confirm Defects (Real-vs-False-Positive Debate)

### 2.1 Phase Description

> triage-team runs **once per group** in the §1.5 grouping loop using `team_arbitrate`: each run only debates the current group's findings (≤5 items), no mixing across groups, no cumulative cross-group debating.

6 debaters (2 reviewer + 2 architect + 1 coder + 1 explorer) debate **the current group's findings** across multiple rounds: **which are real issues, which are false positives**. **This phase does not discuss fix strategies** — fix approaches are deferred to §3 fix-team's coder for independent decisions. After the debate, 1 `almighty` arbiter (sam) weighs all positions and issues a **binding ruling** — **only confirms findings where debaters reached consensus** (those with remaining disagreement are discarded by default).

### 2.2 Team Configuration

```json
{
  "name": "cr-triage",
  "description": "Code review triage team: 6 debaters (2 reviewers + 2 architects + 1 coder + 1 explorer) + 1 almighty arbiter triage audit findings via arbitrate — debate real-vs-false-positive, arbiter confirms only consensus findings; NOT fix strategies",
  "members": [
    {
      "name": "erin",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues (not false positives). For each finding argue ONLY: is it a genuine issue? does the code actually exhibit the described problem? Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues (not false positives). For each finding argue ONLY: is it a genuine issue? does the code actually exhibit the described problem? Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "grace",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL. Weigh whether the described problem genuinely violates design invariants or contracts. Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "quinn",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL. Weigh whether the described problem genuinely violates design invariants, contracts, or long-term correctness. Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "mona",
      "role": "coder",
      "prompt": "You are a CODER debating which audit findings are REAL. Approach each finding SKEPTICALLY from an implementer's perspective: by default suspect it is a false positive — ask whether real-world code paths actually trigger the described behavior, whether existing guards or context already cover it, whether the described impact is genuinely reachable. Only concede a finding is real if presented with concrete evidence (a triggering call path, a missing guard, a demonstrated failure). Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "ruby",
      "role": "explorer",
      "prompt": "You are an EXPLORER debating which audit findings are REAL. Approach each finding SKEPTICALLY from a codebase-traversal perspective: by default suspect it is a false positive — trace whether the flagged code is actually reachable in real execution, whether callers or upstream already validate the input, whether the described race or error window can actually open. Only concede a finding is real if presented with concrete evidence (a live call path reaching the code, an unguarded entry point, a demonstrated trigger). Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "sam",
      "role": "almighty",
      "prompt": "You are the ARBITER (almighty). Six debaters (2 reviewers, 2 architects, 1 coder, 1 explorer) debated which audit findings are REAL, actionable issues. Weigh all positions impartially across the rounds. Apply this BINDING rule: confirm a finding ONLY IF the debaters reached consensus that it is real — i.e. no substantive dissent remained, or any initial skepticism was withdrawn when confronted with concrete evidence (a triggering call path, a missing guard, a demonstrated failure). Findings with unresolved disagreement are rejected as unconfirmed. Do NOT discuss fix strategies — that is delegated to the fix team. In your FINAL ruling, emit one line per confirmed finding exactly formatted: <!-- CONFIRMED: <finding-id> --> (rejected findings are simply omitted), then emit exactly one line formatted: <ruling>{\"decision\":\"<comma-separated confirmed ids, or none>\",\"rationale\":\"<which findings reached consensus and which did not, and why>\"}</ruling>."
    }
  ]
}
```

**Role selection**: erin/frank use `reviewer` (read-only deep review), grace/quinn use `architect` (architectural perspective on whether invariants/contracts are genuinely violated). mona uses `coder` (implementer perspective, default skepticism about triggerability), ruby uses `explorer` (codebase reachability perspective, default skepticism about path reachability), both inclined to play devil's advocate — tend to classify as false positives unless convinced by concrete evidence (triggering call chain, missing guard, demonstrable failure). sam uses `almighty` (arbiter, not a debater, not master) — after the debate, weighs 6 positions and issues a ruling under the binding rule of "only confirm consensus findings". The debate focus converges to "real or false positive", deferring strategy.

### 2.3 Master Launch Call

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "cr-triage",
    "task": "<Paste the current group's findings (≤5 items) verbatim: each FINDING id/dim/severity/description>",
    "arbiter": "sam",
    "debaters": ["erin", "frank", "grace", "quinn", "mona", "ruby"],
    "max_rounds": 6,
    "timeout_ms": 2400000
  }
}
```

**Parameter selection**:
- `task` = the **current group's** findings (master extracts ≤5 from §1.5 grouping and pastes them in by hand); arbitrate's `task` is the dispute topic.
- `arbiter: "sam"` (role=`almighty`) — not a debater, not master; weighs 6 debater positions and issues a binding ruling.
- `debaters` — 6 debaters (erin/frank/grace/quinn/mona/ruby), ≥2 and unique, none may be the arbiter.
- `max_rounds: 6` — gives sufficient debate space, with maneuver room for large numbers of findings.
- No `signoff_policy` set — the arbiter's ruling is itself the endpoint (equivalent to `none` gate).

### 2.4 Lifecycle Steps (master)

triage-team is reused per group in the loop, defined once, activated per group (the same group's fix-team follows immediately after, see §3.4):

```
team_create(cr-triage)         # Defined once outside the loop
# (cr-audit already deactivated; cr-fix can be defined in advance or at first §3.4)

for each group g in 1..G:        # §1.5 grouping loop
    team_activate(cr-triage)     # Activate (confirm no other active team currently)
    team_arbitrate(...)          # task = group g findings (≤5 items), arbiter=sam
    # Wait for arbiter's ruling → team_results for current group's confirmed
    team_deactivate(cr-triage)   # Make way for the same group's fix-team
    # → Continue to §3.4: activate(cr-fix) to run current group's confirmed tollgate
```

### 2.5 Output and Handoff (Current Group)

- Master extracts all `<!-- CONFIRMED: <id> -->` from the **current group's** arbiter ruling output, deduplicates into the **current group's confirmed defects table**.
- For each CONFIRMED id, look up the defect description from the §1.5 id → description map, assemble the task for each §3 tollgate run.
- The current group's confirmed defects table is immediately handed to §3 fix-team (activate fix-team after deactivating triage-team); **do not wait for other groups**, intra-group serial repair must finish before entering the next group's triage.

---

## §3 fix-team (`team_tollgate`) — Fix (One-by-One Gating, TDD Order)

### 3.1 Phase Description

> fix-team creates a **fresh instance per group** (after each group's triage completes) in the §1.5 grouping loop: delete the previous group's old fix-team (if any), team_create a new instance, activate it, run tollgate individually for each CONFIRMED finding in the current group, deactivate when done, then enter the next group.

5 members use a TDD gated pipeline, **individually** fixing **the current group's** confirmed findings. Master launches **one independent tollgate run serially per CONFIRMED** (current group N items → N runs, all within the newly created fix-team instance). Each run goes through two gates:

```
Stage 1:  henry writes failing test  →  iris verifies
            criteria: test accurately reproduces the bug (FAIL must be caused by this bug, not a generic failure)
            FAIL → roll back henry for rewrite        INVALID → escalate leo

Stage 2:  jack fixes code  →  kate verifies
            criteria: 1) failing test turns PASS
                      2) full regression has no new failures
                      3) fix is minimal (no bundled refactors)
                      4) type-safe (no as any / @ts-ignore)
            FAIL → roll back jack for rework          INVALID → escalate leo

Both gates PASS → leo final signoff (signoff_policy: decider)
```

**Why TDD order (tester before coder)**: completion criteria are locked in by an independent tester upfront — tests must FAIL before the fix and PASS after the fix. The coder cannot write "rubber-stamp tests that pass by design", the test objectively defines what "fixed" means.

**Why different verifiers for the two gates**: iris and kate separately guard the test gate and the fix gate, avoiding blind spots from a single verifier.

**Why serial one-by-one rather than batch**: tollgate's stages are a fixed single pipeline. Serial one-by-one lets each bug be independently gated with no interference; the current group's N runs are launched serially by master within the same fix-team instance, while instances are rebuilt across groups.

### 3.2 Team Configuration

```json
{
  "name": "cr-fix",
  "description": "Code review fix team: 5 members, TDD tollgate (write failing test → verify → fix → verify → signoff), one run per confirmed finding",
  "members": [
    {
      "name": "henry",
      "role": "tester",
      "prompt": "You are the TESTER (Stage 1 producer) in a tollgate fix pipeline. For the confirmed finding assigned in the task, write a FOCUSED regression test (in <TARGET>'s test directory) that reproduces the bug. The test MUST fail on the current (unfixed) code for the RIGHT reason (the actual bug, not a trivial/syntax error, not a different bug). Do NOT modify production code. Emit <!-- TEST-WRITTEN: <finding-id> --> with the test file path."
    },
    {
      "name": "iris",
      "role": "reviewer",
      "prompt": "You are the Stage 1 VERIFIER in a tollgate fix pipeline. Verify that Henry's failing test accurately reproduces the confirmed finding: it FAILS on the current code for the right reason, is focused, and would turn PASS once the bug is fixed. Emit PASS / FAIL (with reason) / INVALID (if the finding description is ambiguous and no accurate test can be written)."
    },
    {
      "name": "jack",
      "role": "coder",
      "prompt": "You are the CODER (Stage 2 producer) in a tollgate fix pipeline. Apply the MINIMAL fix to <TARGET> that turns the failing test PASS. Make the smallest change that resolves the issue without unrelated edits or refactors. Emit <!-- FIXED: <finding-id> --> with the patch (diff or changed lines)."
    },
    {
      "name": "kate",
      "role": "reviewer",
      "prompt": "You are the Stage 2 VERIFIER in a tollgate fix pipeline. Verify Jack's fix: 1) Henry's failing test now PASSES. 2) Full regression suite has no new failures (or no test suite exists). 3) The fix is minimal — no unrelated refactors, no scope creep. 4) Type-safe — no 'as any', no '@ts-ignore', no suppressed errors. Emit PASS / FAIL (with reason) / INVALID (if the fix approach is fundamentally flawed, not merely an implementation slip)."
    },
    {
      "name": "leo",
      "role": "reviewer",
      "prompt": "You are the ESCALATION TARGET and SIGNOFF DECIDER for the fix tollgate. When a verifier emits INVALID (finding ambiguous or fix approach fundamentally flawed), issue a binding ruling on how to proceed. When both gates PASS, provide final signoff. Do NOT participate as a stage member or debater — you only rule on escalations and sign off."
    }
  ]
}
```

**Role selection**: henry `tester` (write failing test), iris/kate/leo `reviewer` (verify + arbitrate), jack `coder` (fix). Each stage's verifier ≠ producer (iris≠henry, kate≠jack); leo does not participate in any stage, only arbitrates and signs off.

### 3.3 Master Launch Call (once per CONFIRMED)

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "cr-fix",
    "stages": [
      {
        "member": "henry",
        "task": "Write a failing test that reproduces confirmed finding <id>: <one-line defect description>. Place it in <TARGET>'s test directory. The test MUST fail on the current (unfixed) code and would pass once the bug is fixed. Do NOT modify production code.",
        "verifier": "iris",
        "criteria": "The test accurately reproduces confirmed finding <id>: it FAILS on the current code for the right reason (the actual bug, not a trivial/syntax failure, not a different bug). The test is focused and would turn PASS once the bug is fixed."
      },
      {
        "member": "jack",
        "task": "Apply the MINIMAL fix to <TARGET> that resolves confirmed finding <id>: <one-line defect description>. Make the smallest change that turns Henry's failing test PASS without unrelated edits. Do NOT refactor neighboring code.",
        "verifier": "kate",
        "criteria": "1. Henry's failing test now PASSES. 2. Full regression suite has no new failures (or no test suite exists). 3. The fix is minimal — no unrelated refactors, no scope creep. 4. Type-safe — no 'as any', no '@ts-ignore', no suppressed errors."
      }
    ],
    "escalate_to": "leo",
    "max_gate_retries": 2,
    "max_invalid_cycles": 3,
    "signoff_policy": "decider",
    "signoff_decider": "leo",
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- For each CONFIRMED finding, replace `<id>` and `<one-line defect description>` (looked up from the §1.5 id → description map).
- `max_gate_retries: 2` — each gate rolls back at most 2 times, avoiding infinite loops.
- `max_invalid_cycles: 3` — INVALID forced escalation fails after at most 3 rounds.
- `signoff_policy: decider` + `signoff_decider: leo` — leo provides final signoff.
- `escalate_to: leo` — INVALID from both gates escalates to leo for ruling.

### 3.4 Lifecycle Steps (master)

fix-team creates a fresh instance per group (to avoid performance degradation from accumulating too many tollgate runs in a single instance), following immediately after the same group's triage:

```
# cr-triage defined once outside the loop (see §2.4)
for each group g in 1..G:         # §1.5 grouping loop (triage already completed for this group)
    if g > 1:
        team_delete(cr-fix)        # Delete previous group's old fix-team (already completed, already deactivated)
    team_create(cr-fix)            # Create fresh fix-team per group (use §3.2 JSON)
    team_activate(cr-fix)          # (cr-triage already deactivated at this point)
    for each CONFIRMED in group g: # Serial one-by-one, current group N items → N runs
        team_tollgate(...)          # Use §3.3 JSON, replace <id> and <one-line defect description>
        # Wait for signoff → team_results for this run's output
    team_deactivate(cr-fix)        # Make way for next group's triage
```

> **Why rebuild fix-team per group**: a single fix-team instance degrades in performance after multiple consecutive team_tollgate runs. After each group's triage confirms findings, delete the old fix-team (if any), create a fresh one, then execute the current group's repairs. triage-team is unaffected by this, still defined once outside the loop and reused per group.

### 3.5 Output and Handoff (Current Group)

- Master extracts the **current group's** `<!-- FIXED: <id> -->` + corresponding patches from each run.
- After the current group's repairs are done, return to §2 to process the next group, until all G groups are completed.
- **After all groups are processed, you read all patches and FIXED markers, and decide the success or failure of the entire review yourself.** The scenario ends here.

---

## End-to-End Timeline (master perspective)

```
T+0   team_create(cr-audit) → team_activate → team_parallel
        8 reviewers audit <TARGET> in parallel
T+~12  Collect findings → deduplicate+merge (no filtering) → group (5 per group, last group may have fewer than 5)
        → team_deactivate(cr-audit)
        If 0 findings after deduplication → abort, report truthfully
        Group count G = ⌈total count / 5⌉

team_create(cr-triage)   # Define once outside the loop

for g in 1..G:                          # Grouping loop: per group triage → fix
    team_activate(cr-triage)              # (the other team already deactivated)
    team_arbitrate(task = group g findings, arbiter=sam, ≤6 rounds)
        6 debaters debate current group's real vs false positive → arbiter(sam) only confirms consensus findings
    team_deactivate(cr-triage)

    if g > 1:
        team_delete(cr-fix)                # Delete previous group's old fix-team
    team_create(cr-fix)                    # Create fresh fix-team per group
    team_activate(cr-fix)                  # (cr-triage already deactivated)
    for each CONFIRMED in group g (serial one-by-one):
        team_tollgate (henry→iris write test gate, jack→kate fix gate, leo signoff)
    team_deactivate(cr-fix)

Collect all fixed+patches → you read all output, decide the outcome
```

(Durations are order-of-magnitude estimates only; larger `<TARGET>`, more groups G, more CONFIRMED per group all increase time. N = total CONFIRMED count.)

---

## Quick-Start Prompts

> Replace `<TARGET>` with the code path you want to review, paste the entire block to the master session. Master will run 3 teams in sequence, executing each step per the README's JSON configuration, with data hand-carried between teams by master.

```text
Run a multi-team code review per demos/code-review/README.md, target code = <TARGET>.
Execute 3 teams, each follows the full lifecycle of "team_create → team_activate → team_<mode> → team_results → team_deactivate". Only one active team allowed at a time — must deactivate before switching.
1. audit-team (team_parallel, §1): per §1.2 team_create, §1.3 team_parallel. 8 reviewers audit <TARGET> in parallel. Deactivate when done. Compile all <!-- FINDING: ... --> markers into a findings list, maintaining an id→description map. **Only deduplicate + merge, no severity filtering** (high/medium/low all retained). If 0 after dedup → abort workflow. Then **group: 5 per group, last group may have fewer than 5**, group count G = ⌈total count / 5⌉.
2. triage-team (team_arbitrate, §2) + fix-team (team_tollgate, §3) alternate looping over G groups:
   Before loop: team_create(cr-triage) once.
   for g in 1..G:
     - activate cr-triage → team_arbitrate (task = group g findings (≤5 items), arbiter=sam, max_rounds=6). 6 debaters debate which are real issues and which are false positives — no fix strategy discussion; arbiter only confirms consensus findings. Deactivate cr-triage. Compile current group's <!-- CONFIRMED: <id> -->.
     - If g>1 first team_delete(cr-fix) to remove previous group's old fix-team; then team_create(cr-fix) fresh instance → activate cr-fix → for each CONFIRMED finding in current group, launch one serial team_tollgate run (replace <id> and defect description). Each run has two gates: henry writes failing test → iris verifies; jack fixes → kate verifies; leo arbitrates and signs off. max_gate_retries=2, signoff_policy=decider, signoff_decider=leo. After current group done, deactivate cr-fix.
3. After all G groups are processed, compile each team's outputs (findings / confirmed / fixed+patches) and present them to me for my judgment. No evaluation script, no regression gate.
Notes:
- Member names must come from the 32-name preset pool (alice/bob/carol/dave/erin/frank/grace/henry/iris/jack/kate/leo/mona/nina/omar/pat/quinn/ruby/sam...), roles must use preset values like reviewer/architect/coder/tester.
- Always team_deactivate the current team before switching, otherwise team_activate will be rejected.
- **No severity filtering**: after dedup, keep high/medium/low all retained, 5 per group (last group may have fewer than 5), triage→fix alternates between groups.
- **Strict serial between groups, no parallelism**: one group's triage→fix fully completes before entering the next group. Never run triage for multiple groups concurrently, or fix for multiple groups concurrently, or one group's triage overlapping with another group's fix.
- fix-team rebuilt per group: after each group's triage completes, delete old fix-team (if any), team_create fresh instance. Within the group, run tollgate serially one by one: one independent run per CONFIRMED. Do not batch into a single run.
- When a team is running, poll team_progress/team_results at 30-second intervals, no more frequent.
```

---

## Related Documents

- [`demos/README.md`](../README.md) — scenario directory overview (single-primitive 9 modes + this comprehensive scenario)
- [`demos/01-team-parallel/README.md`](../01-team-parallel/README.md) — parallel primitive reference
- [`demos/07-team-arbitrate/README.md`](../07-team-arbitrate/README.md) — arbitrate primitive reference
- [`demos/09-team-tollgate/README.md`](../09-team-tollgate/README.md) — tollgate primitive reference
- parallel / arbitrate / tollgate source: [`src/orchestration/modes/parallel.ts`](../../src/orchestration/modes/parallel.ts) / [`arbitrate.ts`](../../src/orchestration/modes/arbitrate.ts) / [`tollgate.ts`](../../src/orchestration/modes/tollgate.ts)
