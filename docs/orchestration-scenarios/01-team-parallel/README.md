# team_parallel 编排场景设计

> **模式**：`team_parallel` — 在所有成员上并行运行任务（`isolated` 同任务 / `collaborative` 各自任务），可选 reduce 策略汇总输出。
> **源码**：[`src/tools/workflow-basic.ts:27-141`](../../../src/tools/workflow-basic.ts)
> **控时设计**：3 成员并行，每成员子任务 5-8 min；总时长 ≈ 最慢成员 + reduce ≈ 10-15 min（远低于 30 min 上限）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role | reduce_policy | 预计总时长 |
|---|------|------|--------|------|---------------|-----------|
| 1 | 数学 | Monte Carlo π 三方法对比 | 3 | `mathematician` | `merge` | ~12 min |
| 2 | 计算物理 | 谐振子三积分器能量漂移 | 3 | `simulator` | `select` | ~12 min |
| 3 | 编程 | 两数和多解法复杂度对比 | 3 | `coder` | `rubric` | ~10 min |

---

## 场景 1: Monte Carlo π 三方法对比

### 1.1 场景描述

**背景**：圆周率 π 有多种基于随机采样的估算方法，方差特性差异显著。在相同样本量（10⁶）下对比能直观展示方法优劣。

**目标**：3 个成员各用一种方法估算 π，汇总成误差对比表。

- 方法 A：朴素 Monte Carlo（单位圆内投点）
- 方法 B：分层抽样（100×100 网格，每格 100 点）
- 方法 C：Buffon 投针（L = d）

**成功标准（可机器评判）**：
- 每个成员输出含 `<!-- PI_EST: <数值> -->` 标注
- 三方法 `|π_est - π| < 0.05`
- 分层抽样的误差 ≤ 朴素 MC（方差理论保证）

### 1.2 Team 配置

```json
{
  "name": "mc-pi-bench",
  "description": "Monte Carlo pi estimation: 3 methods compared at 1e6 samples",
  "members": [
    {
      "name": "naive-mc",
      "role": "mathematician",
      "prompt": "Estimate pi via naive Monte Carlo: sample (x,y) uniformly in [0,1]^2, count fraction inside the unit circle (x^2+y^2<=1), pi ~ 4*count/N. Use EXACTLY 1,000,000 samples with fixed seed 42. Run the code, report the estimate, and give a one-line variance analysis. Your output MUST end with a line exactly formatted: <!-- PI_EST: <your_numeric_estimate> -->"
    },
    {
      "name": "stratified-mc",
      "role": "mathematician",
      "prompt": "Estimate pi via stratified sampling: divide [0,1]^2 into a 100x100 grid (10,000 strata), sample 100 points per stratum (total 1,000,000). For each stratum compute the in-circle fraction then average. Fixed seed 42. Report the estimate and explain in one line why stratification reduces variance. Your output MUST end with a line exactly formatted: <!-- PI_EST: <your_numeric_estimate> -->"
    },
    {
      "name": "buffon-needle",
      "role": "mathematician",
      "prompt": "Estimate pi via Buffon's needle: needle length L equals line spacing d; the crossing probability is 2/pi, so pi ~ 2*N_total/N_cross. Drop 1,000,000 needles with fixed seed 42. Report the estimate. Your output MUST end with a line exactly formatted: <!-- PI_EST: <your_numeric_estimate> -->"
    }
  ]
}
```

**Role 选择理由**：`mathematician` 用 `build` agent，可写代码、运行、做数值验证——完全匹配本场景需求。

### 1.3 Master 启动调用

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "mc-pi-bench",
    "mode": "collaborative",
    "tasks": {
      "naive-mc": "Run your pi estimation now. Produce the numeric result and end with the PI_EST marker.",
      "stratified-mc": "Run your pi estimation now. Produce the numeric result and end with the PI_EST marker.",
      "buffon-needle": "Run your pi estimation now. Produce the numeric result and end with the PI_EST marker."
    },
    "reduce_policy": "merge",
    "timeout_ms": 900000,
    "max_errored_members": 0
  }
}
```

**参数选择**：
- `mode: collaborative` — 三方法不同，必须各自任务
- `reduce_policy: merge` — 保留三方法独立结果做对比（非 select 单选）
- `timeout_ms: 900000`（15 min）— 给足余量，正常 8 min 完成
- `max_errored_members: 0` — 任一成员失败即整体失败（三方法缺一不完整）

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_parallel (collaborative)
T+0m    OCTeam 并行 dispatch 3 个 mathematician 成员
T+0~8m  各成员独立：写代码 → 运行 10^6 采样 → 写 markdown 报告 + PI_EST 标记
T+8m    最慢成员 idle → 触发 reduce (merge policy)
T+9m    汇总报告交付 master
T+9m    运行: bun check-math-montecarlo-pi.ts <run_dir>
```

### 1.5 评判脚本

[`check-math-montecarlo-pi.ts`](./check-math-montecarlo-pi.ts)

- **加载**：`runs/<run_id>/{naive-mc,stratified-mc,buffon-needle}.md`
- **提取**：正则 `<!-- PI_EST:\s*([\d.]+)\s*-->`
- **断言**：
  1. 三个估算值都存在
  2. 每个值 `|est - π| < 0.05`
  3. `stratified-mc` 的误差 ≤ `naive-mc` 的误差

---

## 场景 2: 谐振子三积分器能量漂移

### 2.1 场景描述

**背景**：简谐振子（`ẍ = -ω²x`，取 ω=1）是能量守恒系统的标准测试题。不同数值积分器在有限步长下的能量漂移差异巨大，是检验积分器品质的经典基准。

**目标**：3 个成员各用一种积分器（显式 Euler / Velocity Verlet / 经典 RK4）模拟 1000 步（步长 h=0.01），报告相对能量漂移。

**成功标准**：
- 每个成员输出含 `<!-- ENERGY_DRIFT: <数值> -->` 标注（相对漂移 |E_end - E_0|/E_0）
- 显式 Euler 漂移显著（理论 > 0.01）
- Velocity Verlet 漂移极小（< 1e-3，辛格式）
- RK4 漂移 < Euler（高阶）
- `verlet.drift < euler.drift` 且 `rk4.drift < euler.drift`

### 2.2 Team 配置

```json
{
  "name": "oscillator-bench",
  "description": "Harmonic oscillator: 3 integrators compared by energy drift over 1000 steps",
  "members": [
    {
      "name": "euler",
      "role": "simulator",
      "prompt": "Simulate the harmonic oscillator d^2x/dt^2 = -x (omega=1) using EXPLICIT (forward) Euler for exactly 1000 steps with step h=0.01. Initial conditions x0=1, v0=0. Total energy E = 0.5*(x^2 + v^2) (initial E0 = 0.5). Report the relative energy drift |E_end - E0|/E0. Your output MUST end with a line exactly formatted: <!-- ENERGY_DRIFT: <numeric_drift> -->"
    },
    {
      "name": "verlet",
      "role": "simulator",
      "prompt": "Simulate the harmonic oscillator d^2x/dt^2 = -x (omega=1) using VELOCITY VERLET for exactly 1000 steps with step h=0.01. Initial conditions x0=1, v0=0. Total energy E = 0.5*(x^2 + v^2) (initial E0 = 0.5). Report the relative energy drift |E_end - E0|/E0. Your output MUST end with a line exactly formatted: <!-- ENERGY_DRIFT: <numeric_drift> -->"
    },
    {
      "name": "rk4",
      "role": "simulator",
      "prompt": "Simulate the harmonic oscillator d^2x/dt^2 = -x (omega=1) using CLASSICAL RK4 (on the first-order system [x,v]) for exactly 1000 steps with step h=0.01. Initial conditions x0=1, v0=0. Total energy E = 0.5*(x^2 + v^2) (initial E0 = 0.5). Report the relative energy drift |E_end - E0|/E0. Your output MUST end with a line exactly formatted: <!-- ENERGY_DRIFT: <numeric_drift> -->"
    }
  ]
}
```

**Role 选择理由**：`simulator` 专为数值模拟设计（PDE/MC/MD/HPC），符合物理仿真场景。

### 2.3 Master 启动调用

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "oscillator-bench",
    "mode": "collaborative",
    "tasks": {
      "euler": "Run your explicit Euler simulation now and report the energy drift marker.",
      "verlet": "Run your Velocity Verlet simulation now and report the energy drift marker.",
      "rk4": "Run your RK4 simulation now and report the energy drift marker."
    },
    "reduce_policy": "select",
    "reducer_member": "verlet",
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `reduce_policy: select` — 让一个成员（verlet，辛格式代表）做综合评判，选出能量守恒最优
- `reducer_member: verlet` — 指定 verlet 汇总（避免默认交给 master）

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_parallel (collaborative)
T+0m    3 个 simulator 成员并行 dispatch
T+0~6m  各成员写积分器代码 → 跑 1000 步 → 报告 ENERGY_DRIFT
T+6m    三成员 idle → reduce (select policy, reducer=verlet)
T+7m    verlet 汇总对比，交付 master
T+7m    运行: bun check-physics-harmonic-integrator.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-harmonic-integrator.ts`](./check-physics-harmonic-integrator.ts)

- **加载**：`runs/<run_id>/{euler,verlet,rk4}.md`
- **提取**：正则 `<!-- ENERGY_DRIFT:\s*([\d.eE+-]+)\s*-->`
- **断言**：
  1. 三个漂移值都存在
  2. `euler.drift > 1e-3`（显式 Euler 在 h=0.01/1000 步必有可见漂移）
  3. `verlet.drift < euler.drift`（辛格式守恒优于显式）
  4. `rk4.drift < euler.drift`（高阶方法优于低阶）

---

## 场景 3: 两数和多解法复杂度对比

### 3.1 场景描述

**背景**：LeetCode 经典题「两数和」（给定整数数组 `nums` 和目标 `target`，返回和为 target 的两元素下标）。同一问题有多种解法，复杂度差异大，是算法教学的标准案例。

**目标**：3 个成员各实现一种解法（暴力 O(n²) / 哈希 O(n) / 排序+双指针 O(n log n)），自报复杂度并通过统一测试用例。

**成功标准**：
- 每个成员输出含 `<!-- COMPLEXITY: <BigO> -->` 标注
- 每个成员的代码通过 3 个预设测试用例
- 复杂度标注正确（brute=O(n^2)、hash=O(n)、two-pointer=O(n log n)）

### 3.2 Team 配置

```json
{
  "name": "two-sum-bench",
  "description": "Two-sum problem: 3 solutions (brute / hash / two-pointer) with complexity analysis",
  "members": [
    {
      "name": "brute",
      "role": "coder",
      "prompt": "Implement the Two Sum problem (return indices of the two numbers adding to target; exactly one solution exists) using the BRUTE-FORCE O(n^2) approach. Function signature: function twoSum(nums: number[], target: number): number[]. Embed the full TypeScript code in a ```typescript fenced block. Then declare the complexity. Your output MUST end with a line exactly formatted: <!-- COMPLEXITY: O(n^2) -->"
    },
    {
      "name": "hash",
      "role": "coder",
      "prompt": "Implement the Two Sum problem (return indices of the two numbers adding to target; exactly one solution exists) using the HASH MAP O(n) approach. Function signature: function twoSum(nums: number[], target: number): number[]. Embed the full TypeScript code in a ```typescript fenced block. Then declare the complexity. Your output MUST end with a line exactly formatted: <!-- COMPLEXITY: O(n) -->"
    },
    {
      "name": "two-pointer",
      "role": "coder",
      "prompt": "Implement Two Sum using SORT + TWO-POINTER O(n log n). NOTE: sort loses original indices, so you must keep (value, originalIndex) pairs. Function signature: function twoSum(nums: number[], target: number): number[]. Embed the full TypeScript code in a ```typescript fenced block. Then declare the complexity. Your output MUST end with a line exactly formatted: <!-- COMPLEXITY: O(n log n) -->"
    }
  ]
}
```

**Role 选择理由**：`coder` 用 `build` agent，专注实现，最小变更——贴合算法题实现需求。

### 3.3 Master 启动调用

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "two-sum-bench",
    "mode": "collaborative",
    "tasks": {
      "brute": "Implement your brute-force Two Sum now. Embed code + complexity marker.",
      "hash": "Implement your hash-map Two Sum now. Embed code + complexity marker.",
      "two-pointer": "Implement your sort+two-pointer Two Sum now. Embed code + complexity marker."
    },
    "reduce_policy": "rubric",
    "reduce_rubric": "Score each solution on: (a) correctness on the 3 test cases [nums=[2,7,11,15],target=9 -> [0,1]; nums=[3,2,4],target=6 -> [1,2]; nums=[3,3],target=6 -> [0,1]], (b) stated complexity matching actual complexity, (c) code clarity. Rank the three solutions.",
    "timeout_ms": 600000
  }
}
```

**参数选择**：
- `reduce_policy: rubric` — 按明确评分表对比（非简单合并）
- `reduce_rubric` 直接嵌入测试用例 — 让 reducer 用同一标准评判

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_parallel (collaborative)
T+0m    3 个 coder 成员并行 dispatch
T+0~5m  各成员写 Two Sum 实现 + 嵌入代码 + 复杂度标注
T+5m    三成员 idle → reduce (rubric policy, 默认交 master)
T+6m    master 按评分表汇总排序
T+6m    运行: bun check-coding-twosum.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-twosum.ts`](./check-coding-twosum.ts)

- **加载**：`runs/<run_id>/{brute,hash,two-pointer}.md`
- **提取**：
  - 代码：抓取 ` ```typescript ... ``` ` 代码块
  - 复杂度：正则 `<!-- COMPLEXITY:\s*(O\([^)]+\))\s*-->`
- **断言**：
  1. 三段代码都能用 `new Function` 加载为 `twoSum` 函数
  2. 每个函数在 3 个测试用例上返回正确下标
  3. 复杂度标注匹配期望（brute=O(n^2)、hash=O(n)、two-pointer=O(n log n)）

---

## 验收清单

- [ ] 3 个 check 脚本 `tsc --noEmit` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `simulator` / `coder` 均为预设）
- [ ] 每个 master 调用参数符合 `team_parallel` schema
- [ ] 每场景总时长 ≤ 15 min（远低于 30 min 上限）
- [ ] 成员 prompt 中明确输出格式约定（marker），评判脚本与之对齐


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成「创建团队 → 激活 → 启动编排 → 等待汇总 → 运行评判脚本」的完整闭环，并按退出码报告 PASS / FAIL。所有具体配置（team_create、team_parallel 参数）直接引用本 README 对应小节，无需手动复制 JSON。

### 场景 1: Monte Carlo π 三方法对比

```text
执行 docs/orchestration-scenarios/01-team-parallel/README.md「场景 1: Monte Carlo π 三方法对比」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按其中的 team_create JSON 创建团队
2. team_activate 激活（team_id = 上一步创建的团队名）
3. 读 README「1.3 Master 启动调用」，按其中的 team_parallel JSON 启动编排
4. team_results 轮询，等待编排完成、master 收到汇总
5. 定位本次 run 的输出目录 <run_dir>（含 naive-mc.md / stratified-mc.md / buffon-needle.md）
6. 运行评判：
   bun docs/orchestration-scenarios/01-team-parallel/check-math-montecarlo-pi.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：三方法 |π_est − π| < 0.05；且分层抽样误差 ≤ 朴素 Monte Carlo。
```

### 场景 2: 谐振子三积分器能量漂移

```text
执行 docs/orchestration-scenarios/01-team-parallel/README.md「场景 2: 谐振子三积分器能量漂移」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_parallel JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>（含 euler.md / verlet.md / rk4.md）
6. 运行：bun docs/orchestration-scenarios/01-team-parallel/check-physics-harmonic-integrator.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：显式 Euler 能量漂移 > 1e-3（体现病理）；Verlet 与 RK4 的漂移均 < Euler。
```

### 场景 3: 两数和多解法复杂度对比

```text
执行 docs/orchestration-scenarios/01-team-parallel/README.md「场景 3: 两数和多解法复杂度对比」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_parallel JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>（含 brute.md / hash.md / two-pointer.md）
6. 运行：bun docs/orchestration-scenarios/01-team-parallel/check-coding-twosum.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：3 个测试用例（[2,7,11,15]/9、[3,2,4]/6、[3,3]/6）全通过；复杂度标注正确（brute=O(n²)、hash=O(n)、two-pointer=O(n log n)）。
```
