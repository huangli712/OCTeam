# team_workflow Advanced Engine Features Demo

`team_workflow` (advanced) demonstrates the declarative engine's loop, ensemble verifier, multi-branch fanout, and select-join capabilities. These four advanced features enable autonomous fix-verify loops, voting-based verification, parallel multi-branch execution with different join policies, and competitive "try multiple implementations, pick the best" patterns.

---

## Scenario Overview

| # | Domain | Scenario | Members | Engine Feature | Est. Duration |
|---|--------|----------|---------|----------------|---------------|
| 1 | Programming | Fix-verify loop: implement parseList, gate FAIL triggers retry via `on_fail_goto` + `loop` | 2 | `on_fail_goto` + `loop` | ~22 min |
| 2 | Math | Induction proof verification by ensemble of 3 reviewers (majority vote) | 4 | `verifiers` + `ensemble_policy: "majority"` | ~18 min |
| 3 | Programming | Multi-branch fanout: parallel sort testing with `join_policy: "all"` | 4 | `fanout` multi-branch + `join_policy: "all"` | ~20 min |
| 4 | Programming (challenge) | Competitive selection: 3 fibonacci implementations, reducer picks the best | 5 | `join_policy: "select"` + `reducer_member` | ~35 min |

> Scenario 4 is challenge-level: 5 members, 3-way competitive fanout with select-join, demonstrating the "try multiple approaches, pick the best" pattern.

---

## Scenario 1: Fix-Verify Loop — Implement parseList with Auto-Retry

### 1.1 Scenario Description

**Background**: When a gate issues FAIL, the engine can jump back to a prior task step instead of terminating the run. With `on_fail_goto` pointing at an earlier task step and a `loop` spec bounding iterations, the engine creates an autonomous fix-verify-fix cycle: the producer receives the FAIL diff, revises the implementation, and the gate re-evaluates. No human intervention needed.

**Goal**: Use `team_workflow` with `on_fail_goto` + `loop` to implement `parseList(s: string): number[]` that parses a comma-separated string of numbers into an array. Empty string returns `[]`. Malformed entries (non-numeric) are skipped. The gate verifies correctness; if it fails, the engine sends the coder back to fix, up to 3 iterations.

**Success criteria (machine-evaluable)**:
- step 1 (task: alice): produces a `parseList` TypeScript function embedded in a code block
- step 2 (gate: bob): verifies `parseList("1,2,3") = [1,2,3]`, `parseList("") = []`, `parseList("1,abc,3") = [1,3]`
- If FAIL: engine jumps back to step 1 (on_fail_goto: "implement"), bounded by max_iterations: 3
- Final verdict must be PASS

### 1.2 Team Configuration

```json
{
  "name": "fix-loop-wf",
  "description": "Workflow with on_fail_goto loop: coder iterates on parseList until the gate passes, up to 3 attempts"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block.\n\nYour output MUST end with a line exactly formatted: <!-- IMPL: parseList -->"
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You are a tester. You verify implementations by running them against edge cases. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Both task dispatches use the same `coder` (alice) because the loop sends her back to the SAME step; the gate uses an independent `tester` (bob) to avoid self-verification.

### 1.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "fix-loop-wf",
    "steps": [
      {
        "kind": "task",
        "id": "implement",
        "member": "alice",
        "task": "Implement `function parseList(s: string): number[]` that parses comma-separated numbers into an array. Empty string returns []. Malformed entries (non-numeric) are skipped. Embed code in a ```typescript fenced block. End with <!-- IMPL: parseList -->"
      },
      {
        "kind": "gate",
        "id": "verify",
        "verifier": "bob",
        "criteria": "Verify parseList('1,2,3') = [1,2,3], parseList('') = [], parseList('1,abc,3') = [1,3] (skip malformed). All three must pass.",
        "target_step": "implement",
        "on_fail": "fail",
        "on_fail_goto": "implement",
        "loop": { "max_iterations": 3, "on_exhaust": "fail" }
      }
    ],
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- step 1 `id: "implement"` — stable identifier so `on_fail_goto: "implement"` targets it precisely
- step 2 `verifier: "bob"` ≠ step 1 `member: "alice"` — satisfies "no self-verification"
- step 2 `on_fail: "fail"` — the gate's natural FAIL becomes a jump trigger (not a retry within the gate)
- step 2 `on_fail_goto: "implement"` — FAIL sends alice back to the implementation step with bob's diff feedback
- step 2 `loop: { max_iterations: 3, on_exhaust: "fail" }` — bounds the fix-verify cycle to 3 total attempts; if the fourth attempt also fails, the run terminates as `workflow_failed`
- `timeout_ms: 1200000` (20 min) — 3 iterations maximum, normal completion in ~22 min

### 1.4 Execution Flow (Timeline)

```
T+0m     master calls team_workflow
T+0m     engine dispatch step 1 (alice, task): implement parseList
T+0~5m   alice produces parseList code → idle
T+5m     engine advances to step 2 (gate): dispatch bob, feeds step 1 output + criteria
T+5~8m   bob runs test cases → <verdict>
         PASS  -> workflow_complete (iteration 0)
         FAIL  -> engine: on_fail_goto → re-dispatch step 1 (alice) with diff, attempt++ (iteration 1)
T+8m     [iteration 1] alice receives diff, fixes parseList → idle
T+8~11m  bob re-runs gate → <verdict>
         PASS  -> workflow_complete
         FAIL  -> on_fail_goto → re-dispatch step 1 (alice), attempt++ (iteration 2)
T+11m    [iteration 2] alice fixes again → idle
T+11~14m bob re-runs gate → <verdict>
         PASS  -> workflow_complete
         FAIL  -> on_fail_goto → re-dispatch step 1 (alice), attempt++ (iteration 3)
T+14m    [iteration 3] final chance; alice fixes → idle
T+14~17m bob re-runs gate → <verdict>
         PASS  -> workflow_complete
         FAIL  -> max_iterations exhausted → workflow_failed
T+17m    workflow_complete (or workflow_failed), summary delivered to master
```

### 1.5 Check Script

[`check-coding-fix-loop.ts`](./check-coding-fix-loop.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
  - alice.md: last ```typescript code block
  - bob.md: last `<verdict>{...}</verdict>` (the final gate verdict after any loop iterations)
- **Assertions**:
  1. alice.md contains `<!-- IMPL: parseList -->` marker
  2. `parseList` function is loadable from the code block
  3. `parseList("1,2,3")` deep-equals `[1,2,3]`
  4. `parseList("")` deep-equals `[]`
  5. `parseList("1,abc,3")` deep-equals `[1,3]`
  6. Bob's final verdict `result` is `PASS`

---

## Scenario 2: Proof Verification by Ensemble (Majority Vote)

### 2.1 Scenario Description

**Background**: Instead of a single verifier, a gate can have an ensemble of verifiers. Each verifier independently evaluates and emits a `<verdict>`. The `ensemble_policy` aggregates: `"majority"` (>50% agree), `"quorum"` (configurable fraction), or `"unanimous"` (all agree). This enables voting-based verification, reducing the risk of a single reviewer's mistake.

**Goal**: Use `team_workflow` with `verifiers` array + `ensemble_policy: "majority"` to verify a proof by induction that the sum of the first n natural numbers is `n(n+1)/2`. Three reviewers independently evaluate the proof; at least 2 of 3 must agree on PASS.

**Success criteria (machine-evaluable)**:
- step 1 (task: alice): produces a proof with base case (n=1) and inductive step, ending with `<!-- PROOF_OK: true -->`
- step 2 (gate, ensemble verifiers [bob, carol, dave]): each reviewer emits an independent verdict
- Majority (at least 2 of 3) verdicts are PASS

### 2.2 Team Configuration

```json
{
  "name": "proof-ensemble-wf",
  "description": "Ensemble gate: 3 reviewers independently verify an induction proof, majority-rule PASS/FAIL"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematician. You write rigorous mathematical proofs with clear base case and inductive step. Your output MUST end with exactly: <!-- PROOF_OK: true --> for a complete proof, or <!-- PROOF_OK: false --> otherwise."
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a reviewer. You independently verify mathematical proofs against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are a reviewer. You independently verify mathematical proofs against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    },
    {
      "name": "dave",
      "role": "reviewer",
      "prompt": "You are a reviewer. You independently verify mathematical proofs against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Alice (mathematician) produces the proof. Bob, Carol, and Dave are three independent `reviewer` agents who each evaluate separately. The ensemble policy aggregates their votes; none of them are the same member as alice, satisfying "no self-verification".

### 2.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "proof-ensemble-wf",
    "steps": [
      {
        "kind": "task",
        "id": "prove",
        "member": "alice",
        "task": "Prove by induction that the sum of the first n natural numbers equals n(n+1)/2. Show base case (n=1: 1 = 1·2/2 = 1) and the inductive step: assume sum(k=1..n) = n(n+1)/2, then show sum(k=1..n+1) = (n+1)(n+2)/2. End with <!-- PROOF_OK: true -->"
      },
      {
        "kind": "gate",
        "id": "review",
        "verifiers": ["bob", "carol", "dave"],
        "ensemble_policy": "majority",
        "criteria": "Verify the proof is mathematically correct: base case holds (n=1 gives 1=1), inductive hypothesis is correctly stated, inductive step uses the hypothesis correctly to derive sum(k=1..n+1) = (n+1)(n+2)/2, and the conclusion follows. Each verifier independently evaluates.",
        "target_step": "prove"
      }
    ],
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- step 1 `id: "prove"` — stable identifier for the gate's `target_step`
- step 2 `verifiers: ["bob", "carol", "dave"]` — three independent verifiers (array form), none equal to step 1's `alice`
- step 2 `ensemble_policy: "majority"` — at least 2 of 3 must agree on PASS for the gate to pass
- No `on_fail` retries — with 3 reviewers voting, a single FAIL is tolerated by majority; only if 2 or 3 FAIL does the whole run fail
- `timeout_ms: 900000` (15 min) — one task (~5 min) + 3 parallel verifiers (~5 min), normal completion in ~18 min

### 2.4 Execution Flow (Timeline)

```
T+0m     master calls team_workflow
T+0m     engine dispatch step 1 (alice, task): prove induction formula
T+0~6m   alice produces proof + PROOF_OK marker → idle
T+6m     engine advances to step 2 (gate): dispatch bob, carol, dave IN PARALLEL, each fed step 1 output + criteria
T+6~11m  bob evaluates independently → <verdict>  ┐
         carol evaluates independently → <verdict> ├─ parallel
         dave evaluates independently → <verdict>  ┘
T+11m    barrier: all 3 verifiers done → engine aggregates ensemble verdicts
         >= 2 PASS → gate PASS, workflow_complete
         >= 2 FAIL → gate FAIL, workflow_failed (no retry configured)
T+11m    workflow_complete (or workflow_failed), summary delivered to master
```

### 2.5 Check Script

[`check-math-proof-ensemble.ts`](./check-math-proof-ensemble.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,dave}.md`
- **Extract**:
  - alice.md: `<!-- PROOF_OK: true -->` marker
  - bob.md, carol.md, dave.md: individual `<verdict>{...}</verdict>` blocks
- **Assertions**:
  1. alice.md contains `<!-- PROOF_OK: true -->`
  2. Each reviewer emitted exactly one verdict
  3. At least 2 of 3 verdict `result` values are `PASS` (majority)
  4. Print each reviewer's verdict and rationale

---

## Scenario 3: Multi-Branch Fanout — Parallel Sort Testing with join_policy: "all"

### 3.1 Scenario Description

**Background**: The 10-team-workflow demo showed `fanout` with `join_policy: "reduce"` (aggregate all branches into one report). This scenario demonstrates `join_policy: "all"`, where EVERY branch must succeed for the workflow to advance. If any branch fails, the workflow fails. This is the strictest join policy, suitable for scenarios where each branch tests a critical independent path.

**Goal**: Use `team_workflow` with a 2-branch fanout and `join_policy: "all"` to implement two sort algorithms (`bubbleSort`, `mergeSort`) and test them in parallel against random data. Both branches must report success.

**Success criteria (machine-evaluable)**:
- step 1 (task: alice): produces `bubbleSort` and `mergeSort` TypeScript functions
- step 2 (fanout, 2 branches): bob tests bubbleSort, carol tests mergeSort against 7-element arrays
- step 3 (join, join_policy: "all"): both branches must pass
- step 4 (gate: frank): verifies overall correctness

### 3.2 Team Configuration

```json
{
  "name": "fanout-all-wf",
  "description": "Fanout workflow: implement two sort algorithms, test in parallel branches, all must pass"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block.\n\nYour output MUST end with a line exactly formatted: <!-- IMPL: sorts -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are a coder. You test implementations against test data. Your output MUST end with exactly: <!-- SORT_OK: true --> for a passing test, or <!-- SORT_OK: false --> for a failing test."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a coder. You test implementations against test data. Your output MUST end with exactly: <!-- SORT_OK: true --> for a passing test, or <!-- SORT_OK: false --> for a failing test."
    },
    {
      "name": "frank",
      "role": "tester",
      "prompt": "You are a tester. You verify that all parallel tests passed. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Alice (coder) implements both algorithms. Bob and Carol (coder ×2) each test one algorithm in parallel. Frank (tester) performs the final gate check.

### 3.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "fanout-all-wf",
    "steps": [
      {
        "kind": "task",
        "id": "implement",
        "member": "alice",
        "task": "Implement `function bubbleSort(arr: number[]): number[]` and `function mergeSort(arr: number[]): number[]`. Both sort ascending. Embed both in a single ```typescript fenced block. End with <!-- IMPL: sorts -->"
      },
      {
        "kind": "fanout",
        "id": "test_fanout",
        "join_policy": "all",
        "branches": [
          {
            "id": "bubble",
            "steps": [
              {
                "kind": "task",
                "member": "bob",
                "task": "Read alice's bubbleSort implementation from the upstream step. Test it on input array [5,3,8,1,9,2,7]. Verify the output is sorted ascending: [1,2,3,5,7,8,9]. Report correctness. End with <!-- SORT_OK: true --> or <!-- SORT_OK: false -->"
              }
            ]
          },
          {
            "id": "merge",
            "steps": [
              {
                "kind": "task",
                "member": "carol",
                "task": "Read alice's mergeSort implementation from the upstream step. Test it on input array [5,3,8,1,9,2,7]. Verify the output is sorted ascending: [1,2,3,5,7,8,9]. Report correctness. End with <!-- SORT_OK: true --> or <!-- SORT_OK: false -->"
              }
            ]
          }
        ]
      },
      {
        "kind": "join",
        "id": "collect"
      },
      {
        "kind": "gate",
        "id": "final",
        "verifier": "frank",
        "criteria": "Both sort test branches passed (each reported SORT_OK: true for its algorithm). Verify that bob's and carol's outputs both confirm correct sorting.",
        "target_step": "collect"
      }
    ],
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- step 2 `join_policy: "all"` — both branches must complete successfully; if either fails, the workflow fails
- step 2 branches each have a distinct `id` ("bubble", "merge") and use different members (bob, carol) so they run in parallel
- step 3 is a `join` that collects both branch outputs; the engine waits for the all-branch barrier
- step 4 `verifier: "frank"` — independent tester, not in any branch
- `timeout_ms: 1200000` (20 min) — implement (~6 min) + parallel testing (~6 min each) + gate (~5 min), normal completion in ~20 min

### 3.4 Execution Flow (Timeline)

```
T+0m     master calls team_workflow
T+0m     engine dispatch step 1 (alice, task): implement bubbleSort + mergeSort
T+0~6m   alice produces both sorts + IMPL marker → idle
T+6m     engine expands step 2 (fanout): parallel dispatch bob(bubble test), carol(merge test)
T+6~12m  bob tests bubbleSort on [5,3,8,1,9,2,7] → reports SORT_OK ┐
         carol tests mergeSort on [5,3,8,1,9,2,7] → reports SORT_OK ┘ (parallel)
T+12m    barrier: both branches complete → engine advances to step 3 (join)
T+12m    join collects branch outputs → engine advances to step 4 (gate)
T+12~17m frank reviews both test results → <verdict>
         PASS  -> workflow_complete
         FAIL  -> workflow_failed
T+17m    workflow_complete, summary delivered to master
```

### 3.5 Check Script

[`check-coding-matrix-scan.ts`](./check-coding-matrix-scan.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,frank}.md`
- **Extract**:
  - alice.md: ```typescript code block containing both sort functions
  - bob.md: `<!-- SORT_OK: true -->` marker for bubble test
  - carol.md: `<!-- SORT_OK: true -->` marker for merge test
  - frank.md: `<verdict>{...}</verdict>` gate verdict
- **Assertions**:
  1. alice.md contains `<!-- IMPL: sorts -->` marker
  2. `bubbleSort` and `mergeSort` are loadable from the code block
  3. `bubbleSort([5,3,8,1,9,2,7])` deep-equals `[1,2,3,5,7,8,9]`
  4. `mergeSort([5,3,8,1,9,2,7])` deep-equals `[1,2,3,5,7,8,9]`
  5. bob.md and carol.md both contain `SORT_OK: true`
  6. frank's verdict `result` is `PASS`

---

## Scenario 4: Select Best Implementation — Competitive Fibonacci (Challenge-Level)

**Challenge-level notes**: This scenario uses **5 members and 3 competitive branches with select-join**, demonstrating `team_workflow`'s "try multiple approaches, reducer picks the best" pattern. ~35 min.

### 4.1 Scenario Description

**Background**: `join_policy: "select"` is the competitive join: after a fanout runs multiple implementations in parallel, a `reducer_member` reviews all branch outputs and SELECTS one winner. This is useful when you want the team to explore different approaches and automatically pick the best one, rather than merging all results.

**Goal**: Use `team_workflow` with a 3-branch fanout and `join_policy: "select"` to implement `fibonacci(n)` three different ways (iterative, recursive with memoization, Binet's formula). A reducer picks the best implementation, and a gate verifies correctness.

**Success criteria (machine-evaluable)**:
- step 1 (fanout, 3 branches): alice (iterative), bob (recursive-memo), carol (binet) each implement fibonacci
- step 2 (join, join_policy: "select"): frank reviews all 3 and selects the best
- step 3 (gate: dave): verifies the SELECTED implementation computes fib(0)=0, fib(1)=1, fib(10)=55, fib(20)=6765

### 4.2 Team Configuration

```json
{
  "name": "select-best-wf",
  "description": "Competitive selection workflow: 3 fibonacci implementations, reducer picks the best approach"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block.\n\nYour output MUST end with a line exactly formatted: <!-- APPROACH: <name> -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block.\n\nYour output MUST end with a line exactly formatted: <!-- APPROACH: <name> -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block.\n\nYour output MUST end with a line exactly formatted: <!-- APPROACH: <name> -->"
    },
    {
      "name": "dave",
      "role": "reviewer",
      "prompt": "You are a reviewer. You verify that the selected fibonacci implementation is correct. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are a reviewer. You compare multiple implementations and select the best one. You consider correctness, time complexity, space complexity, and numerical stability.\n\nEmit a verdict: PASS if every criterion holds, FAIL otherwise.\n\nYour output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>. Also clearly state which implementation you selected: <!-- SELECTED: <approach-name> -->"
    }
  ]
}
```

**Role selection rationale**:
- `alice`, `bob`, `carol` (coder ×3): each implements fibonacci using a different approach, competing in parallel
- `frank` (reviewer): join reducer who reviews all 3 implementations and selects the winner
- `dave` (reviewer): gate verifier who independently confirms the selected implementation is correct

### 4.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "select-best-wf",
    "steps": [
      {
        "kind": "fanout",
        "id": "compete",
        "join_policy": "select",
        "reducer_member": "frank",
        "branches": [
          {
            "id": "iterative",
            "steps": [
              {
                "kind": "task",
                "member": "alice",
                "task": "Implement `function fibonacci(n: number): number` using an ITERATIVE approach (loop, O(n) time, O(1) space). Handle base cases n=0,1. Embed the full TypeScript in a ```typescript fenced block. End with <!-- APPROACH: iterative -->"
              }
            ]
          },
          {
            "id": "recursive",
            "steps": [
              {
                "kind": "task",
                "member": "bob",
                "task": "Implement `function fibonacci(n: number): number` using RECURSION with memoization (cache, O(n) time, O(n) space). Handle base cases n=0,1. Embed the full TypeScript in a ```typescript fenced block. End with <!-- APPROACH: recursive-memo -->"
              }
            ]
          },
          {
            "id": "binet",
            "steps": [
              {
                "kind": "task",
                "member": "carol",
                "task": "Implement `function fibonacci(n: number): number` using Binet's closed-form formula: fib(n) = (phi^n - psi^n) / sqrt(5) where phi = (1+sqrt(5))/2, psi = (1-sqrt(5))/2. Round to nearest integer. Handle base cases n=0,1. Embed the full TypeScript in a ```typescript fenced block. End with <!-- APPROACH: binet -->"
              }
            ]
          }
        ]
      },
      {
        "kind": "join",
        "id": "select_winner"
      },
      {
        "kind": "gate",
        "id": "verify_winner",
        "verifier": "dave",
        "criteria": "The selected fibonacci implementation correctly computes fib(0)=0, fib(1)=1, fib(10)=55, fib(20)=6765. Emit PASS only if all four values are correct; FAIL naming any incorrect value.",
        "target_step": "select_winner"
      }
    ],
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- step 1 `join_policy: "select"` + `reducer_member: "frank"` — after all 3 branches complete, frank reviews and selects one winner; the other implementations are discarded
- step 1 branch ids ("iterative", "recursive", "binet") are stable and identifiable in frank's selection output
- step 2 is a `join` that triggers frank's reducer dispatch; after frank produces the selection output, the join completes
- step 3 `verifier: "dave"` ≠ any branch member — independent verification of the selected implementation
- `timeout_ms: 1800000` (30 min) — 3 parallel implementations (~8 min) + reducer selection (~10 min) + gate verification (~8 min), normal completion in ~35 min

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_workflow
T+0m     engine expands step 1 (fanout): parallel dispatch alice(iterative), bob(recursive), carol(binet)
T+0~10m  alice implements iterative fibonacci → APPROACH: iterative ┐
         bob implements recursive-memo fibonacci → APPROACH: recursive-memo ├─ parallel
         carol implements binet fibonacci → APPROACH: binet         ┘
T+10m    barrier: all 3 branches complete → engine advances to step 2 (join, select)
T+10m    dispatch frank (reducer), feeds all 3 branch outputs
T+10~20m frank compares approaches: time complexity, space complexity, numerical stability
         frank selects winner → emits <!-- SELECTED: <approach> -->
T+20m    join completes → engine advances to step 3 (gate)
T+20m    dispatch dave (verifier), feeds selected implementation + criteria
T+20~28m dave tests fib(0)=0, fib(1)=1, fib(10)=55, fib(20)=6765 → <verdict>
         PASS  -> workflow_complete
         FAIL  -> workflow_failed
T+28m    workflow_complete, summary delivered to master
```

### 4.5 Check Script

[`check-coding-select-optimal.ts`](./check-coding-select-optimal.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,frank,dave}.md`
- **Extract**:
  - frank.md: `<!-- SELECTED: <approach> -->` marker indicating the winner
  - alice.md, bob.md, carol.md: ```typescript code blocks with `<!-- APPROACH: <name> -->` markers
  - dave.md: `<verdict>{...}</verdict>` gate verdict
- **Assertions**:
  1. Each coder's output has an `APPROACH` marker matching their assigned approach
  2. frank.md contains `SELECTED` marker naming the winner
  3. The selected approach's fibonacci function is loadable
  4. `fib(0) = 0`, `fib(1) = 1`, `fib(10) = 55`, `fib(20) = 6765`
  5. dave's verdict `result` is `PASS`

---

## Recovery and Checkpoint Granularity

`team_workflow` state is fully persisted in `activeTask` (`steps[]` + `currentStageIndex` cursor), including loop iteration counters for `on_fail_goto` loops and ensemble verifier states. After a process crash, `team_resume` re-drives the current step. For fanout branches with `join_policy: "all"`, crashed branches are re-dispatched; with `join_policy: "select"`, only the incomplete branches are resumed.

**Known limitations**: `on_fail_goto` loops count iterations per run, not per member session. A member who was mid-response during a crash is re-dispatched from scratch (full task replay). Ensemble verifiers run in parallel and the engine aggregates after the barrier.

---

## Quick-Start Prompts (Copy and Use)

Paste any of the following prompts into the master session and the AI will automatically complete the full loop of "create team → activate → launch orchestration → wait for summary → run check script".

### Scenario 1: Fix-Verify Loop — parseList with Auto-Retry (Programming)

```text
Run the complete closed loop for demos/15-team-workflow/README.md "Scenario 1" and auto-evaluate.
Steps:
1. Read README "1.2 Team Configuration", create team per team_create JSON (2 members: alice=coder, bob=tester)
2. team_activate to activate
3. Read README "1.3 Master Launch Call", start orchestration per team_workflow JSON (2-step loop: task(implement parseList) → gate(on_fail_goto back to implement, max 3 iterations))
4. Poll team_results until master receives summary (engine drives loop: alice implements → bob verifies → on FAIL jumps back to alice) (poll every 30s)
5. Locate <run_dir> (contains alice and bob's .md)
6. Run: bun demos/15-team-workflow/check-coding-fix-loop.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error
Success criteria: parseList handles all three cases correctly; bob's final verdict is PASS.
```

### Scenario 2: Proof Verification by Ensemble — Induction Proof with Majority Vote (Math)

```text
Run the complete closed loop for demos/15-team-workflow/README.md "Scenario 2" and auto-evaluate.
Steps:
1. Read README "2.2 Team Configuration", create team per team_create JSON (4 members: alice=mathematician, bob/carol/dave=reviewer)
2. team_activate to activate
3. Read README "2.3 Master Launch Call", start orchestration per team_workflow JSON (2-step: task(prove induction) → gate(ensemble verifiers [bob,carol,dave], majority rule))
4. Poll team_results until master receives summary (poll every 30s)
5. Locate <run_dir> (contains alice, bob, carol, dave .md)
6. Run: bun demos/15-team-workflow/check-math-proof-ensemble.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error
Success criteria: proof is marked PROOF_OK; at least 2 of 3 reviewers vote PASS.
```

### Scenario 3: Multi-Branch Fanout — Parallel Sort Testing with join_policy: "all" (Programming)

```text
Run the complete closed loop for demos/15-team-workflow/README.md "Scenario 3" and auto-evaluate.
Steps:
1. Read README "3.2 Team Configuration", create team per team_create JSON (4 members: alice/bob/carol=coder, frank=tester)
2. team_activate to activate
3. Read README "3.3 Master Launch Call", start orchestration per team_workflow JSON (4 steps: task(implement sorts) → fanout(2 branches parallel test) → join(all) → gate(verify))
4. Poll team_results until master receives summary (poll every 30s)
5. Locate <run_dir> (contains alice, bob, carol, frank .md)
6. Run: bun demos/15-team-workflow/check-coding-matrix-scan.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error
Success criteria: both sort algorithms correctly sort the test array; bob and carol both report SORT_OK: true; frank's verdict is PASS.
```

### Scenario 4: Select Best Implementation — Competitive Fibonacci with Reducer Selection (Challenge-Level · Programming)

```text
Run the complete closed loop for demos/15-team-workflow/README.md "Scenario 4" and auto-evaluate (challenge-level: 5 members, 3-way competitive fanout with select-join).
Steps:
1. Read README "4.2 Team Configuration", create team per team_create JSON (5 members: alice/bob/carol=coder, dave/frank=reviewer)
2. team_activate to activate
3. Read README "4.3 Master Launch Call", start orchestration per team_workflow JSON (3 steps: fanout(3 competing implementations) → join(select, frank is reducer) → gate(dave verifies winner))
4. Poll team_results until master receives summary (poll every 30s)
5. Locate <run_dir> (contains alice, bob, carol, frank, dave .md)
6. Run: bun demos/15-team-workflow/check-coding-select-optimal.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error
Success criteria: frank selects one winner; the selected fibonacci computes all four test values correctly; dave's verdict is PASS.
```
