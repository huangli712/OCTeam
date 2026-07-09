# team_arena 编排场景设计

> **模式**：`team_arena` —— 竞争擂台。N 名候选成员在各自的隔离 git worktree 中实现同一任务的竞争方案（implement 阶段）；随后一名独立 evaluator 对每位候选人的输出运行相同的客观评估，产出结构化 `<scoreboard>` 评分；引擎按 `winner_metric` 和 `score_direction` 选出确定性胜者并直接交付（v1 无 signoff 门控）。
> **源码**：[`src/tools/arena.ts`](../../src/tools/arena.ts)
> **控时设计**：每基线场景 3 名候选 + 1 名 evaluator，候选实现 5-8 min、evaluator 评估 3-5 min，并行 implement + 串行 evaluate ≈ 10-13 min（远低于 30 min 上限）。**场景 4 为挑战级**：5 名候选 + 1 名 evaluator，规模放大至 5 求解器 × 1000×1000 稀疏系统综合擂台，约 40 min，演示 arena 在多候选、高计算密度下的扩展性。

## 场景一览

| # | 方向 | 场景 | 候选数 | 评估基准 | 胜出指标 | 预计总时长 |
|---|------|------|--------|---------|---------|-----------|
| 1 | 编程 | 三种排序实现基准选最快 | 3 | `eval_command` 跑基准脚本 | 吞吐量（`score_direction: "max"`） | ~10 min |
| 2 | 计算物理 | 三种积分器按能量漂移选最稳 | 3 | `eval_criteria` 能量守恒判定 | 能量漂移（`score_direction: "min"`） | ~12 min |
| 3 | 数学 | 定积分三求积方法精度对决 | 3 | `eval_criteria` 与精确解对比 | 绝对误差（`score_direction: "min"`） | ~12 min |
| 4 | 计算物理（挑战） | 泊松方程五求解器综合擂台 | 5 | `eval_command` 跑收敛基准 | 收敛迭代数（`score_direction: "min"`） | ~40 min |

---

## 前置约束

**v1 边界**：`team_arena`（v1）有以下硬性假设与限制，使用时必须遵守：

1. **候选须有 worktree**：每位 candidate 必须在 `team_add_member` 时设置 `worktree: true`，否则 arena 启动时直接报错退出。
2. **至少 2 名候选**：`candidates` 显式列表或自动推断（除 evaluator 以外的所有非 master 成员）须 ≥ 2。
3. **至少一种评估基准**：`eval_command` 或 `eval_criteria` 必须至少填一个（可同时提供）。
4. **evaluator 不在候选列表中**：evaluator 不能同时是候选成员。
5. **单轮、客观比分**：v1 只做一轮 implement → evaluate；evaluator 输出 `<scoreboard>` 必须为有效 JSON；引擎按 `winner_metric` 的单值比较选胜者，不做多轮演化或 tie-break 协商。
6. **无 signoff、无自动合并、无 loser 清理**：这些是 v1 明确不提供的功能。

**关键假设（Metis 标注）**：evaluator 在自己的 worktree 中运行，但读取 candidates 的 **绝对 worktree 路径**（含未提交的 agent 编辑）。这要求宿主机 **不** sandbox 成员到其自身目录内——evaluator 必须能通过绝对路径访问其他候选人的 worktree 文件。

---

## 场景 1: 三种排序实现基准选最快

### 1.1 场景描述

**背景**：排序是每个程序员都写过的基础操作。不同规模、不同数据分布（随机、已近排序、逆序）下，不同算法（快速排序、归并排序、内省排序）的实际 wall‑clock 吞吐量差异显著。「最快」不是一种理论判断，而是**同一硬件、同一数据、同一基准脚本**下的可测量事实。

**目标**：三名候选（`coder` 角色）各实现一种排序算法；evaluator 运行基准脚本 `benchmark.bun.ts` 对每份实现跑相同的数据集，产出每候选的 `throughput_ops_per_sec` 指标；引擎按 `score_direction: "max"` 选吞吐量最高者。

**成功标准（可机器评判）**：
- 每位候选输出含 `<!-- IMPL: sort -->` 标注，嵌入可加载代码块
- evaluator 输出含 `<scoreboard>{...}</scoreboard>` 标签 JSON 块
- scoreboard 的 `scores` 数组长度为候选人数，每项含 `member`、`score`（number）、`passed`（bool）、`rationale`（string）
- 引擎选出 `score` 最大的候选为胜者

### 1.2 Team 配置

```json
{
  "name": "sort-arena",
  "description": "Three sorting implementations benchmarked: quickSort vs mergeSort vs introSort — winner by max throughput",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing a sorting algorithm. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with an IMPL marker. Your output MUST end with a line exactly formatted: <!-- IMPL: sort -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing a sorting algorithm. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with an IMPL marker. Your output MUST end with a line exactly formatted: <!-- IMPL: sort -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing a sorting algorithm. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with an IMPL marker. Your output MUST end with a line exactly formatted: <!-- IMPL: sort -->"
    },
    {
      "name": "dave",
      "role": "reviewer",
      "worktree": true,
      "prompt": "You are a benchmark evaluator. You run the same objective benchmark command against each candidate's worktree and emit a scoreboard. Run the eval command for EVERY candidate at the absolute worktree path shown. Write the benchmark wrapper script yourself based on the eval command, run it per candidate, and produce the score. Emit EXACTLY one scoreboard block and nothing after it: <scoreboard>{\"scores\":[{\"member\":\"...\",\"score\":<n>,\"metrics\":{...},\"passed\":true|false,\"rationale\":\"...\"}],\"rationale\":\"...\"}</scoreboard>"
    }
  ]
}
```

**Role 选择理由**：前三名候选统一用 `coder`（`oct-junior` agent，可写码+跑测试）在独立 worktree 中实现各自的排序方案；evaluator 用 `reviewer`（只读 agent，专注跑客观基准并产出结构化比分）。

### 1.3 Master 启动调用

```json
{
  "tool": "team_arena",
  "args": {
    "team_id": "sort-arena",
    "task": "Implement an in-place array sorting function `sort(arr: number[]): number[]` in TypeScript. Choose ONE algorithm (quickSort, mergeSort, or introSort) and implement it cleanly in a single ```typescript fenced block. Your function must correctly sort arrays of up to 10^6 numbers. Embed code and end with <!-- IMPL: sort -->.",
    "evaluator": "dave",
    "candidates": ["alice", "bob", "carol"],
    "eval_command": "bun run benchmark.bun.ts",
    "winner_metric": "throughput_ops_per_sec",
    "score_direction": "max",
    "max_eval_retries": 1,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `evaluator: "dave"` —— 不在 `candidates` 列表中，满足「evaluator ≠ candidate」硬约束
- `candidates` 显式列出 3 名 —— 刚好够多方法对比，又不超基线成员数
- `eval_command: "bun run benchmark.bun.ts"` —— 客观基准脚本；evaluator 在每名候选的 worktree 下执行相同命令
- `winner_metric: "throughput_ops_per_sec"` + `score_direction: "max"` —— 吞吐量越高越好
- `max_eval_retries: 1` —— evaluator scoreboard 格式错误或解析失败时给一次重试
- `timeout_ms: 900000`（15 min）—— 候选并行 8 min + 评估串行 3 min，留余量

### 1.4 执行流程（时序）

```
T+0m     master 调用 team_arena (3 candidates + evaluator)
T+0m     implement 阶段: 并行 dispatch alice, bob, carol (各在独立 worktree)
T+0~8m   三名候选各自实现排序算法 → 输出 IMPL 标记 → idle
T+8m     barrier: 所有候选 idle → arena 阶段切换至 evaluate
T+8m     evaluator prompt 构建: 列出候选人名 + 绝对 worktree 路径 + eval_command + winner_metric
T+8m     dispatch evaluator (dave, reviewer)
T+8~11m  dave 为每名候选跑 `bun run benchmark.bun.ts` → 收集吞吐量 → 产出 <scoreboard> JSON
T+11m    引擎解析 scoreboard → selectArenaWinner → 结果交付 master
```

（若候选实现出错导致 `max_errored_members` 超限，arena 整体失败；evaluator scoreboard 解析失败且 attempts < max_eval_retries，evaluator 退回重评。）

### 1.5 评判脚本

> 本场景未绑独立 check 脚本；评判依托 evaluator 产出的 `<scoreboard>` JSON 和引擎的 `selectArenaWinner` 内建逻辑。如需外部验证，读取 `runs/<run_id>/dave.md`（evaluator 输出），提取 scoreboard JSON，交叉核对 `scores[].score` 值为有限数且 `passed` 为 `true`。

### 1.6 评估器 scoreboard 示例

evaluator（dave）在跑完三份基准后应产出如下格式的 scoreboard：

```
<scoreboard>{"scores":[{"member":"alice","score":12450000,"metrics":{"throughput_ops_per_sec":12450000,"algorithm":"quickSort","dataset_size":1000000},"passed":true,"rationale":"quickSort on random 10^6: 12.45M ops/sec, fastest of three"},{"member":"bob","score":8700000,"metrics":{"throughput_ops_per_sec":8700000,"algorithm":"mergeSort","dataset_size":1000000},"passed":true,"rationale":"mergeSort on random 10^6: 8.70M ops/sec, stable but slower due to allocation"},{"member":"carol","score":11200000,"metrics":{"throughput_ops_per_sec":11200000,"algorithm":"introSort","dataset_size":1000000},"passed":true,"rationale":"introSort on random 10^6: 11.20M ops/sec, close second to quickSort"}],"rationale":"Benchmark: bun run benchmark.bun.ts on random 10^6-int array. Alice wins with quickSort at 12.45M ops/sec; introSort is 10% slower; mergeSort trails due to extra allocation. Winner metric: max throughput_ops_per_sec."}</scoreboard>
```

引擎会解析此 JSON，按 `winner_metric: "throughput_ops_per_sec"` 和 `score_direction: "max"` 选出 `alice` 为胜者。

---

## 场景 2: 三种积分器按能量漂移选最稳

### 2.1 场景描述

**背景**：谐振子 `ẍ = -ω²x`（ω=1，初值 `x0=1, v0=0`）是能量守恒系统的标准测试题，理论能量 `E = ½(x² + v²) = 0.5` 恒定。不同数值积分器的能量守恒特性迥异：**显式 Euler** 能量系统性增长、**隐式 Euler** 能量系统性衰减、**Velocity Verlet** 能量在平衡值附近有界振荡。在长时间仿真中，积分器的**能量漂移**（相对漂移 `|E_end - E0|/E0`）是区分稳定性的直接指标。

**目标**：三名候选（`simulator` 角色）各实现一种积分器，跑相同步数报告相对能量漂移；evaluator 按 `eval_criteria` 判定每份实现的漂移是否满足辛格式守恒界，按漂移值打分，引擎选漂移最小者为胜。

**成功标准（可机器评判）**：
- 每位候选输出含 `<!-- DRIFT: <数值> -->` 标注
- evaluator 输出含 `<scoreboard>{...}</scoreboard>` 标签 JSON 块
- scoreboard 的每项 `score` 为相对能量漂移值（number），`passed` 依据 `eval_criteria` 判定
- 引擎按 `score_direction: "min"` 选出漂移最小的候选为胜者

### 2.2 Team 配置

```json
{
  "name": "integrator-arena",
  "description": "Three numerical integrators on harmonic oscillator: Euler vs implicit Euler vs Verlet — winner by min energy drift",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing a numerical integrator for the harmonic oscillator (omega=1, x0=1, v0=0). Run 1000 steps h=0.01, report the relative energy drift |E_end - E0|/E0. Embed runnable code in a ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing a numerical integrator for the harmonic oscillator (omega=1, x0=1, v0=0). Run 1000 steps h=0.01, report the relative energy drift |E_end - E0|/E0. Embed runnable code in a ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing a numerical integrator for the harmonic oscillator (omega=1, x0=1, v0=0). Run 1000 steps h=0.01, report the relative energy drift |E_end - E0|/E0. Embed runnable code in a ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
    },
    {
      "name": "dave",
      "role": "physicist",
      "worktree": true,
      "prompt": "You are a physicist. You evaluate each candidate's integrator by reading their output (the DRIFT marker), re-running their code if possible, and scoring by energy conservation quality. A lower drift is better (min direction). A drift < 1e-3 demonstrates symplectic or near-symplectic behavior (pass). Emit EXACTLY one scoreboard block and nothing after it: <scoreboard>{\"scores\":[{\"member\":\"...\",\"score\":<n>,\"metrics\":{\"drift\":<n>},\"passed\":true|false,\"rationale\":\"...\"}],\"rationale\":\"...\"}</scoreboard>"
    }
  ]
}
```

**Role 选择理由**：前三名候选用 `simulator`（数值模拟专用，`oct-junior` agent）在独立 worktree 中实现各自的积分器；evaluator 用 `physicist`（懂能量守恒/辛格式，能独立复算判定漂移）。

### 2.3 Master 启动调用

```json
{
  "tool": "team_arena",
  "args": {
    "team_id": "integrator-arena",
    "task": "Implement a numerical integrator for the harmonic oscillator (omega=1, x0=1, v0=0) in TypeScript. Choose ONE method: explicit Euler, implicit Euler, or Velocity Verlet. Run 1000 steps with h=0.01 (t_final=10.0). Track total energy E = 0.5*(x^2 + v^2) at every step. Report the relative energy drift |E_end - E0|/E0 where E0 = 0.5. Embed code in a ```typescript fenced block and end with <!-- DRIFT: <value> -->.",
    "evaluator": "dave",
    "candidates": ["alice", "bob", "carol"],
    "eval_criteria": "Score based on relative energy drift. Lower drift is better. Drift < 1e-3 qualifies as symplectic or near-symplectic (pass=true). Drift >= 1e-3 is a non-conservative method (pass=false). Report the drift as the 'score' field for each candidate.",
    "winner_metric": "score",
    "score_direction": "min",
    "max_eval_retries": 1,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `eval_criteria` 而非 `eval_command` —— 物理判定不需要跑外部基准脚本；evaluator 凭候选 DRIFT 标记和物理知识即可打分
- `winner_metric` 用默认值 `"score"`，候选的 `score` 即其能量漂移值
- `score_direction: "min"` —— 漂移越小越好
- `max_eval_retries: 1` —— evaluator 评分失败给一次重试

### 2.4 执行流程（时序）

```
T+0m     master 调用 team_arena (3 candidates + evaluator)
T+0m     implement 阶段: 并行 dispatch alice, bob, carol (各在独立 worktree)
T+0~8m   三名候选各自实现积分器 → 跑 1000 步 → 报告 DRIFT 标记 → idle
T+8m     barrier: 所有候选 idle → arena 阶段切换至 evaluate
T+8m     evaluator prompt 构建: 列出候选人名 + 绝对 worktree 路径 + eval_criteria + winner_metric
T+8m     dispatch evaluator (dave, physicist)
T+8~12m  dave 读每名候选的 DRIFT 值 → 可选复算代码 → 按 eval_criteria 打分 → 产出 <scoreboard> JSON
T+12m    引擎解析 scoreboard → selectArenaWinner → 按 score_direction: "min" 选最小漂移者 → 结果交付 master
```

### 2.5 评判脚本

> 本场景依托 evaluator 产出的 `<scoreboard>` JSON 和引擎内建选优逻辑。外部验证：读取 `runs/<run_id>/dave.md`，提取 scoreboard JSON，交叉核对每名候选的 `score` 值与其 DRIFT 标记一致，且 `score` 最小的候选 `passed` 为 `true`。

### 2.6 评估器 scoreboard 示例

evaluator（dave）在审阅三份实现后应产出如下格式的 scoreboard：

```
<scoreboard>{"scores":[{"member":"alice","score":0.239,"metrics":{"drift":0.239,"method":"explicit Euler","E_final":0.6195},"passed":false,"rationale":"Explicit Euler: energy grows systematically from 0.5 to 0.6195 (drift 0.239 >> 1e-3). Non-conservative, fails symplecticity check."},{"member":"bob","score":0.318,"metrics":{"drift":0.318,"method":"implicit Euler","E_final":0.341},"passed":false,"rationale":"Implicit Euler: energy decays from 0.5 to 0.341 (drift 0.318 >> 1e-3). Non-conservative, fails symplecticity check."},{"member":"carol","score":0.00041,"metrics":{"drift":0.00041,"method":"Velocity Verlet","E_final":0.499795},"passed":true,"rationale":"Velocity Verlet: energy oscillates near 0.5, relative drift 4.1e-4 < 1e-3. Symplectic behavior confirmed. Pass."}],"rationale":"Evaluated drift from <!-- DRIFT --> markers + recomputation. Carol's Velocity Verlet stays within symplectic bound (drift 4.1e-4). Alice and Bob both exceed 1e-3 threshold by 2+ orders of magnitude. Winner metric: min drift."}</scoreboard>
```

引擎会按 `score_direction: "min"` 选出 `carol`（漂移 0.00041）为胜者。

---

## 场景 3: 定积分三求积方法精度对决

### 3.1 场景描述

**背景**：数值求积（numerical quadrature）是计算数学的基石。同一个定积分，用不同求积公式（梯形法、辛普森法、高斯-勒让德法）在同样多的函数求值次数下，精度可以差数个数量级。`∫₀¹ 1/(1+x²) dx = π/4 ≈ 0.7853981633974483` 是一个光滑、无奇点的标准测试积分，不同方法的误差差异直观可测。

**目标**：三名候选（`coder` 角色）各实现一种求积方法，在相同的被积函数和区间上计算积分近似值，报告绝对误差 `|I_num - π/4|`；evaluator 按 `eval_criteria` 判定每份实现是否达到所属方法的期望精度阶，按误差打分，引擎选误差最小者为胜。

**成功标准（可机器评判）**：
- 每位候选输出含 `<!-- QUAD: <数值误差> -->` 标注（绝对误差）
- evaluator 输出含 `<scoreboard>{...}</scoreboard>` 标签 JSON 块
- scoreboard 的每项 `score` 为绝对误差值（number），`passed` 依据 `eval_criteria` 判定
- 引擎按 `score_direction: "min"` 选出误差最小的候选为胜者

### 3.2 Team 配置

```json
{
  "name": "quad-arena",
  "description": "Three quadrature methods on ∫₀¹ 1/(1+x²)dx: trapezoidal vs Simpson vs Gaussian-Legendre — winner by min absolute error",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing numerical quadrature. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a QUAD marker showing absolute error vs π/4. Your output MUST end with a line exactly formatted: <!-- QUAD: <absolute_error> -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing numerical quadrature. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a QUAD marker showing absolute error vs π/4. Your output MUST end with a line exactly formatted: <!-- QUAD: <absolute_error> -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing numerical quadrature. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a QUAD marker showing absolute error vs π/4. Your output MUST end with a line exactly formatted: <!-- QUAD: <absolute_error> -->"
    },
    {
      "name": "dave",
      "role": "mathematician",
      "worktree": true,
      "prompt": "You are a mathematician. You evaluate each candidate's quadrature implementation by reading their absolute error (QUAD marker), optionally recomputing the integral, and scoring by accuracy. A lower error is better (min direction). An error < 1e-5 demonstrates a well-implemented method (pass). Emit EXACTLY one scoreboard block and nothing after it: <scoreboard>{\"scores\":[{\"member\":\"...\",\"score\":<n>,\"metrics\":{\"error\":<n>},\"passed\":true|false,\"rationale\":\"...\"}],\"rationale\":\"...\"}</scoreboard>"
    }
  ]
}
```

**Role 选择理由**：前三名候选统一用 `coder`（`oct-junior` agent，可写码+跑测试）在独立 worktree 中实现各自的求积方法；evaluator 用 `mathematician`（懂数值分析，能识辨不同方法的理论误差阶）。

### 3.3 Master 启动调用

```json
{
  "tool": "team_arena",
  "args": {
    "team_id": "quad-arena",
    "task": "Implement a numerical quadrature method to approximate ∫₀¹ 1/(1+x²) dx in TypeScript. Choose ONE method: composite trapezoidal rule (n=100 subintervals), composite Simpson's rule (n=100 subintervals), or 5-point Gaussian-Legendre quadrature on [-1,1] mapped to [0,1]. The exact value is π/4 ≈ 0.7853981633974483. Report the absolute error |I_num - π/4|. Embed code in a ```typescript fenced block and end with <!-- QUAD: <absolute_error> -->.",
    "evaluator": "dave",
    "candidates": ["alice", "bob", "carol"],
    "eval_criteria": "Score based on absolute error |I_num - π/4|. Lower error is better. Error < 1e-5 demonstrates a well-implemented quadrature method (pass=true). Error >= 1e-5 or NaN => pass=false. Report the error as the 'score' field for each candidate.",
    "winner_metric": "score",
    "score_direction": "min",
    "max_eval_retries": 1,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `eval_criteria` 而非 `eval_command` —— 评估只需核对候选报告的误差是否与所声称的方法的期望精度阶一致，不需跑外部基准
- `winner_metric` 用默认值 `"score"`，候选的 `score` 即其绝对误差
- `score_direction: "min"` —— 误差越小越好
- `max_eval_retries: 1` —— evaluator 评分失败给一次重试

### 3.4 执行流程（时序）

```
T+0m     master 调用 team_arena (3 candidates + evaluator)
T+0m     implement 阶段: 并行 dispatch alice, bob, carol (各在独立 worktree)
T+0~8m   三名候选各自实现求积方法 → 算积分 → 报告 QUAD 标记 → idle
T+8m     barrier: 所有候选 idle → arena 阶段切换至 evaluate
T+8m     evaluator prompt 构建: 列出候选人名 + 绝对 worktree 路径 + eval_criteria + winner_metric
T+8m     dispatch evaluator (dave, mathematician)
T+8~12m  dave 读每名候选的 QUAD 误差 → 可选复算代码 → 按 eval_criteria 打分 → 产出 <scoreboard> JSON
T+12m    引擎解析 scoreboard → selectArenaWinner → 按 score_direction: "min" 选最小误差者 → 结果交付 master
```

### 3.5 评判脚本

> 本场景依托 evaluator 产出的 `<scoreboard>` JSON 和引擎内建选优逻辑。外部验证：读取 `runs/<run_id>/dave.md`，提取 scoreboard JSON，交叉核对每名候选的 `score` 值与其 QUAD 标记一致，且 `score` 最小的候选 `passed` 为 `true`。

### 3.6 评估器 scoreboard 示例

evaluator（dave）在审阅三份实现后应产出如下格式的 scoreboard：

```
<scoreboard>{"scores":[{"member":"alice","score":0.000785,"metrics":{"error":0.000785,"method":"composite trapezoidal (n=100)","exact":0.785398}，"passed":false,"rationale":"Trapezoidal rule: O(h²) convergence, 100 subintervals gives error ~7.85e-4 >> 1e-5. Fails accuracy threshold."},{"member":"bob","score":6.5e-8,"metrics":{"error":6.5e-8,"method":"composite Simpson's (n=100)","exact":0.785398},"passed":true,"rationale":"Simpson's rule: O(h⁴) convergence on this smooth integrand, 100 subintervals yields error ~6.5e-8 < 1e-5. Pass."},{"member":"carol","score":1.1e-16,"metrics":{"error":1.1e-16,"method":"5-point Gaussian-Legendre","exact":0.785398},"passed":true,"rationale":"Gaussian-Legendre (n=5): exact for polynomials up to degree 9, so this smooth integrand is integrated near machine precision. Error ~1.1e-16 < 1e-5. Pass."}],"rationale":"Evaluated absolute error from <!-- QUAD --> markers. Carol's Gaussian-Legendre achieves machine-precision accuracy (1.1e-16); Bob's Simpson's is 8 orders of magnitude worse but still below 1e-5; Alice's trapezoidal is 4 orders above threshold. Winner metric: min error."}</scoreboard>
```

引擎会按 `score_direction: "min"` 选出 `carol`（误差 1.1e-16）为胜者。

---

## 场景 4: 泊松方程五求解器综合擂台（挑战级）

> **挑战级说明**：本场景突破基线约束（3 候选 / ≤4 成员 / ≤30 min），使用 **5 名候选 + 1 名 evaluator**，各候选在独立 worktree 中实现不同的线性系统求解器，evaluator 运行统一收敛基准脚本，按收敛迭代数打分。约 40 min，演示 arena 在多候选、高计算密度下的扩展性。

### 4.1 场景描述

**背景**：二维泊松方程 `∇²u = -2π²sin(πx)sin(πy)`（精确解 `u = sin(πx)sin(πy)`）在 `(N+1)×(N+1)` 网格上用标准五点差分离散化，得到 `N² × N²` 稀疏线性系统 `Au = f`。求解这类大规模稀疏系统是科学计算的核心：不同迭代法在收敛速度、每步开销、实现复杂度上差异巨大。雅可比迭代收敛极慢，共轭梯度显著加速，多重网格近乎最优。

**目标**：五名候选（`simulator` 角色）各实现一种迭代求解器，在 `N=100`（10000×10000 稀疏矩阵）的统一问题上跑至残差 `||r||₂/||b||₂ < 1e-6`；evaluator 运行收敛基准脚本 `bun run convergence.ts`，对每名候选的求解器测迭代数，按迭代数打分，引擎选迭代数最少者为胜。

**成功标准（可机器评判）**：
- 每位候选输出含 `<!-- CONV: <迭代数> -->` 标注
- evaluator 输出含 `<scoreboard>{...}</scoreboard>` 标签 JSON 块
- scoreboard 的每项 `score` 为收敛所需迭代数（number），`passed` 依据 `eval_criteria` 判定
- 引擎按 `score_direction: "min"` 选出迭代数最少的候选为胜者

### 4.2 Team 配置

```json
{
  "name": "poisson-arena",
  "description": "Five iterative solvers for the 2D Poisson equation (N=100 grid): Jacobi vs Gauss-Seidel vs SOR vs Conjugate Gradient vs Multigrid V-cycle — winner by min iterations to convergence",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil. Your output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil. Your output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil. Your output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "dave",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil. Your output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "erin",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil. Your output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "frank",
      "role": "physicist",
      "worktree": true,
      "prompt": "You are a physicist. You evaluate each candidate's iterative Poisson solver by running the same convergence benchmark script (bun run convergence.ts) in each candidate's worktree, measuring the number of iterations to reach ||r||₂/||b||₂ < 1e-6 on the N=100 Poisson problem. A lower iteration count is better (min direction). A count > 100,000 is considered non-convergent (pass=false). Emit EXACTLY one scoreboard block and nothing after it: <scoreboard>{\"scores\":[{\"member\":\"...\",\"score\":<n>,\"metrics\":{\"iterations\":<n>},\"passed\":true|false,\"rationale\":\"...\"}],\"rationale\":\"...\"}</scoreboard>"
    }
  ]
}
```

**Role 选择理由**：五名候选统一用 `simulator`（数值模拟专用，`oct-junior` agent）在独立 worktree 中实现各自的迭代求解器；evaluator 用 `physicist`（懂 PDE 数值方法，能独立判定收敛性），注意 6 名成员（5 候选 + 1 evaluator）已达 arena v1 的推荐上限。

### 4.3 Master 启动调用

```json
{
  "tool": "team_arena",
  "args": {
    "team_id": "poisson-arena",
    "task": "Implement an iterative linear solver for the 2D Poisson equation -∇²u = f on the unit square (Dirichlet BC u=0 on boundary) using 5-point finite-difference stencil on an N=100 grid (interior grid N²=10000 unknowns). Exact solution: u = sin(πx)sin(πy), so f = 2π²sin(πx)sin(πy). Choose ONE method: Jacobi iteration, Gauss-Seidel (lexicographic), SOR (optimal ω≈1.9), Conjugate Gradient, or Multigrid V-cycle (Jacobi smoother + full-weighting restriction + bilinear prolongation, 2 pre/2 post smoothing). Run to convergence: ||r||₂/||b||₂ < 1e-6. Report the number of iterations to convergence. Embed code in a ```typescript fenced block and end with <!-- CONV: <iteration_count> -->.",
    "evaluator": "frank",
    "candidates": ["alice", "bob", "carol", "dave", "erin"],
    "eval_command": "bun run convergence.ts",
    "eval_criteria": "Score based on number of iterations to reach ||r||₂/||b||₂ < 1e-6 on the N=100 Poisson problem. Fewer iterations is better (min direction). Iterations > 100,000 => non-convergent (pass=false). Report the iteration count as the 'score' field for each candidate.",
    "winner_metric": "iterations",
    "score_direction": "min",
    "max_eval_retries": 1,
    "timeout_ms": 2400000
  }
}
```

**参数选择**：
- `evaluator: "frank"` —— 不在 `candidates` 列表中，满足「evaluator ≠ candidate」硬约束
- `candidates` 显式列出 5 名 —— 刚好覆盖 5 种主流迭代法的代表性对比
- `eval_command` 与 `eval_criteria` **同时提供** —— 基准脚本确保一致度量，criteria 做阈值判定（迭代 > 100k 视作发散）
- `winner_metric: "iterations"` + `score_direction: "min"` —— 迭代数越少越好
- `max_eval_retries: 1` —— evaluator 评分失败给一次重试
- `timeout_ms: 2400000`（40 min）—— 5 名候选并行 10 min + 评估串行 20 min（每候选的 N=100 收敛需数次迭代，耗时不一），留足余量

### 4.4 执行流程（时序）

```
T+0m     master 调用 team_arena (5 candidates + evaluator)
T+0m     implement 阶段: 并行 dispatch alice, bob, carol, dave, erin (各在独立 worktree)
T+0~10m  五名候选各自实现迭代求解器 → 跑收敛 → 报告 CONV 标记 → idle
T+10m    barrier: 所有候选 idle → arena 阶段切换至 evaluate
T+10m    evaluator prompt 构建: 列出候选人名 + 绝对 worktree 路径 + eval_command + eval_criteria + winner_metric
T+10m    dispatch evaluator (frank, physicist)
T+10~30m frank 为每名候选跑 `bun run convergence.ts` → 收集各求解器迭代数 → 产出 <scoreboard> JSON
T+30m    引擎解析 scoreboard → selectArenaWinner → 按 score_direction: "min" 选最少迭代数者 → 结果交付 master
```

（5 候选并行实现，单一 evaluator 串行评估各候选 worktree；N=100 的 Poisson 问题上 Jacobi ≈ 6000 迭代、Gauss-Seidel ≈ 3000 迭代、SOR(ω=1.9) ≈ 300 迭代、CG ≈ 300 迭代、Multigrid V(2,2) ≈ 10 迭代——收敛速度差距巨大，arena 评分的区分度极高。）

### 4.5 评判脚本

> 本场景依托 evaluator 产出的 `<scoreboard>` JSON 和引擎内建选优逻辑。外部验证：读取 `runs/<run_id>/frank.md`，提取 scoreboard JSON，交叉核对每名候选的迭代数与 CONV 标记一致，物理预期 Multigrid 胜出（≤20 迭代）且 Jacobi 垫底（≥5000 迭代）。

### 4.6 评估器 scoreboard 示例

evaluator（frank）在跑完五份基准后应产出如下格式的 scoreboard：

```
<scoreboard>{"scores":[{"member":"alice","score":6120,"metrics":{"iterations":6120,"method":"Jacobi","residual":9.87e-7},"passed":true,"rationale":"Jacobi: slow convergence (~6k iterations), typical for simple relaxation on 100x100 grid. < 100k => pass."},{"member":"bob","score":2980,"metrics":{"iterations":2980,"method":"Gauss-Seidel","residual":9.92e-7},"passed":true,"rationale":"Gauss-Seidel: ~2x faster than Jacobi due to immediate use of updated values, ~3k iterations on 100x100. Pass."},{"member":"carol","score":312,"metrics":{"iterations":312,"method":"SOR (ω=1.9)","residual":9.65e-7},"passed":true,"rationale":"SOR with near-optimal ω≈1.9: convergence accelerated ~10x vs GS, ~300 iterations. Excellent for this problem class. Pass."},{"member":"dave","score":295,"metrics":{"iterations":295,"method":"Conjugate Gradient","residual":9.88e-7},"passed":true,"rationale":"CG: Krylov-subspace optimal, ~300 iterations on 100x100 SPD system. Comparable to optimal SOR. Pass."},{"member":"erin","score":9,"metrics":{"iterations":9,"method":"Multigrid V(2,2)","residual":8.73e-7},"passed":true,"rationale":"Multigrid V-cycle (2 pre/2 post smoothing, full-weighting restriction, bilinear prolongation): mesh-independent convergence! Only 9 iterations to reach sub-1e-6 residual. Near-optimal O(N) solver. Pass."}],"rationale":"Convergence benchmark via bun run convergence.ts on N=100 Poisson problem (10000 unknowns). Erin's Multigrid dominates at 9 iterations (O(N) optimal); SOR/CG compete at ~300; Gauss-Seidel trails at ~3k; Jacobi bottom at ~6k. Winner metric: min iterations."}</scoreboard>
```

引擎会按 `score_direction: "min"` 选出 `erin`（9 次迭代）为胜者——多重网格的近乎最优收敛在 10000 未知数的系统上展现出数量级优势。

---

## 验收清单

- [ ] 每个 team 配置中所有 candidate 均设置 `worktree: true`（arena 硬性要求）
- [ ] `evaluator` 不在 `candidates` 列表中（满足「evaluator ≠ candidate」约束）
- [ ] 每个 master 调用参数符合 `team_arena` schema（`team_id`, `task`, `evaluator`, `candidates`, `eval_command` 或 `eval_criteria`, `winner_metric`, `score_direction` 等）
- [ ] 至少一种评估基准（`eval_command` 或 `eval_criteria`）已提供
- [ ] `score_direction` 与场景目标一致（场景 1: `"max"` 吞吐量；场景 2: `"min"` 漂移；场景 3: `"min"` 误差；场景 4: `"min"` 迭代数）
- [ ] 候选 prompt 与 evaluator 的 scoreboard 字段标记对齐（场景 1: `IMPL` 标记；场景 2: `DRIFT` 标记；场景 3: `QUAD` 标记；场景 4: `CONV` 标记；evaluator 统一发 `<scoreboard>` JSON）
- [ ] 场景 1-3 总时长 ≤ 15 min（远低于 30 min 上限）；场景 4 为挑战级约 40 min（5 候选、N=100 大型稀疏系统）

---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成完整闭环。arena 模式评判读取 **evaluator** 成员的 .md 中的 `<scoreboard>` JSON + 引擎 `selectArenaWinner` 内建选优逻辑。

### 场景 1: 三种排序基准选最快（编程）

```text
执行 demos/11-team-arena/README.md「场景 1」的完整闭环并自动评分。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（3 名候选 coder + 1 名 evaluator reviewer，每名候选 worktree: true，evaluator 也设 worktree: true）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_arena JSON 启动擂台（implement → evaluate，eval_command 跑基准脚本）
4. team_results 轮询至 master 收到汇总（所有候选 idle 后 evaluator 跑基准、出 scoreboard；引擎自动选胜者）
5. 定位 <run_dir>（含 evaluator dave.md）
6. 读取 dave.md，提取 <scoreboard> JSON，查看胜者与各候选得分

成功标准：evaluator 产出合法 <scoreboard> JSON；引擎按 throughput_ops_per_sec max 选出吞吐最高者。至少 2 名候选 passed=true。
```

### 场景 2: 三种积分器按能量漂移选最稳（计算物理）

```text
执行 demos/11-team-arena/README.md「场景 2」的完整闭环并自动评分。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队（3 名候选 simulator + 1 名 evaluator physicist，每名候选 worktree: true，evaluator 也设 worktree: true）
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_arena JSON 启动擂台（implement → evaluate，eval_criteria 能量守恒判定）
4. team_results 轮询至 master 收到汇总（所有候选 idle 后 evaluator 审阅 DRIFT、出 scoreboard；引擎自动选胜者）
5. 定位 <run_dir>（含 evaluator dave.md）
6. 读取 dave.md，提取 <scoreboard> JSON，查看胜者与各候选漂移值

成功标准：evaluator 产出合法 <scoreboard> JSON；引擎按 score min 选出漂移最小的辛格式积分器。Velocity Verlet 候选 passed=true 且 score < 1e-3。
```

### 场景 3: 定积分三求积方法精度对决（数学）

```text
执行 demos/11-team-arena/README.md「场景 3」的完整闭环并自动评分。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队（3 名候选 coder + 1 名 evaluator mathematician，每名候选 worktree: true，evaluator 也设 worktree: true）
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_arena JSON 启动擂台（implement → evaluate，eval_criteria 精度判定）
4. team_results 轮询至 master 收到汇总（所有候选 idle 后 evaluator 审阅 QUAD、出 scoreboard；引擎自动选胜者）
5. 定位 <run_dir>（含 evaluator dave.md）
6. 读取 dave.md，提取 <scoreboard> JSON，查看胜者与各候选误差

成功标准：evaluator 产出合法 <scoreboard> JSON；引擎按 score min 选出误差最小的求积方法。Gaussian-Legendre 候选 passed=true 且 score < 1e-10（高斯求积在光滑被积函数上应达机器精度）。
```

### 场景 4: 泊松方程五求解器综合擂台（挑战级·计算物理）

```text
执行 demos/11-team-arena/README.md「场景 4」的完整闭环并自动评分（挑战级：5 名候选 + 1 名 evaluator，N=100 大型稀疏系统）。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（5 名候选 simulator + 1 名 evaluator physicist，每名候选 worktree: true，evaluator 也设 worktree: true）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_arena JSON 启动擂台（implement → evaluate，eval_command + eval_criteria 双基准）
4. team_results 轮询至 master 收到汇总（所有候选 idle 后 evaluator 跑收敛基准、出 scoreboard；引擎自动选胜者）
5. 定位 <run_dir>（含 evaluator frank.md）
6. 读取 frank.md，提取 <scoreboard> JSON，查看胜者与各候选迭代数

成功标准：evaluator 产出合法 <scoreboard> JSON；引擎按 iterations min 选出收敛最快的求解器。Multigrid V 循环候选应 ≤20 迭代、Jacobi 应 ≥5000 迭代（验证收敛速度的数量级区分度）。至少 3 名候选 passed=true。
```
