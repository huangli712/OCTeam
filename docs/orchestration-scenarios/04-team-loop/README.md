# team_loop 编排场景设计

> **模式**：`team_loop` — 运行修正闭环 `代码 → 评审 → 决策 → 重复`。每轮由各 stage 成员依次产出，`decider`（一名成员，非 master）emit `<decision>{"decision":"done"|"continue",...}</decision>`；`decider` 说 `done`、达到 `max_rounds`、超时或连续 3 次解析失败时停止。
> **源码**：[`src/tools/workflow-basic.ts:284-363`](../../../src/tools/workflow-basic.ts)（`teamLoopTool`）
> **控时设计**：3 成员（2 stage + 1 decider），`max_rounds=3`；典型 1-2 轮收敛，每轮各 stage ≤ 5 min，总时长 ≈ 10-15 min（远低于 30 min 上限）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role | key param | 预计总时长 |
|---|------|------|--------|------|-----------|-----------|
| 1 | 数学 | 二分法求根边界 bug 修复 | 3 | `coder` / `tester` / `reviewer` | `max_rounds=3` | ~12 min |
| 2 | 计算物理 | 弹簧-质点能量漂移调试 | 3 | `simulator` / `analyst` / `reviewer` | `max_rounds=3` | ~13 min |
| 3 | 编程 | 区间合并 off-by-one 修复 | 3 | `coder` / `tester` / `reviewer` | `max_rounds=3` | ~10 min |

---

## 场景 1: 二分法求根边界 bug 修复

### 1.1 场景描述

**背景**：二分法（bisection）是求连续函数单根的经典稳健方法，但其正确性强依赖三个前提：输入有效（非 NaN）、区间端点函数值异号（保证有根）、收敛判据应基于区间半宽而非函数残差（否则在平缓函数上过早返回）。下列初始实现同时违反这三条：

```typescript
// Buggy bisection — three latent defects (A/B/C).
function bisect(f: (x: number) => number, a: number, b: number, tol: number, maxIter: number): number {
    let lo = a, hi = b;
    for (let i = 0; i < maxIter; i++) {
        const mid = (lo + hi) / 2;
        const fmid = f(mid);
        // (C) BUG: terminates on residual |f(mid)|, not bracket half-width (hi-lo)/2.
        if (Math.abs(fmid) < tol) return mid;
        // (B) BUG: no validation that f(lo), f(hi) actually bracket a root.
        if (fmid * f(lo) < 0) hi = mid; else lo = mid;
        // (A) BUG: NaN in a/b/f propagates silently (no guard).
    }
    return (lo + hi) / 2;
}
```

**目标**：`coder` 最小修复三处缺陷；`tester` 跑边界用例集（NaN、同号区间、平缓函数阈值）；`reviewer` 评审后决策是否收敛。

**成功标准（可机器评判）**：
- `coder` 输出以 `<!-- FIXES: <count> -->` 结尾
- `tester` 输出以 `<!-- FAILING: <count> -->` 结尾
- `reviewer` 最终 `<decision>` JSON 含 `"decision": "done"` 且 `"testsPass": true`

### 1.2 Team 配置

```json
{
  "name": "bisection-fix-loop",
  "description": "Bisection root-finder: coder fixes 3 edge-case bugs, tester runs the edge suite, reviewer decides convergence.",
  "members": [
    {
      "name": "coder",
      "role": "coder",
      "prompt": "You fix the bisection() function minimally. Three defects to address: (A) no NaN guard on a/b/f outputs, (B) no sign-change (bracket) validation at start, (C) convergence checks the residual |f(mid)| instead of the bracket half-width (hi-lo)/2. Make the MINIMAL change: throw a descriptive Error on NaN inputs or when f(a)*f(b) >= 0 (no bracket), and terminate when (hi-lo)/2 < tol. Embed the full corrected TypeScript function in a single ```typescript fenced block with signature `function bisect(f, a, b, tol, maxIter)`. Count only the distinct bugs you fixed. Your output MUST end with a line exactly formatted: <!-- FIXES: <count> -->"
    },
    {
      "name": "tester",
      "role": "tester",
      "prompt": "You run the edge-case suite against the coder's CURRENT bisect() implementation (read coder.md, extract the ```typescript block). Report exactly three cases: (1) NaN input -> bisect(f, NaN, 2, 1e-6, 100) for f=x*x-2 MUST throw; (2) same-sign interval -> bisect(f, 0, 1, 1e-6, 100) for f=x*x+1 (always positive) MUST throw; (3) flat-function threshold -> bisect(f, 0, 1, 1e-9, 100) for f=(x-0.5)^3 MUST return within 1e-6 of 0.5 (bracket-width convergence, not residual). For each case state PASS/FAIL with a one-line reason. Count how many FAIL. Your output MUST end with a line exactly formatted: <!-- FAILING: <count> -->"
    },
    {
      "name": "reviewer",
      "role": "reviewer",
      "prompt": "You are the loop DECIDER. Read coder.md (the fix + FIXES count) and tester.md (the FAILING count + per-case reasons). Decide whether the bisection routine is correct: 'done' only when tester reports 0 failing cases AND coder's fix is minimal/non-degenerate; otherwise 'continue' with concrete nextActions for the coder. In EVERY <decision> block you emit, include the standard fields (decision, rationale, nextActions) PLUS the additional boolean field \"testsPass\": true|false reflecting whether the tester reported 0 failing cases. The literal English tags <decision> and </decision> are required."
    }
  ]
}
```

**Role 选择理由**：`coder`（`build` agent，可改代码）、`tester`（只读评审/运行）、`reviewer`（默认只读，适合做决策者）——三者职责与 `team_loop` 的 `modify` / `read_only` / `read_only` 三段天然对齐。

### 1.3 Master 启动调用

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "bisection-fix-loop",
    "stages": [
      { "member": "coder", "task": "Fix the three bisection defects minimally. Emit the corrected function and the FIXES marker.", "action": "modify" },
      { "member": "tester", "task": "Run the three edge cases against the coder's current bisect() and report the FAILING count.", "action": "read_only" }
    ],
    "decider": "reviewer",
    "max_rounds": 3,
    "initial_task": "Here is the BUGGY bisection to fix (three defects: A no-NaN-guard, B no-bracket-validation, C residual-based convergence). Fix all three minimally.\n\n```typescript\nfunction bisect(f: (x: number) => number, a: number, b: number, tol: number, maxIter: number): number {\n    let lo = a, hi = b;\n    for (let i = 0; i < maxIter; i++) {\n        const mid = (lo + hi) / 2;\n        const fmid = f(mid);\n        if (Math.abs(fmid) < tol) return mid;\n        if (fmid * f(lo) < 0) hi = mid; else lo = mid;\n    }\n    return (lo + hi) / 2;\n}\n```\n\nRequirements: throw on NaN a/b/f outputs; throw when f(a)*f(b) >= 0 (no bracket); terminate on (hi-lo)/2 < tol. Keep the signature. End with <!-- FIXES: <count> -->."
  }
}
```

**参数选择**：
- `stages` 只列 `coder`（`modify`）与 `tester`（`read_only`）——`decider` 不在 stages 中，由 OCTeam 自动追加为末尾 `read_only` 阶段（源码 `workflow-basic.ts` buildTask 分支）。
- `decider: "reviewer"` ——成员名，非 master（schema 强制）。
- `max_rounds: 3` ——典型 1 轮即收敛；3 轮上限兜底偶发回归。
- `initial_task` ——包含完整 buggy 代码，round 1 派发给 stages[0]（coder）。
- stage 成员名唯一（`coder` / `tester`），符合 schema 校验。

### 1.4 执行流程（时序）

```
T+0m     master 调用 team_loop；round 1 启动
T+0m     coder (modify) 收到 initial_task -> 修复三处缺陷 -> 写 coder.md + FIXES 标记
T+3m     tester (read_only) 读 coder.md -> 跑 3 边界用例 -> 写 tester.md + FAILING 标记
T+5m     reviewer (decider, read_only) 读 coder+tester -> emit <decision>
         若 testsPass=true -> decision="done" -> 循环结束（典型路径）
         若 testsPass=false -> decision="continue" -> round 2 重派 coder
T+5~12m  至多 3 轮；done 或 max_rounds 触发停止
T+12m    运行: bun check-math-bisection-fix.ts <run_dir>
```

### 1.5 评判脚本

[`check-math-bisection-fix.ts`](./check-math-bisection-fix.ts)

- **加载**：`runs/<run_id>/reviewer.md`（decider），附带 `coder.md` / `tester.md` 做诊断
- **提取**：正则 `<decision>([\s\S]*?)</decision>` 取最后一处（最终轮），`JSON.parse`
- **断言**：
  1. `decision.decision === "done"`
  2. `decision.testsPass === true`（布尔存在且为真）

---

## 场景 2: 弹簧-质点能量漂移调试

### 2.1 场景描述

**背景**：无阻尼弹簧-质点系统（`k=1, m=1`，即 `ẍ = -x`，角频率 ω=1）能量 `E = ½(x² + ẋ²)` 应严格守恒。初始条件 `x0=1, v0=0`，故 `E0 = 0.5`。**显式 Euler** 积分一步放大矩阵 `[[1,h],[-h,1]]` 的特征值模为 `√(1+h²) > 1`，能量单调发散——取 `h=0.05`、1000 步，能量放大约 12×（相对漂移约 1100%，远超可接受范围）。**Velocity Verlet** 是辛格式，能量有界振荡，漂移 ≪ 1e-3。

```typescript
// Buggy integrator: EXPLICIT (forward) Euler on the spring-mass system.
// k=1, m=1, x0=1, v0=0, h=0.05, 1000 steps. Energy drifts severely (~12x growth).
function simulate(h: number, steps: number): { x: number; v: number } {
    let x = 1, v = 0;
    const omega2 = 1; // k/m
    for (let i = 0; i < steps; i++) {
        const a = -omega2 * x;   // acceleration from CURRENT x
        x = x + h * v;           // Euler update of position
        v = v + h * a;           // Euler update of velocity (explicit)
    }
    return { x, v };
}
// E = 0.5*(x*x + v*v); E0 = 0.5; relative drift = |E_end - E0|/E0.
```

**目标**：`simulator` 将显式 Euler 替换为 Velocity Verlet（最小变更）；`analyst` 计算修复前后两版的相对能量漂移；`reviewer` 评审后决策。

**成功标准（可机器评判）**：
- `simulator` 输出以 `<!-- INTEGRATOR: <name> -->` 结尾（应为 Velocity Verlet）
- `analyst` 输出以 `<!-- DRIFT_AFTER: <number> -->` 结尾（并含 `<!-- DRIFT_BEFORE: <number> -->`）
- `reviewer` 最终 `<decision>` JSON 含 `"decision": "done"` 且 `"driftAcceptable": true`
- `analyst` 的 `DRIFT_AFTER < 1e-3`（辛格式门槛）

### 2.2 Team 配置

```json
{
  "name": "spring-energy-loop",
  "description": "Spring-mass (k=m=1) energy drift: simulator swaps explicit Euler for Velocity Verlet, analyst measures drift before/after, reviewer decides.",
  "members": [
    {
      "name": "simulator",
      "role": "simulator",
      "prompt": "You replace the BUGGY explicit-Euler integrator with VELOCITY VERLET for the spring-mass system (k=1, m=1, omega^2=1). Same params: x0=1, v0=0, h=0.05, exactly 1000 steps. Velocity Verlet update per step: a_n = -omega2*x_n; v_{n+1/2} = v_n + 0.5*h*a_n; x_{n+1} = x_n + h*v_{n+1/2}; a_{n+1} = -omega2*x_{n+1}; v_{n+1} = v_{n+1/2} + 0.5*h*a_{n+1}. Make the MINIMAL change to the simulate() function (keep signature `function simulate(h, steps)` returning {x,v}). Embed the full corrected TypeScript in a single ```typescript fenced block. Name the integrator. Your output MUST end with a line exactly formatted: <!-- INTEGRATOR: <name> -->"
    },
    {
      "name": "analyst",
      "role": "analyst",
      "prompt": "You compute the relative energy drift |E_end - E0|/E0 where E = 0.5*(x^2 + v^2), E0 = 0.5 (x0=1, v0=0), for BOTH integrators at h=0.05, 1000 steps: (1) the BUGGY explicit Euler from the initial_task, (2) the simulator's CURRENT Velocity Verlet from simulator.md (extract the ```typescript block, run both). Report both numbers. Your output MUST contain a line exactly formatted: <!-- DRIFT_BEFORE: <numeric_drift_euler> --> AND MUST end with a line exactly formatted: <!-- DRIFT_AFTER: <numeric_drift_verlet> -->"
    },
    {
      "name": "reviewer",
      "role": "reviewer",
      "prompt": "You are the loop DECIDER. Read simulator.md (integrator name) and analyst.md (DRIFT_BEFORE and DRIFT_AFTER). Decide whether the energy drift is acceptable: 'done' only when the simulator used Velocity Verlet AND DRIFT_AFTER < 1e-3; otherwise 'continue' with concrete nextActions. In EVERY <decision> block you emit, include the standard fields (decision, rationale, nextActions) PLUS the additional boolean field \"driftAcceptable\": true|false reflecting whether DRIFT_AFTER < 1e-3. The literal English tags <decision> and </decision> are required."
    }
  ]
}
```

**Role 选择理由**：`simulator`（数值仿真专责）、`analyst`（数据测算只读）、`reviewer`（决策者）——与 stage 的 `modify` / `read_only` / `read_only` 对齐。

### 2.3 Master 启动调用

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "spring-energy-loop",
    "stages": [
      { "member": "simulator", "task": "Replace explicit Euler with Velocity Verlet. Emit the corrected simulate() and the INTEGRATOR marker.", "action": "modify" },
      { "member": "analyst", "task": "Measure relative energy drift before (Euler) and after (Verlet) at h=0.05, 1000 steps. Emit DRIFT_BEFORE and DRIFT_AFTER markers.", "action": "read_only" }
    ],
    "decider": "reviewer",
    "max_rounds": 3,
    "initial_task": "Here is the BUGGY explicit-Euler integrator for the spring-mass system (k=1, m=1). Energy drifts severely (~12x growth over 1000 steps at h=0.05). Replace it with VELOCITY VERLET (minimal change).\n\n```typescript\nfunction simulate(h: number, steps: number): { x: number; v: number } {\n    let x = 1, v = 0;\n    const omega2 = 1;\n    for (let i = 0; i < steps; i++) {\n        const a = -omega2 * x;\n        x = x + h * v;\n        v = v + h * a;\n    }\n    return { x, v };\n}\n```\n\nRequirements: keep signature `function simulate(h, steps)`; use the velocity-Verlet update; exactly 1000 steps; x0=1, v0=0. End with <!-- INTEGRATOR: <name> -->."
  }
}
```

**参数选择**：
- `stages` 只列 `simulator`（`modify`）与 `analyst`（`read_only`）；`decider` 自动追加。
- `max_rounds: 3` —— Verlet 替换通常一轮达标；余量兜底。
- `initial_task` 内嵌完整 Euler 代码 + 物理参数，确保 `simulator` 与 `analyst` 引用同一基准。

### 2.4 执行流程（时序）

```
T+0m     master 调用 team_loop；round 1 启动
T+0m     simulator (modify) 收到 initial_task -> 改写为 Velocity Verlet -> simulator.md + INTEGRATOR
T+4m     analyst (read_only) 读 simulator.md -> 跑 Euler 与 Verlet 各 1000 步 -> analyst.md + DRIFT_BEFORE/AFTER
T+7m     reviewer (decider) 读两份输出 -> emit <decision>
         若 driftAcceptable=true -> decision="done"（典型路径）
         否则 -> decision="continue" -> round 2
T+7~13m  至多 3 轮
T+13m    运行: bun check-physics-spring-energy.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-spring-energy.ts`](./check-physics-spring-energy.ts)

- **加载**：`runs/<run_id>/reviewer.md`（decider）与 `analyst.md`（交叉核验），附带 `simulator.md` 诊断
- **提取**：
  - decider：正则 `<decision>([\s\S]*?)</decision>` 取最后一处，`JSON.parse`
  - analyst：正则 `<!-- DRIFT_BEFORE:\s*([\d.eE+-]+)\s*-->` 与 `<!-- DRIFT_AFTER:\s*([\d.eE+-]+)\s*-->`
- **断言**：
  1. `analyst` `DRIFT_AFTER < DRIFT_BEFORE`（修复确实降低漂移）
  2. `analyst` `DRIFT_AFTER < 1e-3`（辛格式门槛）
  3. `decision.decision === "done"`
  4. `decision.driftAcceptable === true`

---

## 场景 3: 区间合并 off-by-one 修复

### 3.1 场景描述

**背景**：合并重叠/相邻区间是调度、基因组、排版等领域的原语。标准实现先按起点排序，再逐个合并：当前区间起点 ≤ 上一合并区间终点时合并。下列实现把 `<=` 误写为 `<`，导致**恰好相邻**的区间（如 `[[1,3],[3,5]]`，应合并为 `[[1,5]]`）被错误地保留为两个区间——典型的 off-by-one。

```typescript
// Buggy interval merge — off-by-one in the overlap test.
function mergeIntervals(intervals: number[][]): number[][] {
    if (intervals.length === 0) return [];
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        const cur = sorted[i];
        if (cur[0] < last[1]) {        // BUG: should be <= (touching intervals merge)
            last[1] = Math.max(last[1], cur[1]);
        } else {
            merged.push(cur);
        }
    }
    return merged;
}
```

**目标**：`coder` 最小修复（`<` → `<=`）；`tester` 跑隐藏 5 例（含相邻区间关键用例）；`reviewer` 评审后决策。

**成功标准（可机器评判）**：
- `coder` 输出以 `<!-- BUGFIX: <one-line-description> -->` 结尾
- `tester` 输出以 `<!-- PASS_COUNT: <n>/5 -->` 结尾
- `reviewer` 最终 `<decision>` JSON 含 `"decision": "done"` 且 `"allPass": true`

### 3.2 Team 配置

```json
{
  "name": "interval-merge-loop",
  "description": "Interval merge off-by-one: coder fixes the <= vs < bug, tester runs the hidden 5-case suite, reviewer decides.",
  "members": [
    {
      "name": "coder",
      "role": "coder",
      "prompt": "You fix the off-by-one in mergeIntervals() minimally: the overlap test `cur[0] < last[1]` must become `cur[0] <= last[1]` so that touching intervals (e.g. [[1,3],[3,5]]) merge. Change ONLY that comparison; do not refactor anything else. Embed the full corrected TypeScript function in a single ```typescript fenced block with signature `function mergeIntervals(intervals)`. Write a one-line description of the fix. Your output MUST end with a line exactly formatted: <!-- BUGFIX: <one-line-description> -->"
    },
    {
      "name": "tester",
      "role": "tester",
      "prompt": "You run the hidden 5-case suite against the coder's CURRENT mergeIntervals() (read coder.md, extract the ```typescript block). The cases (input -> expected): (1) [[1,3],[2,6],[8,10],[15,18]] -> [[1,6],[8,10],[15,18]]; (2) [[1,4],[4,5]] -> [[1,5]] (TOUCHING, must merge — the regression case); (3) [[1,4],[0,4]] -> [[0,4]] (unsorted input); (4) [] -> []; (5) [[1,5]] -> [[1,5]]. Deep-equal each actual vs expected. Count how many pass. Your output MUST end with a line exactly formatted: <!-- PASS_COUNT: <n>/5 -->"
    },
    {
      "name": "reviewer",
      "role": "reviewer",
      "prompt": "You are the loop DECIDER. Read coder.md (the BUGFIX description) and tester.md (the PASS_COUNT and per-case results). Decide whether the fix is correct: 'done' only when tester reports 5/5 pass AND the fix is the minimal <= change (not a refactor); otherwise 'continue' with concrete nextActions. In EVERY <decision> block you emit, include the standard fields (decision, rationale, nextActions) PLUS the additional boolean field \"allPass\": true|false reflecting whether the tester reported 5/5. The literal English tags <decision> and </decision> are required."
    }
  ]
}
```

**Role 选择理由**：`coder`（最小修复）、`tester`（隐藏用例只读运行）、`reviewer`（决策者）——三段映射清晰。

### 3.3 Master 启动调用

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "interval-merge-loop",
    "stages": [
      { "member": "coder", "task": "Fix the off-by-one in mergeIntervals minimally. Emit the corrected function and the BUGFIX marker.", "action": "modify" },
      { "member": "tester", "task": "Run the hidden 5-case suite against the coder's current mergeIntervals() and report PASS_COUNT.", "action": "read_only" }
    ],
    "decider": "reviewer",
    "max_rounds": 3,
    "initial_task": "Here is the BUGGY mergeIntervals with an off-by-one in the overlap test (`<` should be `<=`; touching intervals must merge). Fix it minimally.\n\n```typescript\nfunction mergeIntervals(intervals: number[][]): number[][] {\n    if (intervals.length === 0) return [];\n    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);\n    const merged: number[][] = [sorted[0]];\n    for (let i = 1; i < sorted.length; i++) {\n        const last = merged[merged.length - 1];\n        const cur = sorted[i];\n        if (cur[0] < last[1]) {\n            last[1] = Math.max(last[1], cur[1]);\n        } else {\n            merged.push(cur);\n        }\n    }\n    return merged;\n}\n```\n\nRequirement: change ONLY the `<` to `<=` on the overlap test; keep the signature. End with <!-- BUGFIX: <one-line-description> -->."
  }
}
```

**参数选择**：
- `stages` 只列 `coder`（`modify`）与 `tester`（`read_only`）；`decider` 自动追加。
- `max_rounds: 3` ——单字符修复通常一轮 5/5；余量兜底偶发笔误。
- `initial_task` 内嵌完整 buggy 代码并点明 `<` → `<=`，约束 `coder` 做最小变更。

### 3.4 执行流程（时序）

```
T+0m     master 调用 team_loop；round 1 启动
T+0m     coder (modify) 收到 initial_task -> < 改为 <= -> coder.md + BUGFIX
T+2m     tester (read_only) 读 coder.md -> 跑 5 例（含相邻区间关键用例）-> tester.md + PASS_COUNT
T+4m     reviewer (decider) 读两份输出 -> emit <decision>
         若 allPass=true -> decision="done"（典型路径）
         否则 -> decision="continue" -> round 2
T+4~10m  至多 3 轮
T+10m    运行: bun check-coding-interval-merge.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-interval-merge.ts`](./check-coding-interval-merge.ts)

- **加载**：`runs/<run_id>/reviewer.md`（decider），附带 `coder.md` / `tester.md` 做诊断
- **提取**：正则 `<decision>([\s\S]*?)</decision>` 取最后一处（最终轮），`JSON.parse`
- **断言**：
  1. `decision.decision === "done"`
  2. `decision.allPass === true`（布尔存在且为真）

---

## 验收清单

- [ ] 3 个 check 脚本 `bunx tsc -p docs/orchestration-scenarios/tsconfig.json` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`coder` / `tester` / `simulator` / `analyst` / `reviewer` 均为预设）
- [ ] 每个 master 调用参数符合 `team_loop` schema（`stages` 成员名唯一、`decider` 非 master 且不在 stages 中、`max_rounds` / `initial_task` 齐备）
- [ ] 每场景总时长 ≤ 15 min（远低于 30 min 上限；`max_rounds=3` 兜底）
- [ ] 成员 prompt 中明确输出格式约定（marker），decider prompt 明确模式专属布尔字段，评判脚本与之对齐


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成完整闭环。loop 模式的评判读 **decider** 成员的最终轮输出（含 `<decision>` 块）。

### 场景 1: 修正二分求根边界 bug（数学）

```text
执行 docs/orchestration-scenarios/04-team-loop/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_loop JSON 启动编排（注意 initial_task 是待修的 buggy 代码）
4. team_results 轮询至 master 收到汇总（最多 max_rounds 轮，decider 说 done 即停）
5. 定位 <run_dir>（含 decider 成员的 .md）
6. 运行：bun docs/orchestration-scenarios/04-team-loop/check-math-bisection-fix.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decider 最终轮 `"decision": "done"` 且 `"testsPass": true`（NaN / 单侧区间 / 收敛阈值三类边界 bug 全修）。
```

### 场景 2: 调试弹簧-质点能量漂移（物理）

```text
执行 docs/scenarios/04-team-loop/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_loop JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>（含 decider 与 analyst 成员的 .md）
6. 运行：bun docs/orchestration-scenarios/04-team-loop/check-physics-spring-energy.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decider decision="done" 且 `"driftAcceptable": true`；analyst 报 DRIFT_AFTER < 1e-3（Verlet 替换 Euler 后）。
```

### 场景 3: 修 off-by-one 区间合并 bug（编程）

```text
执行 docs/orchestration-scenarios/04-team-loop/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_loop JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/04-team-loop/check-coding-interval-merge.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decider decision="done" 且 `"allPass": true`（5 个用例含 [[1,3],[3,5]] 这类 touching 区间正确合并）。
```
