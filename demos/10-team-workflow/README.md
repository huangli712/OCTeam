# team_workflow Orchestration Scenario Design

> **Mode**: `team_workflow` — declarative, deterministic step engine. Each step can be a `task` (one member produces output), a `gate` (a verifier issues a three-valued PASS / FAIL / INVALID verdict on a specified preceding task), a `fanout`, or a `join`. The engine — not the master LLM — drives advancement, retries, branch merging, reduce aggregation, and recovery; intermediate results enter only the downstream member context by default, not the master context.
> **Source**: [`src/tools/workflow.ts`](../../src/tools/workflow.ts) / [`src/orchestration/workflow/workflow.ts`](../../src/orchestration/workflow/workflow.ts)
> **Time budget**: Each baseline scenario has 2 members, a 4-step chain (task → gate → task → gate), each step 3-5 min, serial ≈ 14-18 min (well under the 30 min ceiling). **Scenario 4 is challenge-level**: 6 members, 8-step fanout→join workflow, ~50 min, demonstrating workflow's parallel branch integration capability.

## Scenario Overview

| # | Domain | Scenario | Members | Member Roles | Step Sequence | Est. Duration |
|---|------|------|--------|---------|-----------|-----------|
| 1 | Programming | REST API handler implementation + verification + refactor + re-verification | 2 | `coder` / `tester` | task → gate → task → gate | ~16 min |
| 2 | Math | Bisection root-finding implementation + verification + iterative optimization | 2 | `mathematician` / `reviewer` | task → gate → task → gate | ~14 min |
| 3 | Computational Physics | Projectile motion RK4 solver + energy verification + drag modeling | 2 | `simulator` / `physicist` | task → gate → task → gate | ~16 min |
| 4 | Programming (challenge) | Multi-module fanout parallel implementation + join reduce integration verification | 6 | `coder` ×4 / `reviewer` / `tester` | task → fanout(3) → join(reduce) → gate | ~50 min |

> Scenarios 1-3 are baseline types (linear task/gate chains) with check scripts provided; scenario 4 is challenge-level (fanout parallel branches + join reduce), demonstrating workflow's declarative concurrent integration capability.

---

## Scenario 1: REST API Handler Implementation + Verification + Refactor

### 1.1 Scenario Description

**Background**: Implement a REST handler for user registration: parameter validation, error responses, and the success path. First write the implementation, then independently verify (edge cases + error handling), and after passing verification, perform a single refactor (extract a validation function, improve readability). After refactoring, use the same gate to verify that behavior is unchanged, ensuring no regressions were introduced.

**Goal**: Use a single `team_workflow` to chain four heterogeneous steps — `coder` implement → `tester` gate verify → `coder` refactor → `tester` gate re-verify — driven deterministically by the engine, with the master receiving only the final summary.

**Success criteria (human-judged)**:
- step 1 (task): `coder` produces a loadable handler code block
- step 2 (gate): `tester` issues `<verdict>{"result":"PASS",...}</verdict>` for the step 1 output
- step 3 (task): `coder` refactors based on upstream (step 1 output), keeping behavior unchanged while improving readability
- step 4 (gate): `tester` re-verifies the step 3 refactored output for unchanged behavior, issuing `<verdict>{"result":"PASS",...}</verdict>`
- Final `workflow_complete`, master receives summary with the four-step ledger + each task's output

### 1.2 Team Configuration

```json
{
  "name": "register-handler-flow",
  "description": "Linear workflow: implement register handler, gate-verify, then refactor — engine-driven, no master context bloat"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement and refactor TypeScript with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block."
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You are a tester. You verify implementations by checking them against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Both task steps use the same `coder` (alice) to ensure implementation-to-refactor continuity; the gate uses an independent `tester` (bob, a read-only agent) as the judge, avoiding self-verification (schema hard constraint: the gate's verifier must differ from the preceding task's member).

### 1.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "register-handler-flow",
    "steps": [
      {
        "kind": "task",
        "member": "alice",
        "task": "Implement a TypeScript function `handleRegister(body: { email: string; password: string })` that returns `{ status: 400, error: string }` on invalid input (empty email, password < 8 chars) and `{ status: 200, user: { email } }` on success. Embed the code in a fenced ```typescript block."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Verify handleRegister rejects empty email with 400, rejects password shorter than 8 chars with 400, and returns 200 with the email on valid input. Emit PASS only if all three hold; FAIL naming the failing case.",
        "on_fail": "retry",
        "max_retries": 1
      },
      {
        "kind": "task",
        "member": "alice",
        "task": "Refactor the upstream handleRegister implementation: extract the validation into a `validate(body)` function and keep behavior identical. Embed the refactored code in a fenced ```typescript block."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Re-verify the REFACTORED handleRegister against the SAME three cases (empty email -> 400, password < 8 -> 400, valid input -> 200). The refactor must not change behavior. Emit PASS only if all three still hold AND a validate() function was extracted; FAIL naming any regression or missing extraction.",
        "on_fail": "retry",
        "max_retries": 1
      }
    ],
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- step 1 is a `task` (hard constraint: the first step must be a task, and a gate must verify a preceding task)
- step 2 `verifier: "bob"` ≠ step 1 `member: "alice"` — satisfies "no self-verification"
- step 2 `on_fail: "retry"` + `max_retries: 1` — on gate FAIL, re-dispatch alice with the diff (first implementations easily miss edge cases); a second FAIL causes the entire run to fail (`workflow_failed`)
- step 3 is a `task`; the engine automatically injects step 1's output as upstream context (gate step verdicts are not included in upstream)
- step 4 is a `gate` verifying step 3's refactored output — `verifier: "bob"` ≠ step 3 `member: "alice"`, also satisfying "no self-verification"; criteria reuse step 2's three cases + the additional requirement that `validate()` was extracted, ensuring the refactor introduces no regression
- step 4 `on_fail: "retry"` + `max_retries: 1` — refactors can also introduce regressions, giving alice one correction chance
> Note: step 4 defaults to verifying the "most recent preceding task" (i.e. step 3). To have step 4 reuse step 2's already-confirmed set of cases but explicitly verify step 1's implementation, add `target_step: 1`; this scenario keeps the default to demonstrate the most-recent-predecessor semantics.
- `timeout_ms: 1200000` (20 min) — four serial steps, normal completion in 16 min, with margin

### 1.4 Execution Flow (Timeline)

```
T+0m     master 调用 team_workflow
T+0m     engine dispatch step 1 (alice, task): 实现 handleRegister
T+0~5m   alice 产出 handler 代码 → idle
T+5m     engine 推进到 step 2 (gate): dispatch bob，喂入 step 1 产出 + criteria
T+5~8m   bob 判定 → <verdict>
         PASS  -> engine 推进到 step 3
         FAIL  -> 重派 alice（带 diff），attempts++；再走一次 gate；第二次 FAIL -> workflow_failed
T+8m     engine dispatch step 3 (alice, task): 重构，注入 step 1 产出作上游
T+8~12m  alice 产出重构代码 → idle
T+12m    engine 推进到 step 4 (gate): dispatch bob，喂入 step 3 重构产出 + criteria
T+12~16m bob 再判定 → <verdict>
         PASS  -> 所有步骤完成 -> workflow_complete
         FAIL  -> 重派 alice（带 diff），attempts++；再走一次 gate；第二次 FAIL -> workflow_failed
T+16m    workflow_complete，汇总交付 master（含四步账本 + task 产出）
```

> When any task/gate actor is missing a live session (session not yet created or member already errored): if `fallback_member` / `fallback_verifier` is declared, the engine automatically switches to the fallback actor; if the fallback is also unavailable, steps **inside a fanout branch** degrade to errored branches (subject to `max_errored` / `join_policy` constraints), while **top-level** steps still explicitly terminate as `workflow_failed:no_session:<member>`. The engine writes a `workflow.steps` snapshot into the `RunRecord` (per step: kind / member / verifier / dispatchedActor / targetStep / verdict / attempts / completed / output / outputBytes). `team_result_get` renders `### workflow steps` groups when reading that run, showing the ledger by Step N plus each task's output snapshot; `format: "mermaid"` exports a Mermaid flowchart diagram.

### 1.5 Optional: Human Approval (HITL)

Add `"human_approval": true` to `team_workflow`, and the engine will pause after every non-terminal step completes (task done, gate PASS) before advancing to the next step, waiting for `team_approve` / `team_reject`:

- `team_approve(team_id, approval_id)` — continue to the next step
- `team_reject(team_id, approval_id, feedback)` — entire run fails (`workflow_human_rejected`)

Wall-clock time during the pause does not count toward the timeout (consistent with HITL in other orchestration modes). The approval prompt displays `workflow_step (step N)` (1-based) along with the completed step's kind / actor / verdict rationale and a summary of the next step, making it easy for the master to judge directly.

### 1.6 Optional: dry_run Preview

Add `dry_run: true` before launching, and `team_workflow` will only render a 1-based step plan without creating `activeTask` or dispatching members:

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "register-handler-flow",
    "dry_run": true,
    "steps": [ /* same as 1.3 */ ]
  }
}
```

Output resembles:
```
Workflow dry run for "register-handler-flow" (4 step(s)):
1. [task] alice: Implement ...
2. [gate] bob verifies step 1: Verify handleRegister ...; on_fail=retry max_retries=1
3. [task] alice: Refactor ...
4. [gate] bob verifies step 3: Re-verify ...; on_fail=retry max_retries=1
```

Validation failures (e.g. `on_fail="retry"` missing `max_retries`, task/gate cross-fields, `target_step` pointing to a gate) are also caught at this stage, avoiding half-started runs.

### 1.7 Optional: workflow_file Template

Complex workflows can be placed in JSON files within the repository and then templated with `vars`. The file must be a relative workspace path ending in `.json`; setting `version: 1` and `strict_vars: true` is recommended so that variable spelling mistakes fail before launch.

This directory provides a template that can be previewed or launched directly: [`register-handler.workflow.json`](./register-handler.workflow.json). Launch it like this:

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "register-handler-flow",
    "workflow_file": "demos/10-team-workflow/register-handler.workflow.json",
    "vars": {
      "handler": "handleRegister",
      "resource": "register handler"
    }
  }
}
```

Add `dry_run: true` first to inspect the variable-substituted step ledger and confirm that members, gates, join policy, and data flow all match expectations before launching the real orchestration.

---

## Scenario 2: Bisection Root-Finding Implementation + Verification + Iterative Optimization

### 2.1 Scenario Description

**Background**: The bisection method is the most fundamental and robust root-finding algorithm in numerical analysis. Given a continuous function `f(x)` and an interval `[a,b]` containing a single root (`f(a)·f(b) < 0`), the bisection method converges to arbitrary precision with logarithmic complexity. Though simple, edge-case handling (sign check, convergence criterion, maximum iteration count) is a classic trap.

**Goal**: Use a single `team_workflow` to chain four steps — `mathematician` implement → `reviewer` gate verify → `mathematician` optimize iteration count → `reviewer` gate re-verify — driven deterministically by the engine.

**Success criteria (machine-evaluable)**:
- step 1 (task): produces a loadable `bisect(f, a, b, tol)` TypeScript function
- step 2 (gate): verifies `bisect` correctly finds the root of `f(x)=x²-2` on `[1,2]` (accuracy < 1e-8), and checks that `f(a)·f(b) ≥ 0` throws an error
- step 3 (task): optimizes the implementation — explicit max_iter safeguard, early termination when signs remain unchanged in the interval
- step 4 (gate): re-verifies the optimized version on two additional functions: `f(x)=cos(x)-x` (root ≈ 0.739085) and `f(x)=x³-5`
- Final `workflow_complete`, both gates PASS

### 2.2 Team Configuration

```json
{
  "name": "bisect-flow",
  "description": "Linear workflow: implement bisection root-finding, gate-verify, then optimize — engine-driven"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematician. You implement numerical algorithms in TypeScript with rigor, using minimal code. When asked to produce an implementation, embed the full TypeScript in a single ```typescript fenced block and declare it with an IMPL marker. Your output MUST end with a line exactly formatted: <!-- IMPL: bisect -->"
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a reviewer. You verify mathematical implementations by running them against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise (naming the failing case). Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Both task steps use the same `mathematician` (alice) to ensure implementation-to-optimization continuity; the gate uses an independent `reviewer` (bob, a read-only agent) as the judge.

### 2.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "bisect-flow",
    "steps": [
      {
        "kind": "task",
        "member": "alice",
        "task": "Implement `bisect(f: (x: number) => number, a: number, b: number, tol: number): number` in TypeScript using the bisection method. Throw if f(a)*f(b) >= 0 (no sign change). Stop when (b-a)/2 < tol. Embed code in a ```typescript fenced block and end with <!-- IMPL: bisect -->."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Verify: (1) bisect(x => x*x-2, 1, 2, 1e-8) returns sqrt(2) ≈ 1.41421356 within tol; (2) bisect(x => x*x-2, 2, 3, 1e-8) throws (no sign change). Emit PASS only if both hold; FAIL naming the failing case.",
        "on_fail": "retry",
        "max_retries": 1
      },
      {
        "kind": "task",
        "member": "alice",
        "task": "Refine the bisect implementation: add an explicit max_iter parameter (default 100), add early-termination when |f(mid)| < tol, and handle the case where the interval does not shrink (no progress). Keep the same function signature (max_iter as optional 4th param after tol). Embed the refined code in a fenced block."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Re-verify the REFINED bisect on two ADDITIONAL functions: (1) f(x)=cos(x)-x on [0,1] → root ≈ 0.739085 (tol=1e-8); (2) f(x)=x^3-5 on [1,2] → root ≈ 1.709976 (tol=1e-8). Also re-confirm the original sqrt(2) case still works. Emit PASS only if all 3 functions' roots are found within tol AND the implementation has a max_iter safeguard; FAIL naming any regression or missing feature.",
        "on_fail": "retry",
        "max_retries": 1
      }
    ],
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- step 1 `verifier: "bob"` ≠ `member: "alice"` — satisfies "no self-verification"
- step 2 `on_fail: "retry"` + `max_retries: 1` — sign-check edge case easily missed on first implementation
- step 3 task reuses alice; engine automatically injects step 1 output as upstream
- step 4 verifies step 3's optimized version with two additional test functions to ensure optimization introduces no regression
- `timeout_ms: 1200000` (20 min) — four serial steps, normal completion in 14 min

### 2.4 Execution Flow (Timeline)

```
T+0m     master 调用 team_workflow
T+0m     engine dispatch step 1 (alice, task): 实现 bisect
T+0~5m   alice 产出 bisect 代码 + IMPL 标记 → idle
T+5m     engine 推进到 step 2 (gate): dispatch bob，喂入 step 1 产出 + criteria
T+5~8m   bob 跑 sqrt(2) 用例 + 符号检查 → <verdict>
         PASS  -> engine 推进到 step 3
         FAIL  -> 重派 alice（带 diff），再走一次 gate；第二次 FAIL -> workflow_failed
T+8m     engine dispatch step 3 (alice, task): 优化 bisect，注入 step 1 产出作上游
T+8~11m  alice 产出优化版代码 → idle
T+11m    engine 推进到 step 4 (gate): dispatch bob，喂入 step 3 产出 + 三条用例
T+11~14m bob 跑 sqrt(2) + cos(x)-x + x³-5 → <verdict>
         PASS  -> workflow_complete
T+14m    workflow_complete，汇总交付 master
```

### 2.5 Check Script

[`check-math-bisect.ts`](./check-math-bisect.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
  - Producer code: grab ` ```typescript ... ``` ` code block
  - Verifier verdict: `<verdict>{...}</verdict>` tagged JSON block (`JSON.parse` to get `result`)
- **Assertions**:
  1. Producer code can be loaded via `new Function` as `bisect` function
  2. `abs(bisect(x=>x*x-2, 1, 2, 1e-8) - sqrt(2)) < 1e-7`
  3. `bisect(x=>x*x-2, 2, 3, 1e-8)` throws (no sign change)
  4. `abs(bisect(x=>Math.cos(x)-x, 0, 1, 1e-8) - 0.739085) < 1e-6`
  5. `abs(bisect(x=>x*x*x-5, 1, 2, 1e-8) - cbrt(5)) < 1e-6`
  6. Both verifier `result` values are `PASS`

---

## Scenario 3: Projectile Motion RK4 Solver + Energy Verification + Drag Modeling

### 3.1 Scenario Description

**Background**: Projectile motion is the entry-level simulation of classical mechanics. 2D projectile motion without drag (x: constant velocity, y: `dv/dt = -g`) has an analytic solution, suitable for verifying solver correctness; adding air resistance (`F_drag = -k·v²`) turns it into a nonlinear ODE system that cannot be solved analytically and must rely on numerical integration. The fourth-order Runge-Kutta method (RK4) is the sweet spot between accuracy and implementation complexity.

**Goal**: Use a single `team_workflow` to chain four steps — `simulator` implement RK4 + drag-free projectile verification → `physicist` gate energy conservation verdict → `simulator` add air resistance → `physicist` gate verify terminal velocity behavior — driven by the engine.

**Success criteria (machine-evaluable)**:
- step 1 (task): produces a loadable `rk4_step(f, y, t, h)` TypeScript function + drag-free projectile simulation
- step 2 (gate): verifies energy conservation (`|E_final - E0|/E0 < 1e-3`) and max height ≈ `v₀²/(2g)`
- step 3 (task): adds velocity-squared air resistance `F_drag = -k·|v|·v` (k=0.1), re-runs simulation
- step 4 (gate): verifies that with drag, energy decays monotonically and terminal velocity approaches the square root of `mg/k`
- Final `workflow_complete`, both gates PASS

### 3.2 Team Configuration

```json
{
  "name": "projectile-flow",
  "description": "Linear workflow: implement RK4 projectile, gate-verify energy conservation, then add drag — engine-driven"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are a simulator. You implement numerical ODE solvers in TypeScript and run them to report physical quantities. Embed runnable code in a ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- ENERGY: <drift> --> when reporting energy drift, and <!-- DRAG: <term_vel> --> when reporting drag results."
    },
    {
      "name": "bob",
      "role": "physicist",
      "prompt": "You are a physicist. You verify numerical results against physical conservation laws and known tolerances. Emit a verdict: PASS if every criterion holds, FAIL otherwise (naming the failing case). Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Task uses `simulator` (numerical ODE simulation expert); gate uses `physicist` (understands energy conservation and aerodynamics, can independently recompute and judge).

### 3.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "projectile-flow",
    "steps": [
      {
        "kind": "task",
        "member": "alice",
        "task": "Implement a 4th-order Runge-Kutta ODE stepper `rk4_step(f, y, t, h)` in TypeScript. Use it to simulate 2D projectile motion WITHOUT air resistance: dx/dt=vx, dvx/dt=0, dy/dt=vy, dvy/dt=-g (g=9.81). IC: (x0=0, y0=0, vx0=20*cos(45°), vy0=20*sin(45°)). Run with h=0.01 until y<0. Report the energy drift |E_final - E0|/E0 and the max height. Embed code in a fenced block and end with <!-- ENERGY: <drift> -->."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Verify: (1) energy drift |E_final-E0|/E0 < 1e-3 (RK4 is symplectic enough for this short integration); (2) max height ≈ vy0^2/(2g) ≈ 10.2 m (within 5%). Emit PASS only if both hold; FAIL naming which criterion failed.",
        "on_fail": "retry",
        "max_retries": 1
      },
      {
        "kind": "task",
        "member": "alice",
        "task": "Add velocity-squared air resistance to the RK4 simulation: F_drag = -k*|v|*v (k=0.1 kg/m) applied to both vx and vy. Keep the same initial conditions. Run until y<0 or t>20s. Report the terminal velocity (magnitude of v when |dv/dt| < 0.01) and the energy decay over time. Embed code in a fenced block and end with <!-- DRAG: <term_vel> -->."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Verify with air resistance: (1) total energy E(t) strictly decreases over time (no energy gain from drag); (2) terminal velocity approaches sqrt(mg/k) — for this setup m=1, k=0.1, sqrt(9.81/0.1) ≈ 9.9 m/s (within 20%). Also re-confirm energy drift from step 1 is < 1e-3. Emit PASS only if all hold; FAIL naming which criterion failed.",
        "on_fail": "retry",
        "max_retries": 1
      }
    ],
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- step 2 `verifier: "bob"` ≠ `member: "alice"` — satisfies "no self-verification"
- step 2 `on_fail: "retry"` + `max_retries: 1` — wrong step size or initial conditions for RK4 can easily cause excessive energy drift
- step 3 task reuses alice; engine automatically injects step 1 output (drag-free simulation) as upstream
- `timeout_ms: 1200000` (20 min) — four serial steps, normal completion in 16 min

### 3.4 Execution Flow (Timeline)

```
T+0m     master 调用 team_workflow
T+0m     engine dispatch step 1 (alice, task): 实现 RK4 抛体
T+0~5m   alice 产出 RK4 + 无阻力仿真 + ENERGY 标记 → idle
T+5m     engine 推进到 step 2 (gate): dispatch bob，喂入 step 1 产出
T+5~8m   bob 核对能量守恒 + 最大高度 → <verdict>
         PASS  -> engine 推进到 step 3
T+8m     engine dispatch step 3 (alice, task): 加入空气阻力
T+8~12m  alice 产出含阻力仿真代码 + DRAG 标记 → idle
T+12m    engine 推进到 step 4 (gate): dispatch bob
T+12~16m bob 核对能量单调衰减 + 终端速度 → <verdict>
         PASS  -> workflow_complete
T+16m    workflow_complete，汇总交付 master
```

### 3.5 Check Script

[`check-physics-projectile.ts`](./check-physics-projectile.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
  - Producer markers: regex `<!--\s*ENERGY:\s*([\d.eE+-]+)\s*-->` extracts drift; `<!--\s*DRAG:\s*([\d.eE+-]+)\s*-->` extracts terminal velocity
  - Verifier verdict: `<verdict>{...}</verdict>` tagged JSON block
- **Assertions**:
  1. `drift` exists and `Number.isFinite`
  2. `drift < 1e-3` (RK4 drag-free short-time integration should conserve energy)
  3. `term_vel` exists and > 0
  4. `abs(term_vel - 9.9) / 9.9 < 0.2` (terminal velocity close to `sqrt(mg/k)`)
  5. Both verifier `result` values are `PASS`

---

## Scenario 4: Multi-Module Fanout Parallel Implementation + Join Reduce Integration Verification (Challenge-Level)

> **Challenge-level notes**: This scenario breaks baseline constraints (2 members / linear chain / ≤30 min), using **6 members and 8 steps (with fanout three-way parallel + join reduce aggregation)**, demonstrating `team_workflow`'s declarative parallel branching and reduce aggregation capability. ~50 min.

### 4.1 Scenario Description

**Background**: Build three core modules of a micro user management system — authentication (auth), user CRUD (users), and audit logging (audit). The modules share type dependencies (`User`, `AuthToken`, `AuditEntry`), so interfaces must be defined uniformly first before implementing separately, and finally integration-verified for the three to work together. Workflow's `fanout` allows parallel implementation of the three modules, `join(reduce)` aggregates all branch outputs into one consolidated report, and finally a `gate` performs integration testing.

**Goal**: Use a single `team_workflow` to chain eight steps — `coder` define shared types (task) → `reviewer` confirm type completeness (gate) → three-way `fanout` parallel module implementation (auth / users / audit) → `join(reduce)` aggregation → `tester` integration verification (gate) — driven deterministically by the engine.

**Success criteria (machine-evaluable)**:
- step 1 (task: alice): produces type definitions containing three TypeScript interfaces: `User`, `AuthToken`, `AuditEntry`
- step 2 (gate: bob): verifies all three interface fields are complete and non-conflicting
- steps 3-5 (fanout three-way parallel task: carol/dave/erin): implement auth (login/logout/validate), users (create/find/delete), and audit (log/query) respectively
- step 6 (join reduce: frank): aggregates the three modules' interface lists and dependency graph
- step 7 (gate: bob): integration test — auth issues token → users creates user with token auth → audit records the action → verify the full chain
- Final `workflow_complete`, all gates PASS

### 4.2 Team Configuration

```json
{
  "name": "modular-cms-flow",
  "description": "Fanout workflow: shared types -> parallel module impl -> join reduce -> integration gate"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You define clean TypeScript interfaces and shared types. Embed code in a ```typescript fenced block. Your output MUST end with your work clearly visible."
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a reviewer. You verify type completeness and cross-module integration. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript modules based on shared type definitions. Embed the full implementation in a ```typescript fenced block. Your output MUST end with a line: <!-- MODULE: auth --> with a summary of exported functions."
    },
    {
      "name": "dave",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript modules based on shared type definitions. Embed the full implementation in a ```typescript fenced block. Your output MUST end with a line: <!-- MODULE: users --> with a summary of exported functions."
    },
    {
      "name": "erin",
      "role": "coder",
      "prompt": "You are a coder. You implement TypeScript modules based on shared type definitions. Embed the full implementation in a ```typescript fenced block. Your output MUST end with a line: <!-- MODULE: audit --> with a summary of exported functions."
    },
    {
      "name": "frank",
      "role": "tester",
      "prompt": "You are a tester. You perform integration testing across multiple modules, verifying that they work together correctly. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**:
- `alice` (coder): defines shared types, single source of truth
- `bob` (reviewer): gate verifies type completeness and performs integration testing
- `carol/dave/erin` (coder ×3): fanout three-way parallel implementation of each module
- `frank` (tester): join reduce aggregation + final gate integration verification

### 4.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "modular-cms-flow",
    "steps": [
      {
        "kind": "task",
        "id": "define-types",
        "member": "alice",
        "task": "Define shared TypeScript interfaces in a single file: `User { id: string; email: string; name: string; createdAt: number }`, `AuthToken { token: string; userId: string; expiresAt: number }`, `AuditEntry { id: string; action: string; userId: string; timestamp: number; details: string }`. Embed in a ```typescript fenced block."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Verify all three interfaces are defined with the required fields. Check for field completeness (all required fields present) and type consistency. Emit PASS only if all three interfaces are valid; FAIL naming the missing/broken interface.",
        "on_fail": "retry",
        "max_retries": 1
      },
      {
        "kind": "fanout",
        "join_policy": "reduce",
        "reducer_member": "frank",
        "branches": [
          {
            "id": "auth",
            "steps": [
              {
                "kind": "task",
                "member": "carol",
                "task": "Implement the auth module using the shared types from upstream. Provide functions: `login(email, password) => AuthToken`, `logout(token) => void`, `validateToken(token) => boolean`. Include input validation. Embed code in a ```typescript fenced block and end with <!-- MODULE: auth --> listing your exports."
              }
            ]
          },
          {
            "id": "users",
            "steps": [
              {
                "kind": "task",
                "member": "dave",
                "task": "Implement the users module using the shared types from upstream. Provide functions: `createUser(data, authToken) => User`, `findUser(id) => User|null`, `deleteUser(id, authToken) => void`. Require valid authToken for mutations. Embed code in a ```typescript fenced block and end with <!-- MODULE: users --> listing your exports."
              }
            ]
          },
          {
            "id": "audit",
            "steps": [
              {
                "kind": "task",
                "member": "erin",
                "task": "Implement the audit module using the shared types from upstream. Provide functions: `logAction(action, userId, details) => AuditEntry`, `queryLogs(userId?, since?) => AuditEntry[]`. Use Date.now() for timestamps. Embed code in a ```typescript fenced block and end with <!-- MODULE: audit --> listing your exports."
              }
            ]
          }
        ]
      },
      {
        "kind": "join"
      },
      {
        "kind": "gate",
        "verifier": "frank",
        "criteria": "Integration test the COMPLETE system: (1) auth.login() returns a valid AuthToken; (2) users.createUser() with valid token creates user; (3) users.createUser() with INVALID token throws/rejects; (4) audit.logAction() records the create-user action; (5) audit.queryLogs() finds the recorded entry. Emit PASS only if ALL 5 cases pass; FAIL naming the failing case.",
        "on_fail": "retry",
        "max_retries": 1
      }
    ],
    "timeout_ms": 3000000
  }
}
```

**Parameter selection**:
- step 3 is a `fanout`, `join_policy: "reduce"` + `reducer_member: "frank"` — after the three parallel tasks complete, frank aggregates all branch outputs
- step 4 `join(reduce)` is the fanout's endpoint — after frank produces the aggregated report, the workflow advances to the integration gate
- step 5 gate's `verifier: "frank"` shares the name with the join reducer but this does not conflict — after the join produces the aggregated report, frank acts as the gate verifier for integration testing
- Each gate has `on_fail: "retry"` + `max_retries: 1` — type definitions or integration may be incomplete on first pass, so give one correction chance
- `timeout_ms: 3000000` (50 min) — 6 members + 8 steps, fanout three-way parallel implementation (~12 min) + join reduce (~8 min) + integration gate (~8 min), serial cumulative ~50 min

### 4.4 Execution Flow (Timeline)

```
T+0m     master 调用 team_workflow
T+0m     engine dispatch step 1 (alice, task): 定义共享类型
T+0~4m   alice 产出 User / AuthToken / AuditEntry 接口 → idle
T+4m     engine 推进到 step 2 (gate): dispatch bob 验证类型完备
T+4~7m   bob 核对三接口字段完整 → <verdict>
         PASS  -> engine 推进到 step 3 (fanout)
         FAIL  -> 重派 alice，再走 gate；二次 FAIL -> workflow_failed
T+7m     engine 展开 fanout: 并行 dispatch carol(auth), dave(users), erin(audit)
T+7~19m  三人各自实现模块（并行，12 min 上限）→ idle
T+19m    barrier: 所有分支完成 → engine 推进到 step 4 (join reduce)
T+19m    dispatch frank（reducer），喂入三路产出
T+19~27m frank 聚合三个模块，产出接口清单 + 依赖图 → idle
T+27m    engine 推进到 step 5 (gate): dispatch frank(verifier)，喂入集成上下文
T+27~35m frank 跑 5 条集成用例（token 鉴权 → 创建用户 → 审计记录）→ <verdict>
         PASS  -> workflow_complete
         FAIL  -> 回路修正（重派对应 producer），再走 gate
T+35m    workflow_complete，汇总交付 master（含所有 8 步账本 + task 产出）
```

### 4.5 Check Script

[`check-coding-modular-cms.ts`](./check-coding-modular-cms.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,dave,erin,frank}.md` (6 files)
- **Extract**:
  - step 1: alice.md contains three interface type definitions (regex: `interface User` + `interface AuthToken` + `interface AuditEntry`)
  - step 2: bob.md `<verdict>{...}</verdict>` gate verdict
  - steps 3-5: carol/dave/erin.md each contain `<!-- MODULE: {auth|users|audit} -->` markers
  - step 5 gate: frank.md `<verdict>{...}</verdict>` gate verdict
- **Assertions**:
  1. alice.md contains all three `interface` definitions
  2. carol/dave/erin.md each contain the corresponding `<!-- MODULE -->` marker and list ≥2 exported functions
  3. frank.md contains aggregated references for at least 3 modules (join reduce output)
  4. Both gate verifier `result` values are `PASS` (step 2 type verification + step 5 integration verification)

## Recovery and Checkpoint Granularity

`team_workflow` state is fully persisted in `activeTask` (`steps[]` + `currentStageIndex` cursor), so it reuses the existing `team_resume`: after a process crash, `team_resume` will re-drive the current step (if the current step's actor already has output, process it directly; otherwise re-dispatch), or deliver directly if all steps are already complete.

**Known limitations** (consistent with all orchestration modes): checkpoint granularity is a full task; recovery restarts from the **current step**, not from intra-step sub-progress. For recovery coverage of branches (captured task replay / no captured response re-dispatch / all-complete direct delivery / captured gate verdict replay), see `tests/resume-dispatch-branches.test.ts`.


## Acceptance Checklist

- [ ] Every gate's `verifier` ≠ the `member` of the task it verifies (satisfies the "no self-verification" hard constraint)
- [ ] Every master launch call conforms to the `team_workflow` schema (first step is a `task`, gate verifies preceding task, `on_fail` paired with `max_retries`, etc.)
- [ ] Every task prompt aligns with check script markers (scenario 1: handler code block; scenario 2: `<!-- IMPL: bisect -->`; scenario 3: `<!-- ENERGY:` / `<!-- DRAG:`; scenario 4: `<!-- MODULE:`)
- [ ] Scenarios 1-3 total duration ≤ 20 min (well under 30 min ceiling); scenario 4 is challenge-level at ~50 min (6 members, 8-step fanout)
- [ ] Scenario 4 fanout branch members are all distinct (carol/dave/erin each implement one module)

---

## Quick-Start Prompt (Copy and Use)

> Paste any of the following prompts into the master session and the AI will automatically complete the full loop of "create team → activate → launch orchestration → wait for summary → run check script". Scenarios 1-3 all provide bun-runnable check scripts.

### Scenario 1: REST API Handler Implementation + Verification + Refactor (Programming)

```text
执行 demos/10-team-workflow/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（2 名成员：alice=coder、bob=tester）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_workflow JSON 启动编排（4 步链：task(implement) → gate(verify) → task(refactor) → gate(re-verify)）
4. team_results 轮询至 master 收到汇总（engine 驱动每步推进）
5. 定位 <run_dir>（含 alice 与 bob 的 .md）
6. 运行：bun demos/10-team-workflow/check-coding-handler.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：handleRegister 三路径正确；两道 gate 均 PASS；重构后提取了 validate 函数。
```

### Scenario 2: Bisection Root-Finding Implementation + Verification + Iterative Optimization (Math)

```text
执行 demos/10-team-workflow/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队（2 名成员：alice=mathematician、bob=reviewer）
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_workflow JSON 启动编排（4 步链：task(implement bisect) → gate(verify sqrt2+sign check) → task(optimize) → gate(re-verify 3 functions)）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>（含 alice 与 bob 的 .md）
6. 运行：bun demos/10-team-workflow/check-math-bisect.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：bisect 在 sqrt(2)、cos(x)-x、x³-5 三个测试上精度 < 1e-6；两道 gate 均 PASS。
```

### Scenario 3: Projectile Motion RK4 Solver + Energy Verification + Drag Modeling (Computational Physics)

```text
执行 demos/10-team-workflow/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队（2 名成员：alice=simulator、bob=physicist）
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_workflow JSON 启动编排（4 步链：task(RK4 projectile) → gate(verify energy) → task(add drag) → gate(verify terminal velocity)）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>（含 alice 与 bob 的 .md）
6. 运行：bun demos/10-team-workflow/check-physics-projectile.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：无阻力时能量漂移 < 1e-3；有阻力时终端速度接近 sqrt(mg/k) ≈ 9.9 m/s（误差 < 20%）；两道 gate 均 PASS。
```

### Scenario 4: Multi-Module Fanout Parallel Implementation + Join Reduce Integration Verification (Challenge-Level · Programming)

```text
执行 demos/10-team-workflow/README.md「场景 4」的完整闭环并自动评判（挑战级：6 成员、8 步 fanout 工作流）。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（6 名成员：alice=coder, bob=reviewer, carol/dave/erin=coder, frank=tester）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_workflow JSON 启动编排（8 步：task(types) → gate(verify types) → fanout(3 parallel modules) → join(reduce) → gate(integration test)）
4. team_results 轮询至 master 收到汇总（engine 推进：alice 定义类型 → bob gate 验证 → carol/dave/erin 并行实现三模块 → frank join reduce 聚合 → frank gate 集成测试）
5. 定位 <run_dir>（含 6 个成员的 .md：alice/bob/carol/dave/erin/frank）
6. 运行：bun demos/10-team-workflow/check-coding-modular-cms.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：三个 interface 定义完整；三个模块各有 `<!-- MODULE -->` 标记；join reduce 产出跨模块聚合；集成测试 5 条用例全 PASS。
```
