# team_arbitrate 编排场景设计

> **模式**：`team_arbitrate` — 两名辩手就一项争议辩论至多 `max_rounds` 轮，随后由一名仲裁（非辩手、非 master）权衡各方立场并下达**有约束力的裁决**。
> **源码**：[`src/tools/workflow-advanced.ts:343-397`](../../src/tools/workflow-advanced.ts)
> **控时设计**：每场景 3 成员（2 辩手 + 1 仲裁），`max_rounds=2`；每成员子任务 ≤ 8 min，总时长 ≈ 2 轮辩论 + 最终裁决 ≈ 12-18 min（远低于 30 min 上限）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role | max_rounds | 预计总时长 |
|---|------|------|--------|------|-----------|-----------|
| 1 | 数学 | 4×4 矩阵求逆法之争（直接 vs 迭代） | 3 | `mathematician` / `reviewer` | 2 | ~15 min |
| 2 | 计算物理 | 刚性 ODE 格式之争（显式 vs 隐式） | 3 | `simulator` / `physicist` | 2 | ~15 min |
| 3 | 编程 | 缓存淘汰策略之争（LRU vs LFU） | 3 | `coder` / `reviewer` | 2 | ~12 min |
| 4 | 计算物理 | 复杂边界 PDE 五方法之争（挑战级） | 6 | `physicist` / `reviewer` | 3 | ~40 min |

---

## 场景 1: 4×4 矩阵求逆法之争

### 1.1 场景描述

**背景**：稠密、良态（条件数 ~10）的小型 4×4 矩阵求逆，经典分歧是「直接法（高斯消元/ Gauss-Jordan）」还是「迭代法（如 Jacobi）」。两种路线在精度、开销、收敛性上的取舍截然不同，是数值线性代数的标准争议。

**目标**：两名辩手各自捍卫一种路线，仲裁综合双方论据下达裁决。

**争议命题**（即 `task`）：*"For inverting a dense, well-conditioned 4×4 matrix (condition number ~10), should you use direct Gaussian elimination or an iterative method (e.g. Jacobi)?"*

**成功标准（可机器评判）**：
- 两名辩手输出各含 `<!-- ARG: <一句话立场> -->` 标注
- 仲裁输出含 `<!-- RULING: <choice> -->`（期望 `direct`）与 `<!-- REASON: <text> -->`
- `REASON` 非空且提及关键术语（`condition` 或 `dense`）

### 1.2 Team 配置

```json
{
  "name": "matrix-inverse-debate",
  "description": "Arbitrate whether direct Gaussian elimination or an iterative method should invert a dense, well-conditioned 4x4 matrix",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are the proponent of DIRECT inversion (Gaussian elimination / Gauss-Jordan) for a dense, well-conditioned 4x4 matrix (condition number ~10). Argue precisely: a 4x4 system is tiny (fixed O(n^3)=O(64) flops), direct methods are exact up to round-off (no convergence criterion), need no diagonal dominance / SPD assumption, and iterative methods only shine for large sparse systems. Cite the operation count and the absence of a convergence loop. Rebut the iterative side's points. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are the proponent of ITERATIVE inversion (e.g. Jacobi) for a dense, well-conditioned 4x4 matrix (condition number ~10). Argue the iterative case as strongly as you can: iterative methods reuse matrix-vector products, avoid pivot instabilities, and their cost scales with desired accuracy. Note that for this specific small dense well-conditioned case the iteration converges fast (spectral radius of the Jacobi iteration matrix is well below 1), so few sweeps suffice. Rebut the direct side's points. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are the ARBITER. Two mathematicians debated whether to invert a dense, well-conditioned 4x4 matrix (condition number ~10) via DIRECT Gaussian elimination or an ITERATIVE method (e.g. Jacobi). Weigh both sides objectively, then deliver a single BINDING ruling. Recall the standard numerical-linear-algebra result: for small, dense, well-conditioned systems direct elimination is exact, assumption-free, and asymptotically cheaper in the constant-factor regime, while iterative methods are designed for large sparse systems. Your output MUST end with two lines exactly formatted: first <!-- RULING: direct --> (or <!-- RULING: iterative -->) then <!-- REASON: <one-sentence rationale referencing why, for this specific matrix class, the winner dominates> -->."
    }
  ]
}
```

**Role 选择理由**：辩手用 `mathematician`（`build` agent，能算 flop 数 / 谱半径佐证论点）；仲裁用 `reviewer`（只读角色，专司权衡证据、下达裁决，不偏袒任一方）。

### 1.3 Master 启动调用

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "matrix-inverse-debate",
    "task": "For inverting a dense, well-conditioned 4x4 matrix (condition number ~10), should you use direct Gaussian elimination or an iterative method (e.g. Jacobi)?",
    "arbiter": "carol",
    "debaters": ["alice", "bob"],
    "max_rounds": 2,
    "timeout_ms": 1200000
  }
}
```

**参数选择**：
- `arbiter: "carol"` — 指向名为 `carol` 的成员（role=`reviewer`）；仲裁**不得**是辩手或 master
- `debaters: ["alice", "bob"]` — 恰好 2 名唯一辩手，各持一派
- `max_rounds: 2` — 立论 + 反驳共两轮，足够暴露分歧（控时）
- `timeout_ms: 1200000`（20 min）— 2 轮辩论 + 裁决的硬上限，正常 ~15 min 完成
- 无 `signoff_*` — 仲裁裁决本身即为终点（等价 `none` 门）

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_arbitrate (max_rounds=2)
T+0m    Round 1: 并行 dispatch 2 名 mathematician 辩手立论
T+0~4m  各辩手写论据 (flop 数 / 收敛性 / 谱半径) + ARG 标记
T+4m    仲裁审阅 Round 1 双方输出
T+5m    Round 2: 并行 dispatch 2 名辩手反驳对方
T+5~8m  各辩手补充反驳，刷新 ARG 标记
T+8m    仲裁审阅 Round 2，下达有约束力裁决 (RULING + REASON)
T+9m    裁决交付 master
T+9m    运行: bun check-math-matrix-inverse.ts <run_dir>
```

### 1.5 评判脚本

[`check-math-matrix-inverse.ts`](./check-math-matrix-inverse.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol}.md`
- **提取**：
  - 辩手 `<!-- ARG:\s*(.+?)\s*-->`
  - 仲裁 `<!-- RULING:\s*(\w[\w-]*)\s*-->` 与 `<!-- REASON:\s*(.+?)\s*-->`
- **断言**：
  1. 两名辩手均产出 `ARG` 标记
  2. 仲裁 `RULING == "direct"`
  3. `REASON` 非空且包含 `condition` 或 `dense`（不区分大小写）

---

## 场景 2: 刚性 ODE 格式之争

### 2.1 场景描述

**背景**：刚性方程 `dy/dt = -1000·y`，`y(0)=1`，积分到 `t=1`，是稳定性压倒精度的教科书级例子。显式 RK4 虽高阶却受 CFL 类刚性约束（`dt < 2/1000 = 0.002`）才稳定；隐式后向 Euler 无条件稳定，虽仅一阶但能以大步长推进。

**目标**：两名辩手分别捍卫显式与隐式路线，仲裁聚焦「刚性下稳定性 vs 精度」下达裁决。

**争议命题**（即 `task`）：*"For the stiff ODE dy/dt = -1000·y, y(0)=1, integrated to t=1, should you use explicit RK4 or implicit backward Euler?"*

**成功标准（可机器评判）**：
- 两名辩手输出各含 `<!-- ARG: <一句话立场> -->` 标注
- 仲裁输出含 `<!-- RULING: implicit -->` 与 `<!-- REASON: <text> -->`
- `REASON` 非空且提及关键术语（`stiff` 或 `stability`）

### 2.2 Team 配置

```json
{
  "name": "stiff-ode-debate",
  "description": "Arbitrate whether explicit RK4 or implicit backward Euler should integrate the stiff ODE dy/dt=-1000y to t=1",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are the proponent of EXPLICIT RK4 for the stiff ODE dy/dt = -1000*y, y(0)=1, integrated to t=1. Argue the explicit case: RK4 is 4th-order accurate (local error O(dt^5)), cheap per step (no linear solve), and trivially parallelizable. Compute the stability limit: RK4's stable for |1 + z + z^2/2 + z^3/6 + z^4/24| <= 1 with z=-1000*dt, requiring dt < ~0.0028 (roughly 2/1000); at dt=0.001 you need ~1000 steps but each is cheap. Rebut the implicit side. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are the proponent of IMPLICIT backward Euler for the stiff ODE dy/dt = -1000*y, y(0)=1, integrated to t=1. Argue the implicit case: backward Euler is A-stable / unconditionally stable (amplification factor 1/(1+1000*dt) is always < 1), so you can take HUGE steps (e.g. dt=0.1, ~10 steps total) without blow-up; RK4 would need ~1000+ tiny steps (dt<0.0028) just to stay stable, swamping its accuracy advantage. For stiff problems stability dominates accuracy. Rebut the explicit side. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "physicist",
      "prompt": "You are the ARBITER. Two simulators debated whether to integrate the stiff ODE dy/dt = -1000*y (y(0)=1, to t=1) with EXPLICIT RK4 or IMPLICIT backward Euler. Weigh both sides objectively, then deliver a single BINDING ruling. Recall the governing principle: for stiff systems, the step size is dictated by stability (the fast mode -1000), not accuracy. RK4's explicit stability region forces dt < 2/1000 = 0.002 (hundreds-to-thousands of steps); backward Euler is A-stable and advances in a handful of large steps. Stability wins over per-step accuracy for stiff problems. Your output MUST end with two lines exactly formatted: first <!-- RULING: implicit --> (or <!-- RULING: explicit -->) then <!-- REASON: <one-sentence rationale referencing stiffness / CFL-like stability constraint> -->."
    }
  ]
}
```

**Role 选择理由**：辩手用 `simulator`（PDE/ODE 数值仿真专家，能推导稳定域、放大因子）；仲裁用 `physicist`（物理直觉判断刚性下稳定性优先于精度）。

### 2.3 Master 启动调用

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "stiff-ode-debate",
    "task": "For the stiff ODE dy/dt = -1000*y, y(0)=1, integrated to t=1, should you use explicit RK4 or implicit backward Euler?",
    "arbiter": "carol",
    "debaters": ["alice", "bob"],
    "max_rounds": 2,
    "timeout_ms": 1200000
  }
}
```

**参数选择**：
- `arbiter: "carol"` — role=`physicist` 的仲裁，裁决刚性 / 稳定性权衡
- `debaters: ["alice", "bob"]` — 显式派 vs 隐式派，恰好 2 名唯一辩手
- `max_rounds: 2` — 立论（稳定域推导）+ 反驳（步数对比）两轮
- `timeout_ms: 1200000`（20 min）— 硬上限

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_arbitrate (max_rounds=2)
T+0m    Round 1: 并行 dispatch 2 名 simulator 辩手立论
T+0~4m  各辩手推导稳定域 / 放大因子 / 步数估计 + ARG 标记
T+4m    仲裁 (physicist) 审阅 Round 1
T+5m    Round 2: 并行 dispatch 2 名辩手反驳
T+5~8m  各辩手反驳，刷新 ARG 标记
T+8m    仲裁审阅 Round 2，下达裁决 (RULING=implicit + REASON)
T+9m    裁决交付 master
T+9m    运行: bun check-physics-stiff-ode.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-stiff-ode.ts`](./check-physics-stiff-ode.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol}.md`
- **提取**：
  - 辩手 `<!-- ARG:\s*(.+?)\s*-->`
  - 仲裁 `<!-- RULING:\s*(\w[\w-]*)\s*-->` 与 `<!-- REASON:\s*(.+?)\s*-->`
- **断言**：
  1. 两名辩手均产出 `ARG` 标记
  2. 仲裁 `RULING == "implicit"`
  3. `REASON` 非空且包含 `stiff` 或 `stability`（不区分大小写）

---

## 场景 3: 缓存淘汰策略之争

### 3.1 场景描述

**背景**：单进程、容量 8 的缓存，工作负载呈强**时间局部性**（最近访问的 key 短期内大概率被再访问）且频率均匀。LRU（最近最少使用）与 LFU（最不常用）对这类负载的命中率差异显著，是缓存设计的经典争议。

**目标**：两名辩手分别捍卫 LRU 与 LFU，仲裁聚焦「时间局部性应优先以 recency 还是 frequency 淘汰」下达裁决。

**争议命题**（即 `task`）：*"For a single-process cache of capacity 8 serving a workload with strong temporal locality (recently-accessed keys likely re-accessed soon) and uniform frequencies, should you use LRU or LFU eviction?"*

**成功标准（可机器评判）**：
- 两名辩手输出各含 `<!-- ARG: <一句话立场> -->` 标注
- 仲裁输出含 `<!-- RULING: lru -->` 与 `<!-- REASON: <text> -->`
- `REASON` 非空且提及关键术语（`temporal` 或 `recency`）

### 3.2 Team 配置

```json
{
  "name": "cache-eviction-debate",
  "description": "Arbitrate LRU vs LFU eviction for a capacity-8 cache under strong temporal locality and uniform frequencies",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are the proponent of LRU (Least Recently Used) eviction for a single-process cache of capacity 8 under a workload with STRONG TEMPORAL LOCALITY (recently-accessed keys are likely re-accessed soon) and UNIFORM frequencies. Argue: LRU orders by recency, which directly tracks temporal locality; it promotes the just-touched key and evicts the one longest unseen, matching the reuse pattern. It is O(1) per op (hash map + doubly-linked list), simple, and adapts to access-pattern shifts. Cite that with uniform frequencies, LFU's frequency signal carries no discriminating information, so recency is the only useful signal. Rebut the LFU side. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are the proponent of LFU (Least Frequently Used) eviction for a single-process cache of capacity 8 under a workload with STRONG TEMPORAL LOCALITY and UNIFORM frequencies. Argue the LFU case as strongly as you can: LFU retains frequently-used items, giving stable hit rates for repeated popular keys; it is not fooled by a single recent touch; and frequency is a robust long-term signal. Acknowledge the uniform-frequency caveat but argue LFU degrades gracefully and avoids LRU's vulnerability to scan/churn patterns. Rebut the LRU side. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are the ARBITER. Two coders debated whether a single-process capacity-8 cache under STRONG TEMPORAL LOCALITY (recently-accessed keys likely re-accessed soon) and UNIFORM frequencies should use LRU or LFU eviction. Weigh both sides objectively, then deliver a single BINDING ruling. Recall the caching principle: when temporal locality dominates and frequencies are uniform, recency (LRU) is the signal that tracks the access pattern; frequency (LFU) carries little information when frequencies are uniform and can even retain stale popular items. Your output MUST end with two lines exactly formatted: first <!-- RULING: lru --> (or <!-- RULING: lfu -->) then <!-- REASON: <one-sentence rationale referencing temporal locality / recency> -->."
    }
  ]
}
```

**Role 选择理由**：辩手用 `coder`（能讲清 O(1) 实现、链表 + hashmap、scan 抗性等工程细节）；仲裁用 `reviewer`（权衡两派工程论据，下达裁决）。

### 3.3 Master 启动调用

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "cache-eviction-debate",
    "task": "For a single-process cache of capacity 8 serving a workload with strong temporal locality (recently-accessed keys likely re-accessed soon) and uniform frequencies, should you use LRU or LFU eviction?",
    "arbiter": "carol",
    "debaters": ["alice", "bob"],
    "max_rounds": 2,
    "timeout_ms": 1080000
  }
}
```

**参数选择**：
- `arbiter: "carol"` — role=`reviewer`，裁决局部性 / recency 权衡
- `debaters: ["alice", "bob"]` — LRU 派 vs LFU 派
- `max_rounds: 2` — 立论（实现 + 复杂度）+ 反驳（scan 抗性 / 频率均匀）两轮
- `timeout_ms: 1080000`（18 min）— 纯文字辩论，略短于数值场景

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_arbitrate (max_rounds=2)
T+0m    Round 1: 并行 dispatch 2 名 coder 辩手立论
T+0~4m  各辩手写淘汰策略论据 (复杂度 / scan 抗性 / 局部性) + ARG 标记
T+4m    仲裁审阅 Round 1
T+5m    Round 2: 并行 dispatch 2 名辩手反驳
T+5~7m  各辩手反驳，刷新 ARG 标记
T+7m    仲裁审阅 Round 2，下达裁决 (RULING=lru + REASON)
T+8m    裁决交付 master
T+8m    运行: bun check-coding-cache-eviction.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-cache-eviction.ts`](./check-coding-cache-eviction.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol}.md`
- **提取**：
  - 辩手 `<!-- ARG:\s*(.+?)\s*-->`
  - 仲裁 `<!-- RULING:\s*(\w[\w-]*)\s*-->` 与 `<!-- REASON:\s*(.+?)\s*-->`
- **断言**：
  1. 两名辩手均产出 `ARG` 标记
  2. 仲裁 `RULING == "lru"`
  3. `REASON` 非空且包含 `temporal` 或 `recency`（不区分大小写）

---

## 场景 4: 复杂边界 PDE 五方法之争（挑战级）

> **挑战级**：6 成员（5 辩手 + 1 仲裁）、`max_rounds=3`、预计 ~40 min，刻意突破标准模板（≤4 成员 / ≤30 min）以压力测试 `team_arbitrate` 在五派辩论下的扩展性。

### 4.1 场景描述

**背景**：一类同时具备三个难点的 PDE——**复杂弯曲边界**（需非结构网格贴合）、**对流占优输运**（易产生数值振荡、需稳定化）、**非线性源项**（排除仅适用于线性问题的方法）。五种主流离散化路线（FEM、FDM、FVM、Spectral、BEM）在几何适应性、对流稳定化、非线性处理上各有取舍，是计算物理中开放性最强的数值方法选择争议之一。

**目标**：五名辩手各自捍卫一种离散化路线，仲裁综合「几何适应性 + 对流稳定化 + 非线性处理」三维度下达裁决。

**争议命题**（即 `task`）：*"For a PDE with a complex CURVED boundary, advection-dominated transport, AND a nonlinear source term, which numerical method should you choose: FEM, FDM, FVM, Spectral, or BEM?"*

**成功标准（可机器评判）**：
- 五名辩手输出各含 `<!-- ARG: <一句话立场> -->` 标注
- 仲裁输出含 `<!-- RULING: <method> -->`（`method` ∈ {fem, fdm, fvm, spectral, bem}）与 `<!-- REASON: <text> -->`
- `REASON` 非空且至少提及 `{curved, boundary, advection, nonlinear, flux, mesh}` 中的两项（不区分大小写）
- **物理预期**：FEM 或 FVM 胜出——两者都能通过非结构网格贴合弯曲边界、通过稳定化 / 通量限制处理对流占优，并自然纳入非线性源项；Spectral 难以适应复杂几何，FDM 在弯曲边界上费力，BEM 仅适用于线性问题（非线性源项直接排除 BEM）。

### 4.2 Team 配置

```json
{
  "name": "pde-method-five-way-debate",
  "description": "Arbitrate among FEM, FDM, FVM, Spectral, and BEM for a PDE with a complex curved boundary, advection-dominated transport, and a nonlinear source term",
  "members": [
    {
      "name": "alice",
      "role": "physicist",
      "prompt": "You are the proponent of FEM (Finite Element Method) for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue: FEM handles arbitrary geometries via unstructured (triangular / tetrahedral) meshes that conform to curved boundaries; advection dominance is tamed by SUPG / GLS stabilization or discontinuous Galerkin; the nonlinear source term is incorporated naturally via the weak form and solved by Newton iteration. The variational framework is mathematically rigorous (Lax-Milgram / Galerkin orthogonality). Rebut the other four methods. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "physicist",
      "prompt": "You are the proponent of FDM (Finite Difference Method) for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue the FDM case as strongly as you can: FDM is conceptually simple and trivially vectorizable, and the nonlinear source term is a local pointwise evaluation (no integration needed). Modern immersed-boundary / cut-cell / overset-grid techniques adapt structured differences to curved geometries without unstructured meshes, and high-order compact schemes rival spectral accuracy on smooth regions. Rebut the other four methods. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "physicist",
      "prompt": "You are the proponent of FVM (Finite Volume Method) for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue: FVM is exactly locally conservative (integral flux form), which is essential for advection-dominated transport; upwind / flux-limiter / MUSCL / WENO schemes suppress oscillations without excessive numerical diffusion; unstructured FVM meshes conform to curved boundaries just like FEM; the nonlinear source term is a cell-average contribution. FVM is the workhorse of CFD for exactly these reasons. Rebut the other four methods. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "dave",
      "role": "physicist",
      "prompt": "You are the proponent of SPECTRAL methods for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue the spectral case as strongly as you can: spectral methods achieve exponential convergence for smooth solutions (error ~ exp(-N)), far outperforming algebraic-order FEM / FDM / FVM; spectral-element / nodal-DG variants patch spectral bases onto curved elements to recover geometric flexibility; dealiasing (the 3/2 rule) handles the nonlinear source term; advection is treated with spectral upwinding. Rebut the other four methods. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "erin",
      "role": "physicist",
      "prompt": "You are the proponent of BEM (Boundary Element Method) for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue the BEM case as strongly as you can: BEM discretizes ONLY the boundary (dimensionality reduction by one — a 3D PDE becomes a 2D surface mesh), so the curved boundary is its natural input; the far-field is exact (no artificial truncation); the resulting system is smaller and dense. Address the advection and nonlinearity concerns via domain-integral formulations or hybrid BEM-FEM coupling. Rebut the other four methods. Your output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are the ARBITER. Five physicists debated which numerical method — FEM, FDM, FVM, Spectral, or BEM — should solve a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Weigh all five sides objectively across three dimensions — (1) geometry adaptability to the curved boundary, (2) stability under advection dominance, (3) handling the nonlinear source — then deliver a single BINDING ruling. Recall the governing trade-offs: FEM and FVM conform to curved boundaries via unstructured meshes and tame advection via SUPG / flux-limiting respectively, and both admit the nonlinear source term naturally; FDM struggles to conform to curved boundaries; Spectral methods lose their exponential-convergence advantage and geometric flexibility on complex domains; BEM requires a linear PDE with a known fundamental solution, so the nonlinear source term fundamentally disqualifies it. Your output MUST end with two lines exactly formatted: first <!-- RULING: fem --> (or <!-- RULING: fdm --> / <!-- RULING: fvm --> / <!-- RULING: spectral --> / <!-- RULING: bem -->) then <!-- REASON: <one-sentence rationale referencing at least two of: curved boundary, advection, nonlinearity, flux, mesh> -->."
    }
  ]
}
```

**Role 选择理由**：5 名辩手均用 `physicist`（计算物理数值方法专家，能讲清弱形式 / 通量守恒 / 稳定域 / 谱收敛 / Green 函数等论据）；仲裁用 `reviewer`（只读角色，跨五方客观权衡，不偏袒任一方法）。

### 4.3 Master 启动调用

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "pde-method-five-way-debate",
    "task": "For a PDE with a complex CURVED boundary, advection-dominated transport, AND a nonlinear source term, which numerical method should you choose: FEM, FDM, FVM, Spectral, or BEM?",
    "arbiter": "frank",
    "debaters": ["alice", "bob", "carol", "dave", "erin"],
    "max_rounds": 3,
    "timeout_ms": 2400000
  }
}
```

**参数选择**：
- `arbiter: "frank"` — role=`reviewer` 的仲裁，非辩手、非 master；裁决几何 / 对流 / 非线性三维权衡
- `debaters: ["alice", "bob", "carol", "dave", "erin"]` — 恰好 5 名唯一辩手，分持 FEM / FDM / FVM / Spectral / BEM
- `max_rounds: 3` — 立论 + 交叉反驳 + 终辩共三轮（五派分歧大，两轮不足以暴露全部取舍）
- `timeout_ms: 2400000`（40 min）— 5 名辩手 × 3 轮 + 裁决的硬上限，挑战级场景刻意放宽
- 无 `signoff_*` — 仲裁裁决本身即为终点（等价 `none` 门）

### 4.4 执行流程（时序）

```
T+0m     master 调用 team_arbitrate (max_rounds=3)
T+0m     Round 1: 并行 dispatch 5 名 physicist 辩手立论
T+0~6m   各辩手写方法论据 (弱形式 / 通量守恒 / 稳定化 / 谱收敛 / Green 函数) + ARG 标记
T+6m     仲裁 (reviewer) 审阅 Round 1 五方输出
T+7m     Round 2: 并行 dispatch 5 名辩手交叉反驳
T+7~14m  各辩手反驳其余四派，刷新 ARG 标记
T+14m    仲裁审阅 Round 2
T+15m    Round 3: 并行 dispatch 5 名辩手终辩
T+15~22m 各辩手终辩收束，刷新 ARG 标记
T+22m    仲裁审阅 Round 3，下达有约束力裁决 (RULING + REASON)
T+24m    裁决交付 master
T+24m    运行: bun check-physics-pde-arbitrate.ts <run_dir>
```

### 4.5 评判脚本

[`check-physics-pde-arbitrate.ts`](./check-physics-pde-arbitrate.ts)

- **加载**：`runs/<run_id>/{alice,bob,carol,dave,erin,frank}.md`
- **提取**：
  - 辩手 `<!-- ARG:\s*(.+?)\s*-->`
  - 仲裁 `<!-- RULING:\s*(\w[\w-]*)\s*-->` 与 `<!-- REASON:\s*(.+?)\s*-->`
- **断言**：
  1. 五名辩手均产出 `ARG` 标记
  2. 仲裁 `RULING` ∈ {fem, fdm, fvm, spectral, bem}
  3. `REASON` 非空且至少包含 `{curved, boundary, advection, nonlinear, flux, mesh}` 中的两项（不区分大小写）

---

## 验收清单

- [ ] 3 个 check 脚本 `tsc -p docs/orchestration-scenarios/tsconfig.json` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `simulator` / `coder` / `reviewer` / `physicist` 均为预设）
- [ ] 每个 master 调用参数符合 `team_arbitrate` schema（`arbiter` 非 master、非辩手；`debaters` ≥2 且唯一）
- [ ] 每场景总时长 ≤ 18 min（远低于 30 min 上限）
- [ ] 成员 prompt 中明确输出格式约定（`ARG` / `RULING` / `REASON` marker），评判脚本与之对齐


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成完整闭环。arbitrate 模式评判读 **carol** 成员的最终裁决（含 RULING / REASON marker）。

### 场景 1: 4×4 矩阵求逆法之争（数学）

```text
执行 docs/orchestration-scenarios/07-team-arbitrate/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（2 debater + 1 arbiter）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_arbitrate JSON 启动编排
4. team_results 轮询至 master 收到汇总（辩手辩论后 arbiter 出裁决）
5. 定位 <run_dir>（含 carol 成员 .md）
6. 运行：bun docs/orchestration-scenarios/07-team-arbitrate/check-math-matrix-inverse.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：arbiter RULING = direct；REASON 含 condition 或 dense（4×4 稠密良态矩阵直接法胜出）。
```

### 场景 2: 刚性 ODE 格式之争（物理）

```text
执行 docs/orchestration-scenarios/07-team-arbitrate/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_arbitrate JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/07-team-arbitrate/check-physics-stiff-ode.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：arbiter RULING = implicit；REASON 含 stiff 或 stability（dy/dt=-1000y 显式受 dt<0.002 限制）。
```

### 场景 3: 缓存淘汰策略之争（编程）

```text
执行 docs/orchestration-scenarios/07-team-arbitrate/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_arbitrate JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/07-team-arbitrate/check-coding-cache-eviction.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：arbiter RULING = lru；REASON 含 temporal 或 recency（强时间局部性 workload 偏好 LRU）。
```

### 场景 4: 复杂边界 PDE 五方法之争（物理 · 挑战级）

```text
执行 docs/orchestration-scenarios/07-team-arbitrate/README.md「场景 4」的完整闭环并自动评判。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（5 debater + 1 arbiter，挑战级）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_arbitrate JSON 启动编排（max_rounds=3）
4. team_results 轮询至 master 收到汇总（五方三轮辩论后 arbiter 出裁决）
5. 定位 <run_dir>（含 frank 成员 .md）
6. 运行：bun docs/orchestration-scenarios/07-team-arbitrate/check-physics-pde-arbitrate.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：arbiter RULING ∈ {fem, fdm, fvm, spectral, bem}；REASON 至少含 {curved, boundary, advection, nonlinear, flux, mesh} 中两项（复杂边界 + 对流占优 + 非线性源项，物理预期 FEM/FVM 胜出）。
```
