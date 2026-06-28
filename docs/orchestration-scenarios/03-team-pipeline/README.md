# team_pipeline 编排场景设计

> **模式**：`team_pipeline` — 线性流水线：stage N 的输出被前缀追加到 stage N+1 的任务上，逐级串行；最终 stage 的输出汇总交付 leader。
> **源码**：[`src/tools/workflow-basic.ts:203-280`](../../../src/tools/workflow-basic.ts)
> **控时设计**：3 stage 串行执行，每 stage 子任务 3-5 min；总时长 ≈ Σ(stage) + summarize ≈ 12-15 min（远低于 30 min 上限，每成员子任务 ≤ 8 min）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role | stages（串行） | 预计总时长 |
|---|------|------|--------|------|----------------|-----------|
| 1 | 数学 | 高斯定积分三段流水线 | 3 | `mathematician` | alice → bob → carol | ~12 min |
| 2 | 计算物理 | 小角度单摆仿真链 | 3 | `simulator` | alice → bob → carol | ~14 min |
| 3 | 编程 | `fib(n)` TDD 流水线 | 3 | `coder` | alice → bob → carol | ~10 min |
| 4 | 计算物理（挑战级） | Lennard-Jones 分子动力学完整仿真链 | 8 | `simulator` | alice → bob → carol → dave → erin → frank → grace → henry | ~60 min |

> **流水线语义**：stage N+1 的任务前缀自动追加 stage N 的完整 markdown 输出；最终 `leader` 收到的是 stage 3 的输出（经 summarize）。评判脚本读取**末段成员**的 `<member>.md`（末段输出即流水线产物）。

---

## 场景 1: 高斯定积分三段流水线

### 1.1 场景描述

**背景**：高斯积分 `I = ∫₀¹ e^(-x²) dx` 无初等闭式原函数，但可用误差函数精确表出 `(√π/2)·erf(1)`。该问题是「符号简化 → 数值求积 → 误差界」三段流水线的经典案例。

**目标**：3 个成员串行接力——
- stage-1（`alice`）：证明无初等闭式，归约为 `(√π/2)·erf(1)`，并给出紧致数值界。
- stage-2（`bob`）：用 **Gauss–Legendre 求积（n=8 节点）** 在 `[0,1]` 上数值计算 `I`，给到 10 位有效数字。
- stage-3（`carol`）：将数值结果与闭式参考值 `(√π/2)·erf(1) ≈ 0.7468241328` 对比，报告绝对误差。

**成功标准（可机器评判）**：
- stage-2 输出含 `<!-- VALUE: <数值> -->` 标注（10 位数值）
- stage-3 输出含 `<!-- ERROR: <数值> -->` 标注
- `error < 1e-8`（Gauss–Legendre n=8 对低阶多项式精确；`e^(-x²)` 在 `[0,1]` 上收敛极快，误差应远小于 1e-8）

### 1.2 Team 配置

```json
{
  "name": "gaussian-integral-pipeline",
  "description": "Gaussian integral pipeline: alice -> bob (Gauss-Legendre n=8) -> error bound",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are stage 1 (simplify) of a 3-stage pipeline evaluating the Gaussian integral I = integral_0^1 e^(-x^2) dx. Tasks: (1) Explain why this integral has no elementary closed-form antiderivative. (2) Identify the exact value in terms of the error function: I = (sqrt(pi)/2)*erf(1). (3) Give a tight numerical bound on I (e.g. via Taylor series or sandwich bounds) so the next stage has a sanity check. Hand the symbolic reduction forward. Your output MUST end with a line exactly formatted: <!-- CLOSED_FORM: (sqrt(pi)/2)*erf(1) -->"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are stage 2 (numerical) of a 3-stage pipeline evaluating the Gaussian integral I = integral_0^1 e^(-x^2) dx. The previous stage established I = (sqrt(pi)/2)*erf(1). Your job: approximate I numerically using Gauss-Legendre quadrature with EXACTLY n=8 nodes on the interval [0,1] (use the standard nodes/weights on [-1,1] then affine-map to [0,1]). Embed the code in a fenced block. Report the estimate to 10 significant digits. Your output MUST end with a line exactly formatted: <!-- VALUE: <your_10_digit_numeric_value> -->"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are stage 3 (error-bound) of a 3-stage pipeline evaluating the Gaussian integral I = integral_0^1 e^(-x^2) dx. Previous stages gave the closed form I = (sqrt(pi)/2)*erf(1) and a Gauss-Legendre (n=8) numerical estimate. Your job: take the numerical estimate from stage 2 and compare it to the closed-form reference value 0.7468241328 (approx (sqrt(pi)/2)*erf(1)); report the absolute error |estimate - reference|. Your output MUST end with a line exactly formatted: <!-- ERROR: <absolute_error> -->"
    }
  ]
}
```

**Role 选择理由**：`mathematician` 用 `build` agent，可写代码、运行、做数值验证——完全匹配符号推导 + 数值求积 + 误差分析的需求。

### 1.3 Master 启动调用

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "gaussian-integral-pipeline",
    "stages": [
      {
        "member": "alice",
        "task": "Run stage 1 now: reduce the Gaussian integral symbolically and produce your CLOSED_FORM marker."
      },
      {
        "member": "bob",
        "task": "Run stage 2 now: implement Gauss-Legendre n=8 on [0,1], compute the estimate, and produce your VALUE marker."
      },
      {
        "member": "carol",
        "task": "Run stage 3 now: compare the stage-2 estimate to 0.7468241328 and produce your ERROR marker."
      }
    ],
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `stages` 三成员**唯一**（流水线硬性要求：`alice` / `bob` / `carol` 互不重复）
- `signoff_policy` 默认 `none` — 小场景直接交付，无需评审门
- `timeout_ms: 900000`（15 min）— 3 stage 串行 + 余量，正常 ~10 min 完成
- stage N+1 的 `task` 仅写本 stage 指令；stage N 的输出由框架自动前缀追加，无需手动拼接

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_pipeline (3 stages)
T+0m    OCTeam dispatch stage-1 (alice)
T+0~4m  alice：符号推导 + CLOSED_FORM 标记 → idle
T+4m    stage-1 输出前缀追加到 stage-2 任务 → dispatch bob
T+4~8m  bob：Gauss-Legendre n=8 代码 → 运行 → VALUE 标记 → idle
T+8m    stage-2 输出前缀追加到 stage-3 任务 → dispatch carol
T+8~12m carol：对比参考值 → ERROR 标记 → idle
T+12m   末段输出 summarize 交付 master
T+12m   运行: bun check-math-gaussian-integral.ts <run_dir>
```

### 1.5 评判脚本

[`check-math-gaussian-integral.ts`](./check-math-gaussian-integral.ts)

- **加载**：`runs/<run_id>/carol.md`（末段成员）
- **提取**：正则 `<!--\s*ERROR:\s*([\d.eE+-]+)\s*-->`
- **断言**：
  1. marker 存在且可解析
  2. `error < 1e-8`（Gauss–Legendre n=8 对 `e^(-x²)` 在 `[0,1]` 上误差远小于此）

---

## 场景 2: 小角度单摆仿真链

### 2.1 场景描述

**背景**：小角度单摆（`θ̈ = -(g/L)θ`，线性化）是可解析的 ODE，常用于验证数值积分器的精度与相图守恒性。一条完整仿真链包含：建模 → 积分 → 相图采样。

**目标**：3 个 `simulator` 成员串行——
- stage-1（`alice`）：导出 ODE、解析解 `θ(t) = θ₀·cos(√(g/L)·t)` 与周期 `T = 2π·√(L/g)`。
- stage-2（`bob`）：用 **经典 RK4** 从 `t=0` 积到 `t=T`，步长 `h=0.001`；输出 `θ(T)`（应 ≈ `θ₀`）。
- stage-3（`carol`）：在 `[0,T]` 上等距取 100 点，比较 RK4 数值 `θ` 与解析 `θ`，输出最大偏差。

**参数**：`g = 9.81 m/s²`，`L = 1.0 m`，`θ₀ = 0.1 rad`（小角度），`θ̇₀ = 0`。

**成功标准（可机器评判）**：
- stage-2 输出含 `<!-- THETA_END: <数值> -->` 标注
- stage-3 输出含 `<!-- MAX_ERR: <数值> -->` 标注
- `max_err < 1e-4`（RK4 在 `h=0.001`、一个周期内的局部截断误差 O(h⁴) 累积远小于 1e-4）

### 2.2 Team 配置

```json
{
  "name": "pendulum-pipeline",
  "description": "Small-angle pendulum pipeline: alice -> RK4 bob -> carol max error",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are stage 1 (model) of a 3-stage pipeline simulating a small-angle pendulum. Setup: rigid pendulum length L=1.0 m, gravity g=9.81 m/s^2, small-angle ODE theta'' = -(g/L)*theta. Initial conditions theta(0)=theta0=0.1 rad, theta'(0)=0. Tasks: (1) Derive the analytic solution theta(t) = theta0*cos(sqrt(g/L)*t). (2) Compute the period T = 2*pi*sqrt(L/g). (3) State theta(T) = theta0 (returns to start after one period). Pass the model and all parameters forward. Your output MUST end with a line exactly formatted: <!-- PERIOD: <T_numeric_value> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are stage 2 (integrate) of a 3-stage pendulum pipeline. The previous stage derived the ODE theta'' = -(g/L)*theta with g=9.81, L=1.0, analytic theta(t) = 0.1*cos(sqrt(9.81)*t), period T = 2*pi*sqrt(1/9.81). Your job: integrate the first-order system [theta, omega] with theta'=omega, omega'=-(g/L)*theta using CLASSICAL RK4 from t=0 to t=T with step h=0.001. Initial theta=0.1, omega=0. Embed the code in a fenced block. Report theta(T) (should be approx 0.1). Your output MUST end with a line exactly formatted: <!-- THETA_END: <theta_at_T> -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are stage 3 (phase-portrait) of a 3-stage pendulum pipeline. Previous stages derived the ODE (theta'' = -(g/L)*theta, g=9.81, L=1.0), analytic solution theta(t)=0.1*cos(sqrt(9.81)*t), period T=2*pi*sqrt(1/9.81), and RK4-integrated theta(T). Your job: over [0, T], sample 100 equally spaced points; at each point compare the RK4 numerical theta to the analytic theta(t)=0.1*cos(sqrt(9.81)*t); report the MAX absolute deviation across the 100 samples. Embed the code in a fenced block. Your output MUST end with a line exactly formatted: <!-- MAX_ERR: <max_deviation> -->"
    }
  ]
}
```

**Role 选择理由**：`simulator` 专为数值模拟设计（PDE/MC/MD/HPC），符合 ODE 积分与相图采样场景。

### 2.3 Master 启动调用

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "pendulum-pipeline",
    "stages": [
      {
        "member": "alice",
        "task": "Run stage 1 now: derive the ODE, analytic solution, and period; produce your PERIOD marker."
      },
      {
        "member": "bob",
        "task": "Run stage 2 now: RK4-integrate from 0 to T at h=0.001 and produce your THETA_END marker."
      },
      {
        "member": "carol",
        "task": "Run stage 3 now: sample 100 points, compare RK4 vs analytic, and produce your MAX_ERR marker."
      }
    ],
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `stages` 三成员唯一（`alice` / `bob` / `carol`）
- `signoff_policy` 默认 `none`
- `timeout_ms: 900000`（15 min）— RK4 在 `h=0.001`、一周期约 2000 步，运行极快，瓶颈在串行 dispatch

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_pipeline (3 stages)
T+0m    dispatch stage-1 (alice)
T+0~4m  alice：推导 ODE + 解析解 + PERIOD 标记 → idle
T+4m    stage-1 输出前缀追加到 stage-2 → dispatch bob
T+4~9m  bob：RK4 h=0.001 跑一周期 → THETA_END 标记 → idle
T+9m    stage-2 输出前缀追加到 stage-3 → dispatch carol
T+9~14m carol：100 点采样 + 最大偏差 → MAX_ERR 标记 → idle
T+14m   末段输出 summarize 交付 master
T+14m   运行: bun check-physics-pendulum.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-pendulum.ts`](./check-physics-pendulum.ts)

- **加载**：`runs/<run_id>/carol.md`（末段成员）
- **提取**：正则 `<!--\s*MAX_ERR:\s*([\d.eE+-]+)\s*-->`
- **断言**：
  1. marker 存在且可解析
  2. `max_err < 1e-4`（RK4 在 `h=0.001`、一周期内的累积误差远低于此）

---

## 场景 3: `fib(n)` TDD 流水线

### 3.1 场景描述

**背景**：TDD（测试驱动开发）天然是流水线——先写测试（红）、再写最小实现（绿）、最后重构（不改行为）。以 `fib(n)` 为载体可清晰演示三段接力。

**目标**：3 个 `coder` 成员串行——
- stage-1（`alice`）：写 4 个 `fib` 测试用例（`(0)→0`、`(1)→1`、`(10)→55`、`(20)→6765`）作为断言，嵌入代码块。
- stage-2（`bob`）：写最小的 `function fib(n: number): number` 通过全部 4 例，嵌入代码块。
- stage-3（`carol`）：取 stage-2 代码做清晰度重构（**不改算法**），重新验证 4 例仍通过，嵌入重构后代码。

**成功标准（可机器评判）**：
- stage-1 输出 `<!-- CASES: 4 -->`
- stage-2 输出 `<!-- IMPLEMENTS: fib -->`
- stage-3 输出 `<!-- PASSES: 4 -->`
- 从 stage-3 的 markdown 抽取重构后代码，`new Function` 加载为 `fib`，4 个用例全部通过

### 3.2 Team 配置

```json
{
  "name": "fib-tdd-pipeline",
  "description": "Fibonacci TDD pipeline: alice -> minimal bob -> carol + re-verify",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are stage 1 (tests) of a 3-stage TDD pipeline implementing the Fibonacci function. Write EXACTLY 4 test cases as TypeScript assertions for fib: fib(0)===0, fib(1)===1, fib(10)===55, fib(20)===6765. Embed the assertion block in a single ```typescript fenced block. Hand the cases forward for the implementation stage. Your output MUST end with a line exactly formatted: <!-- CASES: 4 -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are stage 2 (implement) of a 3-stage TDD pipeline. Previous stage defined 4 test cases for fib: fib(0)=0, fib(1)=1, fib(10)=55, fib(20)=6765. Your job: write the MINIMAL `function fib(n: number): number` that passes all 4 cases. Embed the full TypeScript implementation in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPLEMENTS: fib -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are stage 3 (refactor) of a 3-stage TDD pipeline. Previous stages wrote 4 test cases (fib: 0->0, 1->1, 10->55, 20->6765) and a minimal implementation. Your job: take stage-2's fib code and refactor for clarity (NO algorithm change, same asymptotic complexity), re-verifying all 4 cases still pass. Embed ONLY the final refactored `function fib(n: number): number` in a single ```typescript fenced block; do NOT include any other code block. Your output MUST end with a line exactly formatted: <!-- PASSES: 4 -->"
    }
  ]
}
```

**Role 选择理由**：`coder` 用 `build` agent，专注实现、最小变更——贴合 TDD 三段式需求。

### 3.3 Master 启动调用

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "fib-tdd-pipeline",
    "stages": [
      {
        "member": "alice",
        "task": "Run stage 1 now: write the 4 fib test cases and produce your CASES marker."
      },
      {
        "member": "bob",
        "task": "Run stage 2 now: write the minimal fib that passes the 4 cases and produce your IMPLEMENTS marker."
      },
      {
        "member": "carol",
        "task": "Run stage 3 now: refactor stage-2's fib for clarity, re-verify the 4 cases, and produce your PASSES marker."
      }
    ],
    "timeout_ms": 600000
  }
}
```

**参数选择**：
- `stages` 三成员唯一（`alice` / `bob` / `carol`）
- `signoff_policy` 默认 `none`
- `timeout_ms: 600000`（10 min）— 单成员任务 < 4 min，三段串行总时长富余

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_pipeline (3 stages)
T+0m    dispatch stage-1 (alice)
T+0~3m  alice：写 4 断言 + CASES 标记 → idle
T+3m    stage-1 输出前缀追加到 stage-2 → dispatch bob
T+3~6m  bob：最小 fib 实现 + IMPLEMENTS 标记 → idle
T+6m    stage-2 输出前缀追加到 stage-3 → dispatch carol
T+6~10m carol：重构 + 重验 4 例 + PASSES 标记 → idle
T+10m   末段输出 summarize 交付 master
T+10m   运行: bun check-coding-fib-tdd.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-fib-tdd.ts`](./check-coding-fib-tdd.ts)

- **加载**：`runs/<run_id>/carol.md`（末段成员）
- **提取**：
  - 代码：抓取 ` ```typescript ... ``` ` 代码块（取最后一个，应对 stage-2 前缀被引用的情形）
  - 标记：正则 `<!--\s*PASSES:\s*(\d+)\s*-->`
- **处理**：剥离 TypeScript 类型注解（`new Function` 不识别 `: number` 等语法）
- **断言**：
  1. `PASSES` 标记存在且为 4
  2. 代码能 `new Function` 加载为 `fib`
  3. 4 个用例全部通过：`fib(0)=0`、`fib(1)=1`、`fib(10)=55`、`fib(20)=6765`

---

## 场景 4: Lennard-Jones 分子动力学完整仿真链（挑战级）

> **挑战级说明**：本场景突破常规 30 min / ≤4 成员上限，使用 **8 段串行流水线**完成一次完整的 Lennard-Jones 分子动力学仿真（力场 → 初始化 → 能量极小化 → NVT 平衡 → NVT 采样 → RDF 分析 → 汇总报告）。每段子任务约 5-8 min，总时长约 60 min，timeout 设 90 min 留余量。仅作能力演示，不作为常规基准。

### 4.1 场景描述

**背景**：液氩（Ar）的经典分子动力学仿真是统计物理教学的标杆体系。原子间相互作用用 Lennard-Jones（LJ）势描述 `V(r) = 4ε[(σ/r)¹² − (σ/r)⁶]`，配合周期性边界条件（PBC）与速度 Verlet 积分，可复现液态氩的径向分布函数 g(r) 与能量守恒性。一条完整、可复现的仿真链涵盖：力场定义 → 初始构型 → 能量极小化 → NVT 平衡 → NVE/NVT 采样 → 轨迹采样 → 后处理（g(r)）→ 报告。

**体系参数**：100 个氩原子，立方盒子周期性边界，密度 ρ = 1.38 g/cm³（液态氩典型值），初始温度 T₀ = 120 K。LJ 参数 ε = 0.998 kJ/mol（≈ 119.8 K·k_B），σ = 3.40 Å，截断半径 r_cut = 2.5σ。

**目标**：8 个 `simulator` 成员串行接力——
- stage-1（`alice`，force-field）：定义 LJ 力场参数（ε=0.998 kJ/mol、σ=3.40 Å、r_cut=2.5σ），给出势能、力的解析表达式，并约定 reduced unit（σ、ε、原子质量 m_Ar）换算。
- stage-2（`bob`，init）：按 ρ=1.38 g/cm³ 与 100 个原子构建立方盒子（含 PBC），在 **FCC 格子**上排布原子（注意 100 不是 FCC 完整 filling，须说明取舍），按 Maxwell–Boltzmann 分布在 T₀=120 K 初始化速度并去质心速度。
- stage-3（`carol`，minimize）：对初始构型做**最速下降法**能量极小化，直到最大原子受力 `F < 1e-4`（reduced 或 SI 一致即可），消除格点重叠带来的高能。
- stage-4（`dave`，equilibrate）：在 **NVT @ 120 K** 下平衡 **10⁴ 步**，步长 h=2 fs（可用 velocity Verlet + Berendsen 或 Langevin 恒温器），使温度、能量进入稳态。
- stage-5（`erin`，produce）：切换到 **NVE**（微正则）产出 **10⁵ 步**，步长 h=2 fs，velocity Verlet 积分；记录总能量曲线用于评估能量漂移。
- stage-6（`frank`，sample）：从产出轨迹等距抽取 **1000 帧**构型，按 PBC 最小镜像约定整理，作为 g(r) 计算输入。
- stage-7（`grace`，rdf）：基于 1000 帧计算**径向分布函数 g(r)**（bin 宽 0.02σ，区间 [0, L/2]），报告 g(r) 第一峰位置 r_peak（Å）。
- stage-8（`henry`，report）：汇总产出阶段平均温度 `<T>`、平均总能量 `<E>`、g(r) 第一峰位置，并计算产出阶段总能量相对漂移 `ΔE/<E>`，形成最终报告。

**成功标准（可机器评判）**：
- stage-8（`henry`）输出含 `<!-- TEMP_K: <数值> -->` 标注（产出阶段平均温度，期望 ≈ 120 K ± 20）
- stage-8 输出含 `<!-- RDF_PEAK_A: <数值> -->` 标注（g(r) 第一峰位置，单位 Å，期望 ≈ 3.40 ± 0.2 Å，即约一个 σ）
- stage-8 输出含 `<!-- ENERGY_DRIFT: <数值> -->` 标注（产出 NVE 阶段总能量相对漂移 `|ΔE|/|<E>|`，期望 < 0.05）
- 评判脚本只读末段 `henry.md`（流水线语义：前 7 段输出会被框架自动前缀追加到 `henry` 的任务上，故末段即完整产物）

### 4.2 Team 配置

```json
{
  "name": "lj-md-pipeline",
  "description": "Lennard-Jones MD pipeline (8 stages): force-field -> init -> minimize -> equilibrate -> produce -> sample -> rdf -> report",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are stage 1 (force-field) of an 8-stage Lennard-Jones molecular dynamics pipeline simulating 100 argon atoms under periodic boundary conditions. Define the Lennard-Jones potential V(r) = 4*epsilon*[(sigma/r)^12 - (sigma/r)^6] and its force F(r) = -dV/dr. Parameters: epsilon = 0.998 kJ/mol (approx 119.8 K * k_B), sigma = 3.40 Angstrom, cutoff r_cut = 2.5*sigma (shifted to zero at r_cut). Argon atomic mass m_Ar = 39.948 u. State the reduced-unit convention (length in sigma, energy in epsilon, mass in m_Ar, time in sigma*sqrt(m_Ar/epsilon)) and the derived box length from rho = 1.38 g/cm^3 and N = 100. Embed any code in a fenced block. Hand the force-field definition and all constants forward. Your output MUST end with a line exactly formatted: <!-- FORCE_FIELD: LJ_epsilon_0.998_kJ_mol_sigma_3.40A_rcut_2.5sigma -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are stage 2 (init) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. The previous stage fixed LJ params (epsilon=0.998 kJ/mol, sigma=3.40 Angstrom, r_cut=2.5*sigma) and reduced units. Your job: build the cubic simulation box with periodic boundary conditions from rho = 1.38 g/cm^3 and N = 100 (compute box length L), place atoms on an FCC lattice (explain how you handle N=100 not being a perfect FCC filling), and initialize velocities from a Maxwell-Boltzmann distribution at T0 = 120 K, removing the center-of-mass velocity. Embed the code in a fenced block. Hand the initial configuration (positions, velocities, L) forward. Your output MUST end with a line exactly formatted: <!-- INIT: N_100_rho_1.38_T0_120K -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are stage 3 (minimize) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. Previous stages fixed the LJ force-field (epsilon=0.998 kJ/mol, sigma=3.40 Angstrom, r_cut=2.5*sigma) and built the initial FCC lattice in a periodic box. Your job: run STEEPEST DESCENT energy minimization on the initial positions (with PBC minimum-image convention) until the maximum per-atom force magnitude drops below 1e-4 (state the unit system used). Embed the code in a fenced block. Hand the minimized positions forward. Your output MUST end with a line exactly formatted: <!-- MINIMIZE: Fmax_below_1e-4 -->"
    },
    {
      "name": "dave",
      "role": "simulator",
      "prompt": "You are stage 4 (equilibrate) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. Previous stages defined the LJ force-field, built the FCC initial configuration, and minimized it. Your job: integrate the equations of motion in the NVT ensemble at T = 120 K for 10^4 steps with timestep h = 2 fs using velocity Verlet plus a thermostat of your choice (Berendsen or Langevin, state which). Use PBC minimum-image and the r_cut = 2.5*sigma cutoff. Embed the code in a fenced block. Report the equilibrated mean temperature and potential energy over the second half of the run. Hand the equilibrated state (positions, velocities) forward. Your output MUST end with a line exactly formatted: <!-- EQUIL: NVT_120K_1e4steps_h_2fs -->"
    },
    {
      "name": "erin",
      "role": "simulator",
      "prompt": "You are stage 5 (produce) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. Previous stages ran NVT equilibration at 120 K. Your job: switch to the NVE ensemble (microcanonical, NO thermostat) and integrate 10^5 steps with timestep h = 2 fs using velocity Verlet (PBC minimum-image, r_cut = 2.5*sigma). Record the total energy E_total at regular intervals to quantify drift. Embed the code in a fenced block. Report the mean total energy <E> and the relative drift |E_end - E_start| / |<E>| over the production run. Hand the production trajectory forward. Your output MUST end with a line exactly formatted: <!-- PRODUCE: NVE_1e5steps_h_2fs -->"
    },
    {
      "name": "frank",
      "role": "simulator",
      "prompt": "You are stage 6 (sample) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. The previous stage produced a 10^5-step NVE trajectory. Your job: down-sample the production trajectory to EXACTLY 1000 equally spaced frames of positions (with PBC wrapping applied). Embed the code in a fenced block. Hand the 1000-frame trajectory forward as the input for radial-distribution-function analysis. Your output MUST end with a line exactly formatted: <!-- SAMPLE: 1000_frames -->"
    },
    {
      "name": "grace",
      "role": "simulator",
      "prompt": "You are stage 7 (rdf) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. The previous stage handed a 1000-frame trajectory in the periodic box. Your job: compute the radial distribution function g(r) from the 1000 frames using bin width 0.02*sigma over r in [0, L/2] (L is the box length), with PBC minimum-image. Normalize correctly for a uniform-ideal-gas reference. Embed the code in a fenced block. Report the position of the FIRST peak of g(r) in Angstrom (expect approx sigma = 3.40 A). Hand g(r) and the first-peak position forward. Your output MUST end with a line exactly formatted: <!-- RDF_PEAK: <first_peak_position_in_Angstrom> -->"
    },
    {
      "name": "henry",
      "role": "simulator",
      "prompt": "You are stage 8 (report, FINAL) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. All previous stages (force-field -> init -> minimize -> NVT equilibrate at 120 K -> NVE produce 1e5 steps -> 1000-frame sampling -> g(r)) have run and their outputs are prefixed above. Your job: synthesize the FINAL report containing (1) mean temperature <T> over the NVE production in Kelvin, (2) mean total energy <E> over production, (3) the g(r) first peak position in Angstrom (from stage 7), and (4) the relative total-energy drift |E_end - E_start| / |<E>| over the NVE production run. Your output MUST end with EXACTLY THREE lines, each on its own line, formatted as: <!-- TEMP_K: <mean_temperature_Kelvin> --> then <!-- RDF_PEAK_A: <first_peak_Angstrom> --> then <!-- ENERGY_DRIFT: <relative_drift> -->"
    }
  ]
}
```

**Role 选择理由**：8 段均为数值模拟（力场、初始化、极小化、NVT/NVE 积分、采样、RDF 后处理、报告），`simulator` 专为 PDE/MC/MD/HPC 数值模拟设计，全程一致无需切 role，且 `build` agent 可写码 + 运行 + 数值验证。

### 4.3 Master 启动调用

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "lj-md-pipeline",
    "stages": [
      { "member": "alice",  "task": "Run stage 1 now: define the LJ force-field (epsilon=0.998 kJ/mol, sigma=3.40 A, r_cut=2.5*sigma), reduced units, and box length from rho=1.38 g/cm^3; produce your FORCE_FIELD marker." },
      { "member": "bob",    "task": "Run stage 2 now: build the cubic PBC box, place 100 atoms on an FCC lattice, Maxwell-Boltzmann velocities at T0=120 K, remove COM velocity; produce your INIT marker." },
      { "member": "carol",  "task": "Run stage 3 now: steepest-descent minimize the initial configuration to Fmax < 1e-4 (PBC minimum-image); produce your MINIMIZE marker." },
      { "member": "dave",   "task": "Run stage 4 now: NVT equilibrate at 120 K for 10^4 steps, h=2 fs, velocity Verlet + thermostat; produce your EQUIL marker." },
      { "member": "erin",   "task": "Run stage 5 now: NVE produce 10^5 steps, h=2 fs, velocity Verlet; record total-energy drift; produce your PRODUCE marker." },
      { "member": "frank",  "task": "Run stage 6 now: down-sample the production trajectory to exactly 1000 PBC-wrapped frames; produce your SAMPLE marker." },
      { "member": "grace",  "task": "Run stage 7 now: compute g(r) over the 1000 frames (bin 0.02*sigma, r in [0,L/2]); produce your RDF_PEAK marker (first peak in Angstrom)." },
      { "member": "henry",  "task": "Run stage 8 now (FINAL): assemble the report with <T>, <E>, g(r) first peak, and relative energy drift; produce your TEMP_K, RDF_PEAK_A, and ENERGY_DRIFT markers." }
    ],
    "timeout_ms": 5400000
  }
}
```

**参数选择**：
- `stages` 八成员**唯一**（流水线硬性要求：`alice` / `bob` / `carol` / `dave` / `erin` / `frank` / `grace` / `henry` 互不重复）
- `signoff_policy` 默认 `none` — 长链流水线靠末段汇总产物，不加评审门以免进一步拉长
- `timeout_ms: 5400000`（90 min）— 8 段串行预计 ~60 min（每段 5-8 min 含 dispatch + 运行），留 50% 余量
- 每个 stage 的 `task` 仅写本 stage 指令；前序 stage 的 markdown 输出由框架自动前缀追加，无需手动拼接

### 4.4 执行流程（时序）

```
T+0m     master 调用 team_pipeline (8 stages)
T+0m     dispatch stage-1 (alice)
T+0~7m   alice：LJ 力场 + reduced unit + 盒长 → FORCE_FIELD 标记 → idle
T+7m     stage-1 输出前缀追加到 stage-2 → dispatch bob
T+7~14m  bob：FCC 初始化 + Maxwell 速度 → INIT 标记 → idle
T+14m    → dispatch carol
T+14~21m carol：最速下降极小化 → MINIMIZE 标记 → idle
T+21m    → dispatch dave
T+21~30m dave：NVT 平衡 10^4 步 → EQUIL 标记 → idle
T+30m    → dispatch erin
T+30~40m erin：NVE 产出 10^5 步 + 能量漂移 → PRODUCE 标记 → idle
T+40m    → dispatch frank
T+40~46m frank：抽取 1000 帧 → SAMPLE 标记 → idle
T+46m    → dispatch grace
T+46~54m grace：g(r) + 第一峰 → RDF_PEAK 标记 → idle
T+54m    → dispatch henry
T+54~60m henry：汇总 <T>/<E>/g(r) 峰/能量漂移 → 三标记 → idle
T+60m    末段输出 summarize 交付 master
T+60m    运行: bun check-physics-md-pipeline.ts <run_dir>
```

### 4.5 评判脚本

[`check-physics-md-pipeline.ts`](./check-physics-md-pipeline.ts)

- **加载**：`runs/<run_id>/henry.md`（末段成员；流水线语义下前 7 段输出已被框架前缀追加到 henry 任务，故末段输出即完整产物，评判只读这一份）
- **提取**：三条正则
  - `<!--\s*TEMP_K:\s*([\d.eE+-]+)\s*-->`
  - `<!--\s*RDF_PEAK_A:\s*([\d.eE+-]+)\s*-->`
  - `<!--\s*ENERGY_DRIFT:\s*([\d.eE+-]+)\s*-->`
- **断言**：
  1. 三条 marker 均存在且可解析为数值
  2. `100 <= TEMP_K <= 140`（NVT 锁定 120 K，NVE 产出期间温度浮动 ±20 K 内）
  3. `3.2 <= RDF_PEAK_A <= 3.6`（液氩 g(r) 第一峰位于约一个 σ ≈ 3.40 Å）
  4. `ENERGY_DRIFT < 0.05`（velocity Verlet 在 h=2 fs、10⁵ 步内的相对能量漂移）

---

## 验收清单

- [ ] 4 个 check 脚本 `tsc --noEmit` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `simulator` / `coder` 均为预设）
- [ ] 每个 master 调用参数符合 `team_pipeline` schema（`stages[].member` 唯一）
- [ ] 场景 1-3 总时长 ≤ 15 min（远低于 30 min 上限；每成员子任务 ≤ 8 min）；场景 4 为挑战级（8 段、~60 min、timeout 90 min），单独标注
- [ ] 成员 prompt 中明确输出格式约定（marker），评判脚本读取**末段成员**输出并与之对齐


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成完整闭环。pipeline 的评判只读「末阶段成员」的输出（前序阶段输出会自动拼到末阶段任务前）。

### 场景 1: 高斯定积分全流程（数学）

```text
执行 docs/orchestration-scenarios/03-team-pipeline/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_pipeline JSON 启动编排（3 阶段顺序）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>（末阶段成员的 .md 即最终输出）
6. 运行：bun docs/orchestration-scenarios/03-team-pipeline/check-math-gaussian-integral.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：末阶段（carol）报 ERROR < 1e-8（Gauss-Legendre n=8 对 e^(-x²) 精度极高）。
```

### 场景 2: 单摆小角度仿真（物理）

```text
执行 docs/orchestration-scenarios/03-team-pipeline/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_pipeline JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/03-team-pipeline/check-physics-pendulum.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：末阶段（carol）报 MAX_ERR < 1e-4（RK4 h=0.001 跑一个周期）。
```

### 场景 3: Fibonacci TDD 线（编程）

```text
执行 docs/orchestration-scenarios/03-team-pipeline/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_pipeline JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>（末阶段 carol 成员的 .md）
6. 运行：bun docs/orchestration-scenarios/03-team-pipeline/check-coding-fib-tdd.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：末阶段（carol）代码通过 4 用例：fib(0)=0、fib(1)=1、fib(10)=55、fib(20)=6765。
```

### 场景 4: Lennard-Jones 分子动力学完整仿真链（挑战级，物理）

```text
执行 docs/orchestration-scenarios/03-team-pipeline/README.md「场景 4」的完整闭环并自动评判（挑战级：8 段串行，约 60 min）。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（8 个 simulator 成员 alice..henry）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_pipeline JSON 启动编排（8 阶段顺序，timeout_ms=5400000）
4. team_results 轮询至 master 收到汇总（注意耗时较长，可拉长轮询间隔）
5. 定位 <run_dir>（末阶段成员 henry.md 即最终输出；前 7 段输出已自动拼到 henry 任务前）
6. 运行：bun docs/orchestration-scenarios/03-team-pipeline/check-physics-md-pipeline.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：末阶段（henry）报 TEMP_K ∈ [100,140] K、RDF_PEAK_A ∈ [3.2,3.6] Å、ENERGY_DRIFT < 0.05。
```
