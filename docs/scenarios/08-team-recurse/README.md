# team_recurse 编排场景设计

> **模式**：`team_recurse` — 层次化递归分解：根任务被分解为子任务（子任务可继续分解至 `max_depth`），子任务结果自底向上聚合，最终解出根任务。使用共享任务列表 + blockedBy DAG 实现分层聚合。
> **源码**：[`src/tools/recurse.ts`](../../../src/tools/recurse.ts)
> **控时设计**：`max_depth=2`、`max_subtasks=3`，根 → 3 个叶节点（成员并行认领），每叶 ≤ 8 min；decomposer 汇总 ≈ 最慢叶 + 聚合 ≈ 10-12 min（远低于 30 min 上限）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role | key param | 预计总时长 |
|---|------|------|--------|------|-----------|-----------|
| 1 | 数学 | 错排数 D_n 三法推导聚合 | 3 | `mathematician` | `max_depth=2, max_subtasks=3` | ~12 min |
| 2 | 计算物理 | 阻尼摆小角分段模型聚合 | 3 | `simulator` | `max_depth=2, max_subtasks=3` | ~12 min |
| 3 | 编程 | 单文件 Markdown→HTML 模块化构建 | 3 | `coder` | `max_depth=2, max_subtasks=3` | ~10 min |
| 4 | 数学（挑战级） | Vandermonde 恒等式多层证明 | 6 | `mathematician` | `max_depth=4, max_subtasks=4` | ~50 min |

---

## 场景 1: 错排数 D_n 三法推导聚合

### 1.1 场景描述

**背景**：错排数 D_n（n 个元素全不在原位的排列数）有三条经典独立推导路径，结论须收敛到同一闭式。递归分解天然适合：把「推导 D_n」拆成 3 个独立证明子任务，再由 decomposer 自底向上聚合。

**目标**：decomposer 把根任务拆为 3 个子任务——容斥原理、递推 D_n=(n-1)(D_{n-1}+D_{n-2})、指数型母函数——3 个成员各认领一法独立推导 D_4，最后 decomposer 聚合闭式 D_n = n!·Σ_{k=0}^{n} (-1)^k/k! 与数值 D_4 = 9。

**成功标准（可机器评判）**：
- decomposer（`alice`）输出含 `<!-- D4_FINAL: 9 -->`（三法聚合后的闭式数值）
- 其余成员中至少 1 人输出含 `<!-- D4_VALUE: 9 -->`（各自方法算出的 D_4）

### 1.2 Team 配置

```json
{
  "name": "derangement-derive",
  "description": "Derive D_n (derangements) via 3 independent proof methods, aggregated bottom-up",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "ROOT TASK: Derive the formula for D_n (the number of derangements of n elements) and aggregate across proof methods.\n\nYou are the DECOMPOSER.\n  STEP 0 (CRITICAL): Claim the root task FIRST (team_task_update status=\"claimed\" on the root). Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator only parses output from members holding a claimed/in_progress task.\n  STEP 1: Decompose the root into 3 subtasks (emit a <decompose> block — the orchestrator creates the subtasks automatically; do NOT call team_task_create): (a) inclusion-exclusion proof, (b) recurrence D_n = (n-1)(D_{n-1}+D_{n-2}) with D_0=1, D_1=0, (c) exponential generating function e^{-x}/(1-x). After the orchestrator creates the subtasks, claim one (e.g. (a)) for yourself; let teammates claim the others. Coordinate via team_send_message.\n\nFor YOUR subtask (a): derive D_n = n! * sum_{k=0}^{n} (-1)^k/k! and compute D_4 = 9 explicitly (D_4 = 24*(1 - 1 + 1/2 - 1/6 + 1/24) = 9). End your subtask writeup with a line exactly formatted: <!-- D4_VALUE: 9 -->\n\nAfter all 3 subtasks report back, AGGREGATE: confirm all three methods yield the same closed form and the same D_4, then write the unified result. Your final aggregated report MUST end with a line exactly formatted: <!-- D4_FINAL: 9 -->\n\nCOMPLETION PROTOCOL for YOUR subtask (a):\n  STEP 1: team_task_update(status=\"claimed\") to acquire your subtask.\n  STEP 2: Solve it, emit the D4_VALUE marker, then STOP (go idle). Do NOT call team_task_update(status=\"completed\") — the orchestrator finalizes your task automatically when you go idle.\nFor aggregation: poll team_task_list periodically; once all three subtasks show status=completed, claim the root task (team_task_update status=\"claimed\"), read each subtask result via team_task_get, aggregate, then emit D4_FINAL and go idle (do NOT mark root completed — the orchestrator finalizes it)."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team derivation of D_n (derangements of n elements). You are a solver member. Watch the shared task list (team_task_list) for subtask (b): the RECURRENCE D_n = (n-1)(D_{n-1}+D_{n-2}) with base cases D_0=1, D_1=0. COMPLETION PROTOCOL:\n  STEP 1 (CLAIM): Call team_task_update(status=\"claimed\") on subtask (b) to acquire it.\n  STEP 2 (SOLVE): Unfold the recurrence, compute D_2=1, D_3=2, D_4=9 step by step, verify it matches the closed form, emit the D4_VALUE marker, then STOP (go idle). Do NOT call team_task_update(status=\"completed\") — the orchestrator finalizes your task automatically when you go idle. Coordinate with the decomposer via team_send_message. Your report MUST end with a line exactly formatted: <!-- D4_VALUE: 9 -->"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team derivation of D_n (derangements of n elements). You are a solver member. Watch the shared task list (team_task_list) for subtask (c): the EXPONENTIAL GENERATING FUNCTION G(x) = sum_{n>=0} D_n x^n/n! = e^{-x}/(1-x). COMPLETION PROTOCOL:\n  STEP 1 (CLAIM): Call team_task_update(status=\"claimed\") on subtask (c) to acquire it.\n  STEP 2 (SOLVE): Extract coefficients D_n = n! * [x^n] e^{-x}/(1-x), evaluate at n=4 to get D_4 = 9, confirm equivalence to the closed form, emit the D4_VALUE marker, then STOP (go idle). Do NOT call team_task_update(status=\"completed\") — the orchestrator finalizes your task automatically when you go idle. Coordinate with the decomposer via team_send_message. Your report MUST end with a line exactly formatted: <!-- D4_VALUE: 9 -->"
    }
  ]
}
```

**Role 选择理由**：`mathematician` 用 `oct-junior` agent，可推导、算数值、写证明——完全匹配本场景。`alice` 兼任 decomposer（既是合法成员，又承担聚合）。

### 1.3 Master 启动调用

```json
{
  "tool": "team_recurse",
  "args": {
    "team_id": "derangement-derive",
    "task": "Derive the formula for D_n (number of derangements of n elements). Decompose into proof approaches, then aggregate.",
    "decomposer": "alice",
    "max_depth": 2,
    "max_subtasks": 3,
    "timeout_ms": 900000,
    "max_retries": 0
  }
}
```

**参数选择**：
- `decomposer: alice` — 必须是成员名，不能是 `master`；选 `alice`（容斥法天然导出闭式，便于聚合）
- `max_depth: 2` — 根（深度 0）→ 3 个叶证明（深度 1），叶节点直接产出结论，无需再拆
- `max_subtasks: 3` — 恰好对应三条独立证明路径，控制扇出
- `timeout_ms: 900000`（15 min）— 给足余量，正常 ~8 min 完成
- `max_retries: 0` — 推导任务确定性高，失败即整体失败

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_recurse；root task 入共享任务列表（depth=0）
T+0m    仅 dispatch decomposer (alice)，附带递归契约
T+0~1m  alice 分解 root → 创建 3 个 subtask（blockedBy DAG）
T+1m    bob / carol 被尾部的 re-prompt 唤醒，认领各自 subtask
T+1~7m  三成员并行推导：alice=容斥, bob=递推, carol=母函数
T+7m    三叶 subtask 完成、回填结果 → 触发 root 聚合
T+8m    alice 聚合三法 → 闭式 D_n 与 D_4=9，写 D4_FINAL
T+9m    运行: bun check-math-derangement.ts <run_dir>
```

### 1.5 评判脚本

[`check-math-derangement.ts`](./check-math-derangement.ts)

- **加载**：读取 `<run_dir>/` 下全部 `*.md`（recurse 输出散落在任务列表 + 各成员报告）
- **提取**：正则 `<!-- D4_FINAL:\s*(\d+)\s*-->` 与 `<!-- D4_VALUE:\s*(\d+)\s*-->`
- **断言**：
  1. decomposer（`alice.md`）存在且含 `D4_FINAL: 9`
  2. 其余成员中至少 1 人含 `D4_VALUE: 9`（证明至少一条独立路径算出了同一数值）

---

## 场景 2: 阻尼摆小角分段模型聚合

### 2.1 场景描述

**背景**：阻尼摆方程 θ̈ + γθ̇ + (g/L)sin(θ) 在小角度下可分层近似：无阻尼简谐解 → 线性阻尼包络 → 非线性 sin 修正。三部分可独立求解，再由 decomposer 聚合为分段有效模型。

**目标**：decomposer 把根任务拆为 3 子任务——无阻尼 SHO 解 θ₀cos(ωt)、线性阻尼包络 e^{-(γ/2)t}、非线性 sin 修正（单摄动项）——成员各认领其一，最后聚合为「γ 小、θ 小」时分段有效的模型。

**成功标准（可机器评判）**：
- decomposer（`alice`）输出含 `<!-- MODEL_VALID: true -->`（聚合模型在有效域内自洽）
- 其余成员中至少 1 人输出含 `<!-- ENVELOPE_DECAY: <数值> -->`，数值 = γ/2 = 0.1（γ=0.2 时阻尼包络 e^{-(γ/2)t} 的衰减常数）

### 2.2 Team 配置

```json
{
  "name": "pendulum-damped",
  "description": "Damped pendulum small-angle model: decompose into SHO + linear damping + nonlinear correction, then aggregate",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "ROOT TASK: Model a damped pendulum d2theta/dt2 + gamma*dtheta/dt + (g/L)*sin(theta) for small angles. Decompose into the undamped solution, the linear-damping perturbation, and the nonlinear correction, then aggregate.\n\nYou are the DECOMPOSER.\n  STEP 0 (CRITICAL): Claim the root task FIRST (team_task_update status=\"claimed\" on the root). Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator only parses output from members holding a claimed/in_progress task.\n  STEP 1: Decompose the root into 3 subtasks (emit a <decompose> block — the orchestrator creates the subtasks automatically; do NOT call team_task_create): (a) undamped SHO solution theta0*cos(w*t) with w=sqrt(g/L), (b) linear-damping envelope exp(-(gamma/2)*t), (c) nonlinear sin-correction via one perturbation term (sin(theta) ~ theta - theta^3/6). After the orchestrator creates the subtasks, claim one (e.g. (a)) for yourself; let teammates claim the others. Coordinate via team_send_message.\n\nFor YOUR subtask (a): set g/L=1 (so w=1), gamma=0.2, theta0 small; give the undamped solution theta(t) = theta0*cos(t) and note its energy. End your subtask writeup with a one-line summary.\n\nAfter all 3 subtasks report back, AGGREGATE a piecewise model valid for gamma small and theta small: theta(t) ~ theta0*exp(-(gamma/2)*t)*cos(w_d*t) with the nonlinear correction noted. Confirm internal consistency. Your final aggregated report MUST end with a line exactly formatted: <!-- MODEL_VALID: true -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "ROOT TASK context: recursive team modeling of a damped pendulum. You are a solver member. Watch the shared task list (team_task_list) for subtask (b): the LINEAR-DAMPING envelope of the underdamped small-angle oscillator theta'' + gamma*theta' + w0^2*theta = 0. When claimable, claim it (team_task_update) and solve: for gamma=0.2 and w0=1, the underdamped envelope is exp(-(gamma/2)*t); identify the decay constant gamma/2 = 0.1 and give the e-folding behavior. Coordinate with the decomposer via team_send_message. Your report MUST end with a line exactly formatted: <!-- ENVELOPE_DECAY: 0.1 -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "ROOT TASK context: recursive team modeling of a damped pendulum. You are a solver member. Watch the shared task list (team_task_list) for subtask (c): the NONLINEAR sin-correction. When claimable, claim it (team_task_update) and solve: expand sin(theta) = theta - theta^3/6 + ..., derive the leading (cubic) correction to the frequency (amplitude-dependent softening, domega ~ -theta0^2/16 for w0=1), and state the small-angle validity bound. Coordinate with the decomposer via team_send_message. Your report MUST end with a one-line summary of the correction magnitude."
    }
  ]
}
```

**Role 选择理由**：`simulator` 专为数值/解析模拟设计，符合物理建模场景。`alice` 兼任 decomposer。

### 2.3 Master 启动调用

```json
{
  "tool": "team_recurse",
  "args": {
    "team_id": "pendulum-damped",
    "task": "Model a damped pendulum d2theta/dt2 + gamma*dtheta/dt + (g/L)*sin(theta) for small angles. Decompose into the undamped solution, the linear-damping perturbation, and the nonlinear correction.",
    "decomposer": "alice",
    "max_depth": 2,
    "max_subtasks": 3,
    "timeout_ms": 900000,
    "max_retries": 0
  }
}
```

**参数选择**：
- `decomposer: alice` — 无阻尼 SHO 是聚合模型的主干（其余两项是它的扰动），适合做聚合锚点
- `max_depth: 2` — 根 → 3 个独立建模子任务，叶节点直接产出解析式
- `max_subtasks: 3` — 对应无阻尼 / 线性阻尼 / 非线性修正三段
- `timeout_ms: 900000`（15 min）— 解析推导 + 聚合的充裕上限

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_recurse；root task 入共享任务列表（depth=0）
T+0m    仅 dispatch decomposer (alice)，附带递归契约
T+0~1m  alice 分解 root → 创建 3 个 subtask（blockedBy DAG）
T+1m    bob / carol 被 re-prompt 唤醒，认领各自 subtask
T+1~7m  三成员并行建模：alice=无阻尼 SHO, bob=包络, carol=修正
T+7m    三叶 subtask 完成、回填 → 触发 root 聚合
T+8m    alice 聚合分段模型，校验有效域，写 MODEL_VALID
T+9m    运行: bun check-physics-damped-pendulum.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-damped-pendulum.ts`](./check-physics-damped-pendulum.ts)

- **加载**：读取 `<run_dir>/` 下全部 `*.md`
- **提取**：正则 `<!-- MODEL_VALID:\s*(true|false)\s*-->` 与 `<!-- ENVELOPE_DECAY:\s*([\d.eE+-]+)\s*-->`
- **断言**：
  1. decomposer（`alice.md`）含 `MODEL_VALID: true`
  2. 其余成员中至少 1 人含 `ENVELOPE_DECAY`，数值 ≈ 0.1（±0.01，即 γ/2 = 0.1）

---

## 场景 3: 单文件 Markdown→HTML 模块化构建

### 3.1 场景描述

**背景**：单文件 Markdown→HTML 转换器可按解析层级模块化：块级解析（标题 + 列表）、行内解析（粗体 + 行内代码）、测试用例。三模块天然有依赖（测试依赖前两者），递归分解配合 blockedBy DAG 能正确排序。

**目标**：decomposer 把根任务拆为 3 子任务——块级解析器（headings + lists）、行内解析器（bold + code）、测试用例——成员各认领其一，最后聚合出一个可运行的 `convert(markdown: string): string`。

**成功标准（可机器评判）**：
- decomposer（`alice`）输出含 `<!-- CONVERTS: true -->`（聚合出可用 convert）
- 测试成员（`carol`）输出含 `<!-- PASS_COUNT: <n> -->`，n ≥ 5（覆盖 5 项特性且全部通过）
- 独立从任一成员报告中提取 `convert` 函数并执行：`convert("# Hi")` 含 `<h1`；`convert("**bold**")` 含 `<strong>` 或 `<b>`

### 3.2 Team 配置

```json
{
  "name": "md-converter",
  "description": "Single-file Markdown-to-HTML converter: decompose into block parser + inline parser + tests, then aggregate",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "ROOT TASK: Build a single-file Markdown-to-HTML converter supporting headings (#, ##, ###), bold (**), inline code (`), and unordered lists (-). Decompose into modules.\n\nYou are the DECOMPOSER.\n  STEP 0 (CRITICAL): Claim the root task FIRST (team_task_update status=\"claimed\" on the root). Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator only parses output from members holding a claimed/in_progress task.\n  STEP 1: Decompose the root into 3 subtasks (emit a <decompose> block — the orchestrator creates the subtasks automatically; do NOT call team_task_create): (a) block-parser handling headings (#/##/### -> <h1>/<h2>/<h3>) and unordered lists (- -> <ul><li>), (b) inline-parser handling bold (** -> <strong>) and inline code (` -> <code>), (c) test-cases that assemble a convert(markdown: string): string and assert all features. After the orchestrator creates the subtasks, claim one (e.g. (a)) for yourself; let teammates claim the others. Coordinate via team_send_message.\n\nFor YOUR subtask (a): implement parseBlocks(markdown: string): string producing the block-level HTML (headings + lists). End your subtask writeup with a line exactly formatted: <!-- IMPL: blockParser -->\n\nAfter all 3 subtasks report back, AGGREGATE: compose a single convert(markdown: string): string that runs block-parser then inline-parser, embed the full TypeScript in a ```typescript fenced block, and confirm it works on the canonical cases. Your final aggregated report MUST end with a line exactly formatted: <!-- CONVERTS: true -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "ROOT TASK context: recursive team build of a single-file Markdown-to-HTML converter. You are a solver member. Watch the shared task list (team_task_list) for subtask (b): the INLINE parser handling bold (**text** -> <strong>text</strong>) and inline code (`code` -> <code>code</code>). When claimable, claim it (team_task_update) and implement parseInline(text: string): string. Embed the TypeScript in a ```typescript fenced block. Coordinate with the decomposer via team_send_message. Your report MUST end with a line exactly formatted: <!-- IMPL: inlineParser -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "ROOT TASK context: recursive team build of a single-file Markdown-to-HTML converter. You are a solver member. Your subtask (c) is BLOCKED BY subtasks (a) block-parser and (b) inline-parser (see blockedBy in the shared task list). Wait until both are done, then claim (c) via team_task_update. Assemble convert(markdown: string): string from the two parsers and write a test suite covering: heading level 1 (#), level 2 (##), level 3 (###), bold (**), inline code (`), unordered list (-). Run the suite (at least 6 cases) and report the number of PASSING cases. Your report MUST end with a line exactly formatted: <!-- PASS_COUNT: <n_passing> --> where <n_passing> is the count of passing test cases."
    }
  ]
}
```

**Role 选择理由**：`coder` 用 `oct-junior` agent，专注实现、最小变更——贴合模块化构建。`alice` 兼任 decomposer（它拥有顶层 `convert` 的组装职责）。

### 3.3 Master 启动调用

```json
{
  "tool": "team_recurse",
  "args": {
    "team_id": "md-converter",
    "task": "Build a single-file Markdown-to-HTML converter supporting headings (#, ##, ###), bold (**), inline code (`), and unordered lists (-). Decompose into modules.",
    "decomposer": "alice",
    "max_depth": 2,
    "max_subtasks": 3,
    "timeout_ms": 900000,
    "max_retries": 0
  }
}
```

**参数选择**：
- `decomposer: alice` — 块级解析是 convert 的入口，由其组装最终 convert 最自然
- `max_depth: 2` — 根 → 3 个模块子任务；测试子任务通过 blockedBy 排在两个 parser 之后
- `max_subtasks: 3` — 块级 / 行内 / 测试三模块
- `timeout_ms: 900000`（15 min）— 含 blockedBy 串行等待（测试在 parser 之后），仍远低于上限

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_recurse；root task 入共享任务列表（depth=0）
T+0m    仅 dispatch decomposer (alice)，附带递归契约
T+0~1m  alice 分解 root → 创建 3 个 subtask（carol blockedBy 两个 parser）
T+1m    bob 被 re-prompt 唤醒并认领 (b)；alice 自做 (a)
T+1~5m  alice 与 bob 并行实现
T+5m    两 parser 完成 → carol 的 blockedBy 解除，被唤醒认领 (c)
T+5~8m  carol 组装 convert、跑测试套件、回填 PASS_COUNT
T+8m    alice 聚合最终 convert，写 CONVERTS
T+9m    运行: bun check-coding-md-converter.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-md-converter.ts`](./check-coding-md-converter.ts)

- **加载**：读取 `<run_dir>/` 下全部 `*.md`
- **提取**：
  - 标记：正则 `<!-- CONVERTS:\s*(true|false)\s*-->`、`<!-- PASS_COUNT:\s*(\d+)\s*-->`
  - 代码：扫描各 `*.md` 的 ` ```typescript ... ``` ` 块，定位含 `convert` 定义的块
- **断言**：
  1. decomposer（`alice.md`）含 `CONVERTS: true`
  2. `carol.md` 含 `PASS_COUNT: <n>`，n ≥ 5（覆盖 5 项特性且全过）
  3. 提取到的 `convert` 函数：`convert("# Hi")` 含 `<h1`；`convert("**bold**")` 含 `<strong>` 或 `<b>`

---

## 场景 4: Vandermonde 恒等式多层证明（挑战级）

> **挑战级**：本场景刻意突破标准预算（30 min 总时长 / ≤4 成员 / `max_depth=2`），用于压测 `team_recurse` 在更深（`max_depth=4`）、更宽（`max_subtasks=4`）、更多成员（6 人）下的多层递归分解与自底向上聚合能力。

### 4.1 场景描述

**背景**：Vandermonde 恒等式 C(m+n, k) = Σ_{i=0}^{k} C(m,i)·C(n, k-i) 是组合数学的核心恒等式之一，拥有三条相互独立的标准证明路径——代数（二项式展开）、组合（双射计数）、母函数（(1+x)^{m+n} 系数提取）。每条路径又可拆为 2-3 个子引理（如代数路径：先证 (1+x)^{m+n}=(1+x)^m·(1+x)^n，再比对 x^k 系数）。这种「根 → 多路径 → 子引理 → 基础等式」的多层结构天然适配 `team_recurse` 的深度递归分解。

**目标**：decomposer（`alice`）把根任务拆为 3 条独立证明路径（代数 / 组合 / 母函数），每条路径再分解为 2-3 个子引理，必要时继续下钻至基础等式（最深至 depth=4）；6 名成员沿路径并行认领叶节点引理并各自证毕；最终由 `alice` 自底向上聚合，确认三路殊途同归，给出 Vandermonde 恒等式的完整证明。

**成功标准（可机器评判）**：
- decomposer（`alice`）输出含 `<!-- VANDERMONDE_PROVEN: true -->`（三路聚合后判定恒等式成立）
- 全部成员的叶节点中收集到的 `<!-- APPROACH: <name> -->` 出现 ≥2 个不同路径名（至少含 `algebraic` 与 `combinatorial`）
- 所有出现的 `<!-- LEMMA_HOLDS: ... -->` 标记均为 `true`（无任何叶引理证伪）

### 4.2 Team 配置

```json
{
  "name": "vandermonde-prove",
  "description": "Prove the Vandermonde identity via 3 independent paths (algebraic / combinatorial / generating-function), each decomposed into sub-lemmas, aggregated bottom-up",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "ROOT TASK: Prove the Vandermonde identity C(m+n, k) = sum_{i=0}^{k} C(m,i)*C(n, k-i). Decompose into independent proof approaches, then sub-lemmas, down to base identities.\n\nYou are the DECOMPOSER.\n  STEP 0 (CRITICAL): Claim the root task FIRST (team_task_update status=\"claimed\" on the root). Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator only parses output from members holding a claimed/in_progress task.\n  STEP 1: Decompose the root into 3 independent proof PATHS (emit a <decompose> block — the orchestrator creates the subtasks automatically; do NOT call team_task_create): (A) algebraic -- expand (1+x)^{m+n} = (1+x)^m*(1+x)^n and equate coefficients of x^k; (B) combinatorial -- count C(m+n,k) directly and biject to the RHS split by how many elements come from the m-group; (C) generating-function -- extract the x^k coefficient from both sides of (1+x)^{m+n}=(1+x)^m*(1+x)^n. Then decompose each PATH into 2-3 sub-lemmas (depth 2); where useful, decompose a sub-lemma further into a base identity (depth 3), and continue down to depth-4 leaves. You may decompose up to max_depth=4 with max_subtasks=4. Coordinate via team_send_message.\n\nEXPECTED sub-lemma breakdown:\n- Algebraic path: (a) prove (1+x)^{m+n} = (1+x)^m*(1+x)^n by the binomial theorem; (b) equate coefficients of x^k on both sides to get sum_i C(m,i)*C(n,k-i) = C(m+n,k).\n- Combinatorial path: (a) count C(m+n,k) as the number of k-subsets of an (m+n)-set; (b) biject by partitioning on i = how many of the k chosen elements lie in a fixed m-subset, giving sum_i C(m,i)*C(n,k-i).\n- Generating-function path: (a) show [x^k](1+x)^{m+n} = C(m+n,k); (b) show [x^k](1+x)^m*(1+x)^n = sum_i C(m,i)*C(n,k-i) via the Cauchy product of power series.\n\nAfter the orchestrator creates the subtasks, claim the algebraic sub-lemma (a) for yourself; let teammates claim the rest.\n\nFor YOUR leaf sub-lemma (algebraic (a)): prove (1+x)^{m+n} = (1+x)^m*(1+x)^n by applying the binomial theorem to each factor on the RHS and combining exponents. Confirm it holds for all non-negative integers m, n. End your leaf writeup with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: algebraic -->\n\nAfter all leaf subtasks report back, AGGREGATE bottom-up: collect each path's conclusion, confirm all three paths yield C(m+n,k) = sum_{i=0}^{k} C(m,i)*C(n, k-i), and write the unified proof. Your final aggregated report MUST end with a line exactly formatted: <!-- VANDERMONDE_PROVEN: true -->"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity C(m+n,k) = sum_{i=0}^{k} C(m,i)*C(n,k-i). You are a solver member on the ALGEBRAIC path. Watch the shared task list (team_task_list) for the algebraic sub-lemma (b): EQUATE COEFFICIENTS of x^k on both sides of (1+x)^{m+n} = (1+x)^m*(1+x)^n. When it is claimable, claim it (team_task_update) and solve: expand (1+x)^m = sum_i C(m,i)*x^i and (1+x)^n = sum_j C(n,j)*x^j; multiply and collect the coefficient of x^k as sum_{i=0}^{k} C(m,i)*C(n,k-i); equate to C(m+n,k) from the LHS. Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: algebraic -->"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity. You are a solver member on the COMBINATORIAL path. Watch the shared task list (team_task_list) for the combinatorial sub-lemma (a): COUNT C(m+n,k) directly as the number of k-element subsets of a fixed set of size m+n. When it is claimable, claim it (team_task_update) and solve: establish the base identity (subset count = n!/(k!*(n-k)!)) and state C(m+n,k) = (m+n)!/(k!*(m+n-k)!). Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: combinatorial -->"
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity. You are a solver member on the COMBINATORIAL path. Watch the shared task list (team_task_list) for the combinatorial sub-lemma (b): BIJECT by partitioning on i = how many of the k chosen elements lie in a fixed m-subset (the remaining k-i come from the n-subset). When it is claimable, claim it (team_task_update) and solve: show the number of k-subsets with exactly i elements from the m-group is C(m,i)*C(n,k-i); summing over i=0..k counts every k-subset exactly once, giving sum_i C(m,i)*C(n,k-i) = C(m+n,k). Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: combinatorial -->"
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity. You are a solver member on the GENERATING-FUNCTION path. Watch the shared task list (team_task_list) for the generating-function sub-lemma (a): show [x^k](1+x)^{m+n} = C(m+n,k) (the coefficient of x^k in the binomial expansion). When it is claimable, claim it (team_task_update) and solve: by the binomial theorem (1+x)^{m+n} = sum_t C(m+n,t)*x^t, so the coefficient of x^k is C(m+n,k). Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: generating-function -->"
    },
    {
      "name": "frank",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity. You are a solver member on the GENERATING-FUNCTION path. Watch the shared task list (team_task_list) for the generating-function sub-lemma (b): show [x^k](1+x)^m*(1+x)^n = sum_{i=0}^{k} C(m,i)*C(n,k-i) via the Cauchy product of power series. When it is claimable, claim it (team_task_update) and solve: write (1+x)^m = sum_i C(m,i)*x^i and (1+x)^n = sum_j C(n,j)*x^j; the x^k coefficient of their product is sum_{i=0}^{k} C(m,i)*C(n,k-i). Equate to the LHS coefficient C(m+n,k). Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: generating-function -->"
    }
  ]
}
```

**Role 选择理由**：`mathematician` 用 `oct-junior` agent，可独立推导、证引理、写多层证明——完全匹配本场景。6 人均为 `mathematician`；`alice` 兼任 decomposer（既是合法成员，又承担根聚合）。成员分工沿三条路径分布：algebraic（alice + bob）、combinatorial（carol + dave）、generating-function（erin + frank），每路径 2 个叶引理。

### 4.3 Master 启动调用

```json
{
  "tool": "team_recurse",
  "args": {
    "team_id": "vandermonde-prove",
    "task": "Prove the Vandermonde identity: C(m+n, k) = Σ_{i=0}^{k} C(m,i)·C(n, k-i). Decompose into independent proof approaches, then sub-lemmas, down to base identities.",
    "decomposer": "alice",
    "max_depth": 4,
    "max_subtasks": 4,
    "timeout_ms": 3000000,
    "max_retries": 0
  }
}
```

**参数选择**：
- `decomposer: alice` — 必须是成员名，不能是 `master`；选 `alice`（兼做代数路径一叶，便于聚合锚定）
- `max_depth: 4` — 根(0) → 路径(1) → 子引理(2) → 基础等式(3) → 深叶(4)；刻意比标准场景的 depth=2 更深，压测多层逐级聚合
- `max_subtasks: 4` — 允许每层最多 4 个子任务，容纳 3 路径 × 2-3 子引理的扇出；比标准 `max_subtasks=3` 更宽
- `timeout_ms: 3000000`（50 min）— 6 成员并行 + 多层逐级聚合的充裕上限（挑战级，超出标准 30 min 预算）
- `max_retries: 0` — 数学证明确定性高，失败即整体失败

### 4.4 执行流程（时序）

```
T+0m     master 调用 team_recurse；root task 入共享任务列表（depth=0）
T+0m     仅 dispatch decomposer (alice)，附带递归契约
T+0~3m   alice 分解 root → 3 条路径任务（depth=1：algebraic / combinatorial / generating-function）
T+3~6m   各路径继续分解为 2-3 子引理（depth=2）；部分子引理下钻至基础等式（depth=3），个别达 depth-4 叶
T+6m     bob / carol / dave / erin / frank 被尾部 re-prompt 唤醒，认领各自叶引理
T+6~38m  六成员并行证明叶引理（alice 兼做 algebraic 一叶），各自回填 LEMMA_HOLDS + APPROACH
T+38m    全部叶引理完成 → 触发 depth-3 → depth-2 → depth-1 逐层聚合
T+38~46m 路径级聚合：三路径各自收敛到 C(m+n,k) = Σ_i C(m,i)·C(n,k-i)
T+46m    alice 聚合三路殊途同归，写 VANDERMONDE_PROVEN
T+50m    运行: bun check-math-vandermonde.ts <run_dir>
```

### 4.5 评判脚本

[`check-math-vandermonde.ts`](./check-math-vandermonde.ts)

- **加载**：读取 `<run_dir>/` 下全部 `*.md`（6 名成员的叶引理报告散落于任务列表 + 各成员输出）
- **提取**：
  - 根聚合标记：正则 `<!-- VANDERMONDE_PROVEN:\s*(true|false)\s*-->`
  - 叶路径标记：全局正则 `<!-- APPROACH:\s*([A-Za-z0-9_-]+)\s*-->`
  - 叶结论标记：全局正则 `<!-- LEMMA_HOLDS:\s*(true|false)\s*-->`
- **断言**：
  1. decomposer（`alice.md`）存在且含 `VANDERMONDE_PROVEN: true`
  2. 全部成员中收集到的 APPROACH 名称去重后 ≥2 个，且必含 `algebraic` 与 `combinatorial`（证明 ≥2 条独立路径走通）
  3. 所有出现的 LEMMA_HOLDS 标记均为 `true`（无叶引理证伪）

---

## 验收清单

- [ ] 3 个 check 脚本 `tsc -p docs/scenarios/tsconfig.json` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `simulator` / `coder` 均为预设）
- [ ] 每个 master 调用参数符合 `team_recurse` schema（`decomposer` 为成员名，非 `master`；`max_depth=2`、`max_subtasks=3`）
- [ ] 每场景总时长 ≤ 15 min（远低于 30 min 上限）
- [ ] 成员 prompt 中明确输出格式约定（marker），评判脚本与之对齐
- [ ] decomposer prompt 使用 `<decompose>` 标签块（非手动 team_task_create）；聚合 marker（D4_FINAL / MODEL_VALID / CONVERTS / VANDERMONDE_PROVEN）与至少一个叶节点 marker 来自不同成员


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成完整闭环。recurse 模式评判扫 **所有成员** 的 .md：找 decomposer 的聚合 marker + 至少 1 个叶子的子结果 marker。

### 场景 1: 错排数 D_n 推导（数学）

```text
执行 docs/scenarios/08-team-recurse/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（3 个 mathematician，decomposer 由团队配置指定）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_recurse JSON 启动编排（root task = 推导 D_n）
4. team_results 轮询至 master 收到汇总（decomposer 拆子任务 → 成员自取 → 底层聚合回根）
5. 定位 <run_dir>（含所有成员 .md）
6. 运行：bun docs/scenarios/08-team-recurse/check-math-derangement.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decomposer 的 D4_FINAL = 9；且至少 1 个叶子成员 D4_VALUE = 9（容斥/递推/生成函数三路均应得 9）。
```

### 场景 2: 阻尼单摆建模（物理）

```text
执行 docs/scenarios/08-team-recurse/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_recurse JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/scenarios/08-team-recurse/check-physics-damped-pendulum.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decomposer 的 MODEL_VALID = true；且至少 1 叶子报 ENVELOPE_DECAY（γ=0.2 时 e-folding 常数 ≈ 0.1，即 2/γ）。
```

### 场景 3: 单页 Markdown→HTML 转换器（编程）

```text
执行 docs/scenarios/08-team-recurse/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_recurse JSON 启动编排（root = 构建转换器）
4. team_results 轮询至 master 收到汇总（子任务：alice / bob / carol）
5. 定位 <run_dir>
6. 运行：bun docs/scenarios/08-team-recurse/check-coding-md-converter.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decomposer 的 CONVERTS = true；且聚合出的 convert() 通过：convert("# Hi") 含 <h1>、convert("**b**") 含 <strong> 或 <b>。
```

### 场景 4: Vandermonde 恒等式多层证明（数学·挑战级）

```text
执行 docs/scenarios/08-team-recurse/README.md「场景 4」的完整闭环并自动评判（挑战级：6 成员、max_depth=4，预计 ~50 min）。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（6 个 mathematician，decomposer 为 alice）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_recurse JSON 启动编排（root = 证明 Vandermonde 恒等式；max_depth=4, max_subtasks=4）
4. team_results 轮询至 master 收到汇总（alice 拆 3 路径 → 各路径拆子引理 → 成员认领叶引理 → 自底向上逐层聚合回根）
5. 定位 <run_dir>（含所有 6 名成员 .md）
6. 运行：bun docs/scenarios/08-team-recurse/check-math-vandermonde.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：alice 的 VANDERMONDE_PROVEN = true；叶节点 APPROACH 出现 ≥2 个不同名称（必含 algebraic 与 combinatorial）；所有 LEMMA_HOLDS 均为 true。
```
