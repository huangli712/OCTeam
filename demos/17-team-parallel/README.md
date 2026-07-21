# team_parallel Isolated Mode and Done-Ack Features Demo

`team_parallel` (isolated + done-ack) demonstrates same-task broadcast (`mode: "isolated"`), explicit done-ack barrier (`require_done_ack: true`), and fault-tolerant redundancy (`max_errored_members`), three features not covered by the existing `01-team-parallel/` demos which all use `cooperative` mode.

---

## What This Demo Covers (and Why)

The `01-team-parallel/` demos all use `mode: "cooperative"`, where each member receives a DIFFERENT task via the `tasks: { memberName: taskText }` map. This demo set complements those by demonstrating three additional `team_parallel` features:

1. **`mode: "isolated"`**: ALL members receive the SAME task (specified by the top-level `task` parameter, not the per-member `tasks` map). This is the simplest parallel mode, useful for broadcasting a problem to multiple independent solvers and comparing answers, multi-method verification, or redundancy for critical computations.

2. **`require_done_ack: true`**: When true, the all-idle barrier is replaced by an all-acked barrier. Members must explicitly call `team_done()` to signal completion. Members that go idle without acking receive an automatic re-prompt. This prevents premature barrier when a member idles waiting for a dependency (e.g., in delegate-style cooperation within a parallel run). Default is false (backward compatible: idle = done).

3. **`max_errored_members`**: Tolerate up to N terminally-errored members and still deliver survivors' work. Default 0 (any member error fails the run). In isolated mode, this enables fault-tolerant redundancy: if you have 4 members solving the same problem and 1 crashes, the other 3 results are still delivered.

## Scenario Overview

| # | Domain | Scenario | Members | Feature | reduce_policy | Est. Duration |
|---|------|------|--------|------|---------------|-----------|
| 1 | Math | Definite integral: 3 independent numerical methods | 3 | `mode: "isolated"` + `merge` | `merge` | ~10 min |
| 2 | Programming | Binary search: rubric-scored comparison | 3 | `mode: "isolated"` + `rubric` | `rubric` | ~10 min |
| 3 | Programming | Hash function: done-ack barrier | 3 | `require_done_ack: true` | `summarize` | ~10 min |
| 4 | Programming (Challenge) | Spiral order: fault-tolerant with error tolerance | 4 | `max_errored_members: 1` | `merge` | ~15 min |

---

## Scenario 1: Same Integral, Three Independent Solutions

### 1.1 Scenario Description

**Background**: Numerical integration is a classic test bed for independent computation. The definite integral of `f(x) = x^2 * e^(-x)` on [0, 2] has a known analytic solution (2 - 10/e^2 ≈ 0.6466), making it easy to verify. In isolated mode, all members receive the identical task and solve it independently, using whatever method they choose.

**Goal**: 3 mathematician members each compute the same definite integral independently (trapezoidal or Simpson's rule with at least 1000 subintervals), then cross-validate their results.

**Success criteria (machine-verifiable)**:
- At least 2 of 3 reported values agree within 0.01 (cross-validation: independent solutions should converge)
- The median of reported values is within 0.05 of 0.6466 (analytic answer)

### 1.2 Team Config

```json
{
    "name": "isolated-integral",
    "description": "Same definite integral computed independently by 3 mathematicians in isolated mode",
    "members": [
        {
            "name": "alice",
            "role": "mathematician",
            "prompt": "Compute the definite integral of f(x) = x^2 * e^(-x) on [0, 2] using numerical integration (trapezoidal or Simpson's rule, at least 1000 subintervals). Report the result to 6 significant digits.\n\nEmbed your code in a ```typescript fenced block.\n\nYour output MUST end with: <!-- INTEGRAL: <numeric_value> -->"
        },
        {
            "name": "bob",
            "role": "mathematician",
            "prompt": "Compute the definite integral of f(x) = x^2 * e^(-x) on [0, 2] using numerical integration (trapezoidal or Simpson's rule, at least 1000 subintervals). Report the result to 6 significant digits.\n\nEmbed your code in a ```typescript fenced block.\n\nYour output MUST end with: <!-- INTEGRAL: <numeric_value> -->"
        },
        {
            "name": "carol",
            "role": "mathematician",
            "prompt": "Compute the definite integral of f(x) = x^2 * e^(-x) on [0, 2] using numerical integration (trapezoidal or Simpson's rule, at least 1000 subintervals). Report the result to 6 significant digits.\n\nEmbed your code in a ```typescript fenced block.\n\nYour output MUST end with: <!-- INTEGRAL: <numeric_value> -->"
        }
    ]
}
```

**Role selection rationale**: `mathematician` uses the `oct-junior` agent, capable of writing code, running it, and doing numerical verification. All three members receive identical prompts because in isolated mode the task is broadcast equally to everyone.

### 1.3 Master Launch Call

```json
{
    "tool": "team_parallel",
    "args": {
        "team_id": "isolated-integral",
        "mode": "isolated",
        "task": "Compute the definite integral of f(x) = x^2 * e^(-x) on [0, 2] using numerical integration (trapezoidal or Simpson's rule, at least 1000 subintervals). Report the result to 6 significant digits. Embed your code in a ```typescript fenced block. Your output MUST end with: <!-- INTEGRAL: <numeric_value> -->",
        "reduce_policy": "merge",
        "reducer_member": "alice",
        "timeout_ms": 600000
    }
}
```

**Parameter selection**:
- `mode: "isolated"` — same task broadcast to all 3 members (contrast with cooperative, which would require a `tasks` map)
- `task` (top-level) — the single task ALL members receive; no `tasks` map needed
- `reduce_policy: "merge"` — keep all three independent results for cross-validation
- `reducer_member: "alice"` — non-summarize strategies must specify reducer_member; alice merges and aggregates
- `timeout_ms: 600000` (10 min) — ample headroom for a simple integral computation

### 1.4 Execution Flow (Timeline)

```
T+0m    master calls team_parallel (isolated)
T+0m    OCTeam dispatches 3 mathematician members, each receives the SAME task
T+0~6m  each member independently: write code → compute integral → report INTEGRAL marker
T+6m    slowest member idle → trigger reduce (merge policy)
T+7m    merged results delivered to master
T+7m    run: bun check-math-isolated-integral.ts <run_dir>
```

### 1.5 Check Script

[`check-math-isolated-integral.ts`](./check-math-isolated-integral.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**: regex `<!-- INTEGRAL:\s*([\d.eE+-]+)\s*-->`
- **Assertions**:
  1. At least 2 of 3 values are within 0.01 of each other (cross-validation of independent solutions)
  2. The median value is within 0.05 of 0.6466 (analytic answer)

---

## Scenario 2: Same Algorithm Problem, Rubric Comparison

### 2.1 Scenario Description

**Background**: Binary search is a canonical algorithm with well-defined correctness properties. In isolated mode, 3 coders independently implement the same function, then a rubric-based reducer scores and ranks them. This demonstrates how isolated + rubric combines same-task broadcast with structured comparative evaluation.

**Goal**: 3 coder members independently implement `binarySearch`, then one reducer scores each solution on correctness, clarity, and edge cases.

**Success criteria (machine-verifiable)**:
- At least one implementation passes all 5 test cases: binarySearch([1,3,5,7,9],5)=2, ([1,3,5,7,9],1)=0, ([1,3,5,7,9],9)=4, ([1,3,5,7,9],4)=-1, ([],1)=-1

### 2.2 Team Config

```json
{
    "name": "isolated-rubric",
    "description": "Three coders independently implement binarySearch, scored by rubric",
    "members": [
        {
            "name": "alice",
            "role": "coder",
            "prompt": "Implement `function binarySearch(arr: number[], target: number): number` — returns index of target in sorted ascending array, or -1 if not found. Handle empty array. Embed in ```typescript block. End with <!-- IMPL: binarySearch -->"
        },
        {
            "name": "bob",
            "role": "coder",
            "prompt": "Implement `function binarySearch(arr: number[], target: number): number` — returns index of target in sorted ascending array, or -1 if not found. Handle empty array. Embed in ```typescript block. End with <!-- IMPL: binarySearch -->"
        },
        {
            "name": "carol",
            "role": "coder",
            "prompt": "Implement `function binarySearch(arr: number[], target: number): number` — returns index of target in sorted ascending array, or -1 if not found. Handle empty array. Embed in ```typescript block. End with <!-- IMPL: binarySearch -->"
        }
    ]
}
```

**Role selection rationale**: `coder` uses the `oct-junior` agent, focusing on implementation. All three get identical prompts because isolated mode broadcasts the same task.

### 2.3 Master Launch Call

```json
{
    "tool": "team_parallel",
    "args": {
        "team_id": "isolated-rubric",
        "mode": "isolated",
        "task": "Implement `function binarySearch(arr: number[], target: number): number` — returns index of target in sorted ascending array, or -1 if not found. Handle empty array. Embed in ```typescript block. End with <!-- IMPL: binarySearch -->",
        "reduce_policy": "rubric",
        "reduce_rubric": "Score each on: (a) correctness [binarySearch([1,3,5,7,9],5)=2, ([1,3,5,7,9],1)=0, ([1,3,5,7,9],9)=4, ([1,3,5,7,9],4)=-1, ([],1)=-1], (b) clarity, (c) edge cases. Rank the three.",
        "reducer_member": "alice",
        "timeout_ms": 600000
    }
}
```

**Parameter selection**:
- `mode: "isolated"` — all 3 coders implement the same binarySearch in parallel
- `reduce_policy: "rubric"` — score each solution by an explicit criteria table
- `reduce_rubric` embeds test cases directly, so the reducer judges with a unified standard
- `reducer_member: "alice"` — alice scores and ranks; non-summarize strategies require reducer_member
- Key difference from cooperative: `task` (single string) not `tasks` (per-member map)

### 2.4 Execution Flow (Timeline)

```
T+0m    master calls team_parallel (isolated)
T+0m    3 coder members dispatched, each receives the SAME binarySearch task
T+0~5m  each member implements binarySearch independently
T+5m    all three members idle → reduce (rubric policy, reducer=alice)
T+6m    alice scores & ranks, delivers reducedResult
T+6m    run: bun check-coding-isolated-rubric.ts <run_dir>
```

### 2.5 Check Script

[`check-coding-isolated-rubric.ts`](./check-coding-isolated-rubric.ts)

- **Load**: all `.md` files in `<run_dir>`
- **Extract**: capture the last ` ```typescript ... ``` ` code block from each file, load `binarySearch` via `new Function`
- **Assertions**:
  1. At least one `binarySearch` function exists and can be loaded
  2. That function passes all 5 test cases

---

## Scenario 3: Done-Ack Barrier for Coordinated Completion

### 3.1 Scenario Description

**Background**: In some parallel workloads, members may temporarily go idle while waiting for intermediate work (sub-processes, file I/O, or internal deliberation). Without `require_done_ack`, the engine would treat idle as completion and trigger the reduce step prematurely. With `require_done_ack: true`, members must explicitly call `team_done()` to signal they are finished.

**Goal**: 3 coder members implement a hash function independently. All must explicitly signal completion via `team_done()` before the parallel run ends and the reduce step fires.

**Success criteria (machine-verifiable)**:
- At least one implementation of `hashString` passes all 4 test cases: hashString("ab")===293, hashString("")===0, hashString("a")===97, hashString("abc")===592

### 3.2 Team Config

```json
{
    "name": "done-ack-parallel",
    "description": "Three coders implement hashString with explicit done-ack barrier",
    "members": [
        {
            "name": "alice",
            "role": "coder",
            "prompt": "Implement `function hashString(s: string): number` — sum of (charCode * (index+1)) for each char. E.g. hashString('ab') = 97*1 + 98*2 = 293. Embed in ```typescript block.\n\nEnd with <!-- IMPL: hashString -->.\n\nAfter verifying, call team_done to signal completion."
        },
        {
            "name": "bob",
            "role": "coder",
            "prompt": "Implement `function hashString(s: string): number` — sum of (charCode * (index+1)) for each char. E.g. hashString('ab') = 97*1 + 98*2 = 293. Embed in ```typescript block.\n\nEnd with <!-- IMPL: hashString -->.\n\nAfter verifying, call team_done to signal completion."
        },
        {
            "name": "carol",
            "role": "coder",
            "prompt": "Implement `function hashString(s: string): number` — sum of (charCode * (index+1)) for each char. E.g. hashString('ab') = 97*1 + 98*2 = 293. Embed in ```typescript block.\n\nEnd with <!-- IMPL: hashString -->.\n\nAfter verifying, call team_done to signal completion."
        }
    ]
}
```

### 3.3 Master Launch Call

```json
{
    "tool": "team_parallel",
    "args": {
        "team_id": "done-ack-parallel",
        "mode": "isolated",
        "task": "Implement `function hashString(s: string): number` — sum of (charCode * (index+1)) for each char. E.g. hashString('ab') = 97*1 + 98*2 = 293. Embed in ```typescript block. End with <!-- IMPL: hashString -->. After verifying, call team_done to signal completion.",
        "require_done_ack": true,
        "reduce_policy": "summarize",
        "timeout_ms": 600000
    }
}
```

**Parameter selection**:
- `require_done_ack: true` — the key feature: replaces the all-idle barrier with an all-acked barrier. Members must explicitly call `team_done()` to signal completion. Members that go idle without acking receive an automatic re-prompt. This prevents premature barrier when a member idles waiting for a dependency.
- `reduce_policy: "summarize"` — simplest reduce; summarize is the only policy that does not require `reducer_member`
- Without `require_done_ack`, the default behavior (false) means any member going idle is treated as done, potentially ending the run before all members have finished their work

### 3.4 Execution Flow (Timeline)

```
T+0m    master calls team_parallel (isolated, require_done_ack=true)
T+0m    3 coder members dispatched, each receives the SAME hashString task
T+0~5m  each member implements hashString, self-verifies
T+0~5m  each member calls team_done() to explicitly signal completion
T+5m    ALL members have acked → barrier satisfied → trigger reduce
T+6m    summarized results delivered to master
T+6m    run: bun check-coding-done-ack.ts <run_dir>
```

### 3.5 Check Script

[`check-coding-done-ack.ts`](./check-coding-done-ack.ts)

- **Load**: all `.md` files in `<run_dir>`
- **Extract**: capture the last ` ```typescript ... ``` ` code block, load `hashString` via `new Function`
- **Assertions**:
  1. At least one implementation passes all 4 test cases: hashString("ab")===293, hashString("")===0, hashString("a")===97, hashString("abc")===592

---

## Scenario 4: Fault-Tolerant Isolated Computation (Challenge)

**Challenge-level note**: This scenario demonstrates `max_errored_members: 1` with 4 members solving the same problem, tolerating up to 1 failure while still delivering the survivors' results. This is a key feature for fault-tolerant redundancy in isolated mode.

### 4.1 Scenario Description

**Background**: Spiral order traversal of a matrix is a well-known algorithm with multiple edge cases (single row, single column, empty inner cells). In isolated mode with error tolerance, 4 members independently implement the same spiralOrder function. Even if 1 member fails (timeout, crash, or error), the remaining 3 results are still delivered and merged.

**Goal**: 4 coder members each implement `spiralOrder`, with fault tolerance allowing up to 1 member failure while still delivering survivors' work.

**Success criteria (machine-verifiable)**:
- At least one implementation passes all 4 test cases: spiralOrder([[1,2,3],[4,5,6],[7,8,9]]) deep-equals [1,2,3,6,9,8,7,4,5], spiralOrder([[1]]) deep-equals [1], spiralOrder([[]]) deep-equals [], spiralOrder([[1,2],[3,4]]) deep-equals [1,2,4,3]

### 4.2 Team Config

```json
{
    "name": "tolerant-isolated",
    "description": "Four coders implement spiralOrder with fault tolerance (tolerate 1 failure)",
    "members": [
        {
            "name": "alice",
            "role": "coder",
            "prompt": "Implement `function spiralOrder(matrix: number[][]): number[]` — spiral order (clockwise from top-left). E.g. spiralOrder([[1,2,3],[4,5,6],[7,8,9]]) = [1,2,3,6,9,8,7,4,5]. Embed in ```typescript block. End with <!-- IMPL: spiralOrder -->"
        },
        {
            "name": "bob",
            "role": "coder",
            "prompt": "Implement `function spiralOrder(matrix: number[][]): number[]` — spiral order (clockwise from top-left). E.g. spiralOrder([[1,2,3],[4,5,6],[7,8,9]]) = [1,2,3,6,9,8,7,4,5]. Embed in ```typescript block. End with <!-- IMPL: spiralOrder -->"
        },
        {
            "name": "carol",
            "role": "coder",
            "prompt": "Implement `function spiralOrder(matrix: number[][]): number[]` — spiral order (clockwise from top-left). E.g. spiralOrder([[1,2,3],[4,5,6],[7,8,9]]) = [1,2,3,6,9,8,7,4,5]. Embed in ```typescript block. End with <!-- IMPL: spiralOrder -->"
        },
        {
            "name": "dave",
            "role": "coder",
            "prompt": "Implement `function spiralOrder(matrix: number[][]): number[]` — spiral order (clockwise from top-left). E.g. spiralOrder([[1,2,3],[4,5,6],[7,8,9]]) = [1,2,3,6,9,8,7,4,5]. Embed in ```typescript block. End with <!-- IMPL: spiralOrder -->"
        }
    ]
}
```

**Member count rationale**: 4 members + `max_errored_members: 1` means 3 results are always delivered, providing redundancy while keeping the team under the 8-member limit. All 4 get identical prompts for isolated mode.

### 4.3 Master Launch Call

```json
{
    "tool": "team_parallel",
    "args": {
        "team_id": "tolerant-isolated",
        "mode": "isolated",
        "task": "Implement `function spiralOrder(matrix: number[][]): number[]` — spiral order (clockwise from top-left). E.g. spiralOrder([[1,2,3],[4,5,6],[7,8,9]]) = [1,2,3,6,9,8,7,4,5]. Embed in ```typescript block. End with <!-- IMPL: spiralOrder -->",
        "reduce_policy": "merge",
        "reducer_member": "alice",
        "max_errored_members": 1,
        "timeout_ms": 900000
    }
}
```

**Parameter selection**:
- `max_errored_members: 1` — tolerate up to 1 terminally-errored member; the remaining 3 survivors' results are still delivered. Without this (default 0), any single member failure would fail the entire run
- `mode: "isolated"` — all 4 get the same task, each is an independent attempt at the same problem. Isolated mode is natural for fault tolerance: each member is a redundant attempt
- `timeout_ms: 900000` (15 min) — slightly longer than baseline to allow for potential member timeouts within the tolerance budget
- `reduce_policy: "merge"` — keep all survivors' results; reducer merges them

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_parallel (isolated, max_errored_members=1)
T+0m     OCTeam dispatches 4 coder members, each receives the SAME spiralOrder task
T+0~10m  each surviving member: implement spiralOrder → verify against 4 test cases → write markdown report
T+0~10m  up to 1 member may error or timeout; fault tolerance absorbs it
T+10m    surviving members (3-4) idle → trigger reduce (merge policy, reducer=alice)
T+11m    merged survivors' results delivered to master
T+11m    run: bun check-coding-isolated-tolerant.ts <run_dir>
```

### 4.5 Check Script

[`check-coding-isolated-tolerant.ts`](./check-coding-isolated-tolerant.ts)

- **Load**: all `.md` files in `<run_dir>`
- **Extract**: capture the last ` ```typescript ... ``` ` code block from each file with one, load `spiralOrder` via `new Function`
- **Assertions**:
  1. At least one implementation passes all 4 test cases (spiralOrder for 3x3, 1x1, 0-column, and 2x2 matrices)
- Accepts that not all members may have produced output (fault tolerance)

---


## Quick-Start Prompts (Copy and Use)

Paste any of the following prompts to the master session, and the AI will automatically complete the full closed loop of "create team → activate → launch orchestration → wait for aggregation → run check script", reporting PASS / FAIL by exit code. All specific configs (team_create, team_parallel parameters) directly reference the corresponding sections of this README.

### Scenario 1: Same Integral, Three Independent Solutions

```text
Run the full closed loop of demos/17-team-parallel/README.md "Scenario 1: Same Integral, Three Independent Solutions" and auto-evaluate.

Steps:
1. Read README "1.2 Team Config", create the team using the team_create JSON
2. team_activate (team_id = isolated-integral)
3. Read README "1.3 Master Launch Call", start the orchestration using the team_parallel JSON
4. team_results poll, wait for orchestration to complete and master to receive summary (poll every 30s)
5. Locate the output directory <run_dir> for this run (contains alice.md / bob.md / carol.md)
6. Run evaluation:
   bun demos/17-team-parallel/check-math-isolated-integral.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: at least 2 of 3 independent solutions agree within 0.01; median within 0.05 of 0.6466.
```

### Scenario 2: Binary Search Rubric Comparison

```text
Run the full closed loop of demos/17-team-parallel/README.md "Scenario 2: Same Algorithm Problem, Rubric Comparison" and auto-evaluate.

Steps:
1. Read README "2.2 Team Config", create the team using the team_create JSON
2. team_activate (team_id = isolated-rubric)
3. Read README "2.3 Master Launch Call", start the orchestration using the team_parallel JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir> (contains alice.md / bob.md / carol.md)
6. Run: bun demos/17-team-parallel/check-coding-isolated-rubric.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: at least one binarySearch implementation passes all 5 test cases.
```

### Scenario 3: Done-Ack Barrier

```text
Run the full closed loop of demos/17-team-parallel/README.md "Scenario 3: Done-Ack Barrier for Coordinated Completion" and auto-evaluate.

Steps:
1. Read README "3.2 Team Config", create the team using the team_create JSON
2. team_activate (team_id = done-ack-parallel)
3. Read README "3.3 Master Launch Call", start the orchestration using the team_parallel JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir> (contains alice.md / bob.md / carol.md)
6. Run: bun demos/17-team-parallel/check-coding-done-ack.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: at least one hashString implementation passes all 4 test cases.
```

### Scenario 4: Fault-Tolerant Spiral Order (Challenge)

```text
Run the full closed loop of demos/17-team-parallel/README.md "Scenario 4: Fault-Tolerant Isolated Computation (Challenge)" and auto-evaluate.

Steps:
1. Read README "4.2 Team Config", create the team using the team_create JSON (4 coder members)
2. team_activate (team_id = tolerant-isolated)
3. Read README "4.3 Master Launch Call", start the orchestration using the team_parallel JSON (max_errored_members=1)
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir> (contains alice.md / bob.md / carol.md / dave.md)
6. Run: bun demos/17-team-parallel/check-coding-isolated-tolerant.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: at least one spiralOrder implementation passes all 4 test cases; tolerant of up to 1 member failure.
```
