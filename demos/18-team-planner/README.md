# team_planner Auto-Planning Scenario Demo

`team_planner` auto-plans from natural-language goals to executable workflows. It uses an oct-metis child session to generate team JSON and workflow JSON from a `goal` and optional `constraints`. The three-operation flow is: **propose** (AI generates team + workflow preview, writes nothing to disk), **revise** (AI regenerates with feedback), and **write** (deterministic validation + persist `team.<id>.json` and `workflow.<id>.json`). After write, the leader uses `team_create` with the team JSON, `team_activate`, then `team_workflow` with `workflow_file: "workflow.<id>.json"` to execute the generated workflow.

---

## Scenario Overview

| # | Domain | Scenario | team_planner flow | join_policy | Members | Est. Duration |
|---|--------|----------|-------------------|-------------|---------|---------------|
| 1 | Programming | isEven: fault-tolerant redundancy via quorum join | propose → write → create → activate → workflow → check | `quorum` (0.67) | 3 | ~12 min |
| 2 | Programming | reverseString: fastest correct wins via any-success join | propose → write → create → activate → workflow → check | `any_success` | 3 | ~12 min |
| 3 | Programming | clamp: critical branch required with survivors | propose → write → create → activate → workflow → check | `required_branches` + `use_survivors` | 3 | ~12 min |
| 4 | Programming (Challenge) | gcd + lcm: comprehensive multi-branch with gate verification | propose → write → create → activate → workflow → check | `required_branches` + gate | 5 | ~30 min |

> Scenarios 1-3 are baseline types (3 members, fanout with different join policy) with check scripts provided; scenario 4 is challenge-level (5 members, fanout + gate + review), demonstrating team_planner's ability to generate more complex multi-step workflows.

---

## Scenario 1: isEven -- Fault-Tolerant Redundancy via Quorum Join

### 1.1 Scenario Description

**Background**: Quorum join allows a fraction of branches to succeed for the overall run to be considered successful. With `quorum: 0.67`, at least 67% of branches must pass. For a 3-branch fanout, this means 2 of 3 branches passing is sufficient, providing fault-tolerant redundancy: one branch can fail and the run still succeeds.

**Goal**: Use `team_planner` to generate a team and workflow that implements `isEven(n: number): boolean` using a 3-branch fanout with `join_policy: "quorum"` and `quorum: 0.67`. Each branch independently implements and tests isEven. At least 2 of 3 branches must succeed.

**Success criteria (machine-evaluable)**:
- team_planner propose generates team + workflow JSON
- team_planner write persists `team.planner-quorum.json` and `workflow.planner-quorum.json`
- team_create + team_activate + team_workflow execute the generated workflow
- At least one implementation passes all 4 test cases: isEven(2)=true, isEven(3)=false, isEven(0)=true, isEven(-1)=false

### 1.2 team_planner Propose Call

```json
{
    "tool": "team_planner",
    "args": {
        "op": "propose",
        "team_id": "planner-quorum",
        "goal": "Create a team and workflow that implements and verifies `function isEven(n: number): boolean` (true for even, false for odd). Use a fanout with 3 parallel branches, each independently implementing and testing isEven. Use join_policy 'quorum' with quorum 0.67 so that 2 of 3 branches passing is sufficient.",
        "constraints": "3 coder members (alice, bob, carol). Fanout with 3 branches. join_policy: quorum, quorum: 0.67. Each branch tests isEven(2)=true, isEven(3)=false, isEven(0)=true, isEven(-1)=false."
    }
}
```

### 1.3 team_planner Write, Create, Activate, and Workflow

After propose returns the team and workflow JSON, call `team_planner` with `op="write"` to persist the files:

```json
{
    "tool": "team_planner",
    "args": {
        "op": "write",
        "team_id": "planner-quorum",
        "team": <team JSON from propose>,
        "workflow": <workflow JSON from propose>
    }
}
```

This writes `team.planner-quorum.json` and `workflow.planner-quorum.json` to the workspace root. Then follow the standard lifecycle:

```
team_create with team.planner-quorum.json
team_activate(team_id="planner-quorum")
team_workflow(team_id="planner-quorum", workflow_file="workflow.planner-quorum.json")
```

### 1.4 Execution Flow (Timeline)

```
T+0m    team_planner op="propose" — AI generates team + workflow JSON
T+1m    team_planner op="write" — persist JSON files
T+1m    team_create — create team from generated JSON
T+1m    team_activate — activate the team
T+2m    team_workflow workflow_file — engine executes generated workflow
T+2~10m members execute fanout branches: alice, bob, carol each implement isEven in parallel
        Engine awaits quorum barrier: at least 2 of 3 branches must succeed
T+10m   workflow_complete, summary delivered to master
T+10m   run: bun check-coding-quorum-join.ts <run_dir>
```

### 1.5 Check Script

[`check-coding-quorum-join.ts`](./check-coding-quorum-join.ts)

- **Load**: ALL `.md` files in `<run_dir>`
- **Extract**: last ` ```typescript ... ``` ` code block from each file, load `isEven` via `Bun.Transpiler` + `new Function`
- **Assertions**: at least one implementation passes all 4 test cases: isEven(2)=true, isEven(3)=false, isEven(0)=true, isEven(-1)=false

---

## Scenario 2: reverseString -- Fastest Correct Wins via Any-Success Join

### 2.1 Scenario Description

**Background**: Any-success join fires as soon as ANY single branch succeeds. The first correct result wins. This is useful for competitive or timeout-sensitive scenarios where you want the fastest correct implementation, not consensus across all branches.

**Goal**: Use `team_planner` to generate a team and workflow that implements `reverseString(s: string): string` using a 3-branch fanout with `join_policy: "any_success"`. Each branch implements reverseString using a different approach (iterative, recursion, built-in). The first correct implementation wins.

**Success criteria (machine-evaluable)**:
- team_planner propose generates team + workflow JSON
- team_planner write persists `team.planner-any-success.json` and `workflow.planner-any-success.json`
- team_create + team_activate + team_workflow execute the generated workflow
- At least one implementation passes all 4 test cases: reverseString("hello")="olleh", reverseString("")="", reverseString("a")="a", reverseString("ab")="ba"

### 2.2 team_planner Propose Call

```json
{
    "tool": "team_planner",
    "args": {
        "op": "propose",
        "team_id": "planner-any-success",
        "goal": "Create a team and workflow that implements `function reverseString(s: string): string` (returns the reversed string). Use a fanout with 3 branches implementing different approaches (iterative, recursion, built-in). Use join_policy 'any_success' so the first correct implementation delivered wins.",
        "constraints": "3 coder members (alice, bob, carol). Fanout with 3 branches. join_policy: any_success. Each branch tests reverseString('hello')='olleh', reverseString('')='', reverseString('a')='a'."
    }
}
```

### 2.3 team_planner Write, Create, Activate, and Workflow

After propose returns the team and workflow JSON:

```json
{
    "tool": "team_planner",
    "args": {
        "op": "write",
        "team_id": "planner-any-success",
        "team": <team JSON from propose>,
        "workflow": <workflow JSON from propose>
    }
}
```

Then:

```
team_create with team.planner-any-success.json
team_activate(team_id="planner-any-success")
team_workflow(team_id="planner-any-success", workflow_file="workflow.planner-any-success.json")
```

### 2.4 Execution Flow (Timeline)

```
T+0m    team_planner op="propose" — AI generates team + workflow JSON
T+1m    team_planner op="write" — persist JSON files
T+1m    team_create — create team from generated JSON
T+1m    team_activate — activate the team
T+2m    team_workflow workflow_file — engine executes generated workflow
T+2~10m members execute fanout branches: alice, bob, carol each implement reverseString differently
        Engine awaits any_success barrier: first correct branch result triggers join
T+10m   workflow_complete, summary delivered to master
T+10m   run: bun check-coding-any-success-join.ts <run_dir>
```

### 2.5 Check Script

[`check-coding-any-success-join.ts`](./check-coding-any-success-join.ts)

- **Load**: ALL `.md` files in `<run_dir>`
- **Extract**: last ` ```typescript ... ``` ` code block from each file, load `reverseString` via `Bun.Transpiler` + `new Function`
- **Assertions**: at least one implementation passes all 4 test cases: reverseString("hello")==="olleh", reverseString("")==="", reverseString("a")==="a", reverseString("ab")==="ba"

---

## Scenario 3: clamp -- Critical Branch Required with Survivors

### 3.1 Scenario Description

**Background**: Required-branches join means specific named branches MUST succeed. Other branches may fail without failing the entire run. Combined with `use_survivors: true`, the surviving branch outputs are used even if non-required branches error. This is useful when some branches are mission-critical and others are best-effort.

**Goal**: Use `team_planner` to generate a team and workflow that implements `clamp(n: number, lo: number, hi: number): number` using a 3-branch fanout with `join_policy: "required_branches"`, `required_branches: ["critical-impl"]`, and `use_survivors: true`. The 'critical-impl' branch must succeed; the other two are optional.

**Success criteria (machine-evaluable)**:
- team_planner propose generates team + workflow JSON
- team_planner write persists `team.planner-required.json` and `workflow.planner-required.json`
- team_create + team_activate + team_workflow execute the generated workflow
- At least one implementation passes all 4 test cases: clamp(5,0,10)=5, clamp(-1,0,10)=0, clamp(15,0,10)=10, clamp(3,0,10)=3

### 3.2 team_planner Propose Call

```json
{
    "tool": "team_planner",
    "args": {
        "op": "propose",
        "team_id": "planner-required",
        "goal": "Create a team and workflow that implements `function clamp(n: number, lo: number, hi: number): number` (clamps n to [lo, hi]). Use a fanout with 3 branches. Designate one branch as 'critical-impl' (required_branches) that MUST succeed. The other two branches are optional. Use use_survivors: true.",
        "constraints": "3 coder members (alice, bob, carol). Fanout with 3 branches. join_policy: required_branches, required_branches: ['critical-impl']. use_survivors: true. Each branch tests clamp(5,0,10)=5, clamp(-1,0,10)=0, clamp(15,0,10)=10, clamp(3,0,10)=3."
    }
}
```

### 3.3 team_planner Write, Create, Activate, and Workflow

After propose returns the team and workflow JSON:

```json
{
    "tool": "team_planner",
    "args": {
        "op": "write",
        "team_id": "planner-required",
        "team": <team JSON from propose>,
        "workflow": <workflow JSON from propose>
    }
}
```

Then:

```
team_create with team.planner-required.json
team_activate(team_id="planner-required")
team_workflow(team_id="planner-required", workflow_file="workflow.planner-required.json")
```

### 3.4 Execution Flow (Timeline)

```
T+0m    team_planner op="propose" — AI generates team + workflow JSON
T+1m    team_planner op="write" — persist JSON files
T+1m    team_create — create team from generated JSON
T+1m    team_activate — activate the team
T+2m    team_workflow workflow_file — engine executes generated workflow
T+2~10m members execute fanout branches: alice, bob, carol each implement clamp
        critical-impl branch MUST succeed; optional branches may fail
        use_survivors: true ensures surviving branch outputs are used
T+10m   workflow_complete, summary delivered to master
T+10m   run: bun check-coding-required-branches-join.ts <run_dir>
```

### 3.5 Check Script

[`check-coding-required-branches-join.ts`](./check-coding-required-branches-join.ts)

- **Load**: ALL `.md` files in `<run_dir>`
- **Extract**: last ` ```typescript ... ``` ` code block from each file, load `clamp` via `Bun.Transpiler` + `new Function`
- **Assertions**: at least one implementation passes all 4 test cases: clamp(5,0,10)=5, clamp(-1,0,10)=0, clamp(15,0,10)=10, clamp(3,0,10)=3

---

## Scenario 4: gcd + lcm -- Comprehensive Multi-Branch with Gate Verification (Challenge)

**Challenge-level notes**: This scenario uses **5 members and a multi-step workflow with fanout, gate, and review**, demonstrating team_planner's ability to generate complex workflows that combine multiple join semantics and post-join verification. ~30 min.

### 4.1 Scenario Description

**Background**: Team_planner can generate workflows that go beyond simple fanout → join patterns. This scenario exercises the planner's ability to produce a multi-step workflow with a fanout (2 required branches implementing gcd and lcm), a join, a gate for integration verification, and a final review step. The mathematical relationship `lcm(a,b) === a*b/gcd(a,b)` provides a natural cross-verification.

**Goal**: Use `team_planner` to generate a team and workflow that implements both `gcd(a: number, b: number): number` and `lcm(a: number, b: number): number` using a 2-branch fanout with `join_policy: "required_branches"` (both branches required). A gate step verifies both functions work together, and a final review step signs off.

**Success criteria (machine-evaluable)**:
- team_planner propose generates team + workflow JSON with 5 members
- team_planner write persists `team.planner-comprehensive.json` and `workflow.planner-comprehensive.json`
- team_create + team_activate + team_workflow execute the generated workflow
- At least one member's output contains working gcd and lcm implementations
- gcd(12,8)=4, gcd(7,13)=1, lcm(12,8)=24, lcm(7,13)=91
- Mathematical relationship verified: lcm(a,b) === a*b/gcd(a,b) for (12,8), (7,13), (48,18)

### 4.2 team_planner Propose Call

```json
{
    "tool": "team_planner",
    "args": {
        "op": "propose",
        "team_id": "planner-comprehensive",
        "goal": "Create a team and workflow that implements BOTH `function gcd(a: number, b: number): number` and `function lcm(a: number, b: number): number` (= a*b/gcd(a,b)). Use a fanout with 2 required branches. Use join_policy: 'required_branches' with both branch ids required. Then a final gate verifies both functions work together.",
        "constraints": "5 members: alice (coder), bob (coder), carol (coder), dave (tester), erin (reviewer). Fanout with 2 branches: 'gcd-branch' (alice) and 'lcm-branch' (bob). join_policy: required_branches. Gate (dave) verifies: gcd(12,8)=4, gcd(7,13)=1, lcm(12,8)=24, lcm(7,13)=91. Final review (erin)."
    }
}
```

### 4.3 team_planner Write, Create, Activate, and Workflow

After propose returns the team and workflow JSON:

```json
{
    "tool": "team_planner",
    "args": {
        "op": "write",
        "team_id": "planner-comprehensive",
        "team": <team JSON from propose>,
        "workflow": <workflow JSON from propose>
    }
}
```

Then:

```
team_create with team.planner-comprehensive.json
team_activate(team_id="planner-comprehensive")
team_workflow(team_id="planner-comprehensive", workflow_file="workflow.planner-comprehensive.json", timeout_ms=1800000)
```

### 4.4 Execution Flow (Timeline)

```
T+0m     team_planner op="propose" — AI generates team + workflow JSON
T+1m     team_planner op="write" — persist JSON files
T+1m     team_create — create team from generated JSON
T+1m     team_activate — activate the team
T+2m     team_workflow workflow_file — engine executes generated workflow
T+2~12m  fanout branches: alice implements gcd, bob implements lcm (parallel)
T+12m    join: both required branches complete
T+12~18m dave (gate) verifies both functions and the mathematical relationship
T+18~25m erin (review) provides final signoff
T+25m    workflow_complete, summary delivered to master
T+25m    run: bun check-coding-comprehensive-join.ts <run_dir>
```

### 4.5 Check Script

[`check-coding-comprehensive-join.ts`](./check-coding-comprehensive-join.ts)

- **Load**: ALL `.md` files in `<run_dir>`
- **Extract**: last ` ```typescript ... ``` ` code block from each file, load both `gcd` and `lcm` via `Bun.Transpiler` + `new Function`
- **Assertions**:
  1. At least one member's code exposes both gcd and lcm functions
  2. gcd(12,8)=4, gcd(7,13)=1
  3. lcm(12,8)=24, lcm(7,13)=91
  4. lcm(a,b) === a*b/gcd(a,b) for all test pairs: (12,8), (7,13), (48,18)

---


## Quick-Start Prompts (Copy and Use)

Paste any of the following prompts into the master session and the AI will automatically complete the full closed loop of "team_planner propose → write → team_create → team_activate → team_workflow → run check script", reporting PASS / FAIL by exit code.

### Scenario 1: isEven via Quorum Join (Fault-Tolerant Redundancy)

```text
Run the full closed loop for demos/18-team-planner/README.md "Scenario 1: isEven via Quorum Join" and auto-evaluate.

Steps:
1. Call team_planner op="propose" with team_id="planner-quorum" and the goal/constraints from README section 1.2
2. Call team_planner op="write" with team_id="planner-quorum" and the generated team + workflow JSON (section 1.3)
3. team_create from the generated team JSON, then team_activate(team_id="planner-quorum")
4. team_workflow(team_id="planner-quorum", workflow_file="workflow.planner-quorum.json")
5. Poll team_results until master receives summary (poll every 30s)
6. Locate <run_dir> (contains per-member .md files)
7. Run: bun demos/18-team-planner/check-coding-quorum-join.ts <run_dir>
8. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: at least one implementation passes all 4 isEven test cases.
```

### Scenario 2: reverseString via Any-Success Join (Fastest Correct Wins)

```text
Run the full closed loop for demos/18-team-planner/README.md "Scenario 2: reverseString via Any-Success Join" and auto-evaluate.

Steps:
1. Call team_planner op="propose" with team_id="planner-any-success" and the goal/constraints from README section 2.2
2. Call team_planner op="write" with team_id="planner-any-success" and the generated team + workflow JSON (section 2.3)
3. team_create from the generated team JSON, then team_activate(team_id="planner-any-success")
4. team_workflow(team_id="planner-any-success", workflow_file="workflow.planner-any-success.json")
5. Poll team_results until master receives summary (poll every 30s)
6. Locate <run_dir>
7. Run: bun demos/18-team-planner/check-coding-any-success-join.ts <run_dir>
8. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: at least one implementation passes all 4 reverseString test cases.
```

### Scenario 3: clamp via Required-Branches Join (Critical Branch with Survivors)

```text
Run the full closed loop for demos/18-team-planner/README.md "Scenario 3: clamp via Required-Branches Join" and auto-evaluate.

Steps:
1. Call team_planner op="propose" with team_id="planner-required" and the goal/constraints from README section 3.2
2. Call team_planner op="write" with team_id="planner-required" and the generated team + workflow JSON (section 3.3)
3. team_create from the generated team JSON, then team_activate(team_id="planner-required")
4. team_workflow(team_id="planner-required", workflow_file="workflow.planner-required.json")
5. Poll team_results until master receives summary (poll every 30s)
6. Locate <run_dir>
7. Run: bun demos/18-team-planner/check-coding-required-branches-join.ts <run_dir>
8. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: at least one implementation passes all 4 clamp test cases.
```

### Scenario 4: gcd + lcm Comprehensive Multi-Branch (Challenge)

```text
Run the full closed loop for demos/18-team-planner/README.md "Scenario 4: gcd + lcm Comprehensive Multi-Branch (Challenge)" and auto-evaluate (challenge-level: 5 members, multi-step workflow).

Steps:
1. Call team_planner op="propose" with team_id="planner-comprehensive" and the goal/constraints from README section 4.2
2. Call team_planner op="write" with team_id="planner-comprehensive" and the generated team + workflow JSON (section 4.3)
3. team_create from the generated team JSON, then team_activate(team_id="planner-comprehensive")
4. team_workflow(team_id="planner-comprehensive", workflow_file="workflow.planner-comprehensive.json", timeout_ms=1800000)
5. Poll team_results until master receives summary (poll every 30s)
6. Locate <run_dir>
7. Run: bun demos/18-team-planner/check-coding-comprehensive-join.ts <run_dir>
8. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: at least one member's gcd and lcm pass all test cases; mathematical relationship lcm(a,b)=a*b/gcd(a,b) verified for 3 pairs.
```
