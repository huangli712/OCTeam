# team_quorum Orchestration Scenario Demo

`team_quorum` runs a replicated k-of-n ballot: N members **independently** answer the same fixed-schema question (no debate, no interaction); the option with strict majority (k > valid_ballots/2) wins. Both malformed ballots and runtime errors **abstain** — they are excluded from the denominator, not counted as no-votes. All members run to completion (no early-exit).

**Key difference from `team_consensus`**: consensus requires **unanimous agreement** through multi-round **debate**; quorum requires only a **strict majority** through single-round **independent voting**. Use consensus when members should persuade each other; use quorum when members should independently judge a fixed-set verdict.

---

## Scenario Overview

| # | Domain | Scenario | Members | Role | vote_options | Est. Total Duration |
|---|------|------|--------|------|------|-----------|
| 1 | Programming | PR merge approval (bugfix review) | 3 | `coder` | ship / hold / block | ~6 min |
| 2 | Math | Square-sum formula verification (3 candidates) | 5 | `mathematician` | 338350 / 338351 / 338500 | ~8 min |
| 3 | Computational Physics | Iterative simulation convergence verdict | 5 | `simulator` | converged / diverged / inconclusive | ~8 min |
| 4 | Governance | 7-member GDPR compliance committee (challenge-level) | 7 | `reviewer` | approve / deny / escrow | ~15 min |

---

## Scenario 1: PR Merge Approval (Bugfix Review)

### 1.1 Scenario Description

**Background**: A junior developer submitted a PR fixing an off-by-one array bounds bug in a binary search function. The fix is a single-line change (`high = len(arr)` → `high = len(arr) - 1`), includes a regression test, and the CI passes. Three reviewers independently inspect the PR and vote: `ship` (approve merge), `hold` (request changes), or `block` (reject). This is the canonical quorum use case: multi-reviewer merge gate.

**Goal**: 3 reviewers independently read the PR diff and test, each casting a single ballot. If `ship` reaches 2 votes (strict majority of 3), the PR is approved; otherwise it is held or blocked.

**Success criteria (machine-verifiable)**:
- Run terminates with `SUCCEEDED` status (a clean bugfix PR should reach majority)
- `winningOption` is `ship` (the fix is correct, tested, and minimal)
- `record.json` contains a `quorum` block with `ballots`, `threshold=2`, `nEff=3`
- Each member's `<vote>` tag in `<member>.md` matches their ballot in `record.json`

### 1.2 Team Config

```json
{
  "name": "pr-review",
  "description": "Bugfix PR merge approval: 3-way independent quorum vote (ship/hold/block)",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are an independent code reviewer on a 3-person merge-approval committee. You will inspect a PR and cast ONE ballot: ship (approve), hold (request changes), or block (reject).\n\nPR: Fix off-by-one in binary_search(). The bug: `high = len(arr)` causes IndexError when the target is larger than all elements. The fix: `high = len(arr) - 1`. A regression test `test_binary_search_upper_bound` is added. CI passes.\n\nReview independently — do NOT discuss with other reviewers. Make your own judgment based on correctness, test coverage, and merge risk.\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"ship\"}</vote> (or \"hold\" or \"block\"). You may include a one-line rationale before the <vote> tag."
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are an independent code reviewer on a 3-person merge-approval committee. You will inspect a PR and cast ONE ballot: ship (approve), hold (request changes), or block (reject).\n\nPR: Fix off-by-one in binary_search(). The bug: `high = len(arr)` causes IndexError when the target is larger than all elements. The fix: `high = len(arr) - 1`. A regression test `test_binary_search_upper_bound` is added. CI passes.\n\nReview independently — do NOT discuss with other reviewers. Make your own judgment based on correctness, test coverage, and merge risk.\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"ship\"}</vote> (or \"hold\" or \"block\"). You may include a one-line rationale before the <vote> tag."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are an independent code reviewer on a 3-person merge-approval committee. You will inspect a PR and cast ONE ballot: ship (approve), hold (request changes), or block (reject).\n\nPR: Fix off-by-one in binary_search(). The bug: `high = len(arr)` causes IndexError when the target is larger than all elements. The fix: `high = len(arr) - 1`. A regression test `test_binary_search_upper_bound` is added. CI passes.\n\nReview independently — do NOT discuss with other reviewers. Make your own judgment based on correctness, test coverage, and merge risk.\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"ship\"}</vote> (or \"hold\" or \"block\"). You may include a one-line rationale before the <vote> tag."
    }
  ]
}
```

**Design note**: Unlike `team_consensus` where each member advocates a DIFFERENT position, all quorum members receive the SAME prompt — they independently evaluate the same PR and reach their own conclusion. No debate, no role assignment.

**Role selection rationale**: `coder` uses the `oct-junior` agent, capable of reading diffs, assessing correctness, and judging merge risk — perfectly matching code review needs.

### 1.3 Master Launch Call

```json
{
  "tool": "team_quorum",
  "args": {
    "team_id": "pr-review",
    "task": "Review the binary_search bugfix PR (high=len(arr) → high=len(arr)-1 + regression test). Cast your ballot: ship, hold, or block.",
    "vote_key": "decision",
    "vote_options": ["ship", "hold", "block"],
    "timeout_ms": 600000
  }
}
```

**Parameter selection**:
- `vote_key: "decision"` — the ballot field name members emit inside `<vote>{"decision": "..."}</vote>`
- `vote_options: ["ship", "hold", "block"]` — 3-way whitelist; values outside this set abstain
- `timeout_ms: 600000` (10 min) — single-round vote, no debate; ~2 min per member, ~6 min total
- No `members` parameter — defaults to all 3 non-master members
- No `max_errored_members` — defaults to N-1=2 (tolerates up to 2 errors; with 1 valid ballot, threshold=1)
- No `signoff_*` — quorum IS the verdict; signoff would be a confusing double-gate
- No `human_approval` — single-round flow with no mid-run pause point

### 1.4 Execution Flow (Timeline)

```
T+0m    master calls team_quorum (task, vote_key, vote_options)
T+0m    OCTeam dispatches 3 coders in parallel, each receives the same vote prompt
T+0~2m  each member independently reads PR → reviews correctness/tests → casts <vote>
T+2m    all 3 members idle → wait-all barrier satisfied → TALLY
T+2m    threshold = floor(3/2)+1 = 2; count ballots; ship >= 2 → SUCCEEDED
T+2m    persistRun writes record.json with quorum block (ballots, winningOption, threshold, nEff)
T+2m    deliver summary to master
T+6m    run: bun check-coding-pr-review.ts <run_dir>
```

### 1.5 Check Script

[`check-coding-pr-review.ts`](./check-coding-pr-review.ts)

- **Load**: `<run_dir>/record.json` (authoritative quorum block) + `<run_dir>/{alice,bob,carol}.md` (cross-validation)
- **Extract**: `quorum.winningOption`, `quorum.threshold`, `quorum.nEff`, `quorum.ballots` from record.json; `<vote>` tags from member .md files
- **Assertions**:
  1. `record.type === "quorum"`
  2. `record.status === "completed"` (a clean PR should reach majority)
  3. `winningOption ∈ {ship, hold, block}`
  4. `threshold === floor(nEff/2)+1`
  5. Each valid ballot in record.json matches the member's `<vote>` tag in .md
  6. Winner's vote count >= threshold

---

## Scenario 2: Square-Sum Formula Verification

### 2.1 Scenario Description

**Background**: The sum of squares formula `Σ_{k=1}^{n} k² = n(n+1)(2n+1)/6` is a classic identity. For `n=100`: `100·101·201/6 = 338350`. Three candidate values are provided: `338350` (correct), `338351` (off-by-one), `338500` (truncated). Five mathematicians independently compute the sum and vote for the value they believe is correct. This is quorum's mathematical-verdict use case: independent computation, majority cross-validation.

**Goal**: 5 mathematicians each independently compute `Σ k²` for k=1..100, then vote for one of three candidate values. The correct answer `338350` should receive strict majority (≥3 of 5).

**Success criteria (machine-verifiable)**:
- Run terminates with `SUCCEEDED` status
- `winningOption === "338350"` (the mathematically correct value)
- `threshold === 3` (floor(5/2)+1)
- All valid ballots' votes match their member.md `<vote>` tags

### 2.2 Team Config

```json
{
  "name": "square-sum",
  "description": "Sum of k^2 for k=1..100: 5-way independent computation quorum (3 candidate values)",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are an independent mathematician on a 5-person verification committee. Compute the sum of k^2 for k=1 to 100, then vote for the correct value from these candidates: 338350, 338351, 338500.\n\nCompute independently using the formula n(n+1)(2n+1)/6 with n=100. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"answer\": \"338350\"}</vote> (or \"338351\" or \"338500\"). The value must be one of the three candidates."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are an independent mathematician on a 5-person verification committee. Compute the sum of k^2 for k=1 to 100, then vote for the correct value from these candidates: 338350, 338351, 338500.\n\nCompute independently using the formula n(n+1)(2n+1)/6 with n=100. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"answer\": \"338350\"}</vote> (or \"338351\" or \"338500\"). The value must be one of the three candidates."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are an independent mathematician on a 5-person verification committee. Compute the sum of k^2 for k=1 to 100, then vote for the correct value from these candidates: 338350, 338351, 338500.\n\nCompute independently using the formula n(n+1)(2n+1)/6 with n=100. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"answer\": \"338350\"}</vote> (or \"338351\" or \"338500\"). The value must be one of the three candidates."
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "You are an independent mathematician on a 5-person verification committee. Compute the sum of k^2 for k=1 to 100, then vote for the correct value from these candidates: 338350, 338351, 338500.\n\nCompute independently using the formula n(n+1)(2n+1)/6 with n=100. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"answer\": \"338350\"}</vote> (or \"338351\" or \"338500\"). The value must be one of the three candidates."
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "You are an independent mathematician on a 5-person verification committee. Compute the sum of k^2 for k=1 to 100, then vote for the correct value from these candidates: 338350, 338351, 338500.\n\nCompute independently using the formula n(n+1)(2n+1)/6 with n=100. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"answer\": \"338350\"}</vote> (or \"338351\" or \"338500\"). The value must be one of the three candidates."
    }
  ]
}
```

**Role selection rationale**: `mathematician` uses the `oct-junior` agent, capable of closed-form computation and formula verification — matching the independent computation needs.

### 2.3 Master Launch Call

```json
{
  "tool": "team_quorum",
  "args": {
    "team_id": "square-sum",
    "task": "Compute the sum of k^2 for k=1 to 100. Vote for the correct value from: 338350, 338351, 338500.",
    "vote_key": "answer",
    "vote_options": ["338350", "338351", "338500"],
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- `vote_key: "answer"` — members emit `<vote>{"answer": "338350"}</vote>`
- `vote_options` — three candidate values; a write-in value would abstain
- `timeout_ms: 900000` (15 min) — 5 members each doing a small computation; ~8 min total

### 2.4 Execution Flow (Timeline)

```
T+0m    master calls team_quorum
T+0m    OCTeam dispatches 5 mathematicians in parallel
T+0~3m  each member independently computes n(n+1)(2n+1)/6 for n=100
T+3m    each member emits <vote>{"answer": "338350"}</vote>
T+5m    all 5 idle → barrier → TALLY: threshold=3, 338350 gets 5 → SUCCEEDED
T+8m    run: bun check-math-square-sum.ts <run_dir>
```

### 2.5 Check Script

[`check-math-square-sum.ts`](./check-math-square-sum.ts)

- **Assertions**:
  1. Run succeeded
  2. `winningOption === "338350"` (the mathematically correct answer)
  3. Threshold/nEff consistent
  4. Ballots cross-validate against member.md `<vote>` tags

---

## Scenario 3: Iterative Simulation Convergence Verdict

### 3.1 Scenario Description

**Background**: A numerical simulation produces the following residual sequence over 20 iterations:

```
Iter  1: R = 1.23e+02
Iter  2: R = 8.45e+01
Iter  3: R = 5.12e+01
Iter  5: R = 1.87e+01
Iter  7: R = 6.34e+00
Iter 10: R = 7.92e-02
Iter 13: R = 9.81e-04
Iter 16: R = 1.21e-06
Iter 18: R = 1.44e-08
Iter 20: R = 3.81e-10
```

The residual decreases monotonically by ~2 orders of magnitude every 3 iterations, reaching machine-epsilon-level values by iteration 20. Five simulators independently analyze this residual sequence and vote on the convergence verdict: `converged` (residual reached acceptable tolerance), `diverged` (residual growing or oscillating), or `inconclusive` (insufficient data to determine).

**Goal**: 5 simulators independently assess the residual trend and cast a verdict ballot. The data clearly indicates monotonic convergence to ~1e-10, so `converged` should receive strict majority.

**Success criteria (machine-verifiable)**:
- Run terminates with `SUCCEEDED` status
- `winningOption === "converged"` (the residual monotonically drops to 1e-10)
- `threshold === 3` (floor(5/2)+1)
- Ballots cross-validate against member.md

### 3.2 Team Config

```json
{
  "name": "convergence-vote",
  "description": "Iterative simulation residual convergence verdict: 5-way independent quorum",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are an independent numerical analyst on a 5-person convergence assessment committee.\n\nAnalyze the following residual sequence from an iterative solver (20 iterations):\n  Iter 1: R=1.23e+02, Iter 2: R=8.45e+01, Iter 3: R=5.12e+01,\n  Iter 5: R=1.87e+01, Iter 7: R=6.34e+00, Iter 10: R=7.92e-02,\n  Iter 13: R=9.81e-04, Iter 16: R=1.21e-06, Iter 18: R=1.44e-08,\n  Iter 20: R=3.81e-10\n\nAssess independently: has the simulation converged, diverged, or is it inconclusive? Look for monotonic decrease, rate of reduction, and final residual magnitude. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"verdict\": \"converged\"}</vote> (or \"diverged\" or \"inconclusive\")."
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are an independent numerical analyst on a 5-person convergence assessment committee.\n\nAnalyze the following residual sequence from an iterative solver (20 iterations):\n  Iter 1: R=1.23e+02, Iter 2: R=8.45e+01, Iter 3: R=5.12e+01,\n  Iter 5: R=1.87e+01, Iter 7: R=6.34e+00, Iter 10: R=7.92e-02,\n  Iter 13: R=9.81e-04, Iter 16: R=1.21e-06, Iter 18: R=1.44e-08,\n  Iter 20: R=3.81e-10\n\nAssess independently: has the simulation converged, diverged, or is it inconclusive? Look for monotonic decrease, rate of reduction, and final residual magnitude. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"verdict\": \"converged\"}</vote> (or \"diverged\" or \"inconclusive\")."
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are an independent numerical analyst on a 5-person convergence assessment committee.\n\nAnalyze the following residual sequence from an iterative solver (20 iterations):\n  Iter 1: R=1.23e+02, Iter 2: R=8.45e+01, Iter 3: R=5.12e+01,\n  Iter 5: R=1.87e+01, Iter 7: R=6.34e+00, Iter 10: R=7.92e-02,\n  Iter 13: R=9.81e-04, Iter 16: R=1.21e-06, Iter 18: R=1.44e-08,\n  Iter 20: R=3.81e-10\n\nAssess independently: has the simulation converged, diverged, or is it inconclusive? Look for monotonic decrease, rate of reduction, and final residual magnitude. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"verdict\": \"converged\"}</vote> (or \"diverged\" or \"inconclusive\")."
    },
    {
      "name": "dave",
      "role": "simulator",
      "prompt": "You are an independent numerical analyst on a 5-person convergence assessment committee.\n\nAnalyze the following residual sequence from an iterative solver (20 iterations):\n  Iter 1: R=1.23e+02, Iter 2: R=8.45e+01, Iter 3: R=5.12e+01,\n  Iter 5: R=1.87e+01, Iter 7: R=6.34e+00, Iter 10: R=7.92e-02,\n  Iter 13: R=9.81e-04, Iter 16: R=1.21e-06, Iter 18: R=1.44e-08,\n  Iter 20: R=3.81e-10\n\nAssess independently: has the simulation converged, diverged, or is it inconclusive? Look for monotonic decrease, rate of reduction, and final residual magnitude. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"verdict\": \"converged\"}</vote> (or \"diverged\" or \"inconclusive\")."
    },
    {
      "name": "erin",
      "role": "simulator",
      "prompt": "You are an independent numerical analyst on a 5-person convergence assessment committee.\n\nAnalyze the following residual sequence from an iterative solver (20 iterations):\n  Iter 1: R=1.23e+02, Iter 2: R=8.45e+01, Iter 3: R=5.12e+01,\n  Iter 5: R=1.87e+01, Iter 7: R=6.34e+00, Iter 10: R=7.92e-02,\n  Iter 13: R=9.81e-04, Iter 16: R=1.21e-06, Iter 18: R=1.44e-08,\n  Iter 20: R=3.81e-10\n\nAssess independently: has the simulation converged, diverged, or is it inconclusive? Look for monotonic decrease, rate of reduction, and final residual magnitude. Do NOT discuss with other members.\n\nEmit your ballot EXACTLY as: <vote>{\"verdict\": \"converged\"}</vote> (or \"diverged\" or \"inconclusive\")."
    }
  ]
}
```

**Role selection rationale**: `simulator` is purpose-built for numerical simulation analysis (residual convergence, stability assessment), fitting the convergence verdict scenario.

### 3.3 Master Launch Call

```json
{
  "tool": "team_quorum",
  "args": {
    "team_id": "convergence-vote",
    "task": "Analyze the iterative solver residual sequence (Iter 1: 1.23e+02 → Iter 20: 3.81e-10, monotonic decrease). Vote: converged, diverged, or inconclusive?",
    "vote_key": "verdict",
    "vote_options": ["converged", "diverged", "inconclusive"],
    "timeout_ms": 900000
  }
}
```

### 3.4 Execution Flow (Timeline)

```
T+0m    master calls team_quorum
T+0m    OCTeam dispatches 5 simulators in parallel
T+0~3m  each member independently analyzes residual trend (monotonic, ~2 orders/3 iter)
T+3m    each member emits <vote>{"verdict": "converged"}</vote>
T+5m    all 5 idle → barrier → TALLY: threshold=3, converged gets 5 → SUCCEEDED
T+8m    run: bun check-physics-convergence.ts <run_dir>
```

### 3.5 Check Script

[`check-physics-convergence.ts`](./check-physics-convergence.ts)

- **Assertions**:
  1. Run succeeded
  2. `winningOption === "converged"` (residual monotonically drops to 1e-10)
  3. Threshold/nEff consistent
  4. Ballots cross-validate

---

## Scenario 4: 7-Member GDPR Compliance Committee (Challenge-Level)

**Challenge-level note**: This scenario deliberately breaks the easy-level constraint of "≤4 members, ≤30 min", using **7 members × `max_errored_members=2`** to simulate a realistic compliance committee at scale — larger N, explicit fault tolerance, and a genuinely borderline case where the outcome is NOT predetermined.

### 4.1 Scenario Description

**Background**: A EU-based SaaS company wants to transfer customer usage data to its US subsidiary for analytics processing. The data includes pseudonymized user IDs, IP addresses, and behavioral events. The company has Standard Contractual Clauses (SCCs) in place but has NOT yet conducted a Transfer Impact Assessment (TIA). The US subsidiary is subject to FISA 702 (US surveillance law). Under the Schrems II ruling, SCCs alone may be insufficient without a TIA evaluating whether US surveillance laws undermine the safeguards.

This is a **genuinely borderline case**:
- **Approve arguments**: pseudonymized data reduces identifiability; SCCs are the standard mechanism; business continuity requires the transfer
- **Deny arguments**: no TIA conducted (Schrems II requires it); FISA 702 exposure is real; IP addresses may be personal data under GDPR
- **Escrow arguments**: conditional approval pending TIA completion; the transfer is not clearly compliant nor clearly non-compliant

Seven compliance reviewers independently assess the case and vote: `approve`, `deny`, or `escrow` (request further assessment).

**Why this tests quorum's unique contracts**:
1. **Strict majority at scale** — N=7, threshold=4; tests that quorum correctly computes k > 7/2 = 4
2. **Abstain semantics** — `max_errored_members=2` explicitly tests that up to 2 errored/abstaining members do NOT block the vote (they are excluded from the denominator)
3. **Explicit failure is valid** — for a borderline case, `FAILED_NO_QUORUM` is an acceptable terminal state (unlike consensus, quorum admits "no majority reached" as a valid outcome, not a bug)
4. **Audit trail** — 7 ballots are fully persisted for compliance review

**Goal**: 7 reviewers independently assess the GDPR case. The quorum resolves to a verdict (any of approve/deny/escrow reaching 4 votes), OR correctly reports no majority. Either outcome demonstrates quorum working correctly.

**Success criteria (machine-verifiable)**:
- Run terminates with a valid quorum terminal state (`SUCCEEDED` or `FAILED_NO_QUORUM` — both acceptable)
- NOT `member_error` (max_errored_members=2 should prevent fault cascade for N=7)
- `threshold === 4` (floor(7/2)+1) if all 7 vote; adjusted if some abstain
- All 7 ballots persisted in record.json (audit completeness)
- At least one member's argument references a compliance keyword (GDPR, SCC, Schrems, FISA, etc.)

### 4.2 Team Config

```json
{
  "name": "gdpr-committee",
  "description": "Borderline GDPR cross-border data transfer case: 7-member compliance committee quorum vote (approve/deny/escrow)",
  "members": [
    {
      "name": "alice",
      "role": "reviewer",
      "prompt": "You are an independent compliance reviewer on a 7-person GDPR committee.\n\nCase: An EU SaaS company wants to transfer pseudonymized customer usage data (user IDs, IP addresses, behavioral events) to its US subsidiary for analytics. Standard Contractual Clauses (SCCs) are signed, but NO Transfer Impact Assessment (TIA) has been conducted. The US subsidiary is subject to FISA 702.\n\nAssess the GDPR compliance independently. Consider: Schrems II ruling (SCCs alone may be insufficient without TIA), pseudonymization effectiveness, IP address as personal data, FISA 702 surveillance exposure. Do NOT discuss with other committee members.\n\nVote: approve (transfer is compliant), deny (transfer violates GDPR), or escrow (conditional — requires TIA first).\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"approve\"}</vote> (or \"deny\" or \"escrow\"). Include a one-line rationale before the <vote> tag."
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are an independent compliance reviewer on a 7-person GDPR committee.\n\nCase: An EU SaaS company wants to transfer pseudonymized customer usage data (user IDs, IP addresses, behavioral events) to its US subsidiary for analytics. Standard Contractual Clauses (SCCs) are signed, but NO Transfer Impact Assessment (TIA) has been conducted. The US subsidiary is subject to FISA 702.\n\nAssess the GDPR compliance independently. Consider: Schrems II ruling (SCCs alone may be insufficient without TIA), pseudonymization effectiveness, IP address as personal data, FISA 702 surveillance exposure. Do NOT discuss with other committee members.\n\nVote: approve (transfer is compliant), deny (transfer violates GDPR), or escrow (conditional — requires TIA first).\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"approve\"}</vote> (or \"deny\" or \"escrow\"). Include a one-line rationale before the <vote> tag."
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are an independent compliance reviewer on a 7-person GDPR committee.\n\nCase: An EU SaaS company wants to transfer pseudonymized customer usage data (user IDs, IP addresses, behavioral events) to its US subsidiary for analytics. Standard Contractual Clauses (SCCs) are signed, but NO Transfer Impact Assessment (TIA) has been conducted. The US subsidiary is subject to FISA 702.\n\nAssess the GDPR compliance independently. Consider: Schrems II ruling (SCCs alone may be insufficient without TIA), pseudonymization effectiveness, IP address as personal data, FISA 702 surveillance exposure. Do NOT discuss with other committee members.\n\nVote: approve (transfer is compliant), deny (transfer violates GDPR), or escrow (conditional — requires TIA first).\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"approve\"}</vote> (or \"deny\" or \"escrow\"). Include a one-line rationale before the <vote> tag."
    },
    {
      "name": "dave",
      "role": "reviewer",
      "prompt": "You are an independent compliance reviewer on a 7-person GDPR committee.\n\nCase: An EU SaaS company wants to transfer pseudonymized customer usage data (user IDs, IP addresses, behavioral events) to its US subsidiary for analytics. Standard Contractual Clauses (SCCs) are signed, but NO Transfer Impact Assessment (TIA) has been conducted. The US subsidiary is subject to FISA 702.\n\nAssess the GDPR compliance independently. Consider: Schrems II ruling (SCCs alone may be insufficient without TIA), pseudonymization effectiveness, IP address as personal data, FISA 702 surveillance exposure. Do NOT discuss with other committee members.\n\nVote: approve (transfer is compliant), deny (transfer violates GDPR), or escrow (conditional — requires TIA first).\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"approve\"}</vote> (or \"deny\" or \"escrow\"). Include a one-line rationale before the <vote> tag."
    },
    {
      "name": "erin",
      "role": "reviewer",
      "prompt": "You are an independent compliance reviewer on a 7-person GDPR committee.\n\nCase: An EU SaaS company wants to transfer pseudonymized customer usage data (user IDs, IP addresses, behavioral events) to its US subsidiary for analytics. Standard Contractual Clauses (SCCs) are signed, but NO Transfer Impact Assessment (TIA) has been conducted. The US subsidiary is subject to FISA 702.\n\nAssess the GDPR compliance independently. Consider: Schrems II ruling (SCCs alone may be insufficient without TIA), pseudonymization effectiveness, IP address as personal data, FISA 702 surveillance exposure. Do NOT discuss with other committee members.\n\nVote: approve (transfer is compliant), deny (transfer violates GDPR), or escrow (conditional — requires TIA first).\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"approve\"}</vote> (or \"deny\" or \"escrow\"). Include a one-line rationale before the <vote> tag."
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are an independent compliance reviewer on a 7-person GDPR committee.\n\nCase: An EU SaaS company wants to transfer pseudonymized customer usage data (user IDs, IP addresses, behavioral events) to its US subsidiary for analytics. Standard Contractual Clauses (SCCs) are signed, but NO Transfer Impact Assessment (TIA) has been conducted. The US subsidiary is subject to FISA 702.\n\nAssess the GDPR compliance independently. Consider: Schrems II ruling (SCCs alone may be insufficient without TIA), pseudonymization effectiveness, IP address as personal data, FISA 702 surveillance exposure. Do NOT discuss with other committee members.\n\nVote: approve (transfer is compliant), deny (transfer violates GDPR), or escrow (conditional — requires TIA first).\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"approve\"}</vote> (or \"deny\" or \"escrow\"). Include a one-line rationale before the <vote> tag."
    },
    {
      "name": "grace",
      "role": "reviewer",
      "prompt": "You are an independent compliance reviewer on a 7-person GDPR committee.\n\nCase: An EU SaaS company wants to transfer pseudonymized customer usage data (user IDs, IP addresses, behavioral events) to its US subsidiary for analytics. Standard Contractual Clauses (SCCs) are signed, but NO Transfer Impact Assessment (TIA) has been conducted. The US subsidiary is subject to FISA 702.\n\nAssess the GDPR compliance independently. Consider: Schrems II ruling (SCCs alone may be insufficient without TIA), pseudonymization effectiveness, IP address as personal data, FISA 702 surveillance exposure. Do NOT discuss with other committee members.\n\nVote: approve (transfer is compliant), deny (transfer violates GDPR), or escrow (conditional — requires TIA first).\n\nEmit your ballot EXACTLY as: <vote>{\"decision\": \"approve\"}</vote> (or \"deny\" or \"escrow\"). Include a one-line rationale before the <vote> tag."
    }
  ]
}
```

**Role selection rationale**: `reviewer` is the read-only analytical role, perfectly matching compliance review (read case materials → assess → vote, no code changes needed). All 7 members use the same role — this is NOT a debate where members advocate different positions.

### 4.3 Master Launch Call

```json
{
  "tool": "team_quorum",
  "args": {
    "team_id": "gdpr-committee",
    "task": "GDPR cross-border data transfer case: EU→US pseudonymized data with SCCs but no TIA, FISA 702 exposure. Vote: approve, deny, or escrow.",
    "vote_key": "decision",
    "vote_options": ["approve", "deny", "escrow"],
    "max_errored_members": 2,
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- `vote_key: "decision"` — members emit `<vote>{"decision": "approve|deny|escrow"}</vote>`
- `vote_options` — three-way verdict; write-ins abstain
- **`max_errored_members: 2`** — explicit tolerance for up to 2 member errors. With N=7 and 2 errors, nEff=5, threshold=floor(5/2)+1=3 — still a workable majority. This tests quorum's "abstain not punish" contract at scale.
- `timeout_ms: 1200000` (20 min) — 7 members each doing compliance analysis; ~15 min total
- No `signoff_*` — the quorum IS the compliance verdict

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_quorum (max_errored_members=2)
T+0m     OCTeam dispatches 7 reviewers in parallel
T+0~5m   each member independently assesses GDPR case (Schrems II, TIA, FISA 702, pseudonymization)
T+5m     each member emits <vote>{"decision": "approve|deny|escrow"}</vote>
T+5~10m  members idle one by one — barrier waits for ALL 7 (no early exit)
T+10m    all 7 terminal → barrier fires → TALLY
         threshold = floor(7/2)+1 = 4
         count ballots per option
         ├─ some option >= 4 → SUCCEEDED, deliver verdict
         └─ no option >= 4   → FAILED_NO_QUORUM (valid for borderline case)
T+10m    persistRun writes 7 ballots to record.json (full audit trail)
T+15m    run: bun check-governance-compliance.ts <run_dir>
```

### 4.5 Check Script

[`check-governance-compliance.ts`](./check-governance-compliance.ts)

Unlike baseline scenarios (which assert a specific winning option), this challenge-level check validates the **quorum mechanism itself**:

- **Assertions**:
  1. `record.type === "quorum"`
  2. 7 participants in the quorum block
  3. Run terminated with `SUCCEEDED` OR `FAILED_NO_QUORUM` (both acceptable for a borderline case) — but NOT `member_error` (max_errored_members=2 should prevent fault cascade)
  4. `threshold === floor(nEff/2)+1` (mathematically correct, adjusting for any errored/abstaining members)
  5. All 7 ballots persisted in record.json (audit completeness)
  6. Ballots cross-validate against member.md `<vote>` tags
  7. At least one member's argument references a compliance keyword (`gdpr`, `compliance`, `cross-border`, `data transfer`, `privacy`)

---

## Quick-Start Prompts

Paste any of the following prompts to the master session, and the AI will automatically complete the full closed loop of "create team → activate → launch orchestration → wait for tally → run check script".

### Scenario 1: PR Merge Approval (Programming)

```text
Run the full closed loop of demos/19-team-quorum/README.md "Scenario 1" and auto-evaluate.

Steps:
1. Read README "1.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "1.3 Master Launch Call", start the orchestration using the team_quorum JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir> (contains record.json + each member <member>.md)
6. Run: bun demos/19-team-quorum/check-coding-pr-review.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: quorum SUCCEEDED with winningOption ∈ {ship, hold, block}; expected "ship" for a clean bugfix PR.
```

### Scenario 2: Square-Sum Verification (Math)

```text
Run the full closed loop of demos/19-team-quorum/README.md "Scenario 2" and auto-evaluate.

Steps:
1. Read README "2.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "2.3 Master Launch Call", start the orchestration using the team_quorum JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir>
6. Run: bun demos/19-team-quorum/check-math-square-sum.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: quorum SUCCEEDED with winningOption = "338350" (the correct sum of k^2 for k=1..100).
```

### Scenario 3: Simulation Convergence Verdict (Physics)

```text
Run the full closed loop of demos/19-team-quorum/README.md "Scenario 3" and auto-evaluate.

Steps:
1. Read README "3.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "3.3 Master Launch Call", start the orchestration using the team_quorum JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir>
6. Run: bun demos/19-team-quorum/check-physics-convergence.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: quorum SUCCEEDED with winningOption = "converged" (residual drops monotonically to 1e-10).
```

### Scenario 4: GDPR Compliance Committee (Challenge-Level, Governance)

```text
Run the full closed loop of demos/19-team-quorum/README.md "Scenario 4" and auto-evaluate (challenge-level, 7 members, estimated ~15 min).

Steps:
1. Read README "4.2 Team Config", create the team using the team_create JSON (7 reviewers)
2. team_activate
3. Read README "4.3 Master Launch Call", start the orchestration using the team_quorum JSON (max_errored_members=2)
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir> (contains record.json + 7 member .md files)
6. Run: bun demos/19-team-quorum/check-governance-compliance.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: quorum correctly resolves at scale — either SUCCEEDED (some option >= threshold=4) or FAILED_NO_QUORUM (no majority, valid for borderline case); NOT member_error (max_errored_members=2 prevents fault cascade). All 7 ballots persisted for audit.
```
