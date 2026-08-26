# Code Bug Fix: One-by-One Gated TDD

A single-team fix scenario: 1 team × 1 orchestration primitive (`team_tollgate`). fix-team fixes a **confirmed findings list** one by one behind two verification gates (failing test → verify; minimal fix → verify), with INVALID escalation and final signoff.

- **Input**: a confirmed findings list — one line per finding: `<id>: <one-line defect description>`. Typical source: the code review scenario's final output ([`../code-review/README.md`](../code-review/README.md)). Any externally sourced list works equally well.

- **Output: patches.** After reading all patches and FIXED markers, you decide the success or failure of the fixes yourself. This scenario **has no regression gate / no check scripts**.

**Self-use template**: not bound to a specific target. Replace `<TARGET>` with the code being fixed, run using the quick-start prompt at the end of this document.

---

## §1 fix-team (`team_tollgate`) — Fix

### 1.1 Phase Description

fix-team creates a **fresh instance per batch** of 5 confirmed findings (last batch may have fewer): delete the previous batch's old fix-team (if any), `team_create` a new instance, activate it, run tollgate **individually** for each finding in the batch, deactivate when done, then enter the next batch. Batch count = ⌈M/5⌉ where M = confirmed findings count.

5 members use a TDD gated pipeline, **individually** fixing the findings. Master launches **one independent tollgate run serially per finding** (M findings → M runs, all within the current batch's fix-team instance). Each run goes through two gates:

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

**Why serial one-by-one rather than batch**: tollgate's stages are a fixed single pipeline. Serial one-by-one lets each bug be independently gated with no interference; the current batch's N runs are launched serially by master within the same fix-team instance, while instances are rebuilt across batches.

**Why fresh fix-team per batch**: a single fix-team instance degrades in performance after multiple consecutive team_tollgate runs. Rebuilding the instance every batch (≤5 runs) keeps each instance's run count bounded.

---

### 1.2 Team Configuration

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
      "role": "evaluator",
      "prompt": "You are the Stage 1 VERIFIER in a tollgate fix pipeline. Verify that Henry's failing test accurately reproduces the confirmed finding: it FAILS on the current code for the right reason, is focused, and would turn PASS once the bug is fixed. Emit PASS / FAIL (with reason) / INVALID (if the finding description is ambiguous and no accurate test can be written)."
    },
    {
      "name": "jack",
      "role": "coder",
      "prompt": "You are the CODER (Stage 2 producer) in a tollgate fix pipeline. Apply the MINIMAL fix to <TARGET> that turns the failing test PASS. Make the smallest change that resolves the issue without unrelated edits or refactors. Emit <!-- FIXED: <finding-id> --> with the patch (diff or changed lines)."
    },
    {
      "name": "kate",
      "role": "evaluator",
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

**Role selection**: henry `tester` (write failing test), iris/kate `evaluator` (verify by actually running the tests — the evaluator role maps to a bash-capable agent, required by the "test FAILS/PASSES" criteria), leo `reviewer` (escalation rulings + final signoff — pure judgment, read-only), jack `coder` (fix). Each stage's verifier ≠ producer (iris≠henry, kate≠jack); leo does not participate in any stage, only arbitrates and signs off.

---

### 1.3 Master Launch Call (once per finding)

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
- For each finding, replace `<id>` and `<one-line defect description>` from the confirmed findings list (the code review scenario's final output, or your own list).
- `max_gate_retries: 2` — each gate rolls back at most 2 times, avoiding infinite loops.
- `max_invalid_cycles: 3` — INVALID forced escalation fails after at most 3 rounds.
- `signoff_policy: decider` + `signoff_decider: leo` — leo provides final signoff.
- `escalate_to: leo` — INVALID from both gates escalates to leo for ruling.

---

### 1.4 Lifecycle Steps (master)

fix-team creates a fresh instance per batch (to avoid performance degradation from accumulating too many tollgate runs in a single instance):

```
Input: confirmed findings list (M items)
If M = 0 → stop, report truthfully (nothing to fix)
Batch count = ⌈M/5⌉

for each batch b in 1..⌈M/5⌉:
    if b > 1:
        team_delete(cr-fix)        # Delete previous batch's old fix-team (already completed, already deactivated)
    team_create(cr-fix)            # Create fresh fix-team per batch (use §1.2 JSON)
    team_activate(cr-fix)
    for each finding in batch b:   # Serial one-by-one, batch N items → N runs
        team_tollgate(...)          # Use §1.3 JSON, replace <id> and <one-line defect description>
        # Wait for signoff → team_results for this run's output
    team_deactivate(cr-fix)        # Make way for next batch
```

---

### 1.5 Output and Handoff (Final)

- Master extracts each run's `<!-- FIXED: <id> -->` + corresponding patches.
- After all batches are done, master compiles all FIXED markers + patches and presents them to the user. **After reading all patches and FIXED markers, you decide the success or failure of the fixes yourself.** The scenario ends here.

---

## End-to-End Timeline (master perspective)

```
Input: confirmed findings list (M items, e.g. the code review scenario's final output)
If M = 0 → stop, report truthfully
Batch count = ⌈M/5⌉

for b in 1..⌈M/5⌉:
    if b > 1: team_delete(cr-fix)        # Delete previous batch's instance
    team_create(cr-fix) → team_activate(cr-fix)
    for each finding in batch b (serial one-by-one):
        team_tollgate (henry→iris write test gate, jack→kate fix gate, leo signoff)
    team_deactivate(cr-fix)

Collect all FIXED markers + patches → present to user → scenario ends
```

(Durations are order-of-magnitude estimates only; more findings M means more batches and runs. Total runs = M.)

---

## Quick-Start Prompt

> Replace the confirmed findings list with the code review scenario's final output (or your own list, one line per finding: `<id>: <one-line defect description>`), set `<TARGET>` to the code being fixed, and paste the entire block to the master session.

```text
Run the bug fix scenario per demos/code-bugfix/README.md, target code = <TARGET>, confirmed findings list:
<paste the confirmed list here: one line per finding, "<id>: <one-line defect description>">
1. Split the list into batches of 5 in list order (last batch may have fewer than 5). If the list is empty → stop and report truthfully.
2. For each batch b:
   - If b > 1, first team_delete(cr-fix) to remove the previous batch's old fix-team; then team_create(cr-fix) fresh instance (§1.2) → team_activate(cr-fix).
   - For each finding in batch b, launch one serial team_tollgate run (§1.3, replace <id> and <one-line defect description>). Each run has two gates: henry writes failing test → iris verifies; jack fixes → kate verifies; leo arbitrates INVALID escalations and signs off. max_gate_retries=2, max_invalid_cycles=3, signoff_policy=decider, signoff_decider=leo.
   - After the batch is done, team_deactivate(cr-fix).
3. After all batches, compile every <!-- FIXED: <id> --> marker + patch and present them to me for my judgment.
Notes:
- Member names must come from the 32-name preset pool (henry/iris/jack/kate/leo...), roles must use preset values like reviewer/coder/tester/evaluator.
- Always team_deactivate the current team before switching, otherwise team_activate will be rejected.
- fix-team rebuilt per batch: after each batch completes, delete the old fix-team, create a fresh instance. Within a batch, run tollgate serially one by one: one independent run per finding. Do not batch into a single run.
- **Strict serial between batches, no parallelism**: one batch fully completes before entering the next batch.
- When a team is running, poll team_progress/team_results at 30-second intervals, no more frequently.
```
