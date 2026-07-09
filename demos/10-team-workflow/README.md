# team_workflow 编排场景设计

> **模式**：`team_workflow` — 声明式、确定性步骤引擎。每个 step 可以是 `task`（一个成员产出）、`gate`（验证者对指定前导 task 给出 PASS / FAIL / INVALID 三值判定）、`fanout` 或 `join`。引擎——而非 master LLM——驱动推进、重试、分支汇合、reduce 聚合和恢复；中间结果默认只进入下游成员上下文，不进 master 上下文。
> **源码**：[`src/tools/workflow.ts`](../../src/tools/workflow.ts) / [`src/orchestration/workflow.ts`](../../src/orchestration/workflow.ts)
> **控时设计**：每基线场景 2 成员，4 步链（task → gate → task → gate），每步 3-5 min，串行 ≈ 14-18 min（远低于 30 min 上限）。**场景 4 为挑战级**：6 成员、8 步 fanout→join 工作流，约 50 min，演示 workflow 的并行分支集成能力。

## 场景一览

| # | 方向 | 场景 | 成员数 | 成员角色 | step 序列 | 预计总时长 |
|---|------|------|--------|---------|-----------|-----------|
| 1 | 编程 | REST API handler 实现 + 验证 + 重构 + 再验证 | 2 | `coder` / `tester` | task → gate → task → gate | ~16 min |
| 2 | 数学 | 二分法求根实现 + 验证 + 迭代优化 | 2 | `mathematician` / `reviewer` | task → gate → task → gate | ~14 min |
| 3 | 计算物理 | 抛体运动 RK4 求解 + 能量验证 + 阻力建模 | 2 | `simulator` / `physicist` | task → gate → task → gate | ~16 min |
| 4 | 编程（挑战） | 多模块 fanout 并行实现 + join reduce 集成验证 | 6 | `coder` ×4 / `reviewer` / `tester` | task → fanout(3) → join(reduce) → gate | ~50 min |

> 场景 1-3 为基线类型（线性 task/gate 链），提供 check 脚本；场景 4 为挑战级（fanout 并行分支 + join reduce），演示 workflow 的声明式并发集成能力。

---

## 场景 1: REST API handler 实现 + 验证 + 重构

### 1.1 场景描述

**背景**：实现一个处理用户注册的 REST handler：参数校验、错误返回、成功路径。先写实现，再独立验证（边界 + 错误处理），验证通过后做一次重构（提取校验函数、改善可读性），重构后再用同一 gate 验证行为不变——保证重构没引入回归。

**目标**：用一条 `team_workflow` 串起四个异构步骤——`coder` 实现 → `tester` gate 验证 → `coder` 重构 → `tester` gate 再验证——由 engine 确定性推进，master 只在结尾收到汇总。

**成功标准（人工自判）**：
- step 1（task）：`coder` 产出可加载的 handler 代码块
- step 2（gate）：`tester` 对 step 1 产出给出 `<verdict>{"result":"PASS",...}</verdict>`
- step 3（task）：`coder` 基于上游（step 1 产出）做重构，行为不变、可读性提升
- step 4（gate）：`tester` 对 step 3 重构产出再次验证行为不变，给出 `<verdict>{"result":"PASS",...}</verdict>`
- 最终 `workflow_complete`，master 收到含四步账本 + 各 task 产出的汇总

### 1.2 Team 配置

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

**Role 选择理由**：两个 task 步骤用同一个 `coder`（alice）保证实现→重构的连续性；gate 用独立的 `tester`（bob，只读 agent）做裁判，避免自验证（schema 硬约束：gate 的 verifier 必须不同于前一个 task 的成员）。

### 1.3 Master 启动调用

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

**参数选择**：
- step 1 是 `task`（验证硬约束：首步必须是 task，gate 必须验证前导 task）
- step 2 的 `verifier: "bob"` ≠ step 1 的 `member: "alice"` —— 满足「禁止自验证」
- step 2 `on_fail: "retry"` + `max_retries: 1` —— gate FAIL 时把 alice 连同 diff 重派一次（首次实现易漏边界），第二次 FAIL 则整条 run 失败（`workflow_failed`）
- step 3 是 `task`，engine 自动注入 step 1 的产出作为上游上下文（gate 步骤的判定不计入上游）
- step 4 是 `gate`，验证 step 3 的重构产出——`verifier: "bob"` ≠ step 3 的 `member: "alice"`，同样满足「禁止自验证」；criteria 复用 step 2 的三用例 + 额外要求提取了 `validate()`，确保重构无回归
- step 4 `on_fail: "retry"` + `max_retries: 1` —— 重构也可能引入回归，给 alice 一次修正机会
> 注：step 4 默认验证“最近前导 task”（即 step 3）。如需让 step 4 复用 step 2 已确认的同一组用例但显式验证 step 1 的实现，可加 `target_step: 1`；本场景保持默认以演示最近前导语义。
- `timeout_ms: 1200000`（20 min）—— 串行四步，正常 16 min 完成，留余量

### 1.4 执行流程（时序）

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

> 期间任意 task/gate 演员缺失 live session（session 未创建或成员已 errored）时：若声明了 `fallback_member` / `fallback_verifier`，engine 自动切换到 fallback 演员继续；若 fallback 也不可用，**fanout 分支内**的步骤降级为 errored 分支（受 `max_errored` / `join_policy` 约束），**顶层**步骤仍以 `workflow_failed:no_session:<member>` 显式终止。engine 把 `workflow.steps` 快照写入 `RunRecord`（每步 kind / member / verifier / dispatchedActor / targetStep / verdict / attempts / completed / output / outputBytes）。`team_result_get` 读取该 run 时会渲染 `### workflow steps` 分组，按 Step N 展示账本 + 各 task 产出快照；`format: "mermaid"` 导出 Mermaid flowchart 图。

### 1.5 可选：人工审批（HITL）

在 `team_workflow` 加 `"human_approval": true`，engine 会在每个非终步完成（task 完成、gate PASS）后、推进下一步前暂停，等待 `team_approve` / `team_reject`：

- `team_approve(team_id, approval_id)` —— 继续下一步
- `team_reject(team_id, approval_id, feedback)` —— 整条 run 失败（`workflow_human_rejected`）

挂钟在暂停期间不计入超时（与其它编排的 HITL 一致）。approval prompt 会显示 `workflow_step (step N)`（1-based）并附上当前完成步骤的 kind / actor / verdict rationale 与下一步摘要，便于 master 直接判断。

### 1.6 可选：dry_run 预演

启动前加 `dry_run: true`，`team_workflow` 只渲染 1-based step 计划，不创建 `activeTask`、不派发成员：

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "register-handler-flow",
    "dry_run": true,
    "steps": [ /* 同 1.3 */ ]
  }
}
```

输出形如：
```
Workflow dry run for "register-handler-flow" (4 step(s)):
1. [task] alice: Implement ...
2. [gate] bob verifies step 1: Verify handleRegister ...; on_fail=retry max_retries=1
3. [task] alice: Refactor ...
4. [gate] bob verifies step 3: Re-verify ...; on_fail=retry max_retries=1
```

校验失败（如 `on_fail="retry"` 缺 `max_retries`、task/gate 跨字段、`target_step` 指向 gate）也会在此阶段报错，避免半启动的 run。

### 1.7 可选：workflow_file 模板

复杂 workflow 可以放进仓库内的 JSON 文件，再用 `vars` 进行模板替换。文件必须是相对工作区路径并以 `.json` 结尾；推荐设置 `version: 1` 和 `strict_vars: true`，让变量拼写错误在启动前失败。

本目录提供了可直接预演或启动的模板：[`register-handler.workflow.json`](./register-handler.workflow.json)。启动方式：

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

先加 `dry_run: true` 可以查看变量替换后的 step ledger，确认成员、gate、join policy 和数据流都符合预期，再启动真实编排。

---

## 场景 2: 二分法求根实现 + 验证 + 迭代优化

### 2.1 场景描述

**背景**：二分法（bisection method）是数值分析中最基础、最稳健的求根算法。给定连续函数 `f(x)` 和包含单根的区间 `[a,b]`（`f(a)·f(b) < 0`），二分法以对数复杂度收敛到任意精度。虽然简单，但边界处理（符号检查、收敛判据、最大迭代数）是典型陷阱。

**目标**：用一条 `team_workflow` 串起四步——`mathematician` 实现 → `reviewer` gate 验证 → `mathematician` 优化迭代次数 → `reviewer` gate 再验证——由 engine 确定性推进。

**成功标准（可机器评判）**：
- step 1（task）：产出可加载的 `bisect(f, a, b, tol)` TypeScript 函数
- step 2（gate）：验证 `bisect` 能正确找到 `f(x)=x²-2` 在 `[1,2]` 的根（精度 < 1e-8），并检查 `f(a)·f(b) ≥ 0` 时抛出异常
- step 3（task）：优化实现——显式 max_iter 保底、提前终止判断符号不变区间
- step 4（gate）：再验证优化版的两条额外函数：`f(x)=cos(x)-x`（根 ≈ 0.739085）和 `f(x)=x³-5`
- 最终 `workflow_complete`，两道 gate 均 PASS

### 2.2 Team 配置

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

**Role 选择理由**：两个 task 步骤用同一个 `mathematician`（alice）保证实现→优化的连续性；gate 用独立的 `reviewer`（bob，只读 agent）做裁判。

### 2.3 Master 启动调用

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

**参数选择**：
- step 1 `verifier: "bob"` ≠ `member: "alice"` —— 满足「禁止自验证」
- step 2 `on_fail: "retry"` + `max_retries: 1` —— 符号检查边界首次实现易漏
- step 3 task 复用 alice，engine 自动注入 step 1 产出作上游
- step 4 验证 step 3 的优化版，新加两条额外测试函数保证优化无回归
- `timeout_ms: 1200000`（20 min）—— 四步串行，正常 14 min 完成

### 2.4 执行流程（时序）

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

### 2.5 评判脚本

[`check-math-bisect.ts`](./check-math-bisect.ts)

- **加载**：`runs/<run_id>/{alice,bob}.md`
- **提取**：
  - producer 代码：抓取 ` ```typescript ... ``` ` 代码块
  - verifier 判定：`<verdict>{...}</verdict>` 标签 JSON 块（`JSON.parse` 取 `result`）
- **断言**：
  1. producer 代码可用 `new Function` 加载为 `bisect` 函数
  2. `abs(bisect(x=>x*x-2, 1, 2, 1e-8) - sqrt(2)) < 1e-7`
  3. `bisect(x=>x*x-2, 2, 3, 1e-8)` 抛出异常（无符号变化）
  4. `abs(bisect(x=>Math.cos(x)-x, 0, 1, 1e-8) - 0.739085) < 1e-6`
  5. `abs(bisect(x=>x*x*x-5, 1, 2, 1e-8) - cbrt(5)) < 1e-6`
  6. 两道 verifier `result` 均为 `PASS`

---

## 场景 3: 抛体运动 RK4 求解 + 能量验证 + 阻力建模

### 3.1 场景描述

**背景**：抛体运动是经典力学的入门仿真。二维无阻力抛体（x: 匀速，y: `dv/dt = -g`）有解析解，适合验证求解器正确性；加入空气阻力（`F_drag = -k·v²`）后变为非线性 ODE 系统，无法解析求解，必须依赖数值积分。四阶 Runge-Kutta（RK4）是精度与实现复杂度的黄金平衡点。

**目标**：用一条 `team_workflow` 串起四步——`simulator` 实现 RK4 + 无阻力抛体验证 → `physicist` gate 能量守恒判定 → `simulator` 加入空气阻力 → `physicist` gate 验证终端速度行为——由 engine 推进。

**成功标准（可机器评判）**：
- step 1（task）：产出可加载的 `rk4_step(f, y, t, h)` TypeScript 函数 + 无阻力抛体仿真
- step 2（gate）：验证能量守恒（`|E_final - E0|/E0 < 1e-3`）且最大高度命中 ≈ `v₀²/(2g)`
- step 3（task）：加入速度平方空气阻力 `F_drag = -k·|v|·v`（k=0.1），重跑仿真
- step 4（gate）：验证有阻力时能量单调衰减、终端速度趋于定值 `mg/k` 的平方根
- 最终 `workflow_complete`，两道 gate 均 PASS

### 3.2 Team 配置

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

**Role 选择理由**：task 用 `simulator`（数值 ODE 仿真专家）；gate 用 `physicist`（懂能量守恒/空气动力学，能独立复算判定）。

### 3.3 Master 启动调用

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

**参数选择**：
- step 2 `verifier: "bob"` ≠ `member: "alice"` —— 满足「禁止自验证」
- step 2 `on_fail: "retry"` + `max_retries: 1` —— RK4 的步长/初始条件选错易导致能量漂移超标
- step 3 task 复用 alice，engine 自动注入 step 1 产出（无阻力仿真）作上游
- `timeout_ms: 1200000`（20 min）—— 四步串行，正常 16 min 完成

### 3.4 执行流程（时序）

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

### 3.5 评判脚本

[`check-physics-projectile.ts`](./check-physics-projectile.ts)

- **加载**：`runs/<run_id>/{alice,bob}.md`
- **提取**：
  - producer 标记：正则 `<!--\s*ENERGY:\s*([\d.eE+-]+)\s*-->` 提取漂移；`<!--\s*DRAG:\s*([\d.eE+-]+)\s*-->` 提取终端速度
  - verifier 判定：`<verdict>{...}</verdict>` 标签 JSON 块
- **断言**：
  1. `drift` 存在且 `Number.isFinite`
  2. `drift < 1e-3`（RK4 无阻力短时间积分应能量守恒）
  3. `term_vel` 存在且 > 0
  4. `abs(term_vel - 9.9) / 9.9 < 0.2`（终端速度接近 `sqrt(mg/k)`）
  5. 两道 verifier `result` 均为 `PASS`

---

## 场景 4: 多模块 fanout 并行实现 + join reduce 集成验证（挑战级）

> **挑战级说明**：本场景突破基线约束（2 成员 / 线性链 / ≤30 min），使用 **6 成员、8 步（含 fanout 三路并行 + join reduce 聚合）**，演示 `team_workflow` 的声明式并行分支与 reduce 聚合能力。约 50 min。

### 4.1 场景描述

**背景**：构建一个微型用户管理系统的三个核心模块——认证（auth）、用户 CRUD（users）、审计日志（audit）。模块之间有共享类型依赖（`User`, `AuthToken`, `AuditEntry`），必须先统一定义接口再分头实现，最后集成验证三者协同工作。workflow 的 `fanout` 允许三模块并行实现，`join(reduce)` 将所有分支输出汇总为一个聚合报告，最后 `gate` 做集成测试。

**目标**：用一条 `team_workflow` 串起八步——`coder` 定义共享类型（task）→ `reviewer` 确认类型完备（gate）→ 三路 `fanout` 并行实现模块（auth / users / audit）→ `join(reduce)` 聚合 → `tester` 集成验证（gate）——engine 确定性推进。

**成功标准（可机器评判）**：
- step 1（task: alice）：产出含 `User`, `AuthToken`, `AuditEntry` 三个 TypeScript interface 的类型定义
- step 2（gate: bob）：验证三个 interface 字段完整且互不冲突
- step 3-5（fanout 三路并行 task: carol/dave/erin）：分别实现 auth（login/logout/validate）、users（create/find/delete）、audit（log/query）
- step 6（join reduce: frank）：聚合三个模块的接口清单与依赖图
- step 7（gate: bob）：集成测试——auth 发放 token → users 用 token 鉴权创建用户 → audit 记录操作 → 验证全链路
- 最终 `workflow_complete`，所有 gate PASS

### 4.2 Team 配置

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

**Role 选择理由**：
- `alice`（coder）：定义共享类型，单一权威来源
- `bob`（reviewer）：gate 验证类型完备 + 集成测试
- `carol/dave/erin`（coder ×3）：fanout 三路并行实现各自模块
- `frank`（tester）：join reduce 聚合 + 最终 gate 集成验证

### 4.3 Master 启动调用

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
        "kind": "join",
        "join_policy": "reduce",
        "reducer_member": "frank"
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

**参数选择**：
- step 3 是 `fanout`，`join_policy: "reduce"` + `reducer_member: "frank"` —— 三路并行任务完成后由 frank 聚合所有分支输出
- step 4 `join(reduce)` 是 fanout 的终点——frank 写出聚合报告后 workflow 推进到集成 gate
- step 5 gate 的 `verifier: "frank"` 与 join 的 reducer 同名但不冲突——join 产出聚合报告后 frank 作为 gate verifier 做集成测试
- 每 gate `on_fail: "retry"` + `max_retries: 1` —— 类型定义或集成可能首次不全，给一次修正
- `timeout_ms: 3000000`（50 min）—— 6 成员 + 8 步，fanout 三路并行实现（~12 min）+ join reduce（~8 min）+ 集成 gate（~8 min），串行累计约 50 min

### 4.4 执行流程（时序）

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

### 4.5 评判脚本

[`check-coding-modular-cms.ts`](./check-coding-modular-cms.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol,dave,erin,frank}.md`（6 个文件）
- **提取**：
  - step 1：alice.md 含三个 interface 的类型定义（正则：`interface User` + `interface AuthToken` + `interface AuditEntry`）
  - step 2：bob.md `<verdict>{...}</verdict>` gate 判定
  - step 3-5：carol/dave/erin.md 各含 `<!-- MODULE: {auth|users|audit} -->` 标记
  - step 5 gate：frank.md `<verdict>{...}</verdict>` gate 判定
- **断言**：
  1. alice.md 含全部三个 `interface` 定义
  2. carol/dave/erin.md 各含对应 `<!-- MODULE -->` 标记且各列出 ≥2 个导出函数
  3. frank.md 含至少 3 个模块的聚合引用（join reduce 产出）
  4. 两道 gate verifier `result` 均为 `PASS`（step 2 类型验证 + step 5 集成验证）

## 恢复与检查点粒度

`team_workflow` 的状态完全保存在 `activeTask`（`steps[]` + `currentStageIndex` 游标）中，因此复用现有的 `team_resume`：进程崩溃后，`team_resume` 会重新驱动当前步骤（若当前步演员已有产出则直接处理，否则重新派发），或若全部步骤已完成则直接交付。

**已知限制**（与所有编排一致）：检查点粒度是整条 task，恢复时从**当前步骤**重新开始，而非步骤内部的子进度。恢复覆盖分支（captured task 重放 / no captured response 重派 / all-complete 直接交付 / captured gate verdict 重放）见 `tests/resume-dispatch-branches.test.ts`。


## 验收清单

- [ ] 每个 gate 的 `verifier` ≠ 其验证的 task 的 `member`（满足「禁止自验证」硬约束）
- [ ] 每个 master 调用参数符合 `team_workflow` schema（首步为 `task`、gate 验证前导 task、`on_fail` 与 `max_retries` 配对等）
- [ ] 每个 task prompt 与评判脚本标记对齐（场景 1: handler 代码块；场景 2: `<!-- IMPL: bisect -->`；场景 3: `<!-- ENERGY:` / `<!-- DRAG:`；场景 4: `<!-- MODULE:`）
- [ ] 场景 1-3 总时长 ≤ 20 min（远低于 30 min 上限）；场景 4 为挑战级约 50 min（6 成员、8 步 fanout）
- [ ] 场景 4 fanout 的所有分支成员互不相同（carol/dave/erin 各实现一个模块）

---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成「创建团队 → 激活 → 启动编排 → 等待汇总 → 运行 check 脚本」的完整闭环。场景 1-3 均提供 bun 可运行的 check 脚本。

### 场景 1: REST API handler 实现 + 验证 + 重构（编程）

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

### 场景 2: 二分法求根实现 + 验证 + 迭代优化（数学）

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

### 场景 3: 抛体运动 RK4 求解 + 能量验证 + 阻力建模（计算物理）

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

### 场景 4: 多模块 fanout 并行实现 + join reduce 集成验证（挑战级·编程）

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
