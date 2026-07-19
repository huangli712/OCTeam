# team_arena Orchestration Scenario Demo

`team_arena` runs a competitive arena. N candidate members implement competing solutions for the same task in their own isolated git worktrees (implement phase); then a single independent evaluator runs the same objective evaluation against every candidate's output and produces a structured `<scoreboard>` rating; the engine selects a deterministic winner by `winner_metric` and `score_direction` and delivers directly.

---

## Scenario Overview

| # | Domain | Scenario | Candidates | Evaluation Benchmark | Winner Metric | Est. Duration |
|---|------|------|--------|---------|---------|-----------|
| 1 | Programming | Three sorting implementations benchmarked for fastest | 3 | `eval_command` runs benchmark script | Throughput (`score_direction: "max"`) | ~10 min |
| 2 | Computational Physics | Three integrators compared by energy drift for most stable | 3 | `eval_criteria` energy conservation verdict | Energy drift (`score_direction: "min"`) | ~12 min |
| 3 | Math | Three quadrature methods compete on definite integral accuracy | 3 | `eval_criteria` comparison against exact solution | Absolute error (`score_direction: "min"`) | ~12 min |
| 4 | Computational Physics (challenge) | Five Poisson equation solvers comprehensive arena | 5 | `eval_command` runs convergence benchmark | Convergence iterations (`score_direction: "min"`) | ~40 min |

---

## Prerequisites

**v1 boundaries**: `team_arena` (v1) has the following hard assumptions and restrictions that must be observed when using it:

1. **Candidates must have worktrees**: Every candidate must set `worktree: true` when adding members via `team_add_member`, otherwise arena aborts with an error on launch.
2. **At least 2 candidates**: The `candidates` explicit list or auto-inference (all non-master, non-evaluator members) must have ≥ 2 candidates.
3. **At least one evaluation benchmark**: Either `eval_command` or `eval_criteria` must be provided (both can be provided together).
4. **Evaluator is not in the candidate list**: The evaluator cannot also be a candidate member.
5. **Single round, objective scoring**: v1 does only one round of implement → evaluate; the evaluator's `<scoreboard>` output must be valid JSON; the engine selects the winner by single-value comparison of `winner_metric`, with no multi-round evolution or tie-break negotiation.
6. **No signoff, no auto-merge, no loser cleanup**: These are features explicitly not provided in v1.

**Key assumption (Metis annotation)**: The evaluator runs in its own worktree but reads candidates' **absolute worktree paths** (including uncommitted agent edits). This requires that the host **not** sandbox members within their own directories — the evaluator must be able to access other candidates' worktree files via absolute paths.

---

## Scenario 1: Three Sorting Implementations Benchmark for Fastest

### 1.1 Scenario Description

**Background**: Sorting is a fundamental operation every programmer has written. Across different sizes and data distributions (random, nearly sorted, reverse order), different algorithms (quicksort, mergesort, introsort) show significantly different actual wall-clock throughput. "Fastest" is not a theoretical judgment but a **measurable fact under the same hardware, same data, same benchmark script**.

**Goal**: Three candidates (`coder` role) each implement one sorting algorithm; the evaluator runs the benchmark script `benchmark.bun.ts` against each implementation with the same dataset and produces a `throughput_ops_per_sec` metric per candidate; the engine selects the candidate with the highest throughput using `score_direction: "max"`.

**Success criteria (machine-evaluable)**:
- Each candidate output contains `<!-- IMPL: sort -->` marker, embedding a loadable code block
- Evaluator output contains `<scoreboard>{...}</scoreboard>` tagged JSON block
- The scoreboard's `scores` array length equals the number of candidates; each entry contains `member`, `score` (number), `passed` (bool), `rationale` (string)
- The engine selects the candidate with the highest `score` as the winner

### 1.2 Team Configuration

```json
{
  "name": "sort-arena",
  "description": "Three sorting implementations benchmarked: quickSort vs mergeSort vs introSort — winner by max throughput",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing a sorting algorithm. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with an IMPL marker.\n\nYour output MUST end with a line exactly formatted: <!-- IMPL: sort -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing a sorting algorithm. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with an IMPL marker.\n\nYour output MUST end with a line exactly formatted: <!-- IMPL: sort -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing a sorting algorithm. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with an IMPL marker.\n\nYour output MUST end with a line exactly formatted: <!-- IMPL: sort -->"
    },
    {
      "name": "dave",
      "role": "reviewer",
      "worktree": true,
      "prompt": "You are an evaluator. You run the same objective benchmark command against each candidate's worktree and emit a scoreboard. Run the eval command for EVERY candidate at the absolute worktree path shown. Write the benchmark wrapper script yourself based on the eval command, run it per candidate, and produce the score.\n\nEmit EXACTLY one scoreboard block and nothing after it: <scoreboard>{\"scores\":[{\"member\":\"...\",\"score\":<n>,\"metrics\":{...},\"passed\":true|false,\"rationale\":\"...\"}],\"rationale\":\"...\"}</scoreboard>"
    }
  ]
}
```

**Role selection rationale**: The first three candidates uniformly use `coder` (`oct-junior` agent, can write code and run tests) in independent worktrees to implement their respective sorting approaches; evaluator uses `reviewer` (read-only agent, focused on running the objective benchmark and producing a structured scoreboard).

### 1.3 Master Launch Call

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

**Parameter selection**:
- `evaluator: "dave"` — not in the `candidates` list, satisfying the "evaluator ≠ candidate" hard constraint
- `candidates` explicitly lists 3 — just enough for multi-method comparison without exceeding the baseline member count
- `eval_command: "bun run benchmark.bun.ts"` — objective benchmark script; the evaluator runs the same command in each candidate's worktree
- `winner_metric: "throughput_ops_per_sec"` + `score_direction: "max"` — higher throughput is better
- `max_eval_retries: 1` — give the evaluator one retry on scoreboard format error or parse failure
- `timeout_ms: 900000` (15 min) — parallel candidate implementation 8 min + serial evaluation 3 min, with margin

### 1.4 Execution Flow (Timeline)

```
T+0m     master calls team_arena (3 candidates + evaluator)
T+0m     implement phase: parallel dispatch alice, bob, carol (each in independent worktree)
T+0~8m   three candidates each implement sorting algorithm → output IMPL marker → idle
T+8m     barrier: all candidates idle → arena phase switches to evaluate
T+8m     evaluator prompt build: list candidate names + absolute worktree paths + eval_command + winner_metric
T+8m     dispatch evaluator (dave, reviewer)
T+8~11m  dave runs `bun run benchmark.bun.ts` per candidate → collects throughput → produces <scoreboard> JSON
T+11m    engine parses scoreboard → selectArenaWinner → result delivered to master
```

(If candidate implementation errors cause `max_errored_members` to be exceeded, the arena fails entirely; if evaluator scoreboard parse fails and attempts < max_eval_retries, the evaluator is sent back for re-evaluation.)

### 1.5 Check Script

> This scenario does not have a standalone check script; evaluation relies on the evaluator's `<scoreboard>` JSON output and the engine's built-in `selectArenaWinner` logic. For external verification, read `runs/<run_id>/dave.md` (evaluator output), extract the scoreboard JSON, and cross-check that `scores[].score` values are finite numbers and `passed` is `true`.

### 1.6 Evaluator Scoreboard Example

The evaluator (dave), after running the three benchmarks, should produce a scoreboard in the following format:

```
<scoreboard>{"scores":[{"member":"alice","score":12450000,"metrics":{"throughput_ops_per_sec":12450000,"algorithm":"quickSort","dataset_size":1000000},"passed":true,"rationale":"quickSort on random 10^6: 12.45M ops/sec, fastest of three"},{"member":"bob","score":8700000,"metrics":{"throughput_ops_per_sec":8700000,"algorithm":"mergeSort","dataset_size":1000000},"passed":true,"rationale":"mergeSort on random 10^6: 8.70M ops/sec, stable but slower due to allocation"},{"member":"carol","score":11200000,"metrics":{"throughput_ops_per_sec":11200000,"algorithm":"introSort","dataset_size":1000000},"passed":true,"rationale":"introSort on random 10^6: 11.20M ops/sec, close second to quickSort"}],"rationale":"Benchmark: bun run benchmark.bun.ts on random 10^6-int array. Alice wins with quickSort at 12.45M ops/sec; introSort is 10% slower; mergeSort trails due to extra allocation. Winner metric: max throughput_ops_per_sec."}</scoreboard>
```

The engine parses this JSON and selects `alice` as the winner by `winner_metric: "throughput_ops_per_sec"` and `score_direction: "max"`.

---

## Scenario 2: Three Integrators Compared by Energy Drift for Most Stable

### 2.1 Scenario Description

**Background**: The harmonic oscillator `ẍ = -ω²x` (ω=1, initial `x0=1, v0=0`) is a standard test problem for energy-conserving systems, with theoretical energy `E = ½(x² + v²) = 0.5` constant. Different numerical integrators have vastly different energy conservation properties: **explicit Euler** exhibits systematic energy growth, **implicit Euler** systematic energy decay, and **Velocity Verlet** exhibits bounded oscillation near the equilibrium value. In long-time simulations, an integrator's **energy drift** (relative drift `|E_end - E0|/E0`) is a direct indicator of stability.

**Goal**: Three candidates (`simulator` role) each implement one integrator, run the same number of steps, and report the relative energy drift; the evaluator judges whether each implementation's drift meets the symplectic conservation bound per `eval_criteria`, scores by drift value, and the engine selects the candidate with the smallest drift as the winner.

**Success criteria (machine-evaluable)**:
- Each candidate output contains `<!-- DRIFT: <value> -->` marker
- Evaluator output contains `<scoreboard>{...}</scoreboard>` tagged JSON block
- Each scoreboard entry's `score` is the relative energy drift value (number); `passed` is determined by `eval_criteria`
- The engine selects the candidate with the smallest drift as the winner using `score_direction: "min"`

### 2.2 Team Configuration

```json
{
  "name": "integrator-arena",
  "description": "Three numerical integrators on harmonic oscillator: Euler vs implicit Euler vs Verlet — winner by min energy drift",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing a numerical integrator for the harmonic oscillator (omega=1, x0=1, v0=0). Run 1000 steps h=0.01, report the relative energy drift |E_end - E0|/E0. Embed runnable code in a ```typescript fenced block.\n\nYour output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing a numerical integrator for the harmonic oscillator (omega=1, x0=1, v0=0). Run 1000 steps h=0.01, report the relative energy drift |E_end - E0|/E0. Embed runnable code in a ```typescript fenced block.\n\nYour output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing a numerical integrator for the harmonic oscillator (omega=1, x0=1, v0=0). Run 1000 steps h=0.01, report the relative energy drift |E_end - E0|/E0. Embed runnable code in a ```typescript fenced block.\n\nYour output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
    },
    {
      "name": "dave",
      "role": "physicist",
      "worktree": true,
      "prompt": "You are a physicist. You evaluate each candidate's integrator by reading their output (the DRIFT marker), re-running their code if possible, and scoring by energy conservation quality. A lower drift is better (min direction). A drift < 1e-3 demonstrates symplectic or near-symplectic behavior (pass).\n\nEmit EXACTLY one scoreboard block and nothing after it: <scoreboard>{\"scores\":[{\"member\":\"...\",\"score\":<n>,\"metrics\":{\"drift\":<n>},\"passed\":true|false,\"rationale\":\"...\"}],\"rationale\":\"...\"}</scoreboard>"
    }
  ]
}
```

**Role selection rationale**: The first three candidates use `simulator` (specialized in numerical simulation, `oct-junior` agent) in independent worktrees to implement their respective integrators; evaluator uses `physicist` (understands energy conservation and symplectic integrators, can independently recompute and judge drift).

### 2.3 Master Launch Call

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

**Parameter selection**:
- `eval_criteria` rather than `eval_command` — physics judgment does not require running an external benchmark script; the evaluator can score from the candidates' DRIFT markers and physics knowledge
- `winner_metric` uses the default `"score"`; each candidate's `score` is their energy drift value
- `score_direction: "min"` — smaller drift is better
- `max_eval_retries: 1` — give the evaluator one retry on scoring failure

### 2.4 Execution Flow (Timeline)

```
T+0m     master calls team_arena (3 candidates + evaluator)
T+0m     implement phase: parallel dispatch alice, bob, carol (each in independent worktree)
T+0~8m   three candidates each implement integrator → run 1000 steps → report DRIFT marker → idle
T+8m     barrier: all candidates idle → arena phase switches to evaluate
T+8m     evaluator prompt build: list candidate names + absolute worktree paths + eval_criteria + winner_metric
T+8m     dispatch evaluator (dave, physicist)
T+8~12m  dave reads each candidate's DRIFT value → optionally re-runs code → scores per eval_criteria → produces <scoreboard> JSON
T+12m    engine parses scoreboard → selectArenaWinner → selects lowest drift by score_direction: "min" → result delivered to master
```

### 2.5 Check Script

> This scenario relies on the evaluator's `<scoreboard>` JSON output and the engine's built-in winner selection logic. External verification: read `runs/<run_id>/dave.md`, extract the scoreboard JSON, and cross-check that each candidate's `score` value matches their DRIFT marker, and the candidate with the smallest `score` has `passed` as `true`.

### 2.6 Evaluator Scoreboard Example

The evaluator (dave), after reviewing the three implementations, should produce a scoreboard in the following format:

```
<scoreboard>{"scores":[{"member":"alice","score":0.239,"metrics":{"drift":0.239,"method":"explicit Euler","E_final":0.6195},"passed":false,"rationale":"Explicit Euler: energy grows systematically from 0.5 to 0.6195 (drift 0.239 >> 1e-3). Non-conservative, fails symplecticity check."},{"member":"bob","score":0.318,"metrics":{"drift":0.318,"method":"implicit Euler","E_final":0.341},"passed":false,"rationale":"Implicit Euler: energy decays from 0.5 to 0.341 (drift 0.318 >> 1e-3). Non-conservative, fails symplecticity check."},{"member":"carol","score":0.00041,"metrics":{"drift":0.00041,"method":"Velocity Verlet","E_final":0.499795},"passed":true,"rationale":"Velocity Verlet: energy oscillates near 0.5, relative drift 4.1e-4 < 1e-3. Symplectic behavior confirmed. Pass."}],"rationale":"Evaluated drift from <!-- DRIFT --> markers + recomputation. Carol's Velocity Verlet stays within symplectic bound (drift 4.1e-4). Alice and Bob both exceed 1e-3 threshold by 2+ orders of magnitude. Winner metric: min drift."}</scoreboard>
```

The engine selects `carol` (drift 0.00041) as the winner using `score_direction: "min"`.

---

## Scenario 3: Three Quadrature Methods Compete on Definite Integral Accuracy

### 3.1 Scenario Description

**Background**: Numerical quadrature is a cornerstone of computational mathematics. For the same definite integral, different quadrature formulas (trapezoidal rule, Simpson's rule, Gauss-Legendre) can differ by several orders of magnitude in accuracy given the same number of function evaluations. `∫₀¹ 1/(1+x²) dx = π/4 ≈ 0.7853981633974483` is a smooth, singularity-free standard test integral whose error differences across methods are intuitively measurable.

**Goal**: Three candidates (`coder` role) each implement one quadrature method, computing an approximate integral value on the same integrand and interval and reporting the absolute error `|I_num - π/4|`; the evaluator judges per `eval_criteria` whether each implementation achieves the expected accuracy order for its method, scores by error, and the engine selects the candidate with the smallest error as the winner.

**Success criteria (machine-evaluable)**:
- Each candidate output contains `<!-- QUAD: <numeric error> -->` marker (absolute error)
- Evaluator output contains `<scoreboard>{...}</scoreboard>` tagged JSON block
- Each scoreboard entry's `score` is the absolute error value (number); `passed` is determined by `eval_criteria`
- The engine selects the candidate with the smallest error as the winner using `score_direction: "min"`

### 3.2 Team Configuration

```json
{
  "name": "quad-arena",
  "description": "Three quadrature methods on ∫₀¹ 1/(1+x²)dx: trapezoidal vs Simpson vs Gaussian-Legendre — winner by min absolute error",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing numerical quadrature. You MUST implement the composite trapezoidal rule with n=100 subintervals (no other method). Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a QUAD marker showing absolute error vs π/4.\n\nYour output MUST end with a line exactly formatted: <!-- QUAD: <absolute_error> -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing numerical quadrature. You MUST implement the composite Simpson's rule with n=100 subintervals (no other method). Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a QUAD marker showing absolute error vs π/4.\n\nYour output MUST end with a line exactly formatted: <!-- QUAD: <absolute_error> -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "worktree": true,
      "prompt": "You are a coder implementing numerical quadrature. You MUST implement 20-point Gaussian-Legendre quadrature on [-1,1] mapped to [0,1] (no other method). Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a QUAD marker showing absolute error vs π/4.\n\nYour output MUST end with a line exactly formatted: <!-- QUAD: <absolute_error> -->"
    },
    {
      "name": "dave",
      "role": "mathematician",
      "worktree": true,
      "prompt": "You are a mathematician. You evaluate each candidate's quadrature implementation by reading their absolute error (QUAD marker), optionally recomputing the integral, and scoring by accuracy. A lower error is better (min direction). An error < 1e-5 demonstrates a well-implemented method (pass).\n\nEmit EXACTLY one scoreboard block and nothing after it: <scoreboard>{\"scores\":[{\"member\":\"...\",\"score\":<n>,\"metrics\":{\"error\":<n>},\"passed\":true|false,\"rationale\":\"...\"}],\"rationale\":\"...\"}</scoreboard>"
    }
  ]
}
```

**Role selection rationale**: The first three candidates uniformly use `coder` (`oct-junior` agent, can write code and run tests) in independent worktrees to implement their respective quadrature methods; evaluator uses `mathematician` (understands numerical analysis, can recognize the theoretical error orders of different methods).

### 3.3 Master Launch Call

```json
{
  "tool": "team_arena",
  "args": {
    "team_id": "quad-arena",
    "task": "Implement the numerical quadrature method assigned in your role prompt to approximate ∫₀¹ 1/(1+x²) dx in TypeScript (do NOT substitute a different method). Compute I_num on [0,1]; the exact value is π/4 ≈ 0.7853981633974483. Report the absolute error |I_num - π/4|. Embed code in a ```typescript fenced block and end with <!-- QUAD: <absolute_error> -->.",
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

**Parameter selection**:
- `eval_criteria` rather than `eval_command` — evaluation only needs to check whether each candidate's reported error is consistent with the claimed method's expected accuracy order, without running an external benchmark
- `winner_metric` uses the default `"score"`; each candidate's `score` is their absolute error
- `score_direction: "min"` — smaller error is better
- `max_eval_retries: 1` — give the evaluator one retry on scoring failure

### 3.4 Execution Flow (Timeline)

```
T+0m     master calls team_arena (3 candidates + evaluator)
T+0m     implement phase: parallel dispatch alice, bob, carol (each in independent worktree)
T+0~8m   three candidates each implement quadrature method → compute integral → report QUAD marker → idle
T+8m     barrier: all candidates idle → arena phase switches to evaluate
T+8m     evaluator prompt build: list candidate names + absolute worktree paths + eval_criteria + winner_metric
T+8m     dispatch evaluator (dave, mathematician)
T+8~12m  dave reads each candidate's QUAD error → optionally re-runs code → scores per eval_criteria → produces <scoreboard> JSON
T+12m    engine parses scoreboard → selectArenaWinner → selects smallest error by score_direction: "min" → result delivered to master
```

### 3.5 Check Script

> This scenario relies on the evaluator's `<scoreboard>` JSON output and the engine's built-in winner selection logic. External verification: read `runs/<run_id>/dave.md`, extract the scoreboard JSON, and cross-check that each candidate's `score` value matches their QUAD marker, and the candidate with the smallest `score` has `passed` as `true`.

### 3.6 Evaluator Scoreboard Example

The evaluator (dave), after reviewing the three implementations, should produce a scoreboard in the following format:

```
<scoreboard>{"scores":[{"member":"alice","score":0.000785,"metrics":{"error":0.000785,"method":"composite trapezoidal (n=100)","exact":0.785398},"passed":false,"rationale":"Trapezoidal rule: O(h²) convergence, 100 subintervals gives error ~7.85e-4 >> 1e-5. Fails accuracy threshold."},{"member":"bob","score":6.5e-8,"metrics":{"error":6.5e-8,"method":"composite Simpson's (n=100)","exact":0.785398},"passed":true,"rationale":"Simpson's rule: O(h⁴) convergence on this smooth integrand, 100 subintervals yields error ~6.5e-8 < 1e-5. Pass."},{"member":"carol","score":4.4e-16,"metrics":{"error":4.4e-16,"method":"20-point Gaussian-Legendre","exact":0.785398},"passed":true,"rationale":"Gaussian-Legendre (n=20): exact for polynomials up to degree 39; 1/(1+x^2) has Bernstein-ellipse radius ρ=1+√2≈2.414, so theoretical error ~ρ^(-2n)≈5e-16 — at IEEE-754 round-off floor. Pass."}],"rationale":"Evaluated absolute error from <!-- QUAD --> markers. Carol's 20-point Gaussian-Legendre achieves machine-precision accuracy (~5e-16); Bob's Simpson's is 8 orders of magnitude worse but still below 1e-5; Alice's trapezoidal is 4 orders above threshold. Winner metric: min error."}</scoreboard>
```

The engine selects `carol` (error ~4.4e-16) as the winner using `score_direction: "min"`.

---

## Scenario 4: Five Poisson Equation Solvers Comprehensive Arena (Challenge-Level)

**Challenge-level notes**: This scenario breaks baseline constraints (3 candidates / ≤4 members / ≤30 min), using **5 candidates + 1 evaluator**, with each candidate implementing a different linear system solver in an independent worktree, and the evaluator running a unified convergence benchmark script, scoring by convergence iteration count. ~40 min, demonstrating arena's scalability under many candidates and high compute density.

### 4.1 Scenario Description

**Background**: The 2D Poisson equation `∇²u = -2π²sin(πx)sin(πy)` (exact solution `u = sin(πx)sin(πy)`) discretized with the standard five-point stencil on an `(N+1)×(N+1)` grid yields an `N² × N²` sparse linear system `Au = f`. Solving such large-scale sparse systems is at the heart of scientific computing: different iterative methods differ enormously in convergence speed, per-step cost, and implementation complexity. Jacobi iteration converges extremely slowly, conjugate gradient provides significant acceleration, and multigrid is near-optimal.

**Goal**: Five candidates (`simulator` role) each implement one iterative solver, running on a unified N=100 problem (10000×10000 sparse matrix) to a residual of `||r||₂/||b||₂ < 1e-6`; the evaluator runs the convergence benchmark script `bun run convergence.ts`, measuring the iteration count for each candidate's solver, scoring by iteration count, and the engine selects the candidate with the fewest iterations as the winner.

**Success criteria (machine-evaluable)**:
- Each candidate output contains `<!-- CONV: <iteration count> -->` marker
- Evaluator output contains `<scoreboard>{...}</scoreboard>` tagged JSON block
- Each scoreboard entry's `score` is the number of iterations to convergence (number); `passed` is determined by `eval_criteria`
- The engine selects the candidate with the fewest iterations as the winner using `score_direction: "min"`

### 4.2 Team Configuration

```json
{
  "name": "poisson-arena",
  "description": "Five iterative solvers for the 2D Poisson equation (N=100 grid): Jacobi vs Gauss-Seidel vs SOR vs Conjugate Gradient vs Multigrid V-cycle — winner by min iterations to convergence",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil.\n\nYour output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil.\n\nYour output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil.\n\nYour output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "dave",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil.\n\nYour output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "erin",
      "role": "simulator",
      "worktree": true,
      "prompt": "You are a simulator implementing an iterative linear solver for the 2D Poisson equation. Embed the full TypeScript implementation in a single ```typescript fenced block and declare it with a CONV marker showing the number of iterations to convergence (residual norm relative < 1e-6). Use N=100 grid (interior points), 5-point Laplacian stencil.\n\nYour output MUST end with a line exactly formatted: <!-- CONV: <iteration_count> -->"
    },
    {
      "name": "frank",
      "role": "physicist",
      "worktree": true,
      "prompt": "You are a physicist. You evaluate each candidate's iterative Poisson solver. Write a unified convergence.ts benchmark script in YOUR OWN worktree that:\n  1. Reads each candidate's TypeScript solver from their captured output at runs/<run_id>/<name>.md (extract the ```typescript fenced block)\n  2. Imports each solver into a common N=100 Poisson harness with Dirichlet BC u=0 on the unit square, f = 2π²sin(πx)sin(πy), exact solution u = sin(πx)sin(πy)\n  3. Runs each to ||r||₂/||b||₂ < 1e-6 using a UNIFIED iteration-count convention (1 iteration = 1 solver step; for Multigrid V-cycle, 1 iteration = 1 V-cycle)\n  4. Records each candidate's iteration count as the 'score' field\nA lower iteration count is better (min direction). A count > 100,000 is considered non-convergent (pass=false). After writing convergence.ts, run `bun run convergence.ts` in your worktree to verify before emitting the scoreboard.\n\nEmit EXACTLY one scoreboard block and nothing after it: <scoreboard>{\"scores\":[{\"member\":\"...\",\"score\":<n>,\"metrics\":{\"iterations\":<n>},\"passed\":true|false,\"rationale\":\"...\"}],\"rationale\":\"...\"}</scoreboard>"
    }
  ]
}
```

**Role selection rationale**: The five candidates uniformly use `simulator` (specialized in numerical simulation, `oct-junior` agent) in independent worktrees to implement their respective iterative solvers; evaluator uses `physicist` (understands PDE numerical methods, can independently judge convergence). Note that 6 members (5 candidates + 1 evaluator) reaches arena v1's recommended ceiling.

### 4.3 Master Launch Call

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

**Parameter selection**:
- `evaluator: "frank"` — not in the `candidates` list, satisfying the "evaluator ≠ candidate" hard constraint
- `candidates` explicitly lists 5 — just enough to cover a representative comparison of 5 mainstream iterative methods
- `eval_command` and `eval_criteria` **provided together** — the benchmark script ensures consistent measurement, the criteria provide threshold judgment (iterations > 100k treated as divergent)
- `winner_metric: "iterations"` + `score_direction: "min"` — fewer iterations is better
- `max_eval_retries: 1` — give the evaluator one retry on scoring failure
- `timeout_ms: 2400000` (40 min) — 5 candidates parallel 10 min + serial evaluation 20 min (each candidate's N=100 convergence needs several iterations with varying runtimes), with ample margin

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_arena (5 candidates + evaluator)
T+0m     implement phase: parallel dispatch alice, bob, carol, dave, erin (each in independent worktree)
T+0~10m  five candidates each implement iterative solver → run convergence → report CONV marker → idle
T+10m    barrier: all candidates idle → arena phase switches to evaluate
T+10m    evaluator prompt build: list candidate names + absolute worktree paths + eval_command + eval_criteria + winner_metric
T+10m    dispatch evaluator (frank, physicist)
T+10~30m frank runs `bun run convergence.ts` per candidate → collects each solver's iteration count → produces <scoreboard> JSON
T+30m    engine parses scoreboard → selectArenaWinner → selects fewest iterations by score_direction: "min" → result delivered to master
```

(5 candidates implement in parallel, a single evaluator serially evaluates each candidate's worktree; on the N=100 Poisson problem, Jacobi ≈ 6000 iterations, Gauss-Seidel ≈ 3000 iterations, SOR(ω=1.9) ≈ 300 iterations, CG ≈ 300 iterations, Multigrid V(2,2) ≈ 10 iterations — convergence speed gaps are enormous, giving the arena scoreboard extremely high discrimination.)

### 4.5 Check Script

> This scenario relies on the evaluator's `<scoreboard>` JSON output and the engine's built-in winner selection logic. External verification: read `runs/<run_id>/frank.md`, extract the scoreboard JSON, cross-check that each candidate's iteration count matches their CONV marker, and the physics expectation is that Multigrid wins (≤20 iterations) and Jacobi comes last (≥5000 iterations).

### 4.6 Evaluator Scoreboard Example

The evaluator (frank), after running the five benchmarks, should produce a scoreboard in the following format:

```
<scoreboard>{"scores":[{"member":"alice","score":6120,"metrics":{"iterations":6120,"method":"Jacobi","residual":9.87e-7},"passed":true,"rationale":"Jacobi: slow convergence (~6k iterations), typical for simple relaxation on 100x100 grid. < 100k => pass."},{"member":"bob","score":2980,"metrics":{"iterations":2980,"method":"Gauss-Seidel","residual":9.92e-7},"passed":true,"rationale":"Gauss-Seidel: ~2x faster than Jacobi due to immediate use of updated values, ~3k iterations on 100x100. Pass."},{"member":"carol","score":312,"metrics":{"iterations":312,"method":"SOR (ω=1.9)","residual":9.65e-7},"passed":true,"rationale":"SOR with near-optimal ω≈1.9: convergence accelerated ~10x vs GS, ~300 iterations. Excellent for this problem class. Pass."},{"member":"dave","score":295,"metrics":{"iterations":295,"method":"Conjugate Gradient","residual":9.88e-7},"passed":true,"rationale":"CG: Krylov-subspace optimal, ~300 iterations on 100x100 SPD system. Comparable to optimal SOR. Pass."},{"member":"erin","score":9,"metrics":{"iterations":9,"method":"Multigrid V(2,2)","residual":8.73e-7},"passed":true,"rationale":"Multigrid V-cycle (2 pre/2 post smoothing, full-weighting restriction, bilinear prolongation): mesh-independent convergence! Only 9 iterations to reach sub-1e-6 residual. Near-optimal O(N) solver. Pass."}],"rationale":"Convergence benchmark via bun run convergence.ts on N=100 Poisson problem (10000 unknowns). Erin's Multigrid dominates at 9 iterations (O(N) optimal); SOR/CG compete at ~300; Gauss-Seidel trails at ~3k; Jacobi bottom at ~6k. Winner metric: min iterations."}</scoreboard>
```

The engine selects `erin` (9 iterations) as the winner using `score_direction: "min"` — multigrid's near-optimal convergence demonstrates an order-of-magnitude advantage on a 10000-unknown system.

---


## Quick-Start Prompt (Copy and Use)

Paste any of the following prompts into the master session and the AI will automatically complete the full loop. In arena mode, evaluation reads the **evaluator** member's .md file for the `<scoreboard>` JSON + the engine's built-in `selectArenaWinner` logic.

### Scenario 1: Three Sorting Implementations Benchmark for Fastest (Programming)

```text
Run the complete closed loop for demos/11-team-arena/README.md "Scenario 1" and auto-score.
Steps:
1. Read README "1.2 Team Configuration", create team per team_create JSON (3 candidate coders + 1 evaluator reviewer, each candidate worktree: true, evaluator also set worktree: true)
2. team_activate to activate
3. Read README "1.3 Master Launch Call", launch arena per team_arena JSON (implement → evaluate, eval_command runs benchmark script)
4. Poll team_results until master receives summary (after all candidates idle, evaluator runs benchmark, produces scoreboard; engine auto-selects winner) (poll every 30s)
5. Locate <run_dir> (contains evaluator dave.md)
6. Read dave.md, extract <scoreboard> JSON, view winner and each candidate's score
Success criteria: evaluator produces valid <scoreboard> JSON; engine selects highest throughput by throughput_ops_per_sec max. At least 2 candidates passed=true.
```

### Scenario 2: Three Integrators Compared by Energy Drift for Most Stable (Computational Physics)

```text
Run the complete closed loop for demos/11-team-arena/README.md "Scenario 2" and auto-score.
Steps:
1. Read README "2.2 Team Configuration", create team per team_create JSON (3 candidate simulators + 1 evaluator physicist, each candidate worktree: true, evaluator also set worktree: true)
2. team_activate to activate
3. Read README "2.3 Master Launch Call", launch arena per team_arena JSON (implement → evaluate, eval_criteria energy conservation judgment)
4. Poll team_results until master receives summary (after all candidates idle, evaluator reviews DRIFT, produces scoreboard; engine auto-selects winner) (poll every 30s)
5. Locate <run_dir> (contains evaluator dave.md)
6. Read dave.md, extract <scoreboard> JSON, view winner and each candidate's drift value
Success criteria: evaluator produces valid <scoreboard> JSON; engine selects symplectic integrator with smallest drift by score min. Velocity Verlet candidate passed=true and score < 1e-3.
```

### Scenario 3: Three Quadrature Methods Compete on Definite Integral Accuracy (Math)

```text
Run the complete closed loop for demos/11-team-arena/README.md "Scenario 3" and auto-score.
Steps:
1. Read README "3.2 Team Configuration", create team per team_create JSON (3 candidate coders + 1 evaluator mathematician, each candidate worktree: true, evaluator also set worktree: true)
2. team_activate to activate
3. Read README "3.3 Master Launch Call", launch arena per team_arena JSON (implement → evaluate, eval_criteria accuracy judgment)
4. Poll team_results until master receives summary (after all candidates idle, evaluator reviews QUAD, produces scoreboard; engine auto-selects winner) (poll every 30s)
5. Locate <run_dir> (contains evaluator dave.md)
6. Read dave.md, extract <scoreboard> JSON, view winner and each candidate's error
Success criteria: evaluator produces valid <scoreboard> JSON; engine selects quadrature method with smallest error by score min. Gaussian-Legendre candidate passed=true and score < 1e-10 (Gaussian quadrature should reach machine precision on smooth integrand).
```

### Scenario 4: Five Poisson Equation Solvers Comprehensive Arena (Challenge-Level · Computational Physics)

```text
Run the complete closed loop for demos/11-team-arena/README.md "Scenario 4" and auto-score (challenge-level: 5 candidates + 1 evaluator, N=100 large sparse system).
Steps:
1. Read README "4.2 Team Configuration", create team per team_create JSON (5 candidate simulators + 1 evaluator physicist, each candidate worktree: true, evaluator also set worktree: true)
2. team_activate to activate
3. Read README "4.3 Master Launch Call", launch arena per team_arena JSON (implement → evaluate, eval_command + eval_criteria dual benchmark)
4. Poll team_results until master receives summary (after all candidates idle, evaluator runs convergence benchmark, produces scoreboard; engine auto-selects winner) (poll every 30s)
5. Locate <run_dir> (contains evaluator frank.md)
6. Read frank.md, extract <scoreboard> JSON, view winner and each candidate's iteration count
Success criteria: evaluator produces valid <scoreboard> JSON; engine selects fastest-converging solver by iterations min. Multigrid V-cycle candidate should have ≤20 iterations, Jacobi should have ≥5000 iterations (verifying order-of-magnitude discrimination of convergence speed). At least 3 candidates passed=true.
```
