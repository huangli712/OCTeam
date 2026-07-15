# team_parallel Orchestration Scenario Demo

`team_parallel` dispatches the same or different tasks to all team members at once and runs them concurrently, then optionally reduces their outputs into a single aggregated result (via `summarize` / `select` / `merge` / `rubric` strategies).

---

## Scenario Overview

| # | Domain | Scenario | Members | Role | reduce_policy | Est. Total Duration |
|---|------|------|--------|------|---------------|-----------|
| 1 | Math | Monte Carlo pi: 3-method comparison | 3 | `mathematician` | `merge` | ~12 min |
| 2 | Computational Physics | Harmonic oscillator: 3 integrators energy drift | 3 | `simulator` | `select` | ~12 min |
| 3 | Programming | Two-sum: multi-solution complexity comparison | 3 | `coder` | `rubric` | ~10 min |
| 4 | Programming (challenge-level) | 8 sorting algorithms 10⁶ three-dataset benchmark | 8 | `coder` | `merge` | ~40 min |

---

## Scenario 1: Monte Carlo Pi 3-Method Comparison

### 1.1 Scenario Description

**Background**: Pi (π) has multiple estimation methods based on random sampling, with significantly different variance characteristics. Comparing them at the same sample size (10⁶) intuitively reveals method quality.

**Goal**: 3 members each use a different method to estimate pi, then aggregate into an error comparison table.

- Method A: Naive Monte Carlo (point-in-unit-circle)
- Method B: Stratified sampling (100×100 grid, 100 points per cell)
- Method C: Buffon's needle (L = d)

**Success criteria (machine-verifiable)**:
- Each member's output contains a `<!-- PI_EST: <value> -->` marker
- All three methods: `|π_est - π| < 0.05`
- Stratified sampling error ≤ naive MC (guaranteed by variance theory)

### 1.2 Team Config

```json
{
  "name": "pi-bench",
  "description": "Monte Carlo pi estimation: 3 methods compared at 1e6 samples",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "Estimate pi via naive Monte Carlo: sample (x,y) uniformly in [0,1]^2, count fraction inside the unit circle (x^2+y^2<=1), pi ~ 4*count/N.\n\nUse EXACTLY 1,000,000 samples with fixed seed 42.\n\nRun the code, report the estimate, and give a one-line variance analysis.\n\nYour output MUST end with a line exactly formatted: <!-- PI_EST: <your_numeric_estimate> -->"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "Estimate pi via stratified sampling: divide [0,1]^2 into a 100x100 grid (10,000 strata), sample 100 points per stratum (total 1,000,000). For each stratum compute the in-circle fraction then average.\n\nFixed seed 42.\n\nReport the estimate and explain in one line why stratification reduces variance.\n\nYour output MUST end with a line exactly formatted: <!-- PI_EST: <your_numeric_estimate> -->"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "Estimate pi via Buffon's needle: needle length L equals line spacing d; the crossing probability is 2/pi, so pi ~ 2*N_total/N_cross.\n\nDrop 1,000,000 needles with fixed seed 42.\n\nReport the estimate.\n\nYour output MUST end with a line exactly formatted: <!-- PI_EST: <your_numeric_estimate> -->"
    }
  ]
}
```

**Role selection rationale**: `mathematician` uses the `oct-junior` agent, capable of writing code, running it, and doing numerical verification — exactly matches this scenario's needs.

### 1.3 Master Launch Invocation

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "pi-bench",
    "mode": "cooperative",
    "tasks": {
      "alice": "Run your pi estimation now. Produce the numeric result and end with the PI_EST marker.",
      "bob": "Run your pi estimation now. Produce the numeric result and end with the PI_EST marker.",
      "carol": "Run your pi estimation now. Produce the numeric result and end with the PI_EST marker."
    },
    "reduce_policy": "merge",
    "reducer_member": "alice",
    "timeout_ms": 900000,
    "max_errored_members": 0
  }
}
```

**Parameter selection**:
- `mode: cooperative` — the three methods differ, each needs its own task
- `reduce_policy: merge` — keep all three independent results for comparison (not select single-winner)
- `reducer_member: alice` — non-summarize strategies must specify reducer_member (otherwise the tool rejects execution); assign alice to merge and aggregate
- `timeout_ms: 900000` (15 min) — ample headroom; normally completes in 8 min
- `max_errored_members: 0` — any member failure means total failure (losing one of three methods is incomplete)

### 1.4 Execution Flow (Timeline)

```
T+0m    master calls team_parallel (cooperative)
T+0m    OCTeam dispatches 3 mathematician members in parallel
T+0~8m  each member independently: write code → run 10^6 samples → write markdown report + PI_EST marker
T+8m    slowest member idle → trigger reduce (merge policy)
T+9m    aggregated report delivered to master
T+9m    run: bun check-math-montecarlo-pi.ts <run_dir>
```

### 1.5 Check Script

[`check-math-montecarlo-pi.ts`](./check-math-montecarlo-pi.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**: regex `<!-- PI_EST:\s*([\d.]+)\s*-->`
- **Assertions**:
  1. All three estimates exist
  2. Each value `|est - π| < 0.05`
  3. `bob`'s error ≤ `alice`'s error

---

## Scenario 2: Harmonic Oscillator 3 Integrators Energy Drift

### 2.1 Scenario Description

**Background**: The simple harmonic oscillator (`ẍ = -ω²x`, with ω=1) is a standard test case for energy-conserving systems. Different numerical integrators exhibit vastly different energy drift under finite step sizes, making it a classic benchmark for integrator quality.

**Goal**: 3 members each use a different integrator (explicit Euler / Velocity Verlet / classical RK4) to simulate 1000 steps (step size h=0.01), reporting relative energy drift.

**Success criteria**:
- Each member's output contains an `<!-- ENERGY_DRIFT: <value> -->` marker (relative drift |E_end - E_0|/E_0)
- Explicit Euler drift is significant (theoretically > 0.01)
- Velocity Verlet drift is extremely small (< 1e-3, symplectic scheme)
- RK4 drift < Euler (higher-order method)
- `bob.drift < alice.drift` and `carol.drift < alice.drift`

### 2.2 Team Config

```json
{
  "name": "oscillator-bench",
  "description": "Harmonic oscillator: 3 integrators compared by energy drift over 1000 steps",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "Simulate the harmonic oscillator d^2x/dt^2 = -x (omega=1) using EXPLICIT (forward) Euler for exactly 1000 steps with step h=0.01.\n\nInitial conditions x0=1, v0=0.\n\nTotal energy E = 0.5*(x^2 + v^2) (initial E0 = 0.5).\n\nReport the relative energy drift |E_end - E0|/E0.\n\nYour output MUST end with a line exactly formatted: <!-- ENERGY_DRIFT: <numeric_drift> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "Simulate the harmonic oscillator d^2x/dt^2 = -x (omega=1) using VELOCITY VERLET for exactly 1000 steps with step h=0.01.\n\nInitial conditions x0=1, v0=0.\n\nTotal energy E = 0.5*(x^2 + v^2) (initial E0 = 0.5).\n\nReport the relative energy drift |E_end - E0|/E0.\n\nYour output MUST end with a line exactly formatted: <!-- ENERGY_DRIFT: <numeric_drift> -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "Simulate the harmonic oscillator d^2x/dt^2 = -x (omega=1) using CLASSICAL RK4 (on the first-order system [x,v]) for exactly 1000 steps with step h=0.01.\n\nInitial conditions x0=1, v0=0.\n\nTotal energy E = 0.5*(x^2 + v^2) (initial E0 = 0.5).\n\nReport the relative energy drift |E_end - E0|/E0.\n\nYour output MUST end with a line exactly formatted: <!-- ENERGY_DRIFT: <numeric_drift> -->"
    }
  ]
}
```

**Role selection rationale**: `simulator` is purpose-built for numerical simulation (PDE/MC/MD/HPC), fitting the physics simulation scenario.

### 2.3 Master Launch Invocation

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "oscillator-bench",
    "mode": "cooperative",
    "tasks": {
      "alice": "Run your explicit Euler simulation now and report the energy drift marker.",
      "bob": "Run your Velocity Verlet simulation now and report the energy drift marker.",
      "carol": "Run your RK4 simulation now and report the energy drift marker."
    },
    "reduce_policy": "select",
    "reduce_select": "Select the integrator with the SMALLEST absolute energy drift |E_end - E0|/E0, as reported in each candidate's ENERGY_DRIFT marker. Judge purely by the reported drift magnitude — do NOT favor any particular integration method.",
    "reducer_member": "alice",
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- `reduce_policy: select` — let one member (alice) do comprehensive evaluation, selecting the best energy-conserving option
- `reduce_select` (method-neutral) — explicitly states "best = smallest absolute ENERGY_DRIFT value", preventing the reducer from treating their own assigned task (implementing explicit Euler) as the judging standard and always selecting themselves. This is the key parameter for the select strategy: without it, the reducer degrades to "pick whoever's solution matches my own method"
- `reducer_member: alice` — assign alice to aggregate (avoid defaulting to master)

### 2.4 Execution Flow (Timeline)

```
T+0m    master calls team_parallel (cooperative)
T+0m    3 simulator members dispatched in parallel
T+0~6m  each member writes integrator code → run 1000 steps → report ENERGY_DRIFT
T+6m    all three members idle → reduce (select policy, reducer=alice)
T+7m    alice aggregates & compares, delivers to master
T+7m    run: bun check-physics-harmonic-integrator.ts <run_dir>
```

### 2.5 Check Script

[`check-physics-harmonic-integrator.ts`](./check-physics-harmonic-integrator.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**: regex `<!-- ENERGY_DRIFT:\s*([\d.eE+-]+)\s*-->`
- **Assertions**:
  1. All three drift values exist
  2. `alice.drift > 1e-3` (explicit Euler at h=0.01/1000 steps must have visible drift)
  3. `bob.drift < alice.drift` (symplectic scheme conserves better than explicit)
  4. `carol.drift < alice.drift` (higher-order method beats lower-order)

---

## Scenario 3: Two-Sum Multi-Solution Complexity Comparison

### 3.1 Scenario Description

**Background**: LeetCode's classic "Two Sum" problem (given integer array `nums` and target `target`, return indices of the two elements summing to target). The same problem has multiple solutions with significantly different complexities, making it a standard case study in algorithm teaching.

**Goal**: 3 members each implement a different solution (brute-force O(n²) / hash map O(n) / sort+two-pointer O(n log n)), self-report complexity, and pass unified test cases.

**Success criteria**:
- Each member's output contains a `<!-- COMPLEXITY: <BigO> -->` marker
- Each member's code passes 3 preset test cases
- Complexity annotations are correct (alice=O(n^2), bob=O(n), carol=O(n log n))

### 3.2 Team Config

```json
{
  "name": "sum-bench",
  "description": "Two-sum problem: 3 solutions (alice / bob / carol) with complexity analysis",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "Implement the Two Sum problem (return indices of the two numbers adding to target; exactly one solution exists) using the BRUTE-FORCE O(n^2) approach.\n\nFunction signature: function twoSum(nums: number[], target: number): number[].\n\nEmbed the full TypeScript code in a ```typescript fenced block. Then declare the complexity.\n\nYour output MUST end with a line exactly formatted: <!-- COMPLEXITY: O(n^2) -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "Implement the Two Sum problem (return indices of the two numbers adding to target; exactly one solution exists) using the HASH MAP O(n) approach.\n\nFunction signature: function twoSum(nums: number[], target: number): number[].\n\nEmbed the full TypeScript code in a ```typescript fenced block. Then declare the complexity.\n\nYour output MUST end with a line exactly formatted: <!-- COMPLEXITY: O(n) -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "Implement Two Sum using SORT + TWO-POINTER O(n log n). NOTE: sort loses original indices, so you must keep (value, originalIndex) pairs.\n\nFunction signature: function twoSum(nums: number[], target: number): number[].\n\nEmbed the full TypeScript code in a ```typescript fenced block. Then declare the complexity.\n\nYour output MUST end with a line exactly formatted: <!-- COMPLEXITY: O(n log n) -->"
    }
  ]
}
```

**Role selection rationale**: `coder` uses the `oct-junior` agent, focusing on implementation with minimal changes — fitting the algorithm-task implementation needs.

### 3.3 Master Launch Invocation

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "sum-bench",
    "mode": "cooperative",
    "tasks": {
      "alice": "Implement your brute-force Two Sum now. Embed code + complexity marker.",
      "bob": "Implement your hash-map Two Sum now. Embed code + complexity marker.",
      "carol": "Implement your sort+two-pointer Two Sum now. Embed code + complexity marker."
    },
    "reduce_policy": "rubric",
    "reduce_rubric": "Score each solution on: (a) correctness on the 3 test cases [nums=[2,7,11,15],target=9 -> [0,1]; nums=[3,2,4],target=6 -> [1,2]; nums=[3,3],target=6 -> [0,1]], (b) stated complexity matching actual complexity, (c) code clarity. Rank the three solutions.",
    "reducer_member": "alice",
    "timeout_ms": 600000
  }
}
```

**Parameter selection**:
- `reduce_policy: rubric` — compare by an explicit scoring table (not simple merging)
- `reduce_rubric` embeds test cases directly — lets the reducer judge with a unified standard
- `reducer_member: alice` — assign alice to score and rank. Non-summarize strategies **must** specify reducer_member, otherwise the scoring guidance is left unexecuted (the tool will error and reject)

### 3.4 Execution Flow (Timeline)

```
T+0m    master calls team_parallel (cooperative)
T+0m    3 coder members dispatched in parallel
T+0~5m  each member writes Two Sum implementation + embed code + complexity annotation
T+5m    all three members idle → reduce (rubric policy, reducer=alice)
T+6m    alice scores & ranks by rubric, produces reducedResult
T+6m    run: bun check-coding-twosum.ts <run_dir>
```

### 3.5 Check Script

[`check-coding-twosum.ts`](./check-coding-twosum.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**:
  - Code: capture ` ```typescript ... ``` ` code block
  - Complexity: regex `<!-- COMPLEXITY:\s*(O\([^)]+\))\s*-->`
- **Assertions**:
  1. All three code blocks can be loaded as `twoSum` functions via `new Function`
  2. Each function returns correct indices on 3 test cases
  3. Complexity annotations match expectations (alice=O(n^2), bob=O(n), carol=O(n log n))

---

## Scenario 4: 8 Sorting Algorithms Large-Data Benchmark (Challenge-Level)

**Challenge-level note**: This scenario's scale (8 members × 10⁶ × 3 datasets) deliberately exceeds the normal limits of Scenarios 1-3 (≤ 4 members / ≤ 30 min), used to stress-test end-to-end orchestration capability with an 8-member full team and 60-min-class timeout.

### 4.1 Scenario Description

**Background**: Sorting algorithms are the "benchmark mother problem" of algorithm engineering. Cross-comparing 8 mainstream sorting algorithms at 10⁶ scale × three typical distributions (uniform random / nearly sorted / reversed) simultaneously tests implementation correctness and each algorithm's sensitivity to input distribution.

**Goal**: 8 coder members each implement **one** sorting algorithm, run it on 3 datasets of 10⁶ integers each, time it, verify element-by-element correctness against the platform's native sort, and finally aggregate into an 8×3 benchmark comparison table.

**Member ↔ Algorithm mapping** (in `MEMBER_NAME_POOL` order)

| Member | Algorithm |
|------|------|
| alice | quicksort (median-of-three + insertion sort fallback for small partitions) |
| bob | mergesort (top-down, stable, O(n) auxiliary buffer) |
| carol | heapsort (in-place binary heap) |
| dave | radixsort (LSD base-256, 4 passes for 32-bit non-negative integers) |
| erin | timsort (minrun + binary insertion + galloping merge) |
| frank | shellsort (Marcin Ciura gap sequence) |
| grace | introsort (quicksort + depth-limit switch to heapsort + insertion for small partitions) |
| henry | counting-sort (count over [min,max]; note ~10⁹ span memory pressure for random dataset) |

**Datasets** (every member runs all, deterministic seed=42)

- **(a) RANDOM**: 10⁶ uniform random integers in `[0, 10⁹)` (deterministic PRNG with seed=42, e.g. mulberry32 / LCG).
- **(b) NEARLY**: Take RANDOM sorted ascending, then perform exactly 10,000 random swaps (1% of 10⁶), PRNG reset to seed=42.
- **(c) REVERSE**: RANDOM sorted descending.

**Success criteria (machine-verifiable)**

- All 8 members each output `<!-- SORT_OK: true -->` (all 3 datasets match native sort element-by-element)
- All 8 members each output `<!-- TIME_RANDOM: <ms> -->` / `<!-- TIME_NEARLY: <ms> -->` / `<!-- TIME_REVERSE: <ms> -->` — totaling 8×3 = 24 TIME markers
- The reduce (`merge` strategy) aggregate output contains an 8-algorithm × 3-dataset comparison table (human visual check, not machine assertion)

**Estimated duration: ~40 min** (members implement in parallel + generate 3×10⁶ datasets + sort + verify + time; slowest member ~35 min, plus reduce and check ≈ 40 min).

### 4.2 Team Config

```json
{
  "name": "sort-bench",
  "description": "Challenge: 8 sorting algorithms benchmarked on 3 datasets of 10^6 integers each",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "Implement QUICKSORT (in-place, median-of-three pivot, switch to insertion sort for partitions smaller than 16).\n\nDatasets (each EXACTLY 1,000,000 integers, deterministic seed 42): (a) RANDOM = uniform integers in [0, 1e9) from a seeded PRNG (mulberry32 or LCG with seed 42); (b) NEARLY = RANDOM sorted ascending then exactly 10,000 random swaps (1% of 10^6), PRNG reset to seed 42; (c) REVERSE = RANDOM sorted descending.\n\nFor EACH dataset: copy it, sort the copy with YOUR quicksort, verify element-by-element equality against Array.prototype.sort with comparator (a,b)=>a-b (the reference), and measure wall-clock milliseconds around YOUR sort only (not dataset generation), taking the median of a few warmup passes.\n\nYour output MUST end with these four lines, each exactly formatted:\n<!-- SORT_OK: <true|false> -->\n<!-- TIME_RANDOM: <ms> -->\n<!-- TIME_NEARLY: <ms> -->\n<!-- TIME_REVERSE: <ms> -->\nSet SORT_OK to true only if all three datasets match the reference sort."
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "Implement MERGESORT (top-down, divide-and-conquer, stable, O(n) auxiliary buffer).\n\nDatasets (each EXACTLY 1,000,000 integers, deterministic seed 42): (a) RANDOM = uniform integers in [0, 1e9) from a seeded PRNG (mulberry32 or LCG with seed 42); (b) NEARLY = RANDOM sorted ascending then exactly 10,000 random swaps (1% of 10^6), PRNG reset to seed 42; (c) REVERSE = RANDOM sorted descending.\n\nFor EACH dataset: copy it, sort the copy with YOUR mergesort, verify element-by-element equality against Array.prototype.sort with comparator (a,b)=>a-b (the reference), and measure wall-clock milliseconds around YOUR sort only (not dataset generation), taking the median of a few warmup passes.\n\nYour output MUST end with these four lines, each exactly formatted:\n<!-- SORT_OK: <true|false> -->\n<!-- TIME_RANDOM: <ms> -->\n<!-- TIME_NEARLY: <ms> -->\n<!-- TIME_REVERSE: <ms> -->\nSet SORT_OK to true only if all three datasets match the reference sort."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "Implement HEAPSORT (in-place binary heap: build-max-heap then repeatedly extract-max to the end).\n\nDatasets (each EXACTLY 1,000,000 integers, deterministic seed 42): (a) RANDOM = uniform integers in [0, 1e9) from a seeded PRNG (mulberry32 or LCG with seed 42); (b) NEARLY = RANDOM sorted ascending then exactly 10,000 random swaps (1% of 10^6), PRNG reset to seed 42; (c) REVERSE = RANDOM sorted descending.\n\nFor EACH dataset: copy it, sort the copy with YOUR heapsort, verify element-by-element equality against Array.prototype.sort with comparator (a,b)=>a-b (the reference), and measure wall-clock milliseconds around YOUR sort only (not dataset generation), taking the median of a few warmup passes.\n\nYour output MUST end with these four lines, each exactly formatted:\n<!-- SORT_OK: <true|false> -->\n<!-- TIME_RANDOM: <ms> -->\n<!-- TIME_NEARLY: <ms> -->\n<!-- TIME_REVERSE: <ms> -->\nSet SORT_OK to true only if all three datasets match the reference sort."
    },
    {
      "name": "dave",
      "role": "coder",
      "prompt": "Implement LSD RADIX SORT (base 256, 4 passes over the bytes of 32-bit non-negative integers, stable counting-sort per byte).\n\nDatasets (each EXACTLY 1,000,000 integers, deterministic seed 42): (a) RANDOM = uniform integers in [0, 1e9) from a seeded PRNG (mulberry32 or LCG with seed 42); (b) NEARLY = RANDOM sorted ascending then exactly 10,000 random swaps (1% of 10^6), PRNG reset to seed 42; (c) REVERSE = RANDOM sorted descending.\n\nFor EACH dataset: copy it, sort the copy with YOUR radix sort, verify element-by-element equality against Array.prototype.sort with comparator (a,b)=>a-b (the reference), and measure wall-clock milliseconds around YOUR sort only (not dataset generation), taking the median of a few warmup passes.\n\nYour output MUST end with these four lines, each exactly formatted:\n<!-- SORT_OK: <true|false> -->\n<!-- TIME_RANDOM: <ms> -->\n<!-- TIME_NEARLY: <ms> -->\n<!-- TIME_REVERSE: <ms> -->\nSet SORT_OK to true only if all three datasets match the reference sort."
    },
    {
      "name": "erin",
      "role": "coder",
      "prompt": "Implement TIMSORT (compute minrun, identify natural runs, binary-insertion-sort runs shorter than minrun, merge runs with galloping).\n\nDatasets (each EXACTLY 1,000,000 integers, deterministic seed 42): (a) RANDOM = uniform integers in [0, 1e9) from a seeded PRNG (mulberry32 or LCG with seed 42); (b) NEARLY = RANDOM sorted ascending then exactly 10,000 random swaps (1% of 10^6), PRNG reset to seed 42; (c) REVERSE = RANDOM sorted descending.\n\nFor EACH dataset: copy it, sort the copy with YOUR timsort, verify element-by-element equality against Array.prototype.sort with comparator (a,b)=>a-b (the reference), and measure wall-clock milliseconds around YOUR sort only (not dataset generation), taking the median of a few warmup passes.\n\nYour output MUST end with these four lines, each exactly formatted:\n<!-- SORT_OK: <true|false> -->\n<!-- TIME_RANDOM: <ms> -->\n<!-- TIME_NEARLY: <ms> -->\n<!-- TIME_REVERSE: <ms> -->\nSet SORT_OK to true only if all three datasets match the reference sort."
    },
    {
      "name": "frank",
      "role": "coder",
      "prompt": "Implement SHELLSORT with the Marcin Ciura gap sequence [701, 301, 132, 57, 23, 10, 4, 1] (gapped insertion sort per gap).\n\nDatasets (each EXACTLY 1,000,000 integers, deterministic seed 42): (a) RANDOM = uniform integers in [0, 1e9) from a seeded PRNG (mulberry32 or LCG with seed 42); (b) NEARLY = RANDOM sorted ascending then exactly 10,000 random swaps (1% of 10^6), PRNG reset to seed 42; (c) REVERSE = RANDOM sorted descending.\n\nFor EACH dataset: copy it, sort the copy with YOUR shellsort, verify element-by-element equality against Array.prototype.sort with comparator (a,b)=>a-b (the reference), and measure wall-clock milliseconds around YOUR sort only (not dataset generation), taking the median of a few warmup passes.\n\nYour output MUST end with these four lines, each exactly formatted:\n<!-- SORT_OK: <true|false> -->\n<!-- TIME_RANDOM: <ms> -->\n<!-- TIME_NEARLY: <ms> -->\n<!-- TIME_REVERSE: <ms> -->\nSet SORT_OK to true only if all three datasets match the reference sort."
    },
    {
      "name": "grace",
      "role": "coder",
      "prompt": "Implement INTROSORT (quicksort with median-of-three, recursion-depth limit 2*floor(log2(n)) that switches to heapsort, and insertion sort for partitions smaller than 16).\n\nDatasets (each EXACTLY 1,000,000 integers, deterministic seed 42): (a) RANDOM = uniform integers in [0, 1e9) from a seeded PRNG (mulberry32 or LCG with seed 42); (b) NEARLY = RANDOM sorted ascending then exactly 10,000 random swaps (1% of 10^6), PRNG reset to seed 42; (c) REVERSE = RANDOM sorted descending.\n\nFor EACH dataset: copy it, sort the copy with YOUR introsort, verify element-by-element equality against Array.prototype.sort with comparator (a,b)=>a-b (the reference), and measure wall-clock milliseconds around YOUR sort only (not dataset generation), taking the median of a few warmup passes.\n\nYour output MUST end with these four lines, each exactly formatted:\n<!-- SORT_OK: <true|false> -->\n<!-- TIME_RANDOM: <ms> -->\n<!-- TIME_NEARLY: <ms> -->\n<!-- TIME_REVERSE: <ms> -->\nSet SORT_OK to true only if all three datasets match the reference sort."
    },
    {
      "name": "henry",
      "role": "coder",
      "prompt": "Implement COUNTING SORT over the [min, max] value range of each dataset using an offset typed-array of size (max-min+1). NOTE: the RANDOM dataset spans roughly [0, 1e9), so a full counting array may need ~4 GB and could be memory-infeasible; if a dataset is infeasible, still report it honestly (SORT_OK=false with a one-line note) rather than crashing.\n\nDatasets (each EXACTLY 1,000,000 integers, deterministic seed 42): (a) RANDOM = uniform integers in [0, 1e9) from a seeded PRNG (mulberry32 or LCG with seed 42); (b) NEARLY = RANDOM sorted ascending then exactly 10,000 random swaps (1% of 10^6), PRNG reset to seed 42; (c) REVERSE = RANDOM sorted descending.\n\nFor EACH dataset that is feasible: copy it, sort the copy with YOUR counting sort, verify element-by-element equality against Array.prototype.sort with comparator (a,b)=>a-b (the reference), and measure wall-clock milliseconds around YOUR sort only (not dataset generation), taking the median of a few warmup passes.\n\nYour output MUST end with these four lines, each exactly formatted:\n<!-- SORT_OK: <true|false> -->\n<!-- TIME_RANDOM: <ms> -->\n<!-- TIME_NEARLY: <ms> -->\n<!-- TIME_REVERSE: <ms> -->\nSet SORT_OK to true only if all three datasets are feasible and match the reference sort."
    }
  ]
}
```

**Role selection rationale**: All 8 members use `coder` (`oct-junior` agent, capable of writing code, running it, and doing correctness verification), perfectly matching the "implement + run benchmarks + self-check" challenge needs. Member names use the first 8 entries from `MEMBER_NAME_POOL` (alice..henry), the team is at full capacity (limit 8).

### 4.3 Master Launch Invocation

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "sort-bench",
    "mode": "cooperative",
    "tasks": {
      "alice": "Implement quicksort and run it on the 3 datasets (random/nearly/reverse, each 10^6, seed 42). Verify against native sort and emit the 4 markers.",
      "bob": "Implement mergesort and run it on the 3 datasets (random/nearly/reverse, each 10^6, seed 42). Verify against native sort and emit the 4 markers.",
      "carol": "Implement heapsort and run it on the 3 datasets (random/nearly/reverse, each 10^6, seed 42). Verify against native sort and emit the 4 markers.",
      "dave": "Implement LSD radix sort and run it on the 3 datasets (random/nearly/reverse, each 10^6, seed 42). Verify against native sort and emit the 4 markers.",
      "erin": "Implement timsort and run it on the 3 datasets (random/nearly/reverse, each 10^6, seed 42). Verify against native sort and emit the 4 markers.",
      "frank": "Implement shellsort (Ciura gaps) and run it on the 3 datasets (random/nearly/reverse, each 10^6, seed 42). Verify against native sort and emit the 4 markers.",
      "grace": "Implement introsort and run it on the 3 datasets (random/nearly/reverse, each 10^6, seed 42). Verify against native sort and emit the 4 markers.",
      "henry": "Implement counting sort and run it on the 3 datasets (random/nearly/reverse, each 10^6, seed 42). Verify against native sort and emit the 4 markers."
    },
    "reduce_policy": "merge",
    "reducer_member": "alice",
    "timeout_ms": 3600000,
    "max_errored_members": 0
  }
}
```

**Parameter selection**

- `mode: cooperative` — 8 algorithms are all different, each needs its own independent task
- `reduce_policy: merge` — keep 8 independent results to assemble a comparison table (not select single-winner / rubric scoring)
- `reducer_member: alice` — non-summarize strategies must specify reducer_member (otherwise the tool rejects execution); assign alice to merge and aggregate
- `timeout_ms: 3600000` (60 min) — ample headroom for challenge-level; normally ~35 min to complete, including heavier implementations like timsort / counting-sort
- `max_errored_members: 0` — missing any of the 8 algorithms makes the comparison table incomplete; any member failure means total failure

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_parallel (cooperative, 8 members)
T+0m     OCTeam dispatches 8 coder members in parallel (full team)
T+0~35m  each member independently: implement algorithm → generate 3×10^6 datasets (seed=42) → sort + time → element-by-element verification against native sort → write markdown report + 4 markers
T+35m    slowest member idle → trigger reduce (merge policy, reducer=alice)
T+38m    merged 8×3 comparison table delivered to master
T+38m    run: bun check-coding-sort-benchmark.ts <run_dir>
```

### 4.5 Check Script

[`check-coding-sort-benchmark.ts`](./check-coding-sort-benchmark.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,dave,erin,frank,grace,henry}.md` (8 files total)
- **Extract**:
  - Correctness: `<!-- SORT_OK:\s*(true|false)\s*-->`
  - Timing: `<!-- TIME_RANDOM:\s*([\d.]+)\s*-->`, `<!-- TIME_NEARLY:\s*([\d.]+)\s*-->`, `<!-- TIME_REVERSE:\s*([\d.]+)\s*-->`
- **Assertions**:
  1. All 8 members `SORT_OK=true` (all 8/8 datasets match native sort)
  2. All 24 TIME markers present (8 members × 3 datasets) and all are non-negative numbers
  3. Print 8×3 benchmark comparison table (for human visual cross-check against reduce aggregation)
- The comparison table in reduce output is a human visual check item, not a machine assertion

---

## Quick-Start Prompt (Copy and Use)

Paste any of the following prompts to the master session, and the AI will automatically complete the full closed loop of "create team → activate → launch orchestration → wait for aggregation → run check script", reporting PASS / FAIL by exit code. All specific configs (team_create, team_parallel parameters) directly reference the corresponding sections of this README — no manual JSON copying needed.

### Scenario 1: Monte Carlo Pi 3-Method Comparison

```text
Run the full closed loop of demos/01-team-parallel/README.md "Scenario 1: Monte Carlo Pi 3-Method Comparison" and auto-evaluate.

Steps:
1. Read README "1.2 Team Config", create the team using the team_create JSON
2. team_activate (team_id = the team name created in the previous step)
3. Read README "1.3 Master Launch Invocation", start the orchestration using the team_parallel JSON
4. team_results poll, wait for orchestration to complete and master to receive summary (poll every 30s)
5. Locate the output directory <run_dir> for this run (contains alice.md / bob.md / carol.md)
6. Run evaluation:
   bun demos/01-team-parallel/check-math-montecarlo-pi.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: all three methods |π_est − π| < 0.05; and stratified sampling error ≤ naive Monte Carlo.
```

### Scenario 2: Harmonic Oscillator 3 Integrators Energy Drift

```text
Run the full closed loop of demos/01-team-parallel/README.md "Scenario 2: Harmonic Oscillator 3 Integrators Energy Drift" and auto-evaluate.

Steps:
1. Read README "2.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "2.3 Master Launch Invocation", start the orchestration using the team_parallel JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir> (contains alice.md / bob.md / carol.md)
6. Run: bun demos/01-team-parallel/check-physics-harmonic-integrator.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: explicit Euler energy drift > 1e-3 (demonstrates pathology); both Verlet and RK4 drift < Euler.
```

### Scenario 3: Two-Sum Multi-Solution Complexity Comparison

```text
Run the full closed loop of demos/01-team-parallel/README.md "Scenario 3: Two-Sum Multi-Solution Complexity Comparison" and auto-evaluate.

Steps:
1. Read README "3.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "3.3 Master Launch Invocation", start the orchestration using the team_parallel JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir> (contains alice.md / bob.md / carol.md)
6. Run: bun demos/01-team-parallel/check-coding-twosum.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: all 3 test cases ([2,7,11,15]/9, [3,2,4]/6, [3,3]/6) pass; complexity annotations correct (alice=O(n²), bob=O(n), carol=O(n log n)).
```

### Scenario 4: 8 Sorting Algorithms Large-Data Benchmark (Challenge-Level)

```text
Run the full closed loop of demos/01-team-parallel/README.md "Scenario 4: 8 Sorting Algorithms Large-Data Benchmark (Challenge-Level)" and auto-evaluate.

Steps:
1. Read README "4.2 Team Config", create the team using the team_create JSON (8 coder members, alice..henry)
2. team_activate (team_id = sort-bench)
3. Read README "4.3 Master Launch Invocation", start the orchestration using the team_parallel JSON (timeout_ms=3600000, allowing 60 min)
4. team_results poll, wait for orchestration to complete and master to receive merge summary (includes 8×3 comparison table) (poll every 30s)
5. Locate the output directory <run_dir> for this run (contains alice.md ... henry.md, 8 files total)
6. Run evaluation:
   bun demos/01-team-parallel/check-coding-sort-benchmark.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: all 8 members SORT_OK=true (all 3 datasets of 10^6 match native sort); and all 24 TIME markers (8 members × 3 datasets) are present.
```
