# team_consensus 编排场景设计

> **模式**：`team_consensus` — 多轮结构化辩论，所有成员就 `topic` 发表立场并逐轮逼近共识；每轮每成员 emits `<consensus>{"agreed": true|false}</consensus>`，全部 `agreed=true` 即共识达成。无 signoff 闸（全员同意机制本身就是闸）。
> **源码**：[`src/tools/workflow-basic.ts:143-201`](../../../src/tools/workflow-basic.ts)
> **控时设计**：3 成员 × `max_rounds=3`；每轮每成员 2-3 min；总时长 ≈ 3 轮 × 3 min + 调度 ≈ 9-12 min（远低于 30 min 上限）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role | max_rounds | 预计总时长 |
|---|------|------|--------|------|------------|-----------|
| 1 | 数学 | 小数组稳定排序算法选型 | 3 | `mathematician` | 3 | ~12 min |
| 2 | 计算物理 | 一维热扩散时间格式选择 | 3 | `simulator` | 3 | ~10 min |
| 3 | 编程 | 短文本串匹配算法选型 | 3 | `coder` | 3 | ~10 min |

---

## 场景 1: 小数组稳定排序算法选型

### 1.1 场景描述

**背景**：当数据量小（n<50）且几乎已排好序，但稳定性是硬性约束时，insertion sort / TimSort / merge sort 三者各有优势。insertion sort 在低逆序对数下接近 O(n)；TimSort 是 hybrid 算法，对小数组有专门优化（minrun + galloping）；merge sort 严格 O(n log n) 但常数大。哪一个是「最优」取决于逆序对密度——这正是适合多轮辩论收敛的开放性问题。

**目标**：3 个成员各辩护一种算法，通过 ≤3 轮辩论收敛到一个共识结论：「命名一个算法 + 一个判据条件」（例：逆序对计数 < n²/16 时 insertion sort，否则 TimSort）。

**成功标准（可机器评判）**：
- 每个成员最终轮输出含 `<consensus>{"agreed": ..., "choice": "..."}</consensus>` 标记
- 三成员最终轮全部 `agreed: true`（共识达成，非 max_rounds 耗尽）
- `choice` 字段值匹配已知算法名（`insertion|timsort|merge`）
- 三成员的 `choice` 收敛到同一算法名（真正达成共识）

### 1.2 Team 配置

```json
{
  "name": "small-sort-debate",
  "description": "Stable sort selection for n<50 nearly-sorted arrays: 3-way consensus debate",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are the advocate for INSERTION SORT in a 3-way debate. Topic: For n<50 nearly-sorted elements that require a STABLE sort, which algorithm is optimal: insertion sort, TimSort, or merge sort? Make the strongest technical case for insertion sort: O(n) best case on nearly-sorted input, O(n+k) where k = inversion count, O(1) auxiliary memory, cache-friendly sequential access, lowest constant factors, no recursion overhead. Across rounds engage honestly with the other advocates (timsort, merge-sort); concede regimes where they win. The group's goal is a consensus naming ONE algorithm plus a decision condition (e.g. 'insertion sort when inversion count < n^2/16, else TimSort'). End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are the advocate for TIMSORT in a 3-way debate. Topic: For n<50 nearly-sorted elements that require a STABLE sort, which algorithm is optimal: insertion sort, TimSort, or merge sort? Make the strongest technical case for TimSort: hybrid adaptive mergesort, exploits existing runs (O(n) on sorted data), production-tested (Python/Java/V8 default), stable, degrades gracefully to O(n log n) worst case. Note for n<50 it uses a small insertion-sort 'minrun' then merges, combining the strengths of both. Across rounds engage honestly with the other advocates (insertion, merge-sort); concede regimes where they win. The group's goal is a consensus naming ONE algorithm plus a decision condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are the advocate for MERGE SORT in a 3-way debate. Topic: For n<50 nearly-sorted elements that require a STABLE sort, which algorithm is optimal: insertion sort, TimSort, or merge sort? Make the strongest technical case for merge sort: strict O(n log n) worst/average/best, stable, predictable performance independent of input distribution, and the foundation on which TimSort is built. Acknowledge the higher constant factor vs insertion sort on tiny n, but argue the predictability and the n log n ceiling matter. Across rounds engage honestly with the other advocates (insertion, timsort); concede regimes where they win. The group's goal is a consensus naming ONE algorithm plus a decision condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>"
    }
  ]
}
```

**Role 选择理由**：`mathematician` 用 `build` agent，可做复杂度分析、反例构造、数值验证——完全匹配算法选型辩论需求。

### 1.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "small-sort-debate",
    "topic": "For n<50 nearly-sorted elements that require stable sort, which algorithm is optimal: insertion sort, TimSort, or merge sort?",
    "max_rounds": 3,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `max_rounds: 3` — 算法选型是开放问题，3 轮足够「亮明立场 → 互相反驳 → 收敛」；超过 3 轮通常无新论点
- `timeout_ms: 900000`（15 min）— 给足余量，正常 ~10 min 收敛
- 不设 `token_budget` — 论题小，token 自然受限；先求收敛质量
- 无 `signoff_*` 参数 — `team_consensus` 设计上无 signoff 闸，全员 `agreed=true` 即通过（见源码 wf-013 注释）

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_consensus (topic, max_rounds=3)
T+0m    OCTeam 并行 dispatch 3 个 mathematician，Round 1：各陈立场
T+0~3m  各成员读题 → 给出算法辩护 + 复杂度论据 + <consensus agreed=false>
T+3m    Round 2：成员互相读取他方论点 → 反驳 / 让步
T+3~6m  各成员调整立场，部分让步 + <consensus agreed=true|false>
T+6m    Round 3（若需要）：收敛到共同结论
T+6~9m  全员 agreed=true，共识达成，运行结束
T+9m    运行: bun check-math-sort-stability.ts <run_dir>
```

### 1.5 评判脚本

[`check-math-sort-stability.ts`](./check-math-sort-stability.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol}.md`
- **提取**：全局正则 `<consensus>([\s\S]*?)</consensus>`，取最后一个 tag 为最终轮
- **断言**：
  1. 每个成员至少含一个 `<consensus>` tag
  2. 每个成员最终轮 `agreed: true`（共识真达成，非 max_rounds 耗尽）
  3. 每个成员最终轮 `choice` 匹配 `/^(insertion|timsort|merge)/i`
  4. 三成员的 `choice` 收敛到同一算法名（case-insensitive 归一化）

---

## 场景 2: 一维热扩散时间格式选择

### 2.1 场景描述

**背景**：一维热传导方程 `u_t = u_xx` 在均匀网格上的有限差分离散，时间积分格式决定稳定性与精度。给定 `dt=0.01`、`dx=0.1`，扩散数 `r = dt/dx² = 0.01/0.01 = 1.0`。显式 FTCS 的 CFL 条件 `r ≤ 0.5` 在此被违反——显式格式数值不稳定，必须换隐式类格式。但隐式（1 阶时间）与 Crank-Nicolson（2 阶时间）在精度与计算成本上仍有取舍。

**目标**：3 个成员各辩护一种格式（显式 FTCS / 全隐式 / Crank-Nicolson），通过 ≤3 轮辩论收敛到一个共识结论：「选定一个格式 + 引用 CFL 稳定性条件（显式 `r = dt/dx² ≤ 0.5`）」。

**成功标准（可机器评判）**：
- 每个成员最终轮输出含 `<consensus>{"agreed": ..., "choice": "..."}</consensus>` 标记
- 三成员最终轮全部 `agreed: true`
- `choice` 字段值匹配已知格式名（`explicit|implicit|crank`）
- 三成员的 `choice` 收敛到同一格式名（显式 FTCS 因 r=1.0>0.5 应被排除，预期收敛到 `implicit` 或 `crank`）

### 2.2 Team 配置

```json
{
  "name": "heat-diffusion-debate",
  "description": "1D heat equation u_t=u_xx time scheme: 3-way consensus debate (FTCS vs implicit vs Crank-Nicolson)",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are the advocate for EXPLICIT FTCS (Forward-Time Centered-Space) in a 3-way debate. Topic: For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose a time scheme: explicit FTCS / fully-implicit / Crank-Nicolson. Make the strongest case for explicit FTCS: trivial to implement, no linear solve per step, O(N) per timestep, and second-order in space. CRUCIAL: you MUST compute the diffusion number r = dt/dx^2 = 0.01/(0.1^2) = 1.0 and acknowledge the CFL stability condition r <= 0.5 for explicit schemes. Since r=1.0 > 0.5, be honest that explicit FTCS is UNSTABLE for these parameters — argue only for the regime where it would win (smaller dt). Across rounds engage with implicit-advocate and crank-advocate; concede when r violates CFL. The group's goal is a consensus naming ONE scheme plus the CFL condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<scheme-name>\"}</consensus>"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are the advocate for FULLY-IMPLICIT (Backward Euler) in a 3-way debate. Topic: For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose a time scheme: explicit FTCS / fully-implicit / Crank-Nicolson. Make the strongest case for fully-implicit (Backward Euler): unconditionally stable for any r (no CFL limit), first-order accurate in time (O(dt)) and second-order in space (O(dx^2)), requires solving a tridiagonal system per step (O(N) via Thomas algorithm). Given r = dt/dx^2 = 1.0 > 0.5, the explicit scheme is unstable, so implicit is the minimum stable upgrade. Across rounds engage with explicit-advocate and crank-advocate; concede the accuracy advantage of Crank-Nicolson. The group's goal is a consensus naming ONE scheme plus the CFL condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<scheme-name>\"}</consensus>"
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are the advocate for CRANK-NICOLSON in a 3-way debate. Topic: For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose a time scheme: explicit FTCS / fully-implicit / Crank-Nicolson. Make the strongest case for Crank-Nicolson: unconditionally stable (like fully-implicit), second-order accurate in BOTH time and space (O(dt^2 + dx^2)), the accuracy leader. Same tridiagonal solve cost per step as fully-implicit. Given r = dt/dx^2 = 1.0 > 0.5, explicit is unstable; the real debate is accuracy: Crank-Nicolson beats Backward Euler on temporal accuracy. Across rounds engage with explicit-advocate and implicit-advocate; concede that for very stiff problems Backward Euler's damping can be desirable. The group's goal is a consensus naming ONE scheme plus the CFL condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<scheme-name>\"}</consensus>"
    }
  ]
}
```

**Role 选择理由**：`simulator` 专为数值仿真设计（PDE/有限差分/稳定性分析），符合热扩散格式选型场景。

### 2.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "heat-diffusion-debate",
    "topic": "For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose: explicit FTCS / fully-implicit / Crank-Nicolson.",
    "max_rounds": 3,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `max_rounds: 3` — CFL 判据是硬约束（r=1.0>0.5 直接淘汰显式），剩余 implicit vs Crank-Nicolson 一轮可定，3 轮足够
- `timeout_ms: 900000`（15 min）— 给足余量
- 无 `signoff_*` 参数 — 共识机制即闸

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_consensus (topic, max_rounds=3)
T+0m    OCTeam 并行 dispatch 3 个 simulator，Round 1：各陈立场 + 算 r
T+0~3m  各成员算 CFL: r=1.0>0.5 → 显式被自我否决
T+3m    Round 2：alice 让步；implicit vs crank 辩精度
T+3~6m  成员收敛到无条件稳定格式（implicit 或 crank）
T+6m    Round 3（若需要）：全员 agreed=true
T+6~9m  共识达成
T+9m    运行: bun check-physics-heat-diffusion.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-heat-diffusion.ts`](./check-physics-heat-diffusion.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol}.md`
- **提取**：全局正则 `<consensus>([\s\S]*?)</consensus>`，取最后一个 tag 为最终轮
- **断言**：
  1. 每个成员至少含一个 `<consensus>` tag
  2. 每个成员最终轮 `agreed: true`
  3. 每个成员最终轮 `choice` 匹配 `/^(explicit|implicit|crank)/i`
  4. 三成员的 `choice` 收敛到同一格式名
  5. 最终共识格式 ≠ `explicit`（因 r=1.0 违反 CFL，显式格式应被排除）

---

## 场景 3: 短文本串匹配算法选型

### 3.1 场景描述

**背景**：模式串匹配是基础算法题。当文本很短（<1KB）且模式也短（≤32 字符）时，朴素法、KMP、Boyer-Moore、Sunday 各有适用场景：朴素法常数极小（无预处理），KMP 保证 O(n+m) 最坏情况但预处理对小输入不值，Sunday（Horspool 变体）平均 O(n/m) 子线性，Boyer-Moore 适合较长模式。短文本下「最优」取决于文本/模式长度比——适合多轮辩论。

**目标**：3 个成员各辩护一种算法（naive / KMP / Sunday），通过 ≤3 轮辩论收敛到一个共识结论：「一个以文本/模式长度为键的决策树」（例：n×m<256 用 naive，否则 Sunday）。

**成功标准（可机器评判）**：
- 每个成员最终轮输出含 `<consensus>{"agreed": ..., "choice": "..."}</consensus>` 标记
- 三成员最终轮全部 `agreed: true`
- `choice` 字段值匹配已知算法名（`naive|kmp|boyer|sunday`）
- 三成员的 `choice` 收敛到同一算法名

### 3.2 Team 配置

```json
{
  "name": "string-match-debate",
  "description": "Short-text pattern matching (<1KB, pattern<=32): 3-way consensus debate (naive / KMP / Sunday)",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are the advocate for the NAIVE (brute-force) string matcher in a 3-way debate. Topic: For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday. Make the strongest case for naive: zero preprocessing, O(nm) worst case but O(n) on typical text with early mismatch on first char, lowest constant factor, branch-predictor friendly, no extra memory. For n<1KB the quadratic ceiling never bites in practice. Across rounds engage with kmp-advocate (whose O(n+m) worst case shines on repetitive text) and sunday-advocate (whose average O(n/m) wins on larger n); concede regimes where they win. The group's goal is a consensus decision tree keyed on text/pattern lengths. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are the advocate for KMP (Knuth-Morris-Pratt) in a 3-way debate. Topic: For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday. Make the strongest case for KMP: guaranteed O(n+m) worst case (never degrades on repetitive/DNA-like text), O(m) preprocessing for the failure function, deterministic performance independent of alphabet. The worst-case guarantee is the differentiator vs naive (which can hit O(nm) on adversarial input like 'aaaa...aab' in 'aaaa...a'). Across rounds engage with naive-advocate (whose constants are lower for tiny n) and sunday-advocate (whose average case is sublinear); concede that for uniformly random short text naive or Sunday may win on wall-clock. The group's goal is a consensus decision tree keyed on text/pattern lengths. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are the advocate for SUNDAY (a.k.a. Sunday / Horspool-variant) string matching in a 3-way debate. Topic: For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday. Make the strongest case for Sunday: average-case O(n/m) sublinear (skips m chars on mismatch using the bad-character table), simple preprocessing (O(alphabet+m)), and the practical winner on typical text for short-to-medium patterns. For short text <1KB with patterns <=32 it consistently beats KMP on wall-clock while being simpler than full Boyer-Moore (no good-suffix rule). Across rounds engage with naive-advocate (whose zero-overhead wins for tiny n) and kmp-advocate (whose worst-case guarantee Sunday lacks); concede regimes where they win. The group's goal is a consensus decision tree keyed on text/pattern lengths. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>"
    }
  ]
}
```

**Role 选择理由**：`coder` 用 `build` agent，可写基准代码、实测短文本匹配耗时来支撑论点——贴合算法实现辩论。

### 3.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "string-match-debate",
    "topic": "For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday.",
    "max_rounds": 3,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `max_rounds: 3` — 短文本场景边界清晰（n<1KB），3 轮足够从「亮立场 → 实测对比 → 收敛决策树」
- `timeout_ms: 900000`（15 min）— 给足余量，正常 ~8 min 收敛
- 无 `signoff_*` 参数 — 共识机制即闸

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_consensus (topic, max_rounds=3)
T+0m    OCTeam 并行 dispatch 3 个 coder，Round 1：各陈立场
T+0~3m  各成员给算法分析（复杂度 + 适用边界）
T+3m    Round 2：成员可写基准实测短文本耗时 → 用数据反驳
T+3~6m  成员按文本/模式长度划分适用域
T+6m    Round 3（若需要）：收敛到决策树，全员 agreed=true
T+6~8m  共识达成
T+8m    运行: bun check-coding-string-match.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-string-match.ts`](./check-coding-string-match.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol}.md`
- **提取**：全局正则 `<consensus>([\s\S]*?)</consensus>`，取最后一个 tag 为最终轮
- **断言**：
  1. 每个成员至少含一个 `<consensus>` tag
  2. 每个成员最终轮 `agreed: true`
  3. 每个成员最终轮 `choice` 匹配 `/^(naive|kmp|boyer|sunday)/i`
  4. 三成员的 `choice` 收敛到同一算法名（case-insensitive 归一化）

---

## 验收清单

- [ ] 3 个 check 脚本 `tsc -p docs/orchestration-scenarios/tsconfig.json` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `simulator` / `coder` 均为预设）
- [ ] 每个 master 调用参数符合 `team_consensus` schema（`team_id` / `topic` / `max_rounds` / `timeout_ms`）
- [ ] 每个调用**无** `signoff_*` 参数（共识机制即闸，源码 wf-013）
- [ ] 每场景总时长 ≤ 12 min（远低于 30 min 上限）
- [ ] 成员 prompt 中明确 `<consensus>` 输出格式约定，评判脚本与之对齐


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成「创建团队 → 激活 → 启动编排 → 等待汇总 → 运行评判脚本」的完整闭环。所有具体配置直接引用本 README 对应小节。

### 场景 1: 小规模排序选型（数学）

```text
执行 docs/orchestration-scenarios/02-team-consensus/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_consensus JSON 启动编排
4. team_results 轮询至 master 收到汇总（consensus 最多 max_rounds 轮）
5. 定位 <run_dir>（含各成员 <member>.md）
6. 运行：bun docs/orchestration-scenarios/02-team-consensus/check-math-sort-stability.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：所有成员最终轮 emit `"agreed": true`；共识 choice ∈ {insertion, timsort, merge}。
```

### 场景 2: 一维热传导时间格式选型（物理）

```text
执行 docs/orchestration-scenarios/02-team-consensus/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_consensus JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/02-team-consensus/check-physics-heat-diffusion.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：全员最终轮 `"agreed": true`；共识 choice ∈ {explicit, implicit, crank-nicolson}。
```

### 场景 3: 短文本字符串匹配选型（编程）

```text
执行 docs/orchestration-scenarios/02-team-consensus/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_consensus JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/02-team-consensus/check-coding-string-match.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：全员最终轮 `"agreed": true`；共识 choice ∈ {naive, kmp, boyer, sunday}。
```
