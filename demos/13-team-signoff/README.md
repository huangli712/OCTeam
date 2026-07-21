# Post-Completion Signoff Scenario Demo

Signoff demonstrates the `signoff_policy` parameter (decider / peer-quorum) across multiple orchestration modes: delegate, parallel, and pipeline. Signoff is a post-completion review gate that dispatches member reviewers AFTER the main orchestration task finishes but BEFORE results are delivered to the leader. Unlike `human_approval`, signoff is fully automatic — no leader intervention needed.

---

## Signoff Mechanism

`signoff_policy` has two modes:

1. **`"decider"`** + `signoff_decider: "<member>"`: A single named reviewer is dispatched with a signoff review prompt. They emit `<signoff>{"approved": true, "rationale": "..."}</signoff>` or `<signoff>{"approved": false, "rationale": "specific issues..."}</signoff>`. If approved — run completes with reason "signoff_approved". If rejected — "signoff_rejected".

2. **`"peer-quorum"`** + `signoff_quorum: <fraction>`: ALL non-master members are dispatched with the signoff review prompt. Each emits the `<signoff>` tag. If the fraction of approvals meets the quorum threshold — "signoff_quorum_reached". Otherwise — "signoff_quorum_not_reached".

The signoff review prompt is automatically generated:
```
[Signoff review] Review the following workflow output.
If it meets quality standards, emit <signoff>{"approved": true, "rationale": "..."}</signoff>.
If not, emit <signoff>{"approved": false, "rationale": "specific issues..."}</signoff>.

<summary of all member outputs>
```

## Scenario Overview

| # | Domain | Scenario | Tool | signoff_policy | Members | Est. Duration |
|---|------|------|------|-----------|--------|-----------|
| 1 | Programming | Utility function delegate with decider signoff | `team_delegate` | `decider` (carol) | 3 | ~12 min |
| 2 | Programming | Sort implementation parallel with peer-quorum | `team_parallel` | `peer-quorum` (0.67) | 3 | ~15 min |
| 3 | Math | Sum-of-squares pipeline with peer-quorum | `team_pipeline` | `peer-quorum` (default 0.5) | 3 | ~12 min |
| 4 | Programming | Multi-stage build pipeline with decider signoff (Challenge) | `team_pipeline` | `decider` (frank) | 6 | ~45 min |

---

## Scenario 1: Utility Function Delegate with Decider Signoff

### 1.1 Scenario Description

**Background**: In delegate mode, members self-claim tasks from a shared task list, solve them autonomously, and report back. The post-completion signoff adds a quality gate: after all tasks are done, a designated reviewer checks every output before the results are delivered. This is the simplest signoff pattern — one reviewer, one vote.

**Goal**: Publish 3 independent programming tasks (toCamelCase, slugify, capitalize). Three coder members self-claim and implement. After all tasks complete, carol (the reviewer) automatically reviews all outputs and emits an approval verdict.

**Success Criteria (Machine-Verifiable)**:
- Combined outputs contain all 3 implementation markers: `<!-- IMPL: toCamelCase -->`, `<!-- IMPL: slugify -->`, `<!-- IMPL: capitalize -->`
- At least one `<signoff>` tag with `"approved": true` found across all member outputs (carol's signoff verdict)

### 1.2 Team Configuration

```json
{
    "name": "util-signoff",
    "description": "Utility function implementers with decider signoff: 2 coders implement, 1 reviewer signs off",
    "members": [
        {
            "name": "alice",
            "role": "coder",
            "prompt": "You are a coder. You work in delegate mode: use team_task_list to find available tasks, claim one with team_task_update (status 'claimed'), implement exactly as the task description specifies, then write the full implementation code AND the output marker directly in your response text (not just via team_send_message). After writing your response, also report to master via team_send_message and release the task. Each task description specifies the exact output marker — include that marker line verbatim in your response.\n\nRepeat until no tasks remain."
        },
        {
            "name": "bob",
            "role": "coder",
            "prompt": "You are a coder. You work in delegate mode: use team_task_list to find available tasks, claim one with team_task_update (status 'claimed'), implement exactly as the task description specifies, then write the full implementation code AND the output marker directly in your response text (not just via team_send_message). After writing your response, also report to master via team_send_message and release the task. Each task description specifies the exact output marker — include that marker line verbatim in your response.\n\nRepeat until no tasks remain."
        },
        {
            "name": "carol",
            "role": "reviewer",
            "prompt": "You are a reviewer. After the coders complete their tasks, you will be automatically dispatched with a signoff review prompt containing a summary of all member outputs. Review the implementations for correctness and completeness, then emit your verdict as <signoff>{\"approved\": true/false, \"rationale\": \"...\"}</signoff>."
        }
    ]
}
```

**Role Selection Rationale**: `coder` members (alice, bob) implement the utility functions using the `oct-junior` agent. Carol uses `reviewer` — a read-only role specialized in evaluating output without modifying it, ideal for signoff review.

### 1.3 Master Launch Call

```json
{
    "tool": "team_delegate",
    "args": {
        "team_id": "util-signoff",
        "tasks": [
            {
                "ref": "camel",
                "subject": "Implement toCamelCase",
                "description": "Implement `function toCamelCase(s: string): string` that converts snake_case to camelCase (e.g. 'hello_world' → 'helloWorld'). Embed in ```typescript block. End with <!-- IMPL: toCamelCase -->"
            },
            {
                "ref": "slug",
                "subject": "Implement slugify",
                "description": "Implement `function slugify(s: string): string` that converts to URL slug (lowercase, spaces→hyphens, strip non-alphanumeric except hyphens). Embed in ```typescript block. End with <!-- IMPL: slugify -->"
            },
            {
                "ref": "cap",
                "subject": "Implement capitalize",
                "description": "Implement `function capitalize(s: string): string` that capitalizes first letter, lowercases rest. Embed in ```typescript block. End with <!-- IMPL: capitalize -->"
            }
        ],
        "signoff_policy": "decider",
        "signoff_decider": "carol",
        "timeout_ms": 900000
    }
}
```

**Parameter Selection**:
- `signoff_policy: "decider"` — Single reviewer (carol) checks all outputs after the main task completes
- `signoff_decider: "carol"` — The reviewer member; must not be the master session
- No `blocked_by` — Three utility functions are fully independent, any coder can claim any task
- `timeout_ms: 900000` (15 min) — 3 tasks × 2 rounds + signoff review ≈ 12 min

### 1.4 Execution Flow (Timeline)

```
T+0m     master calls team_delegate, publishes 3 tasks
T+0m     OCTeam dispatches 2 coders + 1 reviewer (carol idle during main phase)
T+0m     alice/bob team_task_list → each claims a task
T+0~4m   each coder implements their function → reports IMPL marker → releases task
T+4m     remaining task claimed → implemented
T+8m     all 3 tasks complete
T+8m     [SIGNOFF PHASE] carol automatically dispatched with review prompt
T+8~10m  carol reviews all 3 implementations → emits <signoff>{"approved": true, ...}</signoff>
T+10m    signoff approved → results delivered to master
T+10m    Run: bun check-coding-delegate-decider.ts <run_dir>
```

### 1.5 Check Script

[`check-coding-delegate-decider.ts`](./check-coding-delegate-decider.ts)

- **Load**: `readdir(<run_dir>)` reads all `*.md` member outputs
- **Extract**:
  - Implementation markers: `<!-- IMPL: toCamelCase -->`, `<!-- IMPL: slugify -->`, `<!-- IMPL: capitalize -->`
  - Signoff tags: `<signoff>{"approved": true/false, "rationale": "..."}</signoff>` (global regex)
- **Assertions**:
  1. All 3 implementation markers are found across combined outputs
  2. At least one signoff tag with `"approved": true` is found

---

## Scenario 2: Sort Implementation Parallel with Peer-Quorum

### 2.1 Scenario Description

**Background**: In parallel cooperative mode, each member works on their own subtask, then outputs are merged by a reducer. Peer-quorum signoff dispatches ALL members to vote on the final merged output, requiring a specified fraction to approve. This demonstrates democratic quality control — no single reviewer has unilateral veto power.

**Goal**: Three coders each implement a different sorting algorithm (bubble sort, merge sort, selection sort). After alice merges the outputs, all 3 members vote on whether the combined result is correct. Quorum is 0.67 (2 of 3 must approve).

**Success Criteria (Machine-Verifiable)**:
- Combined outputs contain all 3 complexity markers: `<!-- COMPLEXITY: O(n^2) -->` (bubble), `<!-- COMPLEXITY: O(n log n) -->` (merge), `<!-- COMPLEXITY: O(n^2) -->` (selection)
- At least 2 of the 3 signoff tags have `"approved": true` (quorum 0.67 × 3 = 2.01, ceiling to 2)

### 2.2 Team Configuration

```json
{
    "name": "sort-quorum",
    "description": "Sort algorithm implementers with peer-quorum signoff: 3 coders vote on correctness of merged output",
    "members": [
        {
            "name": "alice",
            "role": "coder",
            "prompt": "You are a coder. Implement your assigned sorting algorithm in TypeScript. Embed the code in a ```typescript block, state the time complexity, and end with <!-- COMPLEXITY: O(...) -->. After your work and the reduce phase, you will be dispatched a signoff review prompt to vote on the overall output quality."
        },
        {
            "name": "bob",
            "role": "coder",
            "prompt": "You are a coder. Implement your assigned sorting algorithm in TypeScript. Embed the code in a ```typescript block, state the time complexity, and end with <!-- COMPLEXITY: O(...) -->. After your work and the reduce phase, you will be dispatched a signoff review prompt to vote on the overall output quality."
        },
        {
            "name": "carol",
            "role": "coder",
            "prompt": "You are a coder. Implement your assigned sorting algorithm in TypeScript. Embed the code in a ```typescript block, state the time complexity, and end with <!-- COMPLEXITY: O(...) -->. After your work and the reduce phase, you will be dispatched a signoff review prompt to vote on the overall output quality."
        }
    ]
}
```

**Role Selection Rationale**: All three members use `coder` with the `oct-junior` agent — role symmetry is intentional: peer-quorum requires every member to participate in the vote, so no member can have a read-only role (which would prevent task output generation).

### 2.3 Master Launch Call

```json
{
    "tool": "team_parallel",
    "args": {
        "team_id": "sort-quorum",
        "mode": "cooperative",
        "tasks": {
            "alice": "Implement bubble sort. Embed in ```typescript block. State the complexity. End with <!-- COMPLEXITY: O(n^2) -->",
            "bob": "Implement merge sort. Embed in ```typescript block. State the complexity. End with <!-- COMPLEXITY: O(n log n) -->",
            "carol": "Implement selection sort. Embed in ```typescript block. State the complexity. End with <!-- COMPLEXITY: O(n^2) -->"
        },
        "reduce_policy": "merge",
        "reducer_member": "alice",
        "signoff_policy": "peer-quorum",
        "signoff_quorum": 0.67,
        "timeout_ms": 900000
    }
}
```

**Parameter Selection**:
- `mode: "cooperative"` — Each member gets a different task (different sort algorithm)
- `reduce_policy: "merge"` — Alice concatenates all three outputs into one
- `signoff_policy: "peer-quorum"` — All 3 members vote on the final merged output
- `signoff_quorum: 0.67` — 0.67 × 3 = 2.01, so at least 2 of 3 must approve (ceiling)
- `timeout_ms: 900000` (15 min) — 3 parallel implementations + merge + signoff vote ≈ 12-15 min

### 2.4 Execution Flow (Timeline)

```
T+0m     master calls team_parallel (cooperative, peer-quorum signoff)
T+0m     OCTeam dispatches alice (bubble), bob (merge), carol (selection) in parallel
T+0~5m   each coder implements their sort → reports COMPLEXITY marker
T+5m     all 3 complete → reduce phase: alice merges outputs
T+6m     [SIGNOFF PHASE] all 3 members dispatched with review prompt (reviewing merged output)
T+6~8m   each member votes: alice, bob, carol each emit <signoff>{"approved": true/false, ...}</signoff>
T+8m     quorum check: need ≥ 2 approvals → if met, "signoff_quorum_reached"
T+8m     results delivered to master
T+8m     Run: bun check-coding-parallel-quorum.ts <run_dir>
```

### 2.5 Check Script

[`check-coding-parallel-quorum.ts`](./check-coding-parallel-quorum.ts)

- **Load**: `readdir(<run_dir>)` reads all `*.md` member outputs
- **Extract**:
  - Complexity markers: `<!-- COMPLEXITY: O(n^2) -->`, `<!-- COMPLEXITY: O(n log n) -->`
  - Signoff tags: `<signoff>{"approved": true/false, "rationale": "..."}</signoff>` (global regex, count per member)
- **Assertions**:
  1. All 3 complexity markers found (O(n^2) appears twice — bubble + selection)
  2. Count of signoff tags with `"approved": true` is ≥ 2 (quorum 0.67 × 3)

---

## Scenario 3: Sum-of-Squares Pipeline with Peer-Quorum

### 3.1 Scenario Description

**Background**: In pipeline mode, each stage's output feeds the next — like a production chain. Peer-quorum signoff sends the complete pipeline output (visible in the last stage's context) to all members for voting. This demonstrates signoff on a multi-stage deliverable where each stage depends on the previous one.

**Goal**: Three mathematicians complete a pipeline: derive the sum-of-squares closed-form (alice), verify it numerically (bob), prove it by induction (carol). After the pipeline completes, all 3 members vote on the full derivation chain. Default quorum (0.5 majority) applies.

**Success Criteria (Machine-Verifiable)**:
- Last stage output (carol.md) contains all 3 pipeline markers:
  - `<!-- FORMULA: n(n+1)(2n+1)/6 -->`
  - `<!-- VERIFY: true -->`
  - `<!-- PROOF_OK: true -->`
- At least 2 of 3 signoff tags have `"approved": true` (majority)

### 3.2 Team Configuration

```json
{
    "name": "sumsq-signoff",
    "description": "Sum-of-squares derivation pipeline with peer-quorum signoff: derive → verify → prove, then all 3 vote",
    "members": [
        {
            "name": "alice",
            "role": "mathematician",
            "prompt": "You are a mathematician. You are the first stage in a pipeline. Derive the closed-form formula for the sum of squares: Σ(k², k=1..n) = n(n+1)(2n+1)/6. Show the derivation concisely using telescoping or polynomial fitting. End your output with a line exactly formatted: <!-- FORMULA: n(n+1)(2n+1)/6 -->.\n\nAfter the pipeline completes, you will be dispatched a signoff review prompt to vote on the complete derivation chain."
        },
        {
            "name": "bob",
            "role": "mathematician",
            "prompt": "You are a mathematician. You are the second stage. You will receive alice's derivation as context. Verify the formula numerically: compute Σ(k², k=1..100) by direct summation and compare to 100*101*201/6 = 338350. Report the match. End your output with a line exactly formatted: <!-- VERIFY: <boolean> -->.\n\nAfter the pipeline completes, you will vote in the signoff."
        },
        {
            "name": "carol",
            "role": "mathematician",
            "prompt": "You are a mathematician. You are the third stage. You will receive bob's output as context (which includes alice's work). Prove the formula by mathematical induction. Base case n=1: LHS=1, RHS=1(2)(3)/6=1. Inductive step: assume Σ(k²,k=1..n)=n(n+1)(2n+1)/6, show it holds for n+1. End with <!-- PROOF_OK: true -->.\n\nAfter the pipeline completes, you will vote in the signoff."
        }
    ]
}
```

**Role Selection Rationale**: All three use `mathematician` with the `oct-junior` agent, capable of symbolic derivation, numerical computation, and induction proofs. Role symmetry is intentional — peer-quorum requires all members to contribute output and vote.

### 3.3 Master Launch Call

```json
{
    "tool": "team_pipeline",
    "args": {
        "team_id": "sumsq-signoff",
        "stages": [
            {
                "member": "alice",
                "task": "Derive Σ(k²,k=1..n) = n(n+1)(2n+1)/6. Show derivation. End with <!-- FORMULA: n(n+1)(2n+1)/6 -->"
            },
            {
                "member": "bob",
                "task": "Verify formula numerically for n=100. Compare to 338350. End with <!-- VERIFY: <boolean> -->"
            },
            {
                "member": "carol",
                "task": "Prove the formula by induction. End with <!-- PROOF_OK: true -->"
            }
        ],
        "signoff_policy": "peer-quorum",
        "timeout_ms": 900000
    }
}
```

**Parameter Selection**:
- `signoff_policy: "peer-quorum"` — All 3 members vote on the complete pipeline output
- No explicit `signoff_quorum` — Default is 0.5, so majority (≥ 2 of 3) is required
- `timeout_ms: 900000` (15 min) — 3 sequential stages + signoff ≈ 10-12 min
- Pipeline members are `alice → bob → carol` — Carol sees both prior stages (alice's and bob's work), enabling her to verify the full chain

### 3.4 Execution Flow (Timeline)

```
T+0m     master calls team_pipeline (3 stages, peer-quorum signoff)
T+0m     Stage 1: alice derives formula → <!-- FORMULA: n(n+1)(2n+1)/6 -->
T+2m     Stage 2: bob receives alice's output, verifies numerically → <!-- VERIFY: true -->
T+4m     Stage 3: carol receives bob's output (includes alice's), proves by induction → <!-- PROOF_OK: true -->
T+6m     pipeline complete
T+6m     [SIGNOFF PHASE] all 3 members dispatched with review prompt (reviewing full pipeline output)
T+6~8m   alice, bob, carol each vote on the complete derivation chain
T+8m     quorum check: need ≥ 2 approvals (majority of 3)
T+8m     results delivered to master
T+8m     Run: bun check-math-pipeline-quorum.ts <run_dir>
```

### 3.5 Check Script

[`check-math-pipeline-quorum.ts`](./check-math-pipeline-quorum.ts)

- **Load**: Read `carol.md` (last pipeline stage, contains full pipeline output prefixed); also `readdir` all `*.md` for signoff scanning
- **Extract**:
  - Formula: `<!-- FORMULA: n(n+1)(2n+1)/6 -->`
  - Verify: `<!-- VERIFY: true -->`
  - Proof: `<!-- PROOF_OK: true -->`
  - Signoff tags: `<signoff>{"approved": true/false, "rationale": "..."}</signoff>`
- **Assertions**:
  1. All 3 pipeline markers present in carol's output
  2. Count of signoff tags with `"approved": true` across all `.md` files is ≥ 2 (majority)

---

## Scenario 4: Multi-Stage Build Pipeline with Decider Signoff (Challenge)

**Challenge-level**: 6 members, 5 pipeline stages, `signoff_policy: "decider"`, est. ~45 min, deliberately exceeds the baseline template (≤ 4 members / ≤ 30 min) to stress-test signoff under larger teams and longer pipelines.

### 4.1 Scenario Description

**Background**: A realistic software development pipeline — spec → implementation (2 parallel-like stages) → testing → documentation — culminating in a single reviewer (frank) checking the complete deliverable. This mirrors the pattern where a team lead or architect signs off on a multi-stage build before release.

**Goal**: Five members complete a 5-stage pipeline building Stack and Queue data structures end-to-end. After the pipeline completes, frank (the designated reviewer) reviews all stages and issues a single approval verdict.

**Success Criteria (Machine-Verifiable)**:
- Last stage output (erin.md) contains all 5 pipeline markers:
  - `<!-- SPEC_OK: true -->`
  - `<!-- IMPL: Stack -->`
  - `<!-- IMPL: Queue -->`
  - `<!-- PASS_COUNT: 8/8 -->`
  - `<!-- DOCS_OK: true -->`
- At least one `<signoff>` tag with `"approved": true` found in frank's output

### 4.2 Team Configuration

```json
{
    "name": "build-signoff",
    "description": "Stack+Queue multi-stage build pipeline with decider signoff: 5 implementers + 1 reviewer",
    "members": [
        {
            "name": "alice",
            "role": "coder",
            "prompt": "You are a coder. You are Stage 1: define the API specifications for BOTH a Stack and a Queue data structure. For Stack, list the methods: push, pop, peek, isEmpty, size. For Queue, list the methods: enqueue, dequeue, front, isEmpty, size. Describe each method's signature and behavior. End your output with a line exactly formatted: <!-- SPEC_OK: true -->"
        },
        {
            "name": "bob",
            "role": "coder",
            "prompt": "You are a coder. You are Stage 2: you will receive alice's API spec as context. Implement `class Stack<T>` with push/pop/peek/isEmpty/size based on the spec. Use an internal array. Embed the full TypeScript code in a ```typescript fenced block. End your output with a line exactly formatted: <!-- IMPL: Stack -->"
        },
        {
            "name": "carol",
            "role": "coder",
            "prompt": "You are a coder. You are Stage 3: you will receive bob's output (which includes alice's spec) as context. Implement `class Queue<T>` with enqueue/dequeue/front/isEmpty/size. Use an internal array with two pointers. Embed the full TypeScript code in a ```typescript fenced block. End your output with a line exactly formatted: <!-- IMPL: Queue -->"
        },
        {
            "name": "dave",
            "role": "tester",
            "prompt": "You are a tester. You are Stage 4: you will receive carol's output (which includes both Stack and Queue implementations) as context. Write 8 test cases covering ALL methods of both data structures: Stack push/pop, Stack peek, Stack isEmpty, Stack size, Queue enqueue/dequeue, Queue front, Queue isEmpty, Queue size. Run them against the implementations. End your output with a line exactly formatted: <!-- PASS_COUNT: <n>/8 -->"
        },
        {
            "name": "erin",
            "role": "coder",
            "prompt": "You are a coder. You are Stage 5: you will receive dave's output (which includes all prior stages) as context. Write usage documentation for Stack and Queue with examples. End your output with a line exactly formatted: <!-- DOCS_OK: true -->"
        },
        {
            "name": "frank",
            "role": "reviewer",
            "prompt": "You are a reviewer. After the pipeline completes, you will be automatically dispatched with a signoff review prompt containing a summary of all 5 stages. Review the spec, both implementations, test results, and documentation. If the complete deliverable meets quality standards, emit <signoff>{\"approved\": true, \"rationale\": \"...\"}</signoff>. If not, emit <signoff>{\"approved\": false, \"rationale\": \"specific issues...\"}</signoff>."
        }
    ]
}
```

**Role Selection Rationale**: Stages 1-3 and 5 use `coder` (`oct-junior` agent) for implementation and documentation. Stage 4 uses `tester` — a specialized role for writing and running test cases. Frank uses `reviewer` (read-only signoff role, evaluates without modifying).

### 4.3 Master Launch Call

```json
{
    "tool": "team_pipeline",
    "args": {
        "team_id": "build-signoff",
        "stages": [
            {
                "member": "alice",
                "task": "Define API spec for BOTH Stack (push/pop/peek/isEmpty/size) and Queue (enqueue/dequeue/front/isEmpty/size). End with <!-- SPEC_OK: true -->"
            },
            {
                "member": "bob",
                "task": "Implement class Stack<T> per spec. Embed in ```typescript block. End with <!-- IMPL: Stack -->"
            },
            {
                "member": "carol",
                "task": "Implement class Queue<T> (enqueue/dequeue/front/isEmpty/size). Embed in ```typescript block. End with <!-- IMPL: Queue -->"
            },
            {
                "member": "dave",
                "task": "Write and run 8 test cases covering all methods of Stack and Queue: Stack push/pop, peek, isEmpty, size; Queue enqueue/dequeue, front, isEmpty, size. End with <!-- PASS_COUNT: <n>/8 -->"
            },
            {
                "member": "erin",
                "task": "Write usage docs for Stack and Queue. End with <!-- DOCS_OK: true -->"
            }
        ],
        "signoff_policy": "decider",
        "signoff_decider": "frank",
        "timeout_ms": 2400000
    }
}
```

**Parameter Selection**:
- `signoff_policy: "decider"` — Single reviewer (frank) checks the complete 5-stage deliverable
- `signoff_decider: "frank"` — The reviewer member with role `reviewer`; never participates in pipeline stages
- `timeout_ms: 2400000` (40 min) — 5 sequential stages × ~5 min + signoff review ≈ 30-40 min; challenge-level deliberately relaxed
- Pipeline order: spec → Stack → Queue → tests → docs — each stage builds on prior outputs

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_pipeline (5 stages, decider signoff, frank=decider)
T+0m     Stage 1: alice defines Stack+Queue spec → <!-- SPEC_OK: true -->
T+5m     Stage 2: bob receives spec, implements Stack<T> → <!-- IMPL: Stack -->
T+10m    Stage 3: carol receives Stack+spec, implements Queue<T> → <!-- IMPL: Queue -->
T+15m    Stage 4: dave receives both implementations, writes+run 8 tests → <!-- PASS_COUNT: 8/8 -->
T+22m    Stage 5: erin receives all prior outputs, writes docs → <!-- DOCS_OK: true -->
T+28m    pipeline complete
T+28m    [SIGNOFF PHASE] frank automatically dispatched with review prompt of all 5 stages
T+28~32m frank reviews spec, Stack, Queue, tests, docs → emits <signoff>{"approved": true, ...}</signoff>
T+32m    signoff approved → results delivered to master
T+32m    Run: bun check-coding-pipeline-decider.ts <run_dir>
```

### 4.5 Check Script

[`check-coding-pipeline-decider.ts`](./check-coding-pipeline-decider.ts)

- **Load**: Read each pipeline stage's `<member>.md` for its own marker (`alice.md`, `bob.md`, `carol.md`, `dave.md`, `erin.md`); also `readdir` all `*.md` for signoff scanning
- **Extract**:
  - Spec: `<!-- SPEC_OK: true -->` (in alice.md)
  - Stack impl: `<!-- IMPL: Stack -->` (in bob.md)
  - Queue impl: `<!-- IMPL: Queue -->` (in carol.md)
  - Tests: `<!-- PASS_COUNT: 8/8 -->` (in dave.md)
  - Docs: `<!-- DOCS_OK: true -->` (in erin.md)
  - Signoff: `<signoff>{"approved": true, "rationale": "..."}</signoff>`
- **Assertions**:
  1. All 5 pipeline markers present, each in its producing stage's `.md` file
  2. At least one signoff tag with `"approved": true` found (frank's verdict)
  3. Signoff rationale is non-empty

---

## Quick-Start Prompts

Paste any of the following prompts to the master session; the AI will automatically complete the full closed loop. Signoff evaluation reads the signoff verdict tags (`<signoff>{"approved": true/false, "rationale": "..."}</signoff>`) from member .md outputs.

### Scenario 1: Utility Function Delegate with Decider Signoff

```text
Execute the full closed loop for demos/13-team-signoff/README.md "Scenario 1" with automatic evaluation.

Steps:
1. Read README "1.2 Team Configuration", create the team with team_create JSON (2 coders + 1 reviewer)
2. team_activate to activate
3. Read README "1.3 Master Launch Call", start orchestration with the team_delegate JSON (signoff_policy: decider, signoff_decider: carol)
4. team_results poll until master receives summary (carol's signoff review completes after tasks) (poll every 30s)
5. Locate <run_dir> (containing member .md outputs with signoff tags)
6. Run: bun demos/13-team-signoff/check-coding-delegate-decider.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: 3 IMPL markers (toCamelCase, slugify, capitalize) + signoff approved=true from carol.
```

### Scenario 2: Sort Implementation Parallel with Peer-Quorum

```text
Execute the full closed loop for demos/13-team-signoff/README.md "Scenario 2" with automatic evaluation.

Steps:
1. Read README "2.2 Team Configuration", create the team with team_create JSON (3 coders)
2. team_activate to activate
3. Read README "2.3 Master Launch Call", start orchestration with the team_parallel JSON (mode: cooperative, signoff_policy: peer-quorum, quorum: 0.67)
4. team_results poll until master receives summary (signoff quorum check completes) (poll every 30s)
5. Locate <run_dir>
6. Run: bun demos/13-team-signoff/check-coding-parallel-quorum.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: 3 COMPLEXITY markers + >= 2 signoff approved=true (quorum 0.67 x 3).
```

### Scenario 3: Sum-of-Squares Pipeline with Peer-Quorum

```text
Execute the full closed loop for demos/13-team-signoff/README.md "Scenario 3" with automatic evaluation.

Steps:
1. Read README "3.2 Team Configuration", create the team with team_create JSON (3 mathematicians)
2. team_activate to activate
3. Read README "3.3 Master Launch Call", start orchestration with the team_pipeline JSON (3 stages, signoff_policy: peer-quorum)
4. team_results poll until master receives summary (signoff quorum check completes) (poll every 30s)
5. Locate <run_dir>
6. Run: bun demos/13-team-signoff/check-math-pipeline-quorum.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: FORMULA + VERIFY=true + PROOF_OK=true in pipeline output + >= 2 signoff approved (majority of 3).
```

### Scenario 4: Multi-Stage Build Pipeline with Decider Signoff (Challenge)

```text
Execute the full closed loop for demos/13-team-signoff/README.md "Scenario 4" with automatic evaluation. Note: challenge-level, ~45 min estimated.

Steps:
1. Read README "4.2 Team Configuration", create the team with team_create JSON (5 implementers + 1 reviewer, 6 total)
2. team_activate to activate
3. Read README "4.3 Master Launch Call", start orchestration with the team_pipeline JSON (5 stages, signoff_policy: decider, signoff_decider: frank)
4. team_results poll until master receives summary (frank's signoff review completes after pipeline) (poll every 30s)
5. Locate <run_dir> (containing erin.md with full pipeline output + frank.md with signoff verdict)
6. Run: bun demos/13-team-signoff/check-coding-pipeline-decider.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: 5 pipeline markers (SPEC_OK, IMPL: Stack, IMPL: Queue, PASS_COUNT=4/4, DOCS_OK) + frank's signoff approved=true.
```
