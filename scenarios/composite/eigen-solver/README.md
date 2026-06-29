# 综合场景：大规模矩阵本征值求解器开发

用 Rust 开发一个 1000×1000 稠密矩阵本征值求解器的端到端工作流：**方法调研 → 方案比选 → 计划+评审 → 实现 → 优化重构 → 代码评审**，6 个独立团队 × 5 种编排原语串联。master 作集成枢纽，团队间彼此隔离、数据手递手。

**自用模板**：不含评判脚本，最终求解器是否正确、性能是否达标**由你自行判断**。

## 核心约束

| 维度 | 约束 |
|------|------|
| 矩阵规模 | 1000 × 1000 稠密实矩阵 |
| 语言 | Rust |
| 加速限制 | 不使用 GPU / 并行加速（纯 CPU 单线程） |
| 基线 | 优化重构后必须通过全部已有测试，保证结果正确性 |

## 工作流总览

| 阶段 | 团队 | 编排原语 | 输入 | 产出（交接 marker） |
|------|------|---------|------|---------------------|
| ① 方法调研 | **research-team** | `team_parallel` | 需求文档 + 外部文献/竞品 | `<!-- METHOD: <id>:<name> -->` × ≥8 |
| ② 方案比选 | **selection-team** | `team_consensus` | 方法清单 | `<!-- SHORTLISTED: <id> -->` 精确 3 条 |
| ③ 计划+评审 | **plan-team** | `team_tollgate` | 3 条入选方案 | `<!-- PLAN-APPROVED -->` |
| ④ 实现 | **implement-team** | `team_pipeline` | 批准的计划 | 求解器代码 + 测试 |
| ⑤ 优化重构 | **optimize-team** | `team_loop` | 已实现的代码 | 优化后代码 + 基线通过（`<!-- OPTIMIZED -->`） |
| ⑥ 代码评审 | **review-team** | `team_parallel` | 优化后的代码 | `<!-- REVIEW: <dim>: pass|fail -->` × 4 维 |

用到 5 种编排：**parallel / consensus / tollgate / pipeline / loop**（parallel 在调研与评审各用一次，tollgate 用于计划的多评审人门控）。

```
需求文档 + 外部文献/竞品
        │
        ▼
research-team (parallel)    ──≥8 methods──► master
                                                │
selection-team (consensus)  ◄──methods──────────┘
        │
        └──3 shortlisted──────────────────► master
                                                │
plan-team (tollgate)        ◄──3 shortlisted────┘
        │  编写→审1→改→审2→改→审3（全部通过）
        └──PLAN-APPROVED──────────────────► master
                                                │
implement-team (pipeline)   ◄──plan─────────────┘
        │  coder→tester
        └──code+tests─────────────────────► master
                                                │
optimize-team (loop)        ◄──code─────────────┘
        │  优化→测试→裁决（基线保证）
        └──OPTIMIZED──────────────────────► master
                                                │
review-team (parallel)      ◄──optimized code───┘
        │
        └──review verdicts────────────────► master ──► 你判断
```

## 如何使用

1. **对象**：本场景生成一个 Rust 矩阵本征值求解器。无需占位符——求解器从零构建。
2. **依次跑 6 个团队**（§1–§6）。每个团队走完整生命周期：`team_create` → `team_activate` → `team_<mode>` → 收产出 → `team_deactivate`。
3. **交接**：每个团队的 marker 产出由 master 汇总，作为下一个团队的输入（methods → topic；shortlisted → plan 输入；approved plan → tollgate 输出到 pipeline；code → loop 输入；optimized code → audit 对象）。
4. **判断**：你读取 review-team 的多维结论与各团队输出，自行裁定求解器是否达到预期。本场景**不设评判脚本**。

## team 切换铁律

同一时刻**仅一个团队** active。`team_activate` 在已有 active 团队时会拒绝——**必须先 `team_deactivate` 再 `team_activate` 下一个**。每个团队段的 master 步骤都已显式写出 deactivate。

---

## §1 research-team（`team_parallel`）— 方法调研

### 1.1 阶段说明

5 名研究员**并行**调研，每人一个维度（维度烤进成员 prompt，parallel 跑 isolated）。覆盖：经典算法（QR、分治、二分法、Jacobi）、竞品库（LAPACK、ARPACK、SLEPc、Eigen）、Rust 生态（nalgebra、faer、lax、gemm）、数值稳定性考量、问题特定优化。每人至少提 3 个候选方法 → 合计 ≥8 （剔除重复项之后）。

### 1.2 Team 配置

```json
{
  "name": "es-research",
  "description": "Eigen-solver research team: 5 researchers survey algorithms, competitors, and Rust ecosystem in parallel",
  "members": [
    {
      "name": "alice",
      "role": "researcher",
      "prompt": "You research CLASSIC EIGENSOLVER ALGORITHMS for dense real matrices. Cover: QR algorithm (with shifts), divide-and-conquer (DSYEVD family), bisection + inverse iteration, Jacobi eigenvalue algorithm, power iteration + deflation. For each candidate method, explain its approach, computational complexity (flops for 1000×1000), convergence properties, and numerical stability. For each you propose, emit a line exactly formatted: <!-- METHOD: <stable-kebab-id>:<name> --> followed by: approach summary, complexity, stability notes, suitability for 1000×1000 dense real matrix. Propose at least 2 candidates."
    },
    {
      "name": "bob",
      "role": "researcher",
      "prompt": "You research COMPETITOR LIBRARIES and their algorithmic choices for dense eigenvalue problems. Cover: LAPACK (DSYEV/DSYEVD/DSYEVX/DSYEVR), ARPACK (implicitly restarted Arnoldi), SLEPc, Eigen C++ (EigenSolver/SelfAdjointEigenSolver), Julia's LinearAlgebra.eigen. Identify which algorithms they use for 1000×1000 dense real symmetric matrices, and what tradeoffs they make. For each insight/candidate you find, emit: <!-- METHOD: <stable-kebab-id>:<name> --> followed by: which library uses it, algorithm details, why it works for this scale. Propose at least 2 candidates."
    },
    {
      "name": "carol",
      "role": "researcher",
      "prompt": "You research the RUST ECOSYSTEM for numerical linear algebra. Cover: nalgebra, faer-rs, lax (LAPACK bindings), gemm, ndarray-linalg, rustfft, matrixmultiply. Evaluate each crate's maturity, eigen-solver support (if any), performance characteristics, and integration feasibility. For each candidate approach (use existing crate vs. implement from scratch vs. FFI to LAPACK), emit: <!-- METHOD: <stable-kebab-id>:<name> --> followed by: crate/approach evaluation, pros/cons, maturity assessment. Propose at least 2 candidates."
    },
    {
      "name": "dave",
      "role": "researcher",
      "prompt": "You research NUMERICAL STABILITY & ACCURACY considerations for eigenvalue computation of 1000×1000 dense matrices. Cover: conditioning of eigenvalue problems, effect of rounding errors, forward/backward stability of different algorithms, accuracy of computed eigenvectors (residual checks), handling of near-defective matrices. For each candidate best-practice or algorithm preference from stability angle, emit: <!-- METHOD: <stable-kebab-id>:<name> --> followed by: the stability issue, recommended approach, what to watch out for. Propose at least 2 candidates."
    },
    {
      "name": "erin",
      "role": "analyst",
      "prompt": "You synthesize PROBLEM-SPECIFIC OPTIMIZATIONS for 1000×1000 dense eigen-solvers. Consider: matrix is real but may not be symmetric — how does this constrain algorithms? memory footprint of 1000×1000 f64 (~8 MB), cache blocking strategies, loop ordering for matrix operations, workspace pre-allocation, convergence criteria tuning for 'engineering accuracy' vs 'machine precision'. For each optimization candidate or algorithmic recommendation, emit: <!-- METHOD: <stable-kebab-id>:<name> --> followed by: the specific optimization, expected benefit, implementation effort. Propose at least 2 candidates."
    }
  ]
}
```

**Role 选择**：alice/bob/carol/dave 用 `researcher`（外部调研），erin 用 `analyst`（综合优化分析）。5 人对称，差异来自维度 prompt。

### 1.3 Master 启动调用

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "es-research",
    "mode": "isolated",
    "task": "Research YOUR ASSIGNED DIMENSION (see your role brief) to identify algorithms, approaches, and techniques for solving the eigenvalue problem of a 1000×1000 dense real matrix in Rust (no GPU/parallel acceleration). Propose at least 2 candidates. For each, emit the <!-- METHOD: <id>:<name> --> marker exactly as your brief specifies, followed by your dimension's analysis. Report every candidate you find.",
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `mode: isolated` + 维度烤进 prompt——5 路并行各扫一个维度，互不重叠。
- 不设 `signoff_policy`——parallel 默认无 signoff，跑完即汇总。

### 1.4 生命周期步骤（master）

```
team_create(es-research)
team_activate(es-research)
team_parallel(...)            # §1.3
# 等待 5 名研究员产出 → team_results 取汇总
team_deactivate(es-research)
```

### 1.5 产出与交接

- master 从 5 份输出抓取所有 `<!-- METHOD: <id>:<name> -->`，汇总成**方法候选清单**（id + name + 各维度分析，应 ≥8 条）。
- 这张清单作为 §2 `team_consensus` 的 `topic`。

---

## §2 selection-team（`team_consensus`）— 方案比选

### 2.1 阶段说明

5 名 debater（2 researcher + 2 architect + 1 analyst）多轮辩论候选方法，综合**数值稳定性 / 实现复杂度 / 性能 / 可维护性**，收敛选出**精确 3 条**最具可行性的算法/技术路线。

### 2.2 Team 配置

```json
{
  "name": "es-selection",
  "description": "Eigen-solver selection team: 5 debaters weigh methods on stability/complexity/performance/maintainability and converge on exactly 3",
  "members": [
    {
      "name": "frank",
      "role": "researcher",
      "prompt": "You debate which approaches to select for implementing the eigen-solver. For each candidate method argue from NUMERICAL STABILITY angle: is the algorithm backward stable? accuracy of computed eigenvalues/eigenvectors? convergence guarantee? Weigh stability, complexity, performance, maintainability. Reach agreement with your teammates to select EXACTLY THREE. In your FINAL message, emit exactly one line per selected method: <!-- SHORTLISTED: <method-id> --> followed by a short rationale (why this one, stability perspective)."
    },
    {
      "name": "grace",
      "role": "architect",
      "prompt": "You debate which approaches to select for implementing the eigen-solver. For each candidate method argue from IMPLEMENTATION COMPLEXITY angle: how much code to write? what are the key data structures? how hard to debug? Weigh stability, complexity, performance, maintainability. Reach agreement with your teammates to select EXACTLY THREE. In your FINAL message, emit exactly one line per selected method: <!-- SHORTLISTED: <method-id> --> followed by a short rationale (complexity perspective)."
    },
    {
      "name": "henry",
      "role": "researcher",
      "prompt": "You debate which approaches to select for implementing the eigen-solver. For each candidate method argue from PERFORMANCE angle: flop count for 1000×1000, convergence speed, memory footprint, cache behavior. Weigh stability, complexity, performance, maintainability. Reach agreement with your teammates to select EXACTLY THREE. In your FINAL message, emit exactly one line per selected method: <!-- SHORTLISTED: <method-id> --> followed by a short rationale (performance perspective)."
    },
    {
      "name": "iris",
      "role": "architect",
      "prompt": "You debate which approaches to select for implementing the eigen-solver. For each candidate method argue from MAINTAINABILITY & EXTENSIBILITY angle: modularity, testability, documentation, how easy to modify later. Weigh stability, complexity, performance, maintainability. Reach agreement with your teammates to select EXACTLY THREE. In your FINAL message, emit exactly one line per selected method: <!-- SHORTLISTED: <method-id> --> followed by a short rationale (maintainability perspective)."
    },
    {
      "name": "jack",
      "role": "analyst",
      "prompt": "You debate which approaches to select for implementing the eigen-solver. For each candidate method argue from OVERALL TRADEOFF angle: synthesize all dimensions, recommend the best 3 that balance stability, complexity, performance, and maintainability. Weigh stability, complexity, performance, maintainability. Reach agreement with your teammates to select EXACTLY THREE. In your FINAL message, emit exactly one line per selected method: <!-- SHORTLISTED: <method-id> --> followed by a balanced rationale synthesizing all perspectives."
    }
  ]
}
```

**Role 选择**：frank/henry `researcher`（稳定性/性能视角），grace/iris `architect`（复杂度/可维护性视角），jack `analyst`（综合权衡）。五视角交叉。

### 2.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "es-selection",
    "topic": "<把 §1.5 的方法候选清单原文粘进来：每条 METHOD id/name/各维度分析>. From these candidates, select EXACTLY THREE approaches to implement a 1000×1000 dense eigen-solver in Rust (no GPU/parallel). Weigh numerical stability, implementation complexity, performance, and maintainability. Each member must emit <!-- SHORTLISTED: <id> --> for exactly 3 candidates in their final message, all converging to the same 3.",
    "max_rounds": 5,
    "timeout_ms": 2400000
  }
}
```

**参数选择**：
- `topic` = 候选清单（master 手递手填入）。
- `max_rounds: 5`——给足辩论空间收敛到精确 3 个。

### 2.4 生命周期步骤（master）

```
team_create(es-selection)
team_activate(es-selection)   # （此时 es-research 已 deactivate）
team_consensus(...)           # topic = §1.5 候选清单
# 等待共识 → team_results 取汇总
team_deactivate(es-selection)
```

### 2.5 产出与交接

- master 抓取所有 `<!-- SHORTLISTED: <id> -->`，确认收敛到同一组 3 个 id。
- 这 3 条入选方案作为 §3 plan-team 的输入（tollgate 各阶段需据此编写计划）。

---

## §3 plan-team（`team_tollgate`）— 计划 + 评审

### 3.1 阶段说明

为入选的 3 条算法编写**实施计划**。每条方案分别撰写计划（含架构、数据结构和测试策略），然后依次通过 3 个评审人的门控。每个评审人专注不同维度：

- **评审人 1（完整性与范围）**：计划是否覆盖了全部必要的模块？
- **评审人 2（技术正确性）**：算法伪代码是否正确？复杂度分析是否合理？
- **评审人 3（可测性与风险）**：测试策略是否完备？风险是否被识别？

任意评审人 FAIL 计划即回退到编写阶段修改，**三人都必须 PASS**（串联门控）。最多允许各评审人各 2 次重试。

> ⚠️ **tollgate 规则**：每个 stage 的 `verifier` 不能等于该 stage 的 `member`。各 verifier 独立不重复。

### 3.2 Team 配置

```json
{
  "name": "es-plan",
  "description": "Eigen-solver plan team: writer drafts plan for 3 selected methods, 3 reviewer gates verify in series — all must pass",
  "members": [
    {
      "name": "kate",
      "role": "coder",
      "prompt": "You are the PLAN WRITER. Write a detailed implementation plan for each of the selected 3 eigen-solver approaches. Each plan must cover: algorithm pseudocode, data structures (matrix representation, workspace), module breakdown (under src/), function signatures, error handling strategy, convergence criteria, test strategy (unit tests for individual routines, integration tests for full solver), numerical accuracy baseline, and risks/mitigations. When a verifier returns FAIL with specific gaps, address those gaps in your revision and explain what changed."
    },
    {
      "name": "leo",
      "role": "reviewer",
      "prompt": "You are VERIFIER 1 — COMPLETENESS & SCOPE. For each selected method's implementation plan, check: does it cover ALL necessary modules (matrix ops, Hessenberg reduction, QR iteration, eigenvector back-transform, convergence check, driver API)? are the module boundaries well-defined? is every component accounted for? Emit PASS if fully complete, or FAIL naming exactly which sections are missing or underspecified."
    },
    {
      "name": "mona",
      "role": "reviewer",
      "prompt": "You are VERIFIER 2 — TECHNICAL CORRECTNESS. For each selected method's implementation plan, check: are the algorithm steps correct? are the convergence criteria mathematically sound? are complexity/flop estimates accurate? are numerical stability concerns addressed? Emit PASS if technically correct, or FAIL naming specific algorithmic errors, missing steps, or incorrect assumptions."
    },
    {
      "name": "nina",
      "role": "reviewer",
      "prompt": "You are VERIFIER 3 — TESTABILITY & RISK. For each selected method's implementation plan, check: are unit/integration/regression tests specified? are edge cases (zero matrix, identity, repeated eigenvalues, ill-conditioned) covered? are risks (non-convergence, memory, numerical drift) identified with mitigations? Emit PASS if adequately testable and risk-aware, or FAIL naming gaps."
    }
  ]
}
```

**Role 选择**：kate `coder`（编写计划，modify），leo/mona/nina `reviewer`（只读门控评审）。

### 3.3 Master 启动调用

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "es-plan",
    "stages": [
      {
        "member": "kate",
        "task": "Write a comprehensive implementation plan for the 3 selected eigen-solver approaches. Selected methods (from §2): <把 §2.5 的 3 条 SHORTLISTED id+描述粘进来>. For each method, produce: algorithm pseudocode, data structures, module breakdown, function signatures, convergence criteria, test strategy, accuracy baseline, risks/mitigations.",
        "verifier": "leo",
        "criteria": "Check the plan for COMPLETENESS: does it cover ALL necessary modules? matrix operations, reduction (Hessenberg/tridiagonal), iteration kernel, eigenvector computation, convergence check, driver API. Are module boundaries clear? Emit PASS if fully complete, FAIL naming what is missing."
      },
      {
        "member": "kate",
        "task": "Revise the implementation plan based on Verifier 1's FAIL feedback if any. If Verifier 1 passed, confirm the plan stands unchanged. Address every gap the verifier named.",
        "verifier": "mona",
        "criteria": "Check the plan for TECHNICAL CORRECTNESS: algorithm steps correct? convergence criteria mathematically sound? complexity estimates accurate? numerical stability addressed? Emit PASS if technically correct, FAIL naming specific algorithmic errors or incorrect assumptions."
      },
      {
        "member": "kate",
        "task": "Revise the implementation plan based on previous verifiers' FAIL feedback if any. If all previous verifiers passed, confirm the plan stands unchanged. Address every gap named.",
        "verifier": "nina",
        "criteria": "Check the plan for TESTABILITY & RISK: are unit/integration/regression tests specified? edge cases covered? risks (non-convergence, memory, numerical) identified and mitigated? Emit PASS if adequate, FAIL naming gaps."
      }
    ],
    "max_gate_retries": 2,
    "max_invalid_cycles": 2,
    "timeout_ms": 3000000
  }
}
```

**参数选择**：
- `stages` 串行 3 个门控：kate 编写/修订 → leo 完整门 → kate 修订 → mona 正确门 → kate 修订 → nina 可测门。前一门 FAIL 才触发修订 PASS 则跳过修订直接到下一门。
- `max_gate_retries: 2`——每个评审人最多退回 2 次，超过则整体失败。
- `max_invalid_cycles: 2`——防止评审标准争议导致无限循环。
- 不设 `signoff_policy`——tollgate 的 PASS/FAIL 机制本身就是终止门。

### 3.4 生命周期步骤（master）

```
team_create(es-plan)
team_activate(es-plan)        # （此时 es-selection 已 deactivate）
team_tollgate(...)            # stages 如上，含 §2.5 的 3 个入选方案
# 等待三个门全部 PASS 或任一耗尽重试 → team_results 取最终计划
team_deactivate(es-plan)
```

### 3.5 产出与交接

- master 抓取 kate 的最终计划（3 条方案的完整实施方案），确认 `<!-- PLAN-APPROVED -->` 已由成员最终消息中的认可标记（若 tollgate 全部 PASS 即可视为计划获批，master 在 task 内要求 emit `<!-- PLAN-APPROVED -->`）。
- 这份计划作为 §4 implement-team pipeline 首阶段（coder）的输入。

为了可靠捕获 PLAN-APPROVED 标记，在 kate 的 task 中要求：当所有门 PASS 后，在最终修订版末尾加上 `<!-- PLAN-APPROVED -->`。

---

## §4 implement-team（`team_pipeline`）— 实现

### 4.1 阶段说明

按批准的计划**线性流水线**实现：**coder 实现求解器 → tester 写+跑测试**。前 stage 的产出拼进下 stage 的 task，顺序加工。

### 4.2 Team 配置

```json
{
  "name": "es-implement",
  "description": "Eigen-solver implementation pipeline: coder implements the solver, tester writes+runs tests",
  "members": [
    {
      "name": "omar",
      "role": "coder",
      "prompt": "You are the CODER (stage 1) in the implementation pipeline. Implement the approved plan for the 3 selected eigen-solver approaches in Rust. Create a Cargo project under a suitable directory (e.g. projects/eigen-solver/). The solver must: accept a 1000×1000 dense f64 matrix, compute eigenvalues (and optionally eigenvectors), verify against known test matrices. Write clean, well-documented Rust code with proper error handling. Output a summary of files created, key implementation decisions, and a quick-start build/run guide for the next stage."
    },
    {
      "name": "pat",
      "role": "tester",
      "prompt": "You are the TESTER (stage 2) in the implementation pipeline. Given Omar's eigen-solver implementation: write comprehensive tests (unit tests for individual routines, integration tests for the full solver against known matrices: identity, diagonal, random symmetric, Hilbert matrix). Run `cargo test` and report pass/fail counts. For each test case, compare computed eigenvalues against known values using a tolerance-based check. Output: which tests you added, the full suite result (pass/fail counts), and any failures observed."
    }
  ]
}
```

**Role 选择**：omar `coder`（实现）、pat `tester`（写+跑测试）。pipeline 各 stage 顺序加工、无 action 字段。

### 4.3 Master 启动调用

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "es-implement",
    "stages": [
      {
        "member": "omar",
        "task": "Implement the approved eigen-solver plan in Rust for a 1000×1000 dense real matrix. Plan: <把 §3.5 的批准计划粘进来>. Create a Cargo project under projects/eigen-solver/. Implement the 3 selected algorithms as separate modules, each exposing a consistent API. Must compile with `cargo build`. Output a summary of files, key decisions, and build instructions."
      },
      {
        "member": "pat",
        "task": "Write tests for Omar's eigen-solver implementation. Cover: unit tests for individual routines (matrix operations, reductions, QR step), integration tests against known matrices (identity → eigenvalues all 1, diagonal → known values, random symmetric). Use approx crate or tolerance-based float comparison. Run `cargo test` and output: tests added, pass/fail counts, any failures with details."
      }
    ],
    "timeout_ms": 3000000
  }
}
```

**参数选择**：
- pipeline 把前 stage 的产出**前缀拼进**下 stage 的 task——pat 能看到 omar 的代码结构和构建说明。
- 首阶段 task 内嵌 §3.5 的完整计划。
- 不设 `signoff_policy`——pipeline 默认 none，两阶段跑完直接交付。

### 4.4 生命周期步骤（master）

```
team_create(es-implement)
team_activate(es-implement)   # （此时 es-plan 已 deactivate）
team_pipeline(...)            # stages 如上，首阶段 task 含 §3.5 计划
# 等待两阶段顺序完成 → team_results 取汇总（code + tests）
team_deactivate(es-implement)
```

### 4.5 产出与交接

- master 抓取 omar 的代码产出 + pat 的测试结果。
- 实现后的求解器代码 + 测试作为 §5 optimize-team 的优化对象。

---

## §5 optimize-team（`team_loop`）— 优化重构

### 5.1 阶段说明

在**保证基线**（全部已有测试通过）的前提下优化代码。每轮按 **优化（optimizer，修改代码）→ 验证（tester，运行测试+检查基线）** 串行，decider 裁决「基线通过 & 性能有提升 → 完成 / 还需继续」。最多 4 轮。

> ⚠️ **decider 不能兼任 stage 成员**（team_loop 规则：decider 是 auto-appended 只读，不能出现在 stages 里）。tom 留作 decider，不进 stages。

### 5.2 Team 配置

```json
{
  "name": "es-optimize",
  "description": "Eigen-solver optimization team: optimizer improves code, tester verifies baseline, decider judges done",
  "members": [
    {
      "name": "ruby",
      "role": "coder",
      "prompt": "You are the OPTIMIZER (stage 1) in the optimization loop. Each round, refactor and optimize the eigen-solver Rust code to improve performance WITHOUT breaking existing tests. Optimization focus areas: loop ordering for cache efficiency, reducing unnecessary allocations, inlining hot paths, using unsafe Rust for unchecked indexing where safe, pre-allocating workspaces, compiler hints (#[inline]). Run 'cargo build' after changes. Preserve correctness — for each change you make, explain why it does not change the numerical result."
    },
    {
      "name": "sam",
      "role": "tester",
      "prompt": "You are the VERIFIER (stage 2) in the optimization loop. Each round, run the full test suite ('cargo test') and check that ALL existing tests pass. Also run 'cargo build' to confirm compilation. Report: 'TESTS: <passed>/<total> passed, <failed> failed, build: <ok/fail>'. If any test fails or build breaks, list which tests failed. The decider uses this to send back for revision."
    },
    {
      "name": "tom",
      "role": "reviewer",
      "prompt": "You are the DECIDER in the optimization loop. After each round (Ruby optimizes -> Sam verifies), decide whether the optimization is COMPLETE. Check: Sam's TESTS report shows all tests pass and build succeeds. Consider whether meaningful optimizations have been applied (at minimum: cache-friendly loop ordering, reduced allocations, workspace reuse). Emit <decision>{\"done\": true}</decision> when baseline holds and optimizations are adequate, or <decision>{\"done\": false, \"reason\": \"...\"}</decision> naming what Ruby should optimize further. The final done state should have the team emit <!-- OPTIMIZED -->."
    }
  ]
}
```

**Role 选择**：ruby `coder`（优化代码，modify）、sam `tester`（验证基线，modify）、tom `reviewer`（decider，auto-appended 只读裁决）。

### 5.3 Master 启动调用

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "es-optimize",
    "initial_task": "Optimize the eigen-solver Rust code for performance while preserving baseline: all existing tests must pass. The code is at <§4 output path>. Each round: Ruby optimizes the code (cache-friendly loops, reduced allocations, workspace reuse, compiler hints), Sam runs `cargo build` + `cargo test` to verify no regressions. Tom decides if optimization is complete (baseline holds + meaningful optimizations applied). On done, emit <!-- OPTIMIZED -->.",
    "stages": [
      {
        "member": "ruby",
        "task": "Optimize the eigen-solver Rust code for performance. Focus: cache-friendly loop ordering, reduce heap allocations, pre-allocate workspaces, use unsafe indexing in hot paths where safe, add #[inline] hints. Run `cargo build` to confirm. Do NOT change public API or numerical results. Output what you changed and why each change is safe.",
        "action": "modify"
      },
      {
        "member": "sam",
        "task": "Verify baseline: run `cargo build` and `cargo test` on the eigen-solver project. Report: 'TESTS: <passed>/<total> passed, <failed> failed, build: <ok/fail>'. If any failures, list them with details.",
        "action": "modify"
      }
    ],
    "decider": "tom",
    "max_rounds": 4,
    "timeout_ms": 2400000
  }
}
```

**参数选择**：
- `stages` 顺序：ruby(modify，优化) → sam(modify，运行测试验证)，每轮一遍；decider tom 每轮裁决。
- `max_rounds: 4`——4 轮内未优化到位则交回你处理。

### 5.4 生命周期步骤（master）

```
team_create(es-optimize)
team_activate(es-optimize)    # （此时 es-implement 已 deactivate）
team_loop(...)                # initial_task + stages 如上
# 等待 decider 裁决 done / 达 max_rounds → team_results 取 OPTIMIZED 标记
team_deactivate(es-optimize)
```

### 5.5 产出与交接

- master 确认 `<!-- OPTIMIZED -->` 标记 + rubys 的优化记录 + sam 的基线测试通过报告。
- 优化后的代码作为 §6 review-team 的评审对象。

---

## §6 review-team（`team_parallel`）— 代码评审

### 6.1 阶段说明

4 名评审员**并行**深审优化后的求解器代码，每人一个维度：**正确性 / 安全性（unsafe Rust） / 性能 / 代码风格与可维护性**。

### 6.2 Team 配置

```json
{
  "name": "es-review",
  "description": "Eigen-solver review team: 4 reviewers audit the final code in parallel across correctness/safety/performance/style",
  "members": [
    {
      "name": "uma",
      "role": "reviewer",
      "prompt": "You audit the eigen-solver code for CORRECTNESS. Review: algorithm implementation matches the plan? convergence criteria correct? eigenvector orthogonality? residual checks? numerical tolerance handling? boundary cases (zero matrix, identity, near-defective)? For your dimension, emit exactly one line: <!-- REVIEW: correctness: pass --> or <!-- REVIEW: correctness: fail --> followed by a short list of findings."
    },
    {
      "name": "victor",
      "role": "reviewer",
      "prompt": "You audit the eigen-solver code for UNSAFE RUST SAFETY. Check all unsafe blocks: are invariants documented? are pointer dereferences valid? are unchecked indexing bounds provably correct? is the unsafe minimal and isolated? For your dimension, emit exactly one line: <!-- REVIEW: unsafe-safety: pass --> or <!-- REVIEW: unsafe-safety: fail --> followed by a short list of safety concerns."
    },
    {
      "name": "wendy",
      "role": "reviewer",
      "prompt": "You audit the eigen-solver code for PERFORMANCE. Review: hot-path loop structure, allocation patterns, cache locality, redundant computations, compiler optimization barriers. Profile mental model — is the inner loop of QR iteration efficient? are matrix-vector/products optimized? For your dimension, emit exactly one line: <!-- REVIEW: performance: pass --> or <!-- REVIEW: performance: fail --> followed by a short list of performance findings."
    },
    {
      "name": "xander",
      "role": "reviewer",
      "prompt": "You audit the eigen-solver code for CODE QUALITY & MAINTAINABILITY. Review: naming conventions, module organization, documentation quality, error handling (use of Result/Option), code duplication, complexity (excessive nesting, overly long functions), test coverage adequacy. For your dimension, emit exactly one line: <!-- REVIEW: code-quality: pass --> or <!-- REVIEW: code-quality: fail --> followed by a short list of style/maintainability findings."
    }
  ]
}
```

**Role 选择**：全部 `reviewer`（只读深审，不改码），4 人对称差异来自维度 prompt。

### 6.3 Master 启动调用

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "es-review",
    "mode": "isolated",
    "task": "Audit the optimized eigen-solver Rust code at <§5 output path> strictly within YOUR ASSIGNED DIMENSION (see your role brief). Read the source files, tests, and any documentation. Emit the <!-- REVIEW: <dim>: pass|fail --> marker exactly as your brief specifies, followed by your findings with specific code references.",
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `mode: isolated` + 维度烤进 prompt——4 路并行各审一个维度。
- review-team 看到的是 §5 优化后的最终代码（master 在 task 里给出代码路径）。

### 6.4 生命周期步骤（master）

```
team_create(es-review)
team_activate(es-review)      # （此时 es-optimize 已 deactivate）
team_parallel(...)            # §6.3，task 含 §5 代码路径
# 等待 4 名评审员产出 → team_results 取汇总
team_deactivate(es-review)
```

### 6.5 产出与交接

- master 抓取所有 `<!-- REVIEW: <dim>: pass|fail -->` + findings。
- **你读取这 4 维评审结论 + 全部 6 个团队的产出，自行裁定求解器开发的成败。** 场景到此结束。

---

## 端到端时序（master 视角）

```
T+0    team_create(es-research) → team_activate → team_parallel
         5 研究员并行调研方法（经典算法/竞品/Rust生态/稳定性/优化）
T+~15  收 ≥8 methods → team_deactivate(es-research)
T+~15  team_create(es-selection) → team_activate → team_consensus(topic=methods)
         5 debater 辩论选 3（≤5 轮）
T+~30  收 3 SHORTLISTED → team_deactivate(es-selection)
T+~30  team_create(es-plan) → team_activate → team_tollgate
         kate 编写 → leo 完整门 → mona 正确门 → nina 可测门（串联，可重试）
T+~50  收 PLAN-APPROVED → team_deactivate(es-plan)
T+~50  team_create(es-implement) → team_activate → team_pipeline
         omar 实现求解器 → pat 写+跑测试
T+~80  收 code+tests → team_deactivate(es-implement)
T+~80  team_create(es-optimize) → team_activate → team_loop
         每轮 ruby 优化 → sam 基线验证，tom 裁决
T+~105 收 OPTIMIZED → team_deactivate(es-optimize)
T+~105 team_create(es-review) → team_activate → team_parallel
         4 评审员并行深审（正确性/unsafe安全/性能/代码质量）
T+~120 收 review verdicts → team_deactivate(es-review)
T+~120 你读取全部输出，裁定结果
```

（时长仅为量级估计；实现和优化阶段依赖实际代码工作量。本场景不设硬性 timeout 上限。）

---

## 快速启动 Prompt（复制即用）

> 整段粘贴给 master 会话。master 会依次跑 6 个团队，每步按 README 的 JSON 配置执行，团队间数据由 master 手递手。

```text
按 scenarios/composite/eigen-solver/README.md 跑一次大规模矩阵本征值求解器开发工作流。

执行 6 个团队，每个走「team_create → team_activate → team_<mode> → team_results → team_deactivate」完整生命周期。同一时刻只允许一个 active 团队——切换前必须先 deactivate。

每个 phas 的产出由你（master）手递手传给下一阶段。

1. research-team (team_parallel，§1)：按 §1.2 team_create，§1.3 team_parallel。5 名研究员并行调研（经典算法/竞品/Rust生态/数值稳定性/问题优化）。完成后 deactivate。汇总所有 <!-- METHOD: <id>:<name> --> marker 成方法候选清单（应 ≥8 条）。

2. selection-team (team_consensus，§2)：按 §2.2 team_create，§2.3 team_consensus（topic = 上一步候选清单，max_rounds=5）。5 名 debater 综合稳定性/复杂度/性能/可维护性，精确选 3 条。完成后 deactivate。抓取 3 条 <!-- SHORTLISTED: <id> --> + 理由。

3. plan-team (team_tollgate，§3)：按 §3.2 team_create，§3.3 team_tollgate（stages 含 3 个门控：kate 编写 → leo 完整门 → kate(修订) → mona 正确门 → kate(修订) → nina 可测门）。3 个评审人都必须 PASS。完成后 deactivate。抓取最终计划（包含 <!-- PLAN-APPROVED -->）。

4. implement-team (team_pipeline，§4)：按 §4.2 team_create，§4.3 team_pipeline（首阶段 task 内嵌 §3 的 PLAN-APPROVED 方案）。omar 编写求解器代码 → pat 写+跑 cargo test。完成后 deactivate。汇总代码产出 + 测试结果。

5. optimize-team (team_loop，§5)：按 §5.2 team_create，§5.3 team_loop（initial_task 含 §4 代码路径）。每轮 ruby 优化代码 → sam 运行 cargo build + cargo test 验证基线，tom 裁决。完成后 deactivate。确认 <!-- OPTIMIZED --> 标记 + 基线测试通过报告。

6. review-team (team_parallel，§6)：按 §6.2 team_create，§6.3 team_parallel（task 含 §5 优化后代码路径）。4 名评审员并行深审（正确性/unsafe安全/性能/代码质量）。完成后 deactivate。汇总所有 <!-- REVIEW: <dim>: pass|fail -->。

全部完成后，把每个团队的产出（methods / shortlisted / plan / implementation / optimized / review verdicts）整理给我，由我裁定结果。不跑评判脚本。

注意：
- 成员名必须取自 32 字预设池（alice/bob/carol/dave/erin/frank/grace/henry/iris/jack/kate/leo/mona/nina/omar/pat/quinn/ruby/sam/tom/uma/victor/wendy/xander...），角色必须用 researcher/analyst/reviewer/architect/coder/tester 等预设值。
- 切换团队前一定先 team_deactivate 当前团队，否则 team_activate 会被拒绝。
- plan-team 的 tollgate 模式：每个 stage 的 verifier 不能等于 member。3 个评审人 leo/mona/nina 各自独立。
- optimize-team 的 decider（tom）不能出现在 stages 里。
- pipeline 模式无 action 字段；各 stage 顺序加工，前 stage 产出自动拼进下 stage task。
- 如果 selection-team 无法收敛到精确 3 条，可增加 max_rounds。
- 如果 plan-team 某评审人耗尽 max_gate_retries，需要手动介入调整计划。
```

---

## 相关文档

- [`scenarios/README.md`](../../README.md) — 场景目录总览（单原语 9 模式 + 综合场景三类）
- [`scenarios/composite/code-review/README.md`](../code-review/README.md) — 姊妹综合场景：多团队代码评审
- [`scenarios/composite/feature-dev/README.md`](../feature-dev/README.md) — 姊妹综合场景：OCTeam 功能增强
- [`scenarios/_AUTHORING.md`](../../_AUTHORING.md) — 单原语场景编写规范（本综合场景为变体：多团队多编排、无评判脚本）
- [`scenarios/01-team-parallel/README.md`](../../01-team-parallel/README.md) — parallel 原语参考
- [`scenarios/04-team-loop/README.md`](../../04-team-loop/README.md) — loop 原语参考
- [`scenarios/09-team-tollgate/README.md`](../../09-team-tollgate/README.md) — tollgate 原语参考（验证门流水线）
- [`src/tools/workflow-basic.ts`](../../../src/tools/workflow-basic.ts) — parallel / consensus / pipeline / loop 源码
- [`src/tools/workflow-advanced.ts`](../../../src/tools/workflow-advanced.ts) — delegate / route / arbitrate / tollgate / recurse 源码
