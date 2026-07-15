# team_workflow Engine Automation Features Demo

`team_workflow` (engine automation) demonstrates the declarative engine's automation features that reduce manual intervention: `retry_on` auto-retry for incomplete output, `foreach` parameterized fanout with value substitution, `on_pass_goto` + `where` conditional branching by quality score, and resilience features (`on_timeout` / `fallback_member` + `fallback_verifier` / `on_malformed`).

---

## Scenario Overview

| # | Domain | Scenario | Members | Engine Feature | Est. Duration |
|---|--------|----------|---------|----------------|---------------|
| 1 | Programming | Auto-retry: implement factorial, retry until IMPL_DONE marker appears | 2 | `retry_on` + `max_task_retries` | ~16 min |
| 2 | Programming | Foreach fanout: implement bubbleSort, test against 3 auto-generated input types | 2 | `foreach` fanout + `${as}` substitution | ~14 min |
| 3 | Programming | Conditional branch: implement isPalindrome, gate score >= 0.8 jumps to deploy, else refines | 3 | `on_pass_goto` + `where` | ~18 min |
| 4 | Programming (challenge) | Resilient chain: implement deduplicate with timeout retry, fallback members, and malformed verdict handling | 6 | `on_timeout` + `fallback_member` + `on_malformed` | ~30 min |

> Scenario 4 is challenge-level: 6 members, 4 steps demonstrating timeout/fallback/malformed resilience in a single workflow run.

---

## Scenario 1: Auto-Retry on Incomplete Output — Factorial with retry_on

### 1.1 Scenario Description

**Background**: When a task step produces output that is clearly incomplete (missing a required marker, empty, or lacking expected content), the engine can automatically re-dispatch the member rather than waiting for a downstream gate to catch it. The `retry_on` field defines the condition, and `max_task_retries` bounds the attempts. This catches incomplete work early, before it reaches a verifier.

**Goal**: Use `team_workflow` with `retry_on: { output_not_contains: "IMPL_DONE" }` and `max_task_retries: 2` to implement a `factorial(n)` function. Alice must include the literal text `IMPL_DONE` in her output; if she forgets it on the first attempt, the engine retries her automatically up to 2 more times before advancing to the gate.

**Success criteria (machine-evaluable)**:
- step 1 (task: alice): produces a `factorial` TypeScript function, and output MUST contain the literal text `IMPL_DONE`
- Engine auto-retries alice if `IMPL_DONE` is missing, up to 2 additional attempts
- step 2 (gate: bob): verifies `factorial(0)=1`, `factorial(5)=120`, `factorial(10)=3628800`, `factorial(-1)` throws
- Final `workflow_complete`, gate PASS

### 1.2 Team Configuration

```json
{
  "name": "retry-on-wf",
  "description": "Workflow with retry_on: auto-retry coder up to 2 extra times if output lacks IMPL_DONE marker, then gate-verify"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block. Your output MUST contain the literal text IMPL_DONE and end with <!-- IMPL: factorial -->"
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You are a tester. You verify implementations by running them against edge cases. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Alice (coder) implements the function. Bob (tester) is the independent gate verifier; the `retry_on` condition operates on alice's output before bob ever sees it, so incomplete work never reaches the gate.

### 1.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "retry-on-wf",
    "steps": [
      {
        "kind": "task",
        "id": "implement",
        "member": "alice",
        "task": "Implement `function factorial(n: number): number` iteratively. Handle n=0 (return 1) and n<0 (throw Error). Embed code in a ```typescript fenced block. Your output MUST contain the literal text IMPL_DONE and end with <!-- IMPL: factorial -->",
        "retry_on": { "output_not_contains": "IMPL_DONE" },
        "max_task_retries": 2
      },
      {
        "kind": "gate",
        "id": "verify",
        "verifier": "bob",
        "criteria": "Verify factorial(0)=1, factorial(5)=120, factorial(10)=3628800. Also verify factorial(-1) throws. All must pass for PASS.",
        "target_step": "implement"
      }
    ],
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- step 1 `retry_on: { output_not_contains: "IMPL_DONE" }` — engine checks alice's output for the literal text `IMPL_DONE`; if absent, auto-retry
- step 1 `max_task_retries: 2` — up to 2 additional attempts after the initial one (3 total), preventing infinite loops
- step 2 `verifier: "bob"` ≠ step 1 `member: "alice"` — satisfies "no self-verification"
- No `on_fail` retry on the gate — if bob issues FAIL, the run fails (the implementation should be correct after surviving `retry_on`)
- `timeout_ms: 900000` (15 min) — one task with up to 3 attempts (~12 min) + one gate (~4 min), normal completion in ~16 min

### 1.4 Parameter Selection

`retry_on` supports four condition types, each based on the task member's raw output:

- `{ empty: true }` — retry if the output is empty or whitespace-only
- `{ output_contains: "TODO" }` — retry if the output contains a specific substring pattern
- `{ output_not_contains: "IMPL_DONE" }` — retry if the output does NOT contain a required marker
- `{ regex: "\\bTODO\\b" }` — retry if the output matches a JavaScript regular expression

All conditions operate on the task's captured output text. When a condition triggers, the engine immediately re-dispatches the same member with a nudge message noting which condition was not met. The member sees this as an additional instruction appended to their task context.

### 1.5 Execution Flow (Timeline)

```
T+0m     master calls team_workflow
T+0m     engine dispatch step 1 (alice, task): implement factorial
T+0~4m   alice produces code (attempt 1) → idle
T+4m     engine checks retry_on: output contains "IMPL_DONE"?
         YES -> engine advances to step 2 (gate)
         NO  -> engine re-dispatches alice with nudge "output must contain IMPL_DONE", attempt++ (1/2)
T+4~8m   [retry 1] alice revises, adds IMPL_DONE → idle
T+8m     engine re-checks retry_on
         YES -> engine advances to step 2 (gate)
         NO  -> engine re-dispatches alice, attempt++ (2/2)
T+8~12m  [retry 2] alice final attempt → idle
T+12m    engine re-checks retry_on
         YES -> engine advances to step 2 (gate)
         NO  -> max_task_retries exhausted → workflow_failed:retry_limit
T+12m    engine advances to step 2 (gate): dispatch bob, feeds step 1 output + criteria
T+12~16m bob runs factorial test cases → <verdict>
         PASS  -> workflow_complete
         FAIL  -> workflow_failed
T+16m    workflow_complete, summary delivered to master
```

### 1.6 Check Script

[`check-coding-retry-on.ts`](./check-coding-retry-on.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
  - alice.md: last ```typescript code block, IMPL_DONE marker
  - bob.md: last `<verdict>{...}</verdict>`
- **Assertions**:
  1. alice.md contains `IMPL_DONE` marker (retry_on satisfied)
  2. `factorial` function is loadable from the code block via `Bun.Transpiler`
  3. `factorial(0) === 1`
  4. `factorial(5) === 120`
  5. `factorial(10) === 3628800`
  6. `factorial(-1)` throws Error
  7. Bob's verdict `result` is `PASS`

---

## Scenario 2: Foreach Fanout — Sort Test Against Parameterized Inputs

### 2.1 Scenario Description

**Background**: The `foreach` field on a `fanout` step auto-generates branches from a list of values. Each value substitutes into the branch step text via `${value}` (or a custom `as` name). This avoids manually writing near-identical branches, making it ideal for parameterized testing where the same logic runs against multiple data configurations.

**Goal**: Use `team_workflow` with `foreach: ["sorted", "random", "reverse"]` and `as: "input"` on a fanout step to auto-generate 3 test branches. Alice implements `bubbleSort`, then bob tests it against 3 auto-generated input arrays (sorted, random with seed 42, reverse). Each branch reports success independently.

**Success criteria (machine-evaluable)**:
- step 1 (task: alice): produces a `bubbleSort` TypeScript function
- step 2 (fanout, foreach): auto-generates 3 branches, each substituting `${input}` with "sorted", "random", or "reverse"
- step 3 (join, join_policy: "all"): all 3 branches must pass
- Check script verifies bubbleSort correctness directly (does not depend on branch structure)

### 2.2 Team Configuration

```json
{
  "name": "foreach-wf",
  "description": "Workflow with foreach fanout: implement bubbleSort, auto-generate 3 test branches for different input patterns"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPL: bubbleSort -->"
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You are a tester. You test sort implementations against generated input arrays and verify correctness. Your output MUST end with exactly: <!-- SORT_OK: true --> for a passing test, or <!-- SORT_OK: false --> for a failing test."
    }
  ]
}
```

**Role selection rationale**: Alice (coder) implements `bubbleSort` once. Bob (tester) is used in all 3 foreach branches because each branch is independent and bob tests against a different input pattern.

### 2.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "foreach-wf",
    "steps": [
      {
        "kind": "task",
        "id": "implement",
        "member": "alice",
        "task": "Implement `function bubbleSort(arr: number[]): number[]` sorting ascending. Embed in ```typescript block. End with <!-- IMPL: bubbleSort -->"
      },
      {
        "kind": "fanout",
        "id": "test_inputs",
        "foreach": ["sorted", "random", "reverse"],
        "as": "input",
        "join_policy": "all",
        "branches": [
          {
            "id": "${input}",
            "steps": [
              {
                "kind": "task",
                "member": "bob",
                "task": "Read alice's bubbleSort from the upstream step. Generate a ${input} array of 500 integers: 'sorted' = [1,2,...,500], 'random' = shuffled with seed 42, 'reverse' = [500,499,...,1]. Sort with bubbleSort. Verify element-by-element against Array.prototype.sort. Report <!-- SORT_OK: true --> if correct, <!-- SORT_OK: false --> otherwise."
              }
            ]
          }
        ]
      },
      {
        "kind": "join",
        "id": "collect"
      }
    ],
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- step 2 `foreach: ["sorted", "random", "reverse"]` — the engine auto-generates 3 branches, one per value
- step 2 `as: "input"` — each branch substitutes `${input}` with its current value in all text fields
- step 2 `join_policy: "all"` — every branch must succeed for the workflow to advance; if any test fails, the workflow fails
- step 3 `join` collects all branch outputs after the barrier
- `timeout_ms: 900000` (15 min) — implement (~5 min) + 3 parallel test branches (~6 min each in parallel) + join (~2 min), normal completion in ~14 min

### 2.4 Parameter Selection

`foreach` and `matrix` are mutually exclusive ways to auto-generate fanout branches:

| Feature | Syntax | Example | Branches Generated |
|---------|--------|---------|--------------------|
| `foreach` | Single-dimension list + `${as}` substitution | `foreach: ["a","b","c"], as: "item"` | 3 branches, `${item}` = a, b, c |
| `matrix` | Cartesian product of named arrays | `matrix: { size: ["10","100"], type: ["int","float"] }` | 4 branches: (10,int), (10,float), (100,int), (100,float) |

Both are incompatible with explicit `branches` — you use `foreach` or `matrix` OR hand-written `branches`, not both.

### 2.5 Execution Flow (Timeline)

```
T+0m     master calls team_workflow
T+0m     engine dispatch step 1 (alice, task): implement bubbleSort
T+0~5m   alice produces bubbleSort code + IMPL marker → idle
T+5m     engine expands step 2 (fanout, foreach): auto-generate 3 branches
         branch 1 (id="sorted"): bob, input=sorted  ┐
         branch 2 (id="random"): bob, input=random  ├─ parallel
         branch 3 (id="reverse"): bob, input=reverse ┘
T+5~11m  bob tests bubbleSort on [1..500] ┐
         bob tests bubbleSort on shuffled(seed=42) ├─ parallel
         bob tests bubbleSort on [500..1]          ┘
T+11m    barrier: all 3 branches complete → engine advances to step 3 (join)
T+11m    join collects branch outputs → workflow advances
T+11m    workflow_complete, summary delivered to master
```

### 2.6 Check Script

[`check-coding-foreach-sort.ts`](./check-coding-foreach-sort.ts)

- **Load**: `runs/<run_id>/alice.md`
- **Extract**: last ```typescript code block
- **Assertions**:
  1. alice.md contains `bubbleSort` reference
  2. `bubbleSort([3,1,2])` deep-equals `[1,2,3]`
  3. `bubbleSort([5,4,3,2,1])` deep-equals `[1,2,3,4,5]`
  4. `bubbleSort([])` deep-equals `[]`
  5. `bubbleSort([1])` deep-equals `[1]`
- **Design note**: The check script verifies the core deliverable (bubbleSort correctness) directly and does not depend on the foreach branch structure, keeping the script simple and robust against engine dispatch variations.

---

## Scenario 3: Conditional Branch by Quality Score — isPalindrome with on_pass_goto + where

### 3.1 Scenario Description

**Background**: After a gate PASSes, the engine normally advances to the next step linearly. With `on_pass_goto`, the engine can jump to an arbitrary step instead. Combine this with a `where` clause, and the jump becomes conditional: only trigger when the verifier's score, confidence, or issue severity matches a threshold. This enables "quality gates" that route high-quality work to deployment and lower-quality work to a refinement loop.

**Goal**: Use `team_workflow` with `on_pass_goto: "deploy"` and `where: { score_gte: 0.8 }` to implement an `isPalindrome(s: string)` function. The reviewer (bob) scores the implementation. If score >= 0.8, the engine jumps directly to the "deploy" step. If score < 0.8, the engine advances linearly to a "refine" step where another coder improves the implementation.

**Success criteria (machine-evaluable)**:
- step 1 (task: alice): produces an `isPalindrome` TypeScript function
- step 2 (gate: bob): verifies correctness and scores 1.0 (clean code, all cases pass) or 0.5 (all pass but messy)
- If score >= 0.8: engine jumps to step 4 ("deploy"), alice writes deployment note
- If score < 0.8: engine advances to step 3 ("refine"), carol improves the code
- Check script verifies `isPalindrome` correctness only (does not assert which branch was taken)

### 3.2 Team Configuration

```json
{
  "name": "conditional-wf",
  "description": "Workflow with on_pass_goto + where: gate score >= 0.8 jumps to deploy, else falls through to refine"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPL: isPalindrome --> for implementation tasks, or <!-- DEPLOYED: true --> for deployment tasks."
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a reviewer. You verify code correctness and assign a quality score. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Include a score field (number between 0 and 1). Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"score\": <number>, \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a coder. You refine existing implementations for clarity and edge-case handling. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPL_REFINED: isPalindrome -->"
    }
  ]
}
```

**Role selection rationale**:
- Alice (coder): initial implementation and optionally writes the deployment note if the score is high enough
- Bob (reviewer): gate verifier whose score drives the conditional jump
- Carol (coder): refines the implementation only when the score is below threshold

### 3.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "conditional-wf",
    "steps": [
      {
        "kind": "task",
        "id": "implement",
        "member": "alice",
        "task": "Implement `function isPalindrome(s: string): boolean` that checks if a string reads the same forwards and backwards (case-insensitive, ignore spaces). Embed in ```typescript block. End with <!-- IMPL: isPalindrome -->"
      },
      {
        "kind": "gate",
        "id": "review",
        "verifier": "bob",
        "criteria": "Verify isPalindrome('racecar')=true, isPalindrome('hello')=false, isPalindrome('A man a plan a canal Panama')=true (ignore spaces, case-insensitive), isPalindrome('')=true. Score 1.0 if all pass with clean code, 0.5 if all pass but code is messy.",
        "target_step": "implement",
        "on_pass_goto": "deploy",
        "where": { "score_gte": 0.8 }
      },
      {
        "kind": "task",
        "id": "refine",
        "member": "carol",
        "task": "Previous isPalindrome scored below 0.8. Refine it for clarity and edge-case handling. Embed improved code. End with <!-- IMPL_REFINED: isPalindrome -->"
      },
      {
        "kind": "task",
        "id": "deploy",
        "member": "alice",
        "task": "Implementation passed review with high score. Write a one-line deployment note. End with <!-- DEPLOYED: true -->"
      }
    ],
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- step 2 `on_pass_goto: "deploy"` — when the gate PASSes, jump to the step with id "deploy"
- step 2 `where: { score_gte: 0.8 }` — the jump only fires when bob's verdict score >= 0.8; if score < 0.8 (or the score field is missing), the engine falls through normally to step 3 ("refine")
- step 2 `verifier: "bob"` ≠ step 1 `member: "alice"` — satisfies "no self-verification"
- step 3 `id: "refine"` — reached only when where condition is not met (score < 0.8)
- step 4 `id: "deploy"` — reached via jump when where condition is met (score >= 0.8)
- `timeout_ms: 900000` (15 min) — implement (~5 min) + gate (~4 min) + either refine or deploy (~5 min), normal completion in ~18 min

### 3.4 Parameter Selection

`where` supports four condition types on the gate verifier's verdict object:

| Condition | Meaning | Example |
|-----------|---------|---------|
| `score_gte: 0.8` | Verdict score >= threshold | Only jump when quality is high |
| `score_lt: 0.5` | Verdict score < threshold | Redirect low-quality work to redo |
| `confidence_gte: 0.9` | Verdict confidence >= threshold | Only trust high-confidence verdicts for jumps |
| `has_issue_severity: "critical"` | Verdict has an issue at this severity | Jump to escalation path for critical issues |

Multiple `where` conditions are ANDed together when the engine evaluates the jump. If any condition fails, the jump is skipped and the engine advances linearly.

### 3.5 Execution Flow (Timeline)

```
T+0m     master calls team_workflow
T+0m     engine dispatch step 1 (alice, task): implement isPalindrome
T+0~5m   alice produces isPalindrome code + IMPL marker → idle
T+5m     engine advances to step 2 (gate): dispatch bob, feeds step 1 output + criteria
T+5~9m   bob runs test cases + scores → <verdict>
         FAIL         -> workflow_failed
         PASS, score >= 0.8 -> engine evaluates on_pass_goto + where -> matches -> jump to step 4 ("deploy")
         PASS, score < 0.8  -> engine evaluates on_pass_goto + where -> fails -> advance to step 3 ("refine")

         ┌─ [score >= 0.8 path] ───────────────────────────────────┐
T+9m     │ engine jumps to step 4 ("deploy"): dispatch alice        │
T+9~14m  │ alice writes deployment note → <!-- DEPLOYED: true -->   │
T+14m    │ all steps complete (step 3 skipped) -> workflow_complete │
         └──────────────────────────────────────────────────────────┘

         ┌─ [score < 0.8 path] ──────────────────────────────────┐
T+9m     │ engine advances to step 3 ("refine"): dispatch carol   │
T+9~14m  │ carol refines isPalindrome → IMPL_REFINED              │
T+14m    │ engine checks no more steps → workflow_complete        │
         └────────────────────────────────────────────────────────┘

T+14m    workflow_complete, summary delivered to master
```

### 3.6 Check Script

[`check-coding-conditional-branch.ts`](./check-coding-conditional-branch.ts)

- **Load**: `runs/<run_id>/alice.md`
- **Extract**: last ```typescript code block
- **Assertions**:
  1. alice.md contains `isPalindrome` reference
  2. `isPalindrome("racecar") === true`
  3. `isPalindrome("hello") === false`
  4. `isPalindrome("A man a plan a canal Panama") === true` (case-insensitive, ignoring spaces)
  5. `isPalindrome("") === true`
- **Design note**: The check script verifies only implementation correctness, intentionally not asserting which branch (deploy vs refine) was taken since both are valid outcomes depending on the reviewer's score.

---

## Scenario 4: Resilient Chain — deduplicate with Timeout Retry, Fallback, and Malformed Handling (Challenge-Level)

> **Challenge-level notes**: This scenario uses **6 members and 4 steps**, demonstrating three resilience features bundled in a single workflow: `on_timeout` + `max_timeout_retries` (retry on timeout), `fallback_member` / `fallback_verifier` (automatic actor substitution), and `on_malformed` + `max_malformed_retries` (handle unparseable verdicts). ~30 min.

### 4.1 Scenario Description

**Background**: Real workflows encounter failures beyond incorrect outputs: members can time out, sessions can become unavailable, and verifier output can be garbled. The engine provides three resilience features to handle these without human intervention. This scenario bundles all three into a single 4-step pipeline implementing a `deduplicate` function with verification, documentation, and final review.

**Goal**: Use `team_workflow` to implement `deduplicate(arr: number[]): number[]` that removes duplicates while preserving first-occurrence order. The workflow demonstrates: (1) alice's task step has `timeout_ms: 300000` with `on_timeout: "retry"` and `max_timeout_retries: 1`, and `fallback_member: "bob"`; (2) dave's gate step has `on_malformed: "retry_verifier"` with `max_malformed_retries: 2`, and `fallback_verifier: "erin"`; (3) carol produces documentation, frank performs a final gate review.

**Success criteria (machine-evaluable)**:
- step 1 (task: alice/bob fallback): produces a `deduplicate` TypeScript function, with timeout retry and fallback protection
- step 2 (gate: dave/erin fallback): verifies correctness, with malformed verdict retry and fallback verifier
- step 3 (task: carol): writes usage documentation with `DOCS_OK` marker
- step 4 (gate: frank): verifies documentation completeness
- Check script is fallback-aware: reads the first available of alice/bob and dave/erin

### 4.2 Team Configuration

```json
{
  "name": "resilient-wf",
  "description": "Resilient workflow: timeout retry + fallback members + malformed verdict handling in a 4-step deduplicate pipeline"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPL: deduplicate -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are a coder (fallback). You implement TypeScript functions with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPL: deduplicate -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a coder. You write clear usage documentation with examples. Your output MUST end with a line exactly formatted: <!-- DOCS_OK: true -->"
    },
    {
      "name": "dave",
      "role": "tester",
      "prompt": "You are a tester (primary verifier). You verify implementations against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    },
    {
      "name": "erin",
      "role": "tester",
      "prompt": "You are a tester (fallback verifier). You verify implementations against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are a reviewer. You verify documentation completeness. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**:
- Alice (coder): primary implementer; Bob (coder): fallback if alice times out or is unavailable
- Dave (tester): primary gate verifier; Erin (tester): fallback verifier if dave produces malformed verdicts or is unavailable
- Carol (coder): writes documentation (independent task, no fallback needed)
- Frank (reviewer): final gate review (independent verifier)

### 4.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "resilient-wf",
    "steps": [
      {
        "kind": "task",
        "id": "implement",
        "member": "alice",
        "fallback_member": "bob",
        "task": "Implement `function deduplicate(arr: number[]): number[]` that removes duplicates, preserving first-occurrence order. Embed in ```typescript block. End with <!-- IMPL: deduplicate -->",
        "timeout_ms": 300000,
        "on_timeout": "retry",
        "max_timeout_retries": 1
      },
      {
        "kind": "gate",
        "id": "verify",
        "verifier": "dave",
        "fallback_verifier": "erin",
        "criteria": "Verify deduplicate([1,2,2,3,3,3])=[1,2,3], deduplicate([])=[], deduplicate([5,5,5,5])=[5]. All must pass for PASS.",
        "target_step": "implement",
        "on_malformed": "retry_verifier",
        "max_malformed_retries": 2
      },
      {
        "kind": "task",
        "id": "document",
        "member": "carol",
        "task": "Write usage documentation for deduplicate with 2 examples. End with <!-- DOCS_OK: true -->"
      },
      {
        "kind": "gate",
        "id": "final_review",
        "verifier": "frank",
        "criteria": "Verify documentation exists and covers deduplicate usage with at least 2 examples.",
        "target_step": "document"
      }
    ],
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- step 1 `timeout_ms: 300000` (5 min) — alice has 5 minutes to produce the implementation
- step 1 `on_timeout: "retry"` — if alice's task times out, re-dispatch her instead of failing immediately
- step 1 `max_timeout_retries: 1` — one retry after timeout; if it times out again, switch to `fallback_member: "bob"`
- step 1 `fallback_member: "bob"` — if alice cannot complete (session unavailable or exhausted retries), bob takes over
- step 2 `on_malformed: "retry_verifier"` — if dave produces unparseable verdict JSON, retry him instead of failing
- step 2 `max_malformed_retries: 2` — up to 2 retries for malformed output; if still malformed, switch to `fallback_verifier: "erin"`
- step 2 `fallback_verifier: "erin"` — if dave cannot produce valid verdicts, erin takes over
- step 2 `verifier: "dave"` ≠ step 1 `member: "alice"` — satisfies "no self-verification"
- step 4 `verifier: "frank"` ≠ step 3 `member: "carol"` — also satisfies "no self-verification"
- No `on_fail` retry on gates — the resilience features handle timeout/malformed issues, not logic failures
- `timeout_ms: 1800000` (30 min) — 4 steps with potential retries and fallbacks, normal completion in ~28 min

### 4.4 Parameter Selection

The resilience features are layered: the engine applies them in priority order during step dispatch.

**`on_timeout` behavior** (for task steps only):

| Setting | Behavior |
|---------|----------|
| `"fail"` (default) | Timeout causes `workflow_failed:timeout` |
| `"retry"` | Re-dispatches the same member up to `max_timeout_retries` times; exhausted → fallback or fail |
| `"skip"` | Marks the step skipped, advances to the next step |

**`fallback_member` / `fallback_verifier` behavior**: When a task/gate step's primary actor has no live session (session not yet created, member errored, or retries exhausted), the engine automatically switches to the fallback. If the fallback is also unavailable: top-level steps terminate as `workflow_failed:no_session:<member>`; branch steps degrade to errored branches (subject to `max_errored` / `join_policy` constraints).

**`on_malformed` behavior** (for gate steps only, independent from `on_invalid`):

| Setting | Behavior |
|---------|----------|
| `"fail"` (falls back to `on_invalid`) | Malformed verdict follows the gate's `on_invalid` policy |
| `"retry_verifier"` | Re-dispatches the verifier up to `max_malformed_retries` times; exhausted → fallback or fail |
| `"skip"` | Marks the gate skipped, advances to the next step |
| `"escalate"` | Pauses for human approval via `team_approve` / `team_reject` |

### 4.5 Execution Flow (Timeline)

```
T+0m     master calls team_workflow
T+0m     engine dispatch step 1 (alice, task): implement deduplicate (timeout=5min)
T+0~5m   alice produces deduplicate code → idle (within timeout)
         OR alice times out → engine retries alice (on_timeout: "retry", max 1)
           T+5~10m  [retry] alice re-attempts → produces code OR times out again
           T+10m    [retry exhausted] engine switches to fallback_member: bob
           T+10~15m bob produces deduplicate code → idle
T+5/10/15m  engine advances to step 2 (gate): dispatch dave, feeds step 1 output + criteria
T+5/10/15~20m  dave evaluates deduplicate → <verdict>
         Valid PASS/FAIL → engine advances normally
         Malformed (unparseable) → engine retries dave (on_malformed: "retry_verifier", max 2)
           [malformed retry 1] dave re-dispatched with nudge
           [malformed retry 2] dave re-dispatched again
           [retries exhausted] engine switches to fallback_verifier: erin
           erin evaluates deduplicate → valid <verdict>
T+20m    engine advances to step 3 (task): dispatch carol
T+20~25m carol writes usage docs + 2 examples → <!-- DOCS_OK: true --> → idle
T+25m    engine advances to step 4 (gate): dispatch frank
T+25~28m frank reviews documentation → <verdict>
         PASS  -> workflow_complete
         FAIL  -> workflow_failed
T+28m    workflow_complete, summary delivered to master
```

### 4.6 Check Script

[`check-coding-resilient-chain.ts`](./check-coding-resilient-chain.ts)

- **Load**: `runs/<run_id>/{alice,bob,dave,erin,carol}.md` — fallback-aware, reads first available
- **Extract**:
  - alice.md or bob.md (whichever has content): last ```typescript code block
  - dave.md or erin.md (whichever has content): last `<verdict>{...}</verdict>`
  - carol.md: `DOCS_OK` marker
- **Assertions**:
  1. Implementer output contains `deduplicate` reference
  2. `deduplicate([1,2,2,3,3,3])` deep-equals `[1,2,3]`
  3. `deduplicate([])` deep-equals `[]`
  4. `deduplicate([5,5,5,5])` deep-equals `[5]`
  5. Verifier verdict `result` is `PASS`
  6. carol.md contains `DOCS_OK` marker

---


## Quick-Start Prompts (Copy and Use)

Paste any of the following prompts into the master session and the AI will automatically complete the full loop of "create team → activate → launch orchestration → wait for summary → run check script".

### Scenario 1: Auto-Retry on Incomplete Output — Factorial with retry_on (Programming)

```text
Run the complete closed loop for demos/16-team-workflow/README.md "Scenario 1" and auto-evaluate.
Steps:
1. Read README "1.2 Team Configuration", create team per team_create JSON (2 members: alice=coder, bob=tester)
2. team_activate to activate
3. Read README "1.3 Master Launch Call", start orchestration per team_workflow JSON (2-step: task(factorial, retry_on: output_not_contains IMPL_DONE, max_task_retries:2) → gate(verify factorial))
4. Poll team_results until master receives summary (engine auto-retries alice if IMPL_DONE missing) (poll every 30s)
5. Locate <run_dir> (contains alice and bob's .md)
6. Run: bun demos/16-team-workflow/check-coding-retry-on.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error
Success criteria: factorial(0)=1, factorial(5)=120, factorial(10)=3628800, factorial(-1) throws; bob's verdict is PASS.
```

### Scenario 2: Foreach Fanout — Sort Test Against Parameterized Inputs (Programming)

```text
Run the complete closed loop for demos/16-team-workflow/README.md "Scenario 2" and auto-evaluate.
Steps:
1. Read README "2.2 Team Configuration", create team per team_create JSON (2 members: alice=coder, bob=tester)
2. team_activate to activate
3. Read README "2.3 Master Launch Call", start orchestration per team_workflow JSON (3 steps: task(implement bubbleSort) → fanout(foreach [sorted,random,reverse], join_policy:all) → join)
4. Poll team_results until master receives summary (engine auto-generates 3 branches, bob tests in parallel) (poll every 30s)
5. Locate <run_dir> (contains alice.md)
6. Run: bun demos/16-team-workflow/check-coding-foreach-sort.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error
Success criteria: bubbleSort correctly sorts ascending; handles empty and single-element arrays.
```

### Scenario 3: Conditional Branch by Quality Score — isPalindrome with on_pass_goto + where (Programming)

```text
Run the complete closed loop for demos/16-team-workflow/README.md "Scenario 3" and auto-evaluate.
Steps:
1. Read README "3.2 Team Configuration", create team per team_create JSON (3 members: alice=coder, bob=reviewer, carol=coder)
2. team_activate to activate
3. Read README "3.3 Master Launch Call", start orchestration per team_workflow JSON (4 steps: task(implement isPalindrome) → gate(on_pass_goto:deploy, where:score_gte 0.8) → task(refine) → task(deploy))
4. Poll team_results until master receives summary (engine conditionally jumps to deploy or falls through to refine) (poll every 30s)
5. Locate <run_dir> (contains alice.md)
6. Run: bun demos/16-team-workflow/check-coding-conditional-branch.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error
Success criteria: isPalindrome correctly handles all cases (palindrome, non-palindrome, spaces, case, empty).
```

### Scenario 4: Resilient Chain — deduplicate with Timeout Retry, Fallback, and Malformed Handling (Challenge-Level · Programming)

```text
Run the complete closed loop for demos/16-team-workflow/README.md "Scenario 4" and auto-evaluate (challenge-level: 6 members, 4 steps with timeout retry, fallback members, and malformed verdict handling).
Steps:
1. Read README "4.2 Team Configuration", create team per team_create JSON (6 members: alice/bob=coder, carol=coder, dave/erin=tester, frank=reviewer)
2. team_activate to activate
3. Read README "4.3 Master Launch Call", start orchestration per team_workflow JSON (4 steps: task(deduplicate, timeout retry + fallback) → gate(verify, malformed retry + fallback) → task(document) → gate(final review))
4. Poll team_results until master receives summary (engine handles timeout retries, fallback switches, and malformed verdicts automatically) (poll every 30s)
5. Locate <run_dir> (contains alice/bob, dave/erin, carol .md)
6. Run: bun demos/16-team-workflow/check-coding-resilient-chain.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error
Success criteria: deduplicate correctly removes duplicates preserving order; verifier PASS; carol has DOCS_OK marker.
```
