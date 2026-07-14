# Comprehensive Scenario: Large-Scale Matrix Eigenvalue Solver Development

An end-to-end workflow for developing a 1000×1000 dense matrix eigenvalue solver in Rust: **Method Research → Approach Selection → Plan+Review → Implementation → Optimization+Refactoring → Code Review**, 6 independent teams × 5 orchestration primitives chained together. Master acts as the integration hub, teams are isolated from each other with hand-to-hand data passing.

**Self-use template**: no check scripts included; whether the final solver is correct and whether performance meets expectations is **for you to judge**.

## Core Constraints

| Dimension | Constraint |
|------|------|
| Matrix size | 1000 × 1000 dense real matrix |
| Language | Rust |
| Acceleration limit | No GPU / parallel acceleration (pure CPU single-threaded) |
| Baseline | After optimization and refactoring, all existing tests must pass, ensuring result correctness |

## Workflow Overview

| Phase | Team | Orchestration Primitive | Input | Output (handoff marker) |
|------|------|---------|------|---------------------|
| ① Method Research | **research-team** | `team_parallel` | Requirements doc + external literature/competitors | `<!-- METHOD: <id>:<name> -->` × ≥8 |
| ② Approach Selection | **selection-team** | `team_consensus` | Methods list | `<!-- SHORTLISTED: <id> -->` exactly 3 items |
| ③ Plan+Review | **plan-team** | `team_tollgate` | 3 shortlisted approaches | `<!-- PLAN-APPROVED -->` |
| ④ Implementation | **implement-team** | `team_pipeline` | Approved plan | Solver code + tests |
| ⑤ Optimization+Refactoring | **optimize-team** | `team_loop` | Implemented code | Optimized code + baseline passing (`<!-- OPTIMIZED -->`) |
| ⑥ Code Review | **review-team** | `team_parallel` | Optimized code | `<!-- REVIEW: <dim>: pass|fail -->` × 4 dimensions |

Uses 5 orchestration primitives: **parallel / consensus / tollgate / pipeline / loop** (parallel is used once each for research and review; tollgate is used for the plan's multi-reviewer gating).

```
Requirements doc + external literature/competitors
        │
        ▼
research-team (parallel)    ──≥8 methods──► master
                                                │
selection-team (consensus)  ◄──methods──────────┘
        │
        └──3 shortlisted──────────────────► master
                                                │
plan-team (tollgate)        ◄──3 shortlisted────┘
        │  Write→Review1→Revise→Review2→Revise→Review3 (all pass)
        └──PLAN-APPROVED──────────────────► master
                                                │
implement-team (pipeline)   ◄──plan─────────────┘
        │  coder→tester
        └──code+tests─────────────────────► master
                                                │
optimize-team (loop)        ◄──code─────────────┘
        │  Optimize→Test→Decide (baseline guarantee)
        └──OPTIMIZED──────────────────────► master
                                                │
review-team (parallel)      ◄──optimized code───┘
        │
        └──review verdicts────────────────► master ──► you judge
```

## How to Use

1. **Target**: this scenario generates a Rust matrix eigenvalue solver. No placeholders — the solver is built from scratch.
2. **Run 6 teams in sequence** (§1–§6). Each team goes through its full lifecycle: `team_create` → `team_activate` → `team_<mode>` → collect output → `team_deactivate`.
3. **Handoff**: each team's marker output is summarized by master and passed as the next team's input (methods → topic; shortlisted → plan input; approved plan → tollgate output to pipeline; code → loop input; optimized code → audit target).
4. **Judge**: you read the review-team's multi-dimensional conclusions and all team outputs, and decide yourself whether the solver meets expectations. This scenario **has no check scripts**.

## Team Switching Iron Rule

Only **one team** active at a time. `team_activate` will be rejected if another team is already active — **you must `team_deactivate` before `team_activate` the next**. Each team section's master steps explicitly include deactivate.

---

## §1 research-team (`team_parallel`) — Method Research

### 1.1 Phase Description

5 researchers **research in parallel**, each with one dimension (dimension baked into member prompt, parallel runs isolated). Coverage: classic algorithms (QR, divide-and-conquer, bisection, Jacobi), competitor libraries (LAPACK, ARPACK, SLEPc, Eigen), Rust ecosystem (nalgebra, faer, lax, gemm), numerical stability considerations, problem-specific optimizations. Each member proposes at least 3 candidate methods → total ≥8 (after removing duplicates).

### 1.2 Team Configuration

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

**Role selection**: alice/bob/carol/dave use `researcher` (external research), erin uses `analyst` (comprehensive optimization analysis). 5 symmetric members, differences come from dimension prompts.

### 1.3 Master Launch Call

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

**Parameter selection**:
- `mode: isolated` + dimension baked into prompts — 5 parallel lanes each scan one dimension, with no overlap.
- No `signoff_policy` set — parallel defaults to no signoff, results are collected when done.

### 1.4 Lifecycle Steps (master)

```
team_create(es-research)
team_activate(es-research)
team_parallel(...)            # §1.3
# Wait for 5 researchers' output → team_results for the summary
team_deactivate(es-research)
```

### 1.5 Output and Handoff

- Master extracts all `<!-- METHOD: <id>:<name> -->` from the 5 outputs, compiles a **methods candidate list** (id + name + per-dimension analysis, should be ≥8 items).
- This list serves as §2 `team_consensus`'s `topic`.

---

## §2 selection-team (`team_consensus`) — Approach Selection

### 2.1 Phase Description

5 debaters (2 researcher + 2 architect + 1 analyst) debate candidate methods across multiple rounds, weighing **numerical stability / implementation complexity / performance / maintainability**, converging to select **exactly 3** most viable algorithm/technical approaches.

### 2.2 Team Configuration

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

**Role selection**: frank/henry `researcher` (stability/performance perspectives), grace/iris `architect` (complexity/maintainability perspectives), jack `analyst` (comprehensive tradeoff). Five perspectives intersect.

### 2.3 Master Launch Call

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "es-selection",
    "topic": "<Paste the §1.5 methods candidate list verbatim: each METHOD id/name/per-dimension analysis>. From these candidates, select EXACTLY THREE approaches to implement a 1000×1000 dense eigen-solver in Rust (no GPU/parallel). Weigh numerical stability, implementation complexity, performance, and maintainability. Each member must emit <!-- SHORTLISTED: <id> --> for exactly 3 candidates in their final message, all converging to the same 3.",
    "max_rounds": 5,
    "timeout_ms": 2400000
  }
}
```

**Parameter selection**:
- `topic` = candidate list (master pastes it in by hand).
- `max_rounds: 5` — gives sufficient debate space to converge to exactly 3.

### 2.4 Lifecycle Steps (master)

```
team_create(es-selection)
team_activate(es-selection)   # (es-research already deactivated at this point)
team_consensus(...)           # topic = §1.5 candidate list
# Wait for consensus → team_results for the summary
team_deactivate(es-selection)
```

### 2.5 Output and Handoff

- Master extracts all `<!-- SHORTLISTED: <id> -->`, confirms convergence to the same set of 3 ids.
- These 3 selected approaches serve as §3 plan-team's input (tollgate stages need to write plans based on them).

---

## §3 plan-team (`team_tollgate`) — Plan + Review

### 3.1 Phase Description

Write an **implementation plan** for the 3 selected algorithms. Each approach has its own plan written (covering architecture, data structures, and test strategy), then passes through 3 reviewer gates in sequence. Each reviewer focuses on a different dimension:

- **Reviewer 1 (Completeness & Scope)**: does the plan cover all necessary modules?
- **Reviewer 2 (Technical Correctness)**: is the algorithm pseudocode correct? is the complexity analysis reasonable?
- **Reviewer 3 (Testability & Risk)**: is the test strategy complete? are risks identified?

If any reviewer FAILs the plan, it rolls back to the writing phase for revision; **all three must PASS** (serial gating). Each reviewer is allowed at most 2 retries.

> ⚠️ **tollgate rule**: each stage's `verifier` cannot equal that stage's `member`. All verifiers are independent and non-duplicate.

### 3.2 Team Configuration

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

**Role selection**: kate `coder` (write plan, modify), leo/mona/nina `reviewer` (read-only gated review).

### 3.3 Master Launch Call

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "es-plan",
    "stages": [
      {
        "member": "kate",
        "task": "Write a comprehensive implementation plan for the 3 selected eigen-solver approaches. Selected methods (from §2): <Paste the §2.5 3 SHORTLISTED ids+descriptions>. For each method, produce: algorithm pseudocode, data structures, module breakdown, function signatures, convergence criteria, test strategy, accuracy baseline, risks/mitigations.",
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

**Parameter selection**:
- `stages` serial 3 gates: kate writes/revises → leo completeness gate → kate revises → mona correctness gate → kate revises → nina testability gate. FAIL in the preceding gate triggers revision; PASS skips revision and goes directly to the next gate.
- `max_gate_retries: 2` — each reviewer can reject at most 2 times; exceeding triggers overall failure.
- `max_invalid_cycles: 2` — prevents infinite loops from review criteria disputes.
- No `signoff_policy` set — tollgate's PASS/FAIL mechanism is itself the terminating gate.

### 3.4 Lifecycle Steps (master)

```
team_create(es-plan)
team_activate(es-plan)        # (es-selection already deactivated at this point)
team_tollgate(...)            # stages as above, includes §2.5's 3 selected approaches
# Wait for all three gates to PASS or any to exhaust retries → team_results for the final plan
team_deactivate(es-plan)
```

### 3.5 Output and Handoff

- Master extracts kate's final plan (complete implementation plan for the 3 approaches), confirming that `<!-- PLAN-APPROVED -->` has been emitted via the member's final message approval marker (if tollgate all PASS, the plan is considered approved; master requests `<!-- PLAN-APPROVED -->` emit in the task).
- This plan serves as §4 implement-team pipeline's first stage (coder) input.

To reliably capture the PLAN-APPROVED marker, kate's task requires: when all gates PASS, append `<!-- PLAN-APPROVED -->` at the end of the final revision.

---

## §4 implement-team (`team_pipeline`) — Implementation

### 4.1 Phase Description

Implement according to the approved plan via a **linear pipeline**: **coder implements solver → tester writes+runs tests**. The preceding stage's output is spliced into the next stage's task, processed in order.

### 4.2 Team Configuration

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

**Role selection**: omar `coder` (implementation), pat `tester` (write+run tests). Pipeline stages are processed in order, no action field.

### 4.3 Master Launch Call

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "es-implement",
    "stages": [
      {
        "member": "omar",
        "task": "Implement the approved eigen-solver plan in Rust for a 1000×1000 dense real matrix. Plan: <Paste the §3.5 approved plan>. Create a Cargo project under projects/eigen-solver/. Implement the 3 selected algorithms as separate modules, each exposing a consistent API. Must compile with `cargo build`. Output a summary of files, key decisions, and build instructions."
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

**Parameter selection**:
- Pipeline **prefix-splices** the preceding stage's output into the next stage's task — pat can see omar's code structure and build instructions.
- The first stage's task embeds §3.5's complete plan.
- No `signoff_policy` set — pipeline defaults to none, the two stages deliver directly when done.

### 4.4 Lifecycle Steps (master)

```
team_create(es-implement)
team_activate(es-implement)   # (es-plan already deactivated at this point)
team_pipeline(...)            # stages as above, first stage task includes §3.5 plan
# Wait for both stages to complete in order → team_results for the summary (code + tests)
team_deactivate(es-implement)
```

### 4.5 Output and Handoff

- Master extracts omar's code output + pat's test results.
- The implemented solver code + tests serve as §5 optimize-team's optimization target.

---

## §5 optimize-team (`team_loop`) — Optimization+Refactoring

### 5.1 Phase Description

Optimize the code while **preserving the baseline** (all existing tests must pass). Each round runs **Optimize (optimizer, modify code) → Verify (tester, run tests+check baseline)** serially; the decider rules "baseline passes & performance improved → done / needs more work". At most 4 rounds.

> ⚠️ **decider cannot double as a stage member** (team_loop rule: decider is auto-appended read-only, cannot appear in stages). tom is reserved as decider, not in stages.

### 5.2 Team Configuration

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

**Role selection**: ruby `coder` (optimize code, modify), sam `tester` (verify baseline, modify), tom `reviewer` (decider, auto-appended read-only ruling).

### 5.3 Master Launch Call

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

**Parameter selection**:
- `stages` order: ruby(modify, optimize) → sam(modify, run test verification), one pass per round; decider tom rules each round.
- `max_rounds: 4` — if not optimized adequately within 4 rounds, return to you for handling.

### 5.4 Lifecycle Steps (master)

```
team_create(es-optimize)
team_activate(es-optimize)    # (es-implement already deactivated at this point)
team_loop(...)                # initial_task + stages as above
# Wait for decider to rule done / max_rounds reached → team_results for OPTIMIZED marker
team_deactivate(es-optimize)
```

### 5.5 Output and Handoff

- Master confirms `<!-- OPTIMIZED -->` marker + ruby's optimization records + sam's baseline test pass report.
- The optimized code serves as §6 review-team's review target.

---

## §6 review-team (`team_parallel`) — Code Review

### 6.1 Phase Description

4 reviewers **review in parallel** the optimized solver code, each with one dimension: **correctness / safety (unsafe Rust) / performance / code quality & maintainability**.

### 6.2 Team Configuration

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

**Role selection**: all `reviewer` (read-only deep review, no code modification), 4 symmetric members, differences come from dimension prompts.

### 6.3 Master Launch Call

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

**Parameter selection**:
- `mode: isolated` + dimension baked into prompts — 4 parallel lanes each review one dimension.
- review-team sees §5's optimized final code (master gives the code path in the task).

### 6.4 Lifecycle Steps (master)

```
team_create(es-review)
team_activate(es-review)      # (es-optimize already deactivated at this point)
team_parallel(...)            # §6.3, task includes §5 code path
# Wait for 4 reviewers' output → team_results for the summary
team_deactivate(es-review)
```

### 6.5 Output and Handoff

- Master extracts all `<!-- REVIEW: <dim>: pass|fail -->` + findings.
- **You read these 4-dimensional review conclusions + all 6 teams' outputs, and decide the success or failure of the solver development yourself.** The scenario ends here.

---

## End-to-End Timeline (master perspective)

```
T+0    team_create(es-research) → team_activate → team_parallel
         5 researchers research methods in parallel (classic algorithms/competitors/Rust ecosystem/stability/optimization)
T+~15  Collect ≥8 methods → team_deactivate(es-research)
T+~15  team_create(es-selection) → team_activate → team_consensus(topic=methods)
         5 debaters debate to select 3 (≤5 rounds)
T+~30  Collect 3 SHORTLISTED → team_deactivate(es-selection)
T+~30  team_create(es-plan) → team_activate → team_tollgate
         kate writes → leo completeness gate → mona correctness gate → nina testability gate (serial, retryable)
T+~50  Collect PLAN-APPROVED → team_deactivate(es-plan)
T+~50  team_create(es-implement) → team_activate → team_pipeline
         omar implements solver → pat writes+runs tests
T+~80  Collect code+tests → team_deactivate(es-implement)
T+~80  team_create(es-optimize) → team_activate → team_loop
         Each round: ruby optimizes → sam baseline verification, tom rules
T+~105 Collect OPTIMIZED → team_deactivate(es-optimize)
T+~105 team_create(es-review) → team_activate → team_parallel
         4 reviewers audit in parallel (correctness/unsafe safety/performance/code quality)
T+~120 Collect review verdicts → team_deactivate(es-review)
T+~120 You read all output, decide the outcome
```

(Durations are order-of-magnitude estimates only; implementation and optimization phases depend on actual code workload. This scenario has no hard timeout cap.)

---

## Quick-Start Prompt (Copy and Use)

> Paste the entire block to the master session. Master will run 6 teams in sequence, executing each step per the README's JSON configuration, with data hand-carried between teams by master.

```text
按 demos/composite/eigen-solver/README.md 跑一次大规模矩阵本征值求解器开发工作流。

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
- 当 team 在运行中时不要频繁轮询 team_progress/team_results，等待 OCTeam 通知完成即可。
```

---

## Related Documents

- [`demos/README.md`](../README.md) — scenario directory overview (single-primitive 9 modes + 3 comprehensive scenarios)
- [`demos/code-review/README.md`](../code-review/README.md) — sister comprehensive scenario: multi-team code review
- [`demos/feature-dev/README.md`](../feature-dev/README.md) — sister comprehensive scenario: OCTeam feature enhancement
- [`demos/01-team-parallel/README.md`](../01-team-parallel/README.md) — parallel primitive reference
- [`demos/04-team-loop/README.md`](../04-team-loop/README.md) — loop primitive reference
- [`demos/09-team-tollgate/README.md`](../09-team-tollgate/README.md) — tollgate primitive reference (verification gate pipeline)
- parallel / consensus / pipeline / loop source: [`src/tools/parallel.ts`](../../src/tools/parallel.ts) / [`consensus.ts`](../../src/tools/consensus.ts) / [`pipeline.ts`](../../src/tools/pipeline.ts) / [`loop.ts`](../../src/tools/loop.ts)
- delegate / route / arbitrate / tollgate / recurse source: [`src/tools/delegate.ts`](../../src/tools/delegate.ts) / [`router.ts`](../../src/tools/router.ts) / [`arbitrate.ts`](../../src/tools/arbitrate.ts) / [`tollgate.ts`](../../src/tools/tollgate.ts) / [`recurse.ts`](../../src/tools/recurse.ts)
