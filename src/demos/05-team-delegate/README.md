# team_delegate 编排场景设计

> **模式**：`team_delegate` — 发布任务到共享列表，空闲成员自行认领（claim）、执行并回报 master；支持 `blocked_by` 依赖构成 DAG。
> **源码**：[`src/tools/delegate.ts`](../../../src/tools/delegate.ts)
> **控时设计**：场景 1-3 基线为 3 成员自领取，每成员子任务 ≤ 6 min；无依赖场景总时长 ≈ ceil(tasks/members) 轮 × 3 min；DAG 场景总时长 ≈ 关键路径 × 3 min（场景 1-3 均 ≤ 15 min，远低于 30 min 上限）。**场景 4 为挑战级**：刻意突破基线约束（8 成员 / 100 任务 / ~90 min），压测 delegate 模式在高并发自领取下的稳定性与任务分发公平性。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role | tasks / deps | 预计总时长 |
|---|------|------|--------|------|-------------|-----------|
| 1 | 数学 | 数论五题独立求解 | 3 | `mathematician` | 5, 无依赖 | ~10 min |
| 2 | 计算物理 | 经典 ODE 三系统仿真 | 3 | `simulator` | 3, 无依赖 | ~8 min |
| 3 | 编程 | CLI 计算器 blockedBy DAG | 3 | `coder` | 4, DAG | ~12 min |
| 4 | 数学（挑战级） | 100 道程序化数论题（4 family） | 8 | `mathematician` | 100, 无依赖 | ~90 min |

---

## 场景 1: 数论五题独立求解

### 1.1 场景描述

**背景**：基础数论是算法面试（LeetCode easy 级别）的经典领域。五道独立题目覆盖素数计数、欧几里得 GCD、素性判定、因子求和、模逆元——互不依赖，天然适合 delegate 模式的并行自领取。

**目标**：发布 5 个独立数论任务到共享列表，3 个 mathematician 成员各自认领、求解、回报答案。

**成功标准（可机器评判）**：
- 所有成员输出合并后包含全部 5 个 `<!-- ANSWER: <value> -->` 标注
- 5 个答案分别匹配期望值：25、21、`true`、56、4

### 1.2 Team 配置

```json
{
  "name": "num-suite",
  "description": "Number-theory puzzle suite: 5 independent tasks self-claimed by 3 mathematicians",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks, claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies, then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks, claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies, then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks, claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies, then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    }
  ]
}
```

**Role 选择理由**：`mathematician` 用 `oct-junior` agent，可写代码枚举/验证，完全匹配数论求解需求。三名成员 prompt 相同（delegate 模式下角色对称，差异来自认领的任务）。

### 1.3 Master 启动调用

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "num-suite",
    "tasks": [
      {
        "ref": "p1",
        "subject": "Count primes below 100",
        "description": "Count the number of prime numbers strictly less than 100. Use the Sieve of Eratosthenes or direct trial division. Show your method briefly, then state the final count. End your report to master with a line exactly formatted: <!-- ANSWER: <your_count> -->"
      },
      {
        "ref": "p2",
        "subject": "GCD of 1071 and 462",
        "description": "Compute the greatest common divisor (GCD) of 1071 and 462 using the Euclidean algorithm. Show the successive division steps, then state the result. End your report to master with a line exactly formatted: <!-- ANSWER: <your_gcd> -->"
      },
      {
        "ref": "p3",
        "subject": "Is 997 prime?",
        "description": "Determine whether 997 is a prime number. Check divisibility by all primes up to sqrt(997) (~31.6): 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31. State the boolean result (true if prime, false otherwise). End your report to master with a line exactly formatted: <!-- ANSWER: <true_or_false> -->"
      },
      {
        "ref": "p4",
        "subject": "Sum of divisors of 28",
        "description": "Compute the sum of all positive divisors of 28 (including 1 and 28 itself). List the divisors, sum them, and report. End your report to master with a line exactly formatted: <!-- ANSWER: <your_sum> -->"
      },
      {
        "ref": "p5",
        "subject": "Modular inverse of 3 mod 11",
        "description": "Compute the modular inverse of 3 modulo 11, i.e. the integer x in {0,...,10} such that 3*x is congruent to 1 (mod 11). Report x. End your report to master with a line exactly formatted: <!-- ANSWER: <your_inverse> -->"
      }
    ],
    "timeout_ms": 900000,
    "max_errored_members": 0
  }
}
```

**参数选择**：
- 无 `blocked_by` — 五题完全独立，任何成员可认领任何任务
- `timeout_ms: 900000`（15 min）— 5 题 / 3 成员 = 2 轮，每轮 3 min，正常 6-8 min 完成
- `max_errored_members: 0` — 任一成员失败即整体失败（5 题缺一不完整）
- 不设 `signoff_policy` — delegate 默认 `none`，任务完成直接交付

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_delegate，发布 5 个任务到共享列表
T+0m    OCTeam dispatch 3 个 mathematician 成员（通用自领取提示）
T+0m    各成员 team_task_list → 认领各自第一个任务（3 个被认领）
T+0~3m  各成员独立求解 → team_send_message 回报 ANSWER 标注 → 释放任务
T+3m    剩余 2 个任务被空闲成员认领（第二轮）
T+3~6m  第二轮求解 + 回报
T+6m    所有 5 题完成，OCTeam 汇总交付 master
T+6m    运行: bun check-math-number-theory.ts <run_dir>
```

### 1.5 评判脚本

[`check-math-number-theory.ts`](./check-math-number-theory.ts)

- **加载**：`readdir(<run_dir>)` 读取所有 `*.md` 成员输出（delegate 模式下不确定哪个成员认领了哪题，故扫描全部）
- **提取**：正则 `<!--\s*ANSWER:\s*(.+?)\s*-->` 全局匹配，收集所有答案
- **断言**：
  1. 合并后至少有 5 个 ANSWER 标注
  2. 期望值 {25, 21, `true`, 56, 4} 每个至少出现一次（数值用 `Number()` 比较，布尔用忽略大小写字符串比较）

---

## 场景 2: 经典 ODE 三系统仿真

### 2.1 场景描述

**背景**：经典常微分方程系统（Lotka-Volterra 捕食者-猎物、Van der Pol 极限环、阻尼振子）是数值仿真的标准教学案例。三题独立，各自有不同的 ODE 形式、参数和报告量，天然适合 delegate 模式的并行自领取。

**目标**：发布 3 个独立 ODE 仿真任务，3 个 simulator 成员各自认领一个，用 RK4 积分并报告关键量。

**成功标准（可机器评判）**：
- Lotka-Volterra 成员输出含 `<!-- PREY_X20: <value> -->`，x(20) ∈ [3.5, 5.5]（期望 ≈ 4.5）
- Van der Pol 成员输出含 `<!-- AMPLITUDE: <value> -->`，极限环幅度 ∈ [1.8, 2.2]（期望 ≈ 2.0）
- 阻尼振子成员输出含 `<!-- UNDERDAMPED: yes -->`

### 2.2 Team 配置

```json
{
  "name": "ode-suite",
  "description": "Classic ODE simulation suite: 3 independent systems self-claimed by 3 simulators",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are a numerical simulator specializing in ODE integration. You work in delegate mode: use team_task_list to find available simulation tasks, claim one with team_task_update (status 'claimed'), simulate exactly as the task description specifies (use classical RK4 with the given step size), then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are a numerical simulator specializing in ODE integration. You work in delegate mode: use team_task_list to find available simulation tasks, claim one with team_task_update (status 'claimed'), simulate exactly as the task description specifies (use classical RK4 with the given step size), then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are a numerical simulator specializing in ODE integration. You work in delegate mode: use team_task_list to find available simulation tasks, claim one with team_task_update (status 'claimed'), simulate exactly as the task description specifies (use classical RK4 with the given step size), then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    }
  ]
}
```

**Role 选择理由**：`simulator` 专为数值模拟设计（ODE/PDE/MC/MD/HPC），完全匹配 ODE 积分场景。

### 2.3 Master 启动调用

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "ode-suite",
    "tasks": [
      {
        "ref": "lv",
        "subject": "Lotka-Volterra predator-prey: final prey x(20)",
        "description": "Simulate the Lotka-Volterra predator-prey system with parameters alpha=1.1, beta=0.4, delta=0.1, gamma=0.1. The equations are dx/dt = alpha*x - beta*x*y (prey) and dy/dt = delta*x*y - gamma*y (predator). Use initial conditions x(0)=1.6, y(0)=4.8. Integrate from t=0 to t=20 with step h=0.01 using classical RK4 (2000 steps). Report the final prey population x(20). End your report to master with a line exactly formatted: <!-- PREY_X20: <your_value> -->"
      },
      {
        "ref": "vdp",
        "subject": "Van der Pol oscillator: limit-cycle amplitude",
        "description": "Simulate the Van der Pol oscillator with mu=1: d2x/dt2 - mu*(1 - x^2)*dx/dt + x = 0. Rewrite as the first-order system [dx/dt, dy/dt] = [y, mu*(1-x^2)*y - x]. Use initial conditions x(0)=1, xdot(0)=0. Integrate from t=0 to t=10 with step h=0.01 using classical RK4 (1000 steps). Report the limit-cycle amplitude, defined as max|x| over the full simulation interval. End your report to master with a line exactly formatted: <!-- AMPLITUDE: <your_value> -->"
      },
      {
        "ref": "osc",
        "subject": "Damped harmonic oscillator: is it underdamped?",
        "description": "Analyze the damped harmonic oscillator x'' + 2*gamma*x' + omega0^2*x = 0 with omega0=2 and gamma=0.5. The damping ratio is zeta = gamma/omega0. Compute zeta and classify: underdamped (zeta < 1), critically damped (zeta = 1), or overdamped (zeta > 1). Report whether the system is underdamped. End your report to master with a line exactly formatted: <!-- UNDERDAMPED: yes --> (or <!-- UNDERDAMPED: no --> if not underdamped)."
      }
    ],
    "timeout_ms": 600000,
    "max_errored_members": 0
  }
}
```

**参数选择**：
- 无 `blocked_by` — 三个 ODE 系统完全独立
- `timeout_ms: 600000`（10 min）— 3 题 / 3 成员 = 1 轮，每轮 5-8 min
- `max_errored_members: 0` — 任一仿真失败即整体失败

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_delegate，发布 3 个 ODE 任务
T+0m    OCTeam dispatch 3 个 simulator 成员
T+0m    各成员 team_task_list → 各自认领 1 个任务（1:1 分配）
T+0~6m  各成员独立写 RK4 代码 → 积分 → 回报 PREY_X20/AMPLITUDE/UNDERDAMPED
T+6m    三任务全部完成，汇总交付 master
T+6m    运行: bun check-physics-ode-suite.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-ode-suite.ts`](./check-physics-ode-suite.ts)

- **加载**：`readdir(<run_dir>)` 读取所有 `*.md`，拼接为单一 blob
- **提取**：
  - `<!--\s*PREY_X20:\s*([\d.eE+-]+)\s*-->`
  - `<!--\s*AMPLITUDE:\s*([\d.eE+-]+)\s*-->`
  - `<!--\s*UNDERDAMPED:\s*(\w+)\s*-->`
- **断言**：
  1. 三个标注都存在（每个至少出现一次）
  2. PREY_X20 ∈ [3.5, 5.5]
  3. AMPLITUDE ∈ [1.8, 2.2]
  4. UNDERDAMPED = `yes`（忽略大小写）

---

## 场景 3: CLI 计算器 blockedBy DAG

### 3.1 场景描述

**背景**：delegate 模式的核心差异化能力是 `blocked_by` 依赖——任务在依赖完成前不可认领，构成有向无环图（DAG）。一个迷你 CLI 计算器天然有四步依赖链：先定 API 规范 → 再并行实现核心逻辑与输出格式 → 最后写测试。

**目标**：发布 4 个有依赖的任务，3 个 coder 成员按 DAG 拓扑顺序认领、实现、回报。

**任务依赖图**：

```
  api (spec) ──┬──> core (calculate) ──┐
               │                        ├──> tests (4 cases)
               └──> output (format) ───┘
```

**成功标准（可机器评判）**：
- 合并输出包含 `<!-- SPEC_OK: true -->`
- 合并输出包含 `<!-- IMPL: calculate -->`，且对应 ```typescript 代码块可加载为 `calculate(op, a, b)` 函数
- 合并输出包含 `<!-- IMPL: format -->`
- 合并输出包含 `<!-- PASS_COUNT: 4/4 -->`
- 提取的 `calculate` 函数通过 4 个标准用例：add(2,3)=5、sub(10,4)=6、mul(3,7)=21、div(20,4)=5

### 3.2 Team 配置

```json
{
  "name": "cli-dag",
  "description": "CLI calculator with blockedBy DAG: spec -> core+output -> tests, self-claimed by 3 coders",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You work in delegate mode: use team_task_list to find available tasks, claim one with team_task_update (status 'claimed'), implement exactly as the task description specifies, then report your result to master via team_send_message and release the task. Tasks with unmet blocked_by dependencies are not claimable — wait for them to clear. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are a coder. You work in delegate mode: use team_task_list to find available tasks, claim one with team_task_update (status 'claimed'), implement exactly as the task description specifies, then report your result to master via team_send_message and release the task. Tasks with unmet blocked_by dependencies are not claimable — wait for them to clear. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a coder. You work in delegate mode: use team_task_list to find available tasks, claim one with team_task_update (status 'claimed'), implement exactly as the task description specifies, then report your result to master via team_send_message and release the task. Tasks with unmet blocked_by dependencies are not claimable — wait for them to clear. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    }
  ]
}
```

**Role 选择理由**：`coder` 用 `oct-junior` agent，专注实现、最小变更，贴合分步构建需求。成员 prompt 中额外强调 blocked_by 语义——依赖未满足时任务不可认领。

### 3.3 Master 启动调用

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "cli-dag",
    "tasks": [
      {
        "ref": "api",
        "subject": "Define CLI argument-parsing spec",
        "description": "Define the CLI argument-parsing specification for a calculator that accepts an operator and two numeric operands. The operator must be one of {add, sub, mul, div}. The operands are real numbers (integers or decimals). Document: (1) the input format, (2) valid operators and their semantics, (3) operand constraints, (4) error behavior for unknown operator or non-numeric operands. Keep the spec concise. End your report to master with a line exactly formatted: <!-- SPEC_OK: true -->"
      },
      {
        "ref": "core",
        "subject": "Implement calculate(op, a, b) in TypeScript",
        "blocked_by": ["api"],
        "description": "Implement the core calculation function calculate(op, a, b) in TypeScript, where op is one of {add, sub, mul, div} and a, b are numbers. Returns the numeric result. For div with b === 0, throw an Error. Embed the full TypeScript code in a ```typescript fenced block. End your report to master with a line exactly formatted: <!-- IMPL: calculate -->"
      },
      {
        "ref": "output",
        "subject": "Implement result formatter in TypeScript",
        "blocked_by": ["api"],
        "description": "Implement the result formatter formatResult(a, op, b, result) in TypeScript that returns the string formatted as: a op b = result (e.g. formatResult(2, 'add', 3, 5) returns '2 add 3 = 5'). Embed the full TypeScript code in a ```typescript fenced block. End your report to master with a line exactly formatted: <!-- IMPL: format -->"
      },
      {
        "ref": "tests",
        "subject": "Write and run 4 calculator test cases",
        "blocked_by": ["core", "output"],
        "description": "Write 4 test cases for the calculator and verify they pass. The cases are: add(2, 3) = 5, sub(10, 4) = 6, mul(3, 7) = 21, div(20, 4) = 5. If the calculate implementation is available from the core task, run the 4 cases against it and report how many pass. End your report to master with a line exactly formatted: <!-- PASS_COUNT: <n>/4 -->"
      }
    ],
    "timeout_ms": 900000,
    "max_errored_members": 0
  }
}
```

**参数选择**：
- `blocked_by` DAG：`api` 无依赖先执行；`core` 和 `output` 依赖 `api`（并行解锁）；`tests` 依赖 `core` + `output`（最后解锁）
- `ref` 字段——`blocked_by` 通过 `ref` 字符串引用，而非数组下标或 UUID
- `timeout_ms: 900000`（15 min）— 关键路径 api(2m) → core/output(3m) → tests(2m) ≈ 7m，给足余量
- `max_errored_members: 0` — DAG 中任一节点失败，后续节点永远阻塞，必须整体失败

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_delegate，发布 4 个任务（api, core[blocked:api], output[blocked:api], tests[blocked:core,output]）
T+0m    OCTeam dispatch 3 个 coder 成员
T+0m    仅 api 可认领（core/output/tests 被 blocked）→ 某成员认领 api
T+0~2m  该成员定义规范 → 回报 SPEC_OK → 释放 api
T+2m    api 完成 → core 和 output 同时解锁
T+2m    两个空闲成员分别认领 core 和 output（并行）
T+2~5m  core (calculate) + output (format) 并行实现 → 各自回报 IMPL 标注
T+5m    core + output 均完成 → tests 解锁
T+5m    某成员认领 tests → 运行 4 用例 → 回报 PASS_COUNT
T+7m    所有 4 任务完成，汇总交付 master
T+7m    运行: bun check-coding-cli-calc.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-cli-calc.ts`](./check-coding-cli-calc.ts)

- **加载**：`readdir(<run_dir>)` 读取所有 `*.md`，拼接为 blob 做标注扫描；同时保留 per-file map 以定位代码块
- **提取**：
  - 标注：`SPEC_OK_RE`、`IMPL_CALC_RE`、`IMPL_FORMAT_RE`、`PASS_COUNT_RE`
  - 代码：在含 `IMPL: calculate` 标注的文件中抓取 ` ```typescript ... ``` ` 代码块
- **断言**：
  1. `SPEC_OK: true` 存在
  2. `IMPL: calculate` 标注存在，且同文件有可加载的 `calculate` 函数
  3. `IMPL: format` 标注存在
  4. `PASS_COUNT: 4/4`（分子必须为 4）
  5. 加载的 `calculate` 函数通过 4 个标准用例（add/sub/mul/div）

---

## 场景 4: 100 道程序化数论题（挑战级）

### 4.1 场景描述

**背景**：前 3 个场景验证了 delegate 模式的基础能力（并行自领取、ODE 仿真、blockedBy DAG）。本**挑战级**场景把规模拉到极限——**100 道程序化可验证的数论题、8 个 mathematician 成员并行自领取**，刻意突破基线约束（≤ 4 成员 / ≤ 30 min）。每题要求一个关于其索引 n 的确定性整数值函数，答案可被独立脚本（Eratosthenes 筛法 / 除数和 / modPow / 欧拉函数筛）严格校验。**规模是本场景的核心**：100 任务 / 8 成员 = 平均 12.5 题/人，考验 delegate 模式在高并发自领取下的稳定性与任务分发公平性——依赖被刻意省略，强调的是吞吐而非拓扑。

**目标**：发布 100 个**完全独立**的数论任务到共享列表，8 个 mathematician 成员各自认领、求解、回报 `<!-- ANSWER_<n>: <value> -->` 标注。

**题目族（4 family × 25 题 = 100，ref scheme `p1`..`p100`）**：

| Family | refs | 问题 | 期望示例 |
|--------|------|------|---------|
| A. 素数计数 π | `p1`..`p25` | π(10·k)，k=1..25 → π(10), π(20), …, π(250) | π(10)=4，π(100)=25 |
| B. 除数和 σ | `p26`..`p50` | σ(n)，n=101..125 | σ(101)=102（素数），σ(125)=156 |
| C. 模幂 | `p51`..`p75` | 2^n mod (10⁹+7)，n=51..75（base=2，exponent=题号，modulus=1_000_000_007） | 2⁵¹ mod (10⁹+7)=797922655 |
| D. 欧拉函数 φ | `p76`..`p100` | φ(n)，n=201..225 | φ(201)=132，φ(225)=120 |

**成功标准（可机器评判）**：100 道题中 **≥ 95 道**的 `<!-- ANSWER_<n>: <value> -->` 标注与独立计算的 ground truth 一致（容忍少量 flaky claim / 个别成员掉队）。

### 4.2 Team 配置

```json
{
  "name": "num-theory-100",
  "description": "Challenge-level: 100 programmatically-verifiable number-theory problems self-claimed by 8 mathematicians",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "frank",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "grace",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "henry",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    }
  ]
}
```

**Role 选择理由**：`mathematician` 用 `oct-junior` agent，可写代码枚举/验证，完全匹配数论求解需求。八名成员 prompt 相同（delegate 模式下角色对称，差异来自认领的任务）——刻意对称以隔离「并发自领取」这一被测变量。

**成员数 = 8（突破 ≤ 4 基线）的理由**：挑战级场景的核心是规模压测。100 任务需要足够的并行槽位才能在合理时间内完成（100/8 ≈ 13 轮 vs 100/4 = 25 轮），同时 8 路并发足以暴露任务分发竞争（多成员同时 team_task_list / claim 同一任务）。

### 4.3 Master 启动调用

`tasks` 数组含 **100 个条目**（ref `p1`..`p100`，无 `blocked_by`）。下面给出 4 个 family 的模板与每族一个具体样例——完整 100 条按相同模式生成。

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "num-theory-100",
    "tasks": [
      {
        "ref": "p1",
        "subject": "π(10) — count primes ≤ 10",
        "description": "Compute π(10), the count of prime numbers ≤ 10 (primes: 2,3,5,7 → expected 4). Use the Sieve of Eratosthenes. End your report to master with a line exactly formatted: <!-- ANSWER_1: <integer_value> -->"
      },

      {
        "ref": "p26",
        "subject": "σ(101) — sum of divisors of 101",
        "description": "Compute σ(101), the sum of all positive divisors of 101 (including 1 and 101; 101 is prime → expected 102). End your report to master with a line exactly formatted: <!-- ANSWER_26: <integer_value> -->"
      },

      {
        "ref": "p51",
        "subject": "2^51 mod (10^9+7)",
        "description": "Compute 2^51 mod 1000000007 using fast modular exponentiation (BigInt modPow). Report the integer in [0, 10^9+6]. End your report to master with a line exactly formatted: <!-- ANSWER_51: <integer_value> -->"
      },

      {
        "ref": "p76",
        "subject": "φ(201) — Euler totient of 201",
        "description": "Compute φ(201), Euler's totient: count of k in {1..201} with gcd(k,201)=1 (201=3·67 → expected 132). End your report to master with a line exactly formatted: <!-- ANSWER_76: <integer_value> -->"
      }
    ],
    "timeout_ms": 5400000,
    "max_errored_members": 1
  }
}
```

**Ref scheme（完整 100 条的生成规则，master 按 schema 展开即可）**：

| ref | 问题 | description 模板（替换 `<n>` / `<arg>`） |
|-----|------|------------------------------------------|
| `p<k>`，k=1..25 | π(10·k) | `Compute π(<10·k>), the count of primes ≤ <10·k>. Use the Sieve of Eratosthenes. End your report to master with a line exactly formatted: <!-- ANSWER_<k>: <integer_value> -->` |
| `p<k>`，k=26..50 | σ(k+75)，即 σ(101)..σ(125) | `Compute σ(<k+75>), the sum of all positive divisors of <k+75> (including 1 and itself). End your report to master with a line exactly formatted: <!-- ANSWER_<k>: <integer_value> -->` |
| `p<k>`，k=51..75 | 2^k mod (10⁹+7) | `Compute 2^<k> mod 1000000007 using fast modular exponentiation. Report the integer in [0, 10^9+6]. End your report to master with a line exactly formatted: <!-- ANSWER_<k>: <integer_value> -->` |
| `p<k>`，k=76..100 | φ(k+125)，即 φ(201)..φ(225) | `Compute φ(<k+125>), Euler's totient of <k+125> (count of k in {1..<k+125>} coprime to it). End your report to master with a line exactly formatted: <!-- ANSWER_<k>: <integer_value> -->` |

**参数选择**：
- **无 `blocked_by`** — 100 题完全独立，刻意强调规模而非依赖（依赖压测见场景 3）
- `timeout_ms: 5400000`（90 min）— 100 题 / 8 成员 ≈ 13 轮 × ~6 min/轮
- `max_errored_members: 1` — 允许 8 中 1 个成员失败（剩余 7 成员仍可覆盖 100 题，平均 ~14.3 题/人），配合 ≥ 95/100 的评判阈值
- 不设 `signoff_policy` — delegate 默认 `none`，任务完成直接交付

### 4.4 执行流程（时序）

```
T+0m     master 调用 team_delegate，发布 100 个任务到共享列表（全部无 blocked_by）
T+0m     OCTeam dispatch 8 个 mathematician 成员
T+0m     8 成员并发 team_task_list → 各自认领 1 个任务（8 个同时被认领，考验 claim 竞争）
T+0~6m   第一轮：8 题并行求解（筛法/除数和/modPow/totient）→ 各自回报 ANSWER_n → 释放任务
T+6m     8 个成员回到 tasklist，继续认领下一批（第二轮）
...
T+~75m   100/8 ≈ 13 轮，平均每轮 ~6 min → 约 75-90 min 全部完成（个别成员可能稍慢）
T+90m    master 收到汇总交付
T+90m    运行: bun src/demos/05-team-delegate/check-math-100-problems.ts <run_dir>
```

### 4.5 评判脚本

[`check-math-100-problems.ts`](./check-math-100-problems.ts)

- **加载**：`readdir(<run_dir>)` 读取所有 8 个 `*.md` 成员输出（delegate 模式下不确定哪个成员认领了哪题，故扫描全部）
- **提取**：正则 `<!--\s*ANSWER_(\d+):\s*(\d+)\s*-->` 全局匹配，构建 `Map<题号 1..100, bigint>`（重复题号取首个；超出 1..100 范围的跳过）
- **ground truth（脚本独立计算，4 个 helper）**：
  1. `sievePrimes(N)` + `primeCount(N)` — Eratosthenes 筛法 → π(10·k)，k=1..25
  2. `sumOfDivisors(n)` — O(√n) 试除法 → σ(n)，n=101..125
  3. `modPow(base, exp, mod)` — BigInt 快速模幂 → 2^k mod (10⁹+7)，k=51..75
  4. `totientSieve(N)` — 欧拉函数筛（线性遍历每个素数 p，对所有倍数减去 ⌊φ/p⌋）→ φ(n)，n=201..225
- **断言**：100 题中 `reported[n] === expected[n]` 的题数 **≥ 95**；输出 per-family 命中率（pi/sigma/modpow/phi）与总体，未达标时打印前 8 个 miss

---

## 验收清单

- [ ] 4 个 check 脚本 `bunx tsc -p src/demos/tsconfig.json` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `simulator` / `coder` 均为预设）
- [ ] 每个 master 调用参数符合 `team_delegate` schema（`tasks[]` 含 `ref`/`subject`/`description`/`blocked_by`）
- [ ] `blocked_by` 引用的 `ref` 均在同级 `tasks` 中声明，无循环
- [ ] 场景 1-3 总时长 ≤ 15 min（远低于 30 min 上限）；**场景 4 挑战级 ~90 min、8 成员，刻意压测规模（基线约束的唯一例外）**
- [ ] 成员 prompt 中明确自领取流程 + 输出格式约定，评判脚本 marker 与任务 description 对齐


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成完整闭环。delegate 模式成员**自取**任务（不直接收任务文本），各成员把结果 `team_send_message` 回 master，run_dir 内每个成员 .md 含其认领任务的报告。

### 场景 1: 5 道数论题（数学）

```text
执行 src/demos/05-team-delegate/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_delegate JSON 启动编排（5 个独立任务发布到 tasklist）
4. team_results 轮询至 master 收到汇总（成员自取自报，无任务即停）
5. 定位 <run_dir>（含各成员 .md，ANSWER marker 分布其中）
6. 运行：bun src/demos/05-team-delegate/check-math-number-theory.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：5 个 ANSWER marker 全对（25, 21, true, 56, 4）。
```

### 场景 2: 3 个经典 ODE 短时仿真（物理）

```text
执行 src/demos/05-team-delegate/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_delegate JSON 启动编排（3 个独立 ODE 任务）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun src/demos/05-team-delegate/check-physics-ode-suite.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：3 个结果 marker 落在预期范围（Lotka-Volterra prey(20)≈4.5；Van der Pol 振幅≈2.0；阻尼振荡 underdamped=yes）。
```

### 场景 3: 小型 CLI 计算器（编程，blockedBy DAG）

```text
执行 src/demos/05-team-delegate/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_delegate JSON 启动编排（4 个任务含 blockedBy 依赖：api → core/output → tests）
4. team_results 轮询至 master 收到汇总（依赖解锁后下游任务才可被认领）
5. 定位 <run_dir>
6. 运行：bun src/demos/05-team-delegate/check-coding-cli-calc.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：4 个 marker 齐全（SPEC_OK=true、IMPL: calculate、IMPL: format、PASS_COUNT=4/4），且 calculate 通过 4 用例（2+3=5、10-4=6、3*7=21、20/4=5）。
```

### 场景 4: 100 道程序化数论题（挑战级，8 成员）

```text
执行 src/demos/05-team-delegate/README.md「场景 4」的完整闭环并自动评判。注意：此为挑战级场景，预计 ~90 min、8 成员并发。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（8 个 mathematician 成员 alice..henry，含 erin）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」+ Ref scheme 表，按 team_delegate JSON 启动编排：tasks[] 需展开为 100 条（p1..p100），按 4 个 family 模板生成（π(10·k) / σ(101..125) / 2^k mod 1e9+7 / φ(201..225)），全部无 blocked_by
4. team_results 轮询至 master 收到汇总（成员自取自报，无任务即停；100 题 / 8 成员 ≈ 13 轮）
5. 定位 <run_dir>（含 8 个成员 .md，ANSWER_n marker 分布其中）
6. 运行：bun src/demos/05-team-delegate/check-math-100-problems.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：100 题 ≥ 95 答案正确（脚本独立用筛法/除数和/modPow/totient 算 ground truth，容忍少量 flaky claim）。
```
