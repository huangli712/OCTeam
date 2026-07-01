# team_consensus 编排场景设计

> **模式**：`team_consensus` — 多轮结构化辩论，所有成员就 `topic` 发表立场并逐轮逼近共识；每轮每成员 emits `<consensus>{"agreed": true|false}</consensus>`，全部 `agreed=true` 即共识达成。无 signoff 闸（全员同意机制本身就是闸）。
> **源码**：[`src/tools/consensus.ts`](../../../src/tools/consensus.ts)
> **控时设计**：3 成员 × `max_rounds=6`；每轮每成员 2-3 min；总时长 ≈ 6 轮 × 3 min + 调度 ≈ 18-24 min（低于 30 min 上限）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role | max_rounds | 预计总时长 |
|---|------|------|--------|------|------------|-----------|
| 1 | 数学 | 小数组稳定排序算法选型 | 3 | `mathematician` | 6 | ~24 min |
| 2 | 计算物理 | 一维热扩散时间格式选择 | 3 | `simulator` | 6 | ~20 min |
| 3 | 编程 | 短文本串匹配算法选型 | 3 | `coder` | 6 | ~20 min |
| 4 | 数学 | 60 位 RSA 模数分解算法选型（挑战级） | 6 | `mathematician` | 5 | ~35 min |

---

## 场景 1: 小数组稳定排序算法选型

### 1.1 场景描述

**背景**：当数据量小（n<50）且几乎已排好序，但稳定性是硬性约束时，insertion sort / TimSort / merge sort 三者各有优势。insertion sort 在低逆序对数下接近 O(n)；TimSort 是 hybrid 算法，对小数组有专门优化（minrun + galloping）；merge sort 严格 O(n log n) 但常数大。哪一个是「最优」取决于逆序对密度——这正是适合多轮辩论收敛的开放性问题。

**目标**：3 个成员各辩护一种算法，通过 ≤6 轮辩论收敛到一个共识结论：「命名一个算法 + 一个判据条件」（例：逆序对计数 < n²/16 时 insertion sort，否则 TimSort）。

**成功标准（可机器评判）**：
- 每个成员最终轮输出含 `<consensus>{"agreed": ..., "choice": "..."}</consensus>` 标记
- 三成员最终轮全部 `agreed: true`（共识达成，非 max_rounds 耗尽）
- `choice` 字段值匹配已知算法名（`insertion|timsort|merge`）
- 三成员的 `choice` 收敛到同一算法名（真正达成共识）

### 1.2 Team 配置

```json
{
  "name": "sort-debate",
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

**Role 选择理由**：`mathematician` 用 `oct-junior` agent，可做复杂度分析、反例构造、数值验证——完全匹配算法选型辩论需求。

### 1.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "sort-debate",
    "topic": "For n<50 nearly-sorted elements that require stable sort, which algorithm is optimal: insertion sort, TimSort, or merge sort?",
    "max_rounds": 6,
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `max_rounds: 6` — 算法选型是开放问题，核心论点通常 3 轮内「亮明立场 → 互相反驳 → 收敛」即清，6 轮为收敛余量
- `timeout_ms: 1800000`（30 min）— 给足余量，正常 ~10 min 收敛
- 不设 `token_budget` — 论题小，token 自然受限；先求收敛质量
- 无 `signoff_*` 参数 — `team_consensus` 设计上无 signoff 闸，全员 `agreed=true` 即通过（见源码 wf-013 注释）

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_consensus (topic, max_rounds=6)
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

**目标**：3 个成员各辩护一种格式（显式 FTCS / 全隐式 / Crank-Nicolson），通过 ≤6 轮辩论收敛到一个共识结论：「选定一个格式 + 引用 CFL 稳定性条件（显式 `r = dt/dx² ≤ 0.5`）」。

**成功标准（可机器评判）**：
- 每个成员最终轮输出含 `<consensus>{"agreed": ..., "choice": "..."}</consensus>` 标记
- 三成员最终轮全部 `agreed: true`
- `choice` 字段值匹配已知格式名（`explicit|implicit|crank`）
- 三成员的 `choice` 收敛到同一格式名（显式 FTCS 因 r=1.0>0.5 应被排除，预期收敛到 `implicit` 或 `crank`）

### 2.2 Team 配置

```json
{
  "name": "heat-debate",
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
    "team_id": "heat-debate",
    "topic": "For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose: explicit FTCS / fully-implicit / Crank-Nicolson.",
    "max_rounds": 6,
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `max_rounds: 6` — CFL 判据是硬约束（r=1.0>0.5 直接淘汰显式），剩余 implicit vs Crank-Nicolson 一轮可定，6 轮为收敛余量
- `timeout_ms: 1800000`（30 min）— 给足余量
- 无 `signoff_*` 参数 — 共识机制即闸

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_consensus (topic, max_rounds=6)
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

**目标**：3 个成员各辩护一种算法（naive / KMP / Sunday），通过 ≤6 轮辩论收敛到一个共识结论：「一个以文本/模式长度为键的决策树」（例：n×m<256 用 naive，否则 Sunday）。

**成功标准（可机器评判）**：
- 每个成员最终轮输出含 `<consensus>{"agreed": ..., "choice": "..."}</consensus>` 标记
- 三成员最终轮全部 `agreed: true`
- `choice` 字段值匹配已知算法名（`naive|kmp|boyer|sunday`）
- 三成员的 `choice` 收敛到同一算法名

### 3.2 Team 配置

```json
{
  "name": "string-debate",
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

**Role 选择理由**：`coder` 用 `oct-junior` agent，可写基准代码、实测短文本匹配耗时来支撑论点——贴合算法实现辩论。

### 3.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "string-debate",
    "topic": "For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday.",
    "max_rounds": 6,
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `max_rounds: 6` — 短文本场景边界清晰（n<1KB），核心对比通常 3 轮内「亮立场 → 实测对比 → 收敛决策树」即成，6 轮为收敛余量
- `timeout_ms: 1800000`（30 min）— 给足余量，正常 ~8 min 收敛
- 无 `signoff_*` 参数 — 共识机制即闸

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_consensus (topic, max_rounds=6)
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

## 场景 4: 60 位 RSA 模数分解算法选型（挑战级）

> **挑战级说明**：本场景刻意突破易级场景「≤4 成员、≤30 min」的规模约束，采用 **6 成员 × `max_rounds=5`** 模拟真实的密码学算法选型辩论——候选方法多、复杂度阶层深、收敛慢。预计总时长 ≈ 35 min。

### 4.1 场景描述

**背景**：分解一个约 60 位十进制（≈200-bit）的 RSA 模数 `N = p·q`（p、q 均为 ~30 位素数），是经典数论与计算数论的标志性问题。六种主流算法各有复杂度阶层与适用域：

| 算法 | 复杂度（N 为模数） | 60 位平衡半素数下的适用性 |
|------|--------------------|-----------------------------|
| 试除法 trial division | `O(N^(1/2))` ≈ `O(10^30)` | 完全不可行（仅对小因子有效） |
| Pollard rho | `O(p^(1/2))` ≈ `O(N^(1/4))` ≈ `10^15` | 平衡半素数下不可行（仅对小/中因子强） |
| Lenstra ECM | `L_p[1/2]`（取决于最小因子 p） | 平衡时被 sieve 系压制（非平衡因子时最强） |
| 二次筛 QS | `L_N[1/2, 1]`（次指数） | 60 位下因开销低，wall-clock 竞争力强 |
| 数域筛 NFS | `L_N[1/3, 1.923]`（次指数，渐近最优） | 标准/记录级工具，可扩展性最强 |
| Shor 量子算法 | `O((log N)^3)`（多项式） | 多项式时间但需容错量子机，目前仅未来相关 |

关键判据：对**平衡**的 60 位 RSA 半素数，试除 / Pollard rho / ECM 都被次指数 sieve 系压制；QS 在 60 位 wall-clock 可能略胜，但 NFS 是渐近最优（`L[1/3]`）、记录保持者、业界标准。Shor 是唯一已知多项式时间算法，但当前缺乏足够规模的容错量子机——属未来相关。

**目标**：6 个成员各辩护一种算法，通过 ≤5 轮辩论收敛到一个共识结论：「选定一种最佳**实用经典**方法（预期 NFS）+ 显式承认 Shor 量子算法的未来相关性」。

**成功标准（可机器评判）**：
- 每个成员最终轮输出含 `<consensus>{"agreed": ..., "choice": "..."}</consensus>` 标记
- 六成员最终轮全部 `agreed: true`（共识真达成，非 max_rounds 耗尽）
- 每个成员最终轮 `choice` ∈ {`nfs`, `number-field-sieve`, `quadratic-sieve`, `qs`, `pollard-rho`, `ecm`, `shor`, `trial-division`}
- 至少一位成员的论证提及关键词 `{sub-exponential, 60-digit, rsa, quantum}` 之一（确认辩论锚定在 RSA 分解问题上）

### 4.2 Team 配置

```json
{
  "name": "rsa-debate",
  "description": "60-digit (~200-bit) RSA modulus factoring: 6-way challenge consensus debate (trial division / Pollard rho / QS / NFS / Lenstra ECM / Shor)",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are the advocate for TRIAL DIVISION in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest technical case for trial division: trivial to implement, zero preprocessing, finds small factors immediately, O(N^(1/2)) worst case. CRUCIAL: be honest — for a balanced 60-digit RSA semiprime, trial division up to N^(1/2) needs ~10^30 divisions, utterly infeasible; trial division only wins when N has a tiny prime factor, which a properly generated RSA modulus does not. Across rounds concede decisively to the sub-exponential sieves (QS L_N[1/2], NFS L_N[1/3]) and to Shor's polynomial-time quantum algorithm (future-relevant). The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant (needs a fault-tolerant quantum computer not yet available at scale). End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are the advocate for POLLARD RHO in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for Pollard rho: expected O(p^(1/2)) = O(N^(1/4)) time to find a factor p, O(1) memory, simple randomized Floyd-cycle loop, the go-to for small/medium factors and a standard subroutine in factoring tools. CRUCIAL: be honest — for a balanced 60-digit RSA semiprime, N^(1/4) ≈ 10^15 iterations, far beyond practical reach; Pollard rho is dominated by the sub-exponential sieves on balanced semiprimes and only wins when one factor is small. Concede to QS/NFS for the balanced case; note rho remains useful as a small-factor pre-screen. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are the advocate for the QUADRATIC SIEVE (QS) in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for QS: sub-exponential complexity L_N[1/2, 1], the fastest general-purpose classical factoring algorithm for numbers below ~100 digits, low constant overhead, fully classical, the workhorse behind 1990s RSA factoring challenges. For 60-digit moduli QS is competitive with or faster than NFS on wall-clock because NFS's larger overhead only pays off above the QS/NFS crossover (historically ~100-110 digits). Across rounds engage honestly: concede that NFS has the better asymptotic exponent L_N[1/3] and is the universal record/standard tool for large sizes, and that for a balanced semiprime trial division/Pollard rho/ECM are all dominated by the sieves; argue QS is the practical wall-clock winner specifically at 60-digit. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>"
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "You are the advocate for the NUMBER FIELD SIEVE (NFS) in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for NFS: sub-exponential complexity L_N[1/3, c] with c≈1.923 — the asymptotically fastest known classical factoring algorithm, the method behind every modern RSA factoring record (RSA-155, RSA-768, RSA-250), and the de-facto standard general-purpose factoring engine for cryptographically relevant sizes. Although QS may have lower wall-clock overhead specifically around 60-digit (below the QS/NFS crossover), NFS is the scalable, standard, record-holding choice that generalizes to any serious RSA factoring target. Across rounds engage honestly: concede QS's overhead advantage at 60-digit but argue the consensus should name NFS as the best practical classical method because it is the standard, scalable, asymptotically superior tool. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>"
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "You are the advocate for LENSTRA'S ELLIPTIC CURVE METHOD (ECM) in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for ECM: sub-exponential in the size of the SMALLEST factor p (L_p[1/2, ...]) rather than in N, the champion when one factor is much smaller than the other, fully classical, widely deployed (GMP-ECM). CRUCIAL: be honest — for a BALANCED 60-digit RSA semiprime (two ~30-digit primes), ECM's runtime depends on the ~30-digit factor: L_p[1/2] is far slower than the sieves' L_N[1/2] or L_N[1/3] in N, so ECM is dominated by QS/NFS on balanced semiprimes; ECM only wins for unbalanced factors (one small prime). Concede to QS/NFS for the balanced case; note ECM stays useful as a small-factor pre-screen. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>"
    },
    {
      "name": "frank",
      "role": "mathematician",
      "prompt": "You are the advocate for SHOR'S QUANTUM ALGORITHM in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for Shor's algorithm: polynomial time O((log N)^3), the only known polynomial-time factoring algorithm, provably efficient on a sufficiently large fault-tolerant quantum computer, and the canonical motivation for the entire post-quantum cryptography effort. CRUCIAL: be honest about the present — no fault-tolerant quantum computer with enough logical qubits to factor a 60-digit (200-bit) RSA modulus exists today; current experimental demonstrations factor only tiny numbers (e.g., 15, 21). So Shor is FUTURE-relevant, not a practical choice today. Argue the consensus must (a) select the best PRACTICAL CLASSICAL method for today (expected NFS) AND (b) explicitly acknowledge Shor as the asymptotic/long-term winner that motivates post-quantum migration. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>"
    }
  ]
}
```

**成员→方法映射**：alice→试除法、bob→Pollard rho、carol→二次筛 QS、dave→数域筛 NFS、erin→Lenstra ECM、frank→Shor 量子算法。

**Role 选择理由**：6 成员均用 `mathematician`（`oct-junior` agent），可做复杂度阶层分析（`O` / 次指数 `L[]`）、对数计算、反例构造——完全匹配密码学算法选型的深度辩论需求。

### 4.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "rsa-debate",
    "topic": "For factoring a ~60-digit (~200-bit) RSA modulus in practice, which algorithm should be used? Consider: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, and Shor's quantum algorithm.",
    "max_rounds": 5,
    "timeout_ms": 2400000
  }
}
```

**参数选择**：
- `max_rounds: 5` — 6 种算法、复杂度阶层深，需更多轮次让弱候选（试除 / Pollard rho / ECM）依次让步、QS 与 NFS 充分对比、Shor 定位为「未来相关」
- `timeout_ms: 2400000`（40 min）— 6 成员 × 5 轮，给足余量，正常 ~35 min 收敛
- 不设 `token_budget` — 论题深，token 自然受限；先求收敛质量
- 无 `signoff_*` 参数 — `team_consensus` 设计上无 signoff 闸，全员 `agreed=true` 即通过（见源码 wf-013 注释）

### 4.4 执行流程（时序）

```
T+0m    master 调用 team_consensus (topic, max_rounds=5)
T+0m    OCTeam 并行 dispatch 6 个 mathematician，Round 1：各陈立场 + 复杂度阶层
T+0~5m  各成员给复杂度（O / 次指数 L[]）+ 60 位下的可行性判据
T+5m    Round 2：试除 / Pollard rho 自我否决（不可行）；ECM 让步
T+5~12m 弱候选承认被 sieve 系压制
T+12m   Round 3：QS vs NFS 辩 wall-clock vs 渐近；Shor 定位「未来相关」
T+12~20m 成员逐步收敛到 NFS（标准 / 可扩展 / 记录级）
T+20m   Round 4-5：全员 agreed=true，显式承认 Shor 未来相关性
T+20~35m 共识达成
T+35m   运行: bun check-math-factoring-consensus.ts <run_dir>
```

### 4.5 评判脚本

[`check-math-factoring-consensus.ts`](./check-math-factoring-consensus.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol,dave,erin,frank}.md`（6 个成员）
- **提取**：全局正则 `<consensus>([\s\S]*?)</consensus>`，取最后一个 tag 为最终轮
- **断言**：
  1. 每个成员至少含一个 `<consensus>` tag
  2. 每个成员最终轮 `agreed: true`（共识真达成，非 max_rounds 耗尽）
  3. 每个成员最终轮 `choice` 归一化后 ∈ 允许集 {`nfs`, `number-field-sieve`, `quadratic-sieve`, `qs`, `pollard-rho`, `ecm`, `shor`, `trial-division`}
  4. 至少一位成员的全文论证匹配关键词之一 `{sub-exponential, 60-digit, rsa, quantum}`（确认锚定 RSA 分解问题）

---

## 验收清单

- [ ] 4 个 check 脚本 `tsc -p docs/scenarios/tsconfig.json` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `simulator` / `coder` 均为预设）
- [ ] 每个 master 调用参数符合 `team_consensus` schema（`team_id` / `topic` / `max_rounds` / `timeout_ms`）
- [ ] 每个调用**无** `signoff_*` 参数（共识机制即闸，源码 wf-013）
- [ ] 易级场景（1-3）总时长 ≤ 24 min；挑战级场景 4 ≈ 35 min（6 成员 × `max_rounds=5`，刻意突破标准 30 min 上限作为规模扩展）
- [ ] 成员 prompt 中明确 `<consensus>` 输出格式约定，评判脚本与之对齐


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成「创建团队 → 激活 → 启动编排 → 等待汇总 → 运行评判脚本」的完整闭环。所有具体配置直接引用本 README 对应小节。

### 场景 1: 小规模排序选型（数学）

```text
执行 docs/scenarios/02-team-consensus/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_consensus JSON 启动编排
4. team_results 轮询至 master 收到汇总（consensus 最多 max_rounds 轮）
5. 定位 <run_dir>（含各成员 <member>.md）
6. 运行：bun docs/scenarios/02-team-consensus/check-math-sort-stability.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：所有成员最终轮 emit `"agreed": true`；共识 choice ∈ {insertion, timsort, merge}。
```

### 场景 2: 一维热传导时间格式选型（物理）

```text
执行 docs/scenarios/02-team-consensus/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_consensus JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/scenarios/02-team-consensus/check-physics-heat-diffusion.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：全员最终轮 `"agreed": true`；共识 choice ∈ {explicit, implicit, crank-nicolson}。
```

### 场景 3: 短文本字符串匹配选型（编程）

```text
执行 docs/scenarios/02-team-consensus/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_consensus JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/scenarios/02-team-consensus/check-coding-string-match.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：全员最终轮 `"agreed": true`；共识 choice ∈ {naive, kmp, boyer, sunday}。
```

### 场景 4: 60 位 RSA 模数分解算法选型（挑战级，数学）

```text
执行 docs/scenarios/02-team-consensus/README.md「场景 4」的完整闭环并自动评判（挑战级，6 成员 × max_rounds=5，预计 ~35 min）。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（6 个 mathematician）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_consensus JSON 启动编排（max_rounds=5）
4. team_results 轮询至 master 收到汇总（consensus 最多 5 轮，需较长等待）
5. 定位 <run_dir>（含 6 个成员 <member>.md）
6. 运行：bun docs/scenarios/02-team-consensus/check-math-factoring-consensus.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：6 成员最终轮全部 `"agreed": true`；每个 choice ∈ {nfs, number-field-sieve, quadratic-sieve, qs, pollard-rho, ecm, shor, trial-division}；至少一位成员论证提及 {sub-exponential, 60-digit, rsa, quantum} 之一。预期共识收敛到 NFS，并承认 Shor 量子算法的未来相关性。
```
