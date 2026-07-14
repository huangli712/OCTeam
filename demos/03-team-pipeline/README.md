# team_pipeline Orchestration Scenario Design

> **Pattern**: `team_pipeline` — Linear pipeline: stage N's output is prefixed and appended to stage N+1's task, serial progression stage by stage; the final stage's output is summarized and delivered to the leader.
> **Source**: [`src/tools/pipeline.ts`](../../src/tools/pipeline.ts)
> **Timing Design**: 3 stages execute serially, each stage subtask 3-5 min; total duration ≈ Σ(stage) + summarize ≈ 12-15 min (well under the 30 min ceiling, subtask per member ≤ 8 min).

## Scenario Overview

| # | Domain | Scenario | Members | Role | Stages (serial) | Estimated Duration |
|---|------|------|--------|------|----------------|-----------|
| 1 | Math | Gaussian integral three-stage pipeline | 3 | `mathematician` | alice → bob → carol | ~12 min |
| 2 | Computational Physics | Small-angle pendulum simulation chain | 3 | `simulator` | alice → bob → carol | ~14 min |
| 3 | Programming | `fib(n)` TDD pipeline | 3 | `coder` | alice → bob → carol | ~10 min |
| 4 | Computational Physics (Challenge-level) | Lennard-Jones molecular dynamics full simulation chain | 8 | `simulator` | alice → bob → carol → dave → erin → frank → grace → henry | ~60 min |

> **Pipeline semantics**: Stage N+1's task prefix is automatically prepended with stage N's full markdown output; the `leader` ultimately receives stage 3's output (via summarize). The check script reads the **final-stage member's** `<member>.md` (final-stage output is the pipeline product).

---

## Scenario 1: Gaussian Integral Three-Stage Pipeline

### 1.1 Scenario Description

**Background**: The Gaussian integral `I = ∫₀¹ e^(-x²) dx` has no elementary closed-form antiderivative, but can be expressed exactly via the error function as `(√π/2)·erf(1)`. This problem is a classic case for a "symbolic simplification → numerical quadrature → error bound" three-stage pipeline.

**Goal**: 3 members relay serially—
- stage-1 (`alice`): Prove there is no elementary closed form, reduce to `(√π/2)·erf(1)`, and give a tight numerical bound.
- stage-2 (`bob`): Use **Gauss–Legendre quadrature (n=8 nodes)** on `[0,1]` to numerically compute `I` to 10 significant digits.
- stage-3 (`carol`): Compare the numerical result to the closed-form reference `(√π/2)·erf(1) ≈ 0.7468241328`, reporting the absolute error.

**Success Criteria (Machine-Verifiable)**:
- stage-2 output contains `<!-- VALUE: <value> -->` marker (10-digit value)
- stage-3 output contains `<!-- ERROR: <value> -->` marker
- `error < 1e-8` (Gauss–Legendre n=8 is exact for low-order polynomials; `e^(-x²)` converges extremely fast on `[0,1]`, error should be well under 1e-8)

### 1.2 Team Configuration

```json
{
  "name": "gaussian-pipeline",
  "description": "Gaussian integral pipeline: alice -> bob (Gauss-Legendre n=8) -> error bound",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are stage 1 (simplify) of a 3-stage pipeline evaluating the Gaussian integral I = integral_0^1 e^(-x^2) dx. Tasks: (1) Explain why this integral has no elementary closed-form antiderivative. (2) Identify the exact value in terms of the error function: I = (sqrt(pi)/2)*erf(1). (3) Give a tight numerical bound on I (e.g. via Taylor series or sandwich bounds) so the next stage has a sanity check. Hand the symbolic reduction forward. Your output MUST end with a line exactly formatted: <!-- CLOSED_FORM: (sqrt(pi)/2)*erf(1) -->"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are stage 2 (numerical) of a 3-stage pipeline evaluating the Gaussian integral I = integral_0^1 e^(-x^2) dx. The previous stage established I = (sqrt(pi)/2)*erf(1). Your job: approximate I numerically using Gauss-Legendre quadrature with EXACTLY n=8 nodes on the interval [0,1] (use the standard nodes/weights on [-1,1] then affine-map to [0,1]). Embed the code in a fenced block. Report the estimate to 10 significant digits. Your output MUST end with a line exactly formatted: <!-- VALUE: <your_10_digit_numeric_value> -->"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are stage 3 (error-bound) of a 3-stage pipeline evaluating the Gaussian integral I = integral_0^1 e^(-x^2) dx. Previous stages gave the closed form I = (sqrt(pi)/2)*erf(1) and a Gauss-Legendre (n=8) numerical estimate. Your job: take the numerical estimate from stage 2 and compare it to the closed-form reference value 0.7468241328 (approx (sqrt(pi)/2)*erf(1)); report the absolute error |estimate - reference|. Your output MUST end with a line exactly formatted: <!-- ERROR: <absolute_error> -->"
    }
  ]
}
```

**Role Selection Rationale**: `mathematician` uses the `oct-junior` agent, capable of writing code, running it, and performing numerical verification — fully matching the needs of symbolic derivation + numerical quadrature + error analysis.

### 1.3 Master Launch Call

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "gaussian-pipeline",
    "stages": [
      {
        "member": "alice",
        "task": "Run stage 1 now: reduce the Gaussian integral symbolically and produce your CLOSED_FORM marker."
      },
      {
        "member": "bob",
        "task": "Run stage 2 now: implement Gauss-Legendre n=8 on [0,1], compute the estimate, and produce your VALUE marker."
      },
      {
        "member": "carol",
        "task": "Run stage 3 now: compare the stage-2 estimate to 0.7468241328 and produce your ERROR marker."
      }
    ],
    "timeout_ms": 900000
  }
}
```

**Parameter Selection**:
- `stages` three members **unique** (pipeline strict requirement: `alice` / `bob` / `carol` must not repeat)
- `signoff_policy` default `none` — small scenario, direct delivery, no review gate needed
- `timeout_ms: 900000` (15 min) — 3 stages serial + margin, normally ~10 min to complete
- Stage N+1's `task` only writes the current stage instructions; stage N's output is automatically prefixed by the framework, no manual concatenation needed

### 1.4 Execution Flow (Timeline)

```
T+0m    master calls team_pipeline (3 stages)
T+0m    OCTeam dispatches stage-1 (alice)
T+0~4m  alice: symbolic derivation + CLOSED_FORM marker → idle
T+4m    stage-1 output prefixed to stage-2 task → dispatch bob
T+4~8m  bob: Gauss-Legendre n=8 code → run → VALUE marker → idle
T+8m    stage-2 output prefixed to stage-3 task → dispatch carol
T+8~12m carol: compare against reference → ERROR marker → idle
T+12m   final-stage output summarized, delivered to master
T+12m   run: bun check-math-gaussian-integral.ts <run_dir>
```

### 1.5 Check Script

[`check-math-gaussian-integral.ts`](./check-math-gaussian-integral.ts)

- **Load**: `runs/<run_id>/carol.md` (final-stage member)
- **Extract**: regex `<!--\s*ERROR:\s*([\d.eE+-]+)\s*-->`
- **Assert**:
  1. marker exists and is parseable
  2. `error < 1e-8` (Gauss–Legendre n=8 error for `e^(-x²)` on `[0,1]` is well below this)

---

## Scenario 2: Small-Angle Pendulum Simulation Chain

### 2.1 Scenario Description

**Background**: The small-angle pendulum (`θ̈ = -(g/L)θ`, linearized) is an analytically solvable ODE, commonly used to verify numerical integrator accuracy and phase-portrait conservation. A complete simulation chain includes: modeling → integration → phase-portrait sampling.

**Goal**: 3 `simulator` members serially—
- stage-1 (`alice`): Derive the ODE, analytic solution `θ(t) = θ₀·cos(√(g/L)·t)`, and period `T = 2π·√(L/g)`.
- stage-2 (`bob`): Use **classical RK4** to integrate from `t=0` to `t=T`, step `h=0.001`; output `θ(T)` (should ≈ `θ₀`).
- stage-3 (`carol`): Sample 100 equally spaced points over `[0,T]`, compare RK4 numerical `θ` against analytic `θ`, output max deviation.

**Parameters**: `g = 9.81 m/s²`, `L = 1.0 m`, `θ₀ = 0.1 rad` (small angle), `θ̇₀ = 0`.

**Success Criteria (Machine-Verifiable)**:
- stage-2 output contains `<!-- THETA_END: <value> -->` marker
- stage-3 output contains `<!-- MAX_ERR: <value> -->` marker
- `max_err < 1e-4` (RK4 at `h=0.001`, one period; local truncation error O(h⁴) accumulation well under 1e-4)

### 2.2 Team Configuration

```json
{
  "name": "pendulum-pipeline",
  "description": "Small-angle pendulum pipeline: alice -> RK4 bob -> carol max error",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are stage 1 (model) of a 3-stage pipeline simulating a small-angle pendulum. Setup: rigid pendulum length L=1.0 m, gravity g=9.81 m/s^2, small-angle ODE theta'' = -(g/L)*theta. Initial conditions theta(0)=theta0=0.1 rad, theta'(0)=0. Tasks: (1) Derive the analytic solution theta(t) = theta0*cos(sqrt(g/L)*t). (2) Compute the period T = 2*pi*sqrt(L/g). (3) State theta(T) = theta0 (returns to start after one period). Pass the model and all parameters forward. Your output MUST end with a line exactly formatted: <!-- PERIOD: <T_numeric_value> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are stage 2 (integrate) of a 3-stage pendulum pipeline. The previous stage derived the ODE theta'' = -(g/L)*theta with g=9.81, L=1.0, analytic theta(t) = 0.1*cos(sqrt(9.81)*t), period T = 2*pi*sqrt(1/9.81). Your job: integrate the first-order system [theta, omega] with theta'=omega, omega'=-(g/L)*theta using CLASSICAL RK4 from t=0 to t=T with step h=0.001. Initial theta=0.1, omega=0. Embed the code in a fenced block. Report theta(T) (should be approx 0.1). Your output MUST end with a line exactly formatted: <!-- THETA_END: <theta_at_T> -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are stage 3 (phase-portrait) of a 3-stage pendulum pipeline. Previous stages derived the ODE (theta'' = -(g/L)*theta, g=9.81, L=1.0), analytic solution theta(t)=0.1*cos(sqrt(9.81)*t), period T=2*pi*sqrt(1/9.81), and RK4-integrated theta(T). Your job: over [0, T], sample 100 equally spaced points; at each point compare the RK4 numerical theta to the analytic theta(t)=0.1*cos(sqrt(9.81)*t); report the MAX absolute deviation across the 100 samples. Embed the code in a fenced block. Your output MUST end with a line exactly formatted: <!-- MAX_ERR: <max_deviation> -->"
    }
  ]
}
```

**Role Selection Rationale**: `simulator` is designed specifically for numerical simulation (PDE/MC/MD/HPC), fitting the ODE integration and phase-portrait sampling scenario.

### 2.3 Master Launch Call

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "pendulum-pipeline",
    "stages": [
      {
        "member": "alice",
        "task": "Run stage 1 now: derive the ODE, analytic solution, and period; produce your PERIOD marker."
      },
      {
        "member": "bob",
        "task": "Run stage 2 now: RK4-integrate from 0 to T at h=0.001 and produce your THETA_END marker."
      },
      {
        "member": "carol",
        "task": "Run stage 3 now: sample 100 points, compare RK4 vs analytic, and produce your MAX_ERR marker."
      }
    ],
    "timeout_ms": 900000
  }
}
```

**Parameter Selection**:
- `stages` three members unique (`alice` / `bob` / `carol`)
- `signoff_policy` default `none`
- `timeout_ms: 900000` (15 min) — RK4 at `h=0.001` runs ~2000 steps per period, runs very fast; bottleneck is serial dispatch

### 2.4 Execution Flow (Timeline)

```
T+0m    master calls team_pipeline (3 stages)
T+0m    dispatch stage-1 (alice)
T+0~4m  alice: derive ODE + analytic solution + PERIOD marker → idle
T+4m    stage-1 output prefixed to stage-2 → dispatch bob
T+4~9m  bob: RK4 h=0.001 run one period → THETA_END marker → idle
T+9m    stage-2 output prefixed to stage-3 → dispatch carol
T+9~14m carol: 100-point sampling + max deviation → MAX_ERR marker → idle
T+14m   final-stage output summarized, delivered to master
T+14m   run: bun check-physics-pendulum.ts <run_dir>
```

### 2.5 Check Script

[`check-physics-pendulum.ts`](./check-physics-pendulum.ts)

- **Load**: `runs/<run_id>/carol.md` (final-stage member)
- **Extract**: regex `<!--\s*MAX_ERR:\s*([\d.eE+-]+)\s*-->`
- **Assert**:
  1. marker exists and is parseable
  2. `max_err < 1e-4` (RK4 at `h=0.001`, cumulative error over one period is well below this)

---

## Scenario 3: `fib(n)` TDD Pipeline

### 3.1 Scenario Description

**Background**: TDD (Test-Driven Development) is naturally a pipeline — write tests first (red), then minimal implementation (green), finally refactor (unchanged behavior). Using `fib(n)` as a vehicle clearly demonstrates the three-stage relay.

**Goal**: 3 `coder` members serially—
- stage-1 (`alice`): Write 4 `fib` test cases (`(0)→0`, `(1)→1`, `(10)→55`, `(20)→6765`) as assertions, embedded in a code block.
- stage-2 (`bob`): Write the minimal `function fib(n: number): number` that passes all 4 cases, embedded in a code block.
- stage-3 (`carol`): Take stage-2's code and refactor for clarity (**no algorithm change**), re-verify all 4 cases still pass, embed the refactored code.

**Success Criteria (Machine-Verifiable)**:
- stage-1 outputs `<!-- CASES: 4 -->`
- stage-2 outputs `<!-- IMPLEMENTS: fib -->`
- stage-3 outputs `<!-- PASSES: 4 -->`
- Extract the refactored code from stage-3's markdown, load as `fib` via `new Function`, all 4 cases pass

### 3.2 Team Configuration

```json
{
  "name": "fib-pipeline",
  "description": "Fibonacci TDD pipeline: alice -> minimal bob -> carol + re-verify",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are stage 1 (tests) of a 3-stage TDD pipeline implementing the Fibonacci function. Write EXACTLY 4 test cases as TypeScript assertions for fib: fib(0)===0, fib(1)===1, fib(10)===55, fib(20)===6765. Embed the assertion block in a single ```typescript fenced block. Hand the cases forward for the implementation stage. Your output MUST end with a line exactly formatted: <!-- CASES: 4 -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are stage 2 (implement) of a 3-stage TDD pipeline. Previous stage defined 4 test cases for fib: fib(0)=0, fib(1)=1, fib(10)=55, fib(20)=6765. Your job: write the MINIMAL `function fib(n: number): number` that passes all 4 cases. Embed the full TypeScript implementation in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPLEMENTS: fib -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are stage 3 (refactor) of a 3-stage TDD pipeline. Previous stages wrote 4 test cases (fib: 0->0, 1->1, 10->55, 20->6765) and a minimal implementation. Your job: take stage-2's fib code and refactor for clarity (NO algorithm change, same asymptotic complexity), re-verifying all 4 cases still pass. Embed ONLY the final refactored `function fib(n: number): number` in a single ```typescript fenced block; do NOT include any other code block. Your output MUST end with a line exactly formatted: <!-- PASSES: 4 -->"
    }
  ]
}
```

**Role Selection Rationale**: `coder` uses the `oct-junior` agent, focused on implementation with minimal changes — fitting the three-stage TDD requirements.

### 3.3 Master Launch Call

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "fib-pipeline",
    "stages": [
      {
        "member": "alice",
        "task": "Run stage 1 now: write the 4 fib test cases and produce your CASES marker."
      },
      {
        "member": "bob",
        "task": "Run stage 2 now: write the minimal fib that passes the 4 cases and produce your IMPLEMENTS marker."
      },
      {
        "member": "carol",
        "task": "Run stage 3 now: refactor stage-2's fib for clarity, re-verify the 4 cases, and produce your PASSES marker."
      }
    ],
    "timeout_ms": 600000
  }
}
```

**Parameter Selection**:
- `stages` three members unique (`alice` / `bob` / `carol`)
- `signoff_policy` default `none`
- `timeout_ms: 600000` (10 min) — single member task < 4 min, three stages serial with ample total time

### 3.4 Execution Flow (Timeline)

```
T+0m    master calls team_pipeline (3 stages)
T+0m    dispatch stage-1 (alice)
T+0~3m  alice: write 4 assertions + CASES marker → idle
T+3m    stage-1 output prefixed to stage-2 → dispatch bob
T+3~6m  bob: minimal fib implementation + IMPLEMENTS marker → idle
T+6m    stage-2 output prefixed to stage-3 → dispatch carol
T+6~10m carol: refactor + re-verify 4 cases + PASSES marker → idle
T+10m   final-stage output summarized, delivered to master
T+10m   run: bun check-coding-fib-tdd.ts <run_dir>
```

### 3.5 Check Script

[`check-coding-fib-tdd.ts`](./check-coding-fib-tdd.ts)

- **Load**: `runs/<run_id>/carol.md` (final-stage member)
- **Extract**:
  - Code: grab the ` ```typescript ... ``` ` code block (take the last one, handling the case where stage-2's prefix is referenced)
  - Marker: regex `<!--\s*PASSES:\s*(\d+)\s*-->`
- **Process**: Strip TypeScript type annotations (`new Function` doesn't recognize `: number` syntax)
- **Assert**:
  1. `PASSES` marker exists and equals 4
  2. Code can be loaded as `fib` via `new Function`
  3. All 4 cases pass: `fib(0)=0`, `fib(1)=1`, `fib(10)=55`, `fib(20)=6765`

---

## Scenario 4: Lennard-Jones Molecular Dynamics Full Simulation Chain (Challenge-Level)

> **Challenge-level note**: This scenario breaks the conventional 30 min / ≤4 member ceiling, using an **8-stage serial pipeline** to complete a full Lennard-Jones molecular dynamics simulation (force field → initialization → energy minimization → NVT equilibration → NVT sampling → RDF analysis → summary report). Each stage subtask approximately 5-8 min, total duration ~60 min, timeout set to 90 min with margin. For capability demonstration only, not a regular benchmark.

### 4.1 Scenario Description

**Background**: Classical molecular dynamics simulation of liquid argon (Ar) is a benchmark system for statistical physics education. Interatomic interactions are described by the Lennard-Jones (LJ) potential `V(r) = 4ε[(σ/r)¹² − (σ/r)⁶]`, combined with periodic boundary conditions (PBC) and velocity Verlet integration, capable of reproducing liquid argon's radial distribution function g(r) and energy conservation. A complete, reproducible simulation chain covers: force field definition → initial configuration → energy minimization → NVT equilibration → NVE/NVT sampling → trajectory sampling → post-processing (g(r)) → report.

**System parameters**: 100 argon atoms, cubic box with periodic boundary conditions, density ρ = 1.38 g/cm³ (typical liquid argon value), initial temperature T₀ = 120 K. LJ parameters ε = 0.998 kJ/mol (≈ 119.8 K·k_B), σ = 3.40 Å, cutoff radius r_cut = 2.5σ.

**Goal**: 8 `simulator` members relay serially—
- stage-1 (`alice`, force-field): Define LJ force-field parameters (ε=0.998 kJ/mol, σ=3.40 Å, r_cut=2.5σ), give analytic expressions for potential energy and force, and specify the reduced unit (σ, ε, atomic mass m_Ar) conversion.
- stage-2 (`bob`, init): Build the cubic box (with PBC) from ρ=1.38 g/cm³ and 100 atoms, place atoms on an **FCC lattice** (note 100 is not a perfect FCC filling; must explain the rounding choice), initialize velocities via Maxwell–Boltzmann distribution at T₀=120 K and remove center-of-mass velocity.
- stage-3 (`carol`, minimize): Apply **steepest descent** energy minimization to the initial configuration until maximum per-atom force `F < 1e-4` (reduced or SI consistent), removing high energy from lattice overlaps.
- stage-4 (`dave`, equilibrate): Equilibrate under **NVT @ 120 K** for **10⁴ steps**, timestep h=2 fs (can use velocity Verlet + Berendsen or Langevin thermostat), bringing temperature and energy to steady state.
- stage-5 (`erin`, produce): Switch to **NVE** (microcanonical) production for **10⁵ steps**, timestep h=2 fs, velocity Verlet integration; record total energy curve for drift assessment.
- stage-6 (`frank`, sample): Down-sample the production trajectory to **1000 equally spaced frames**, wrap by PBC minimum-image convention, as input for g(r) calculation.
- stage-7 (`grace`, rdf): Compute the **radial distribution function g(r)** from the 1000 frames (bin width 0.02σ, range [0, L/2]), report the first peak position r_peak (Å).
- stage-8 (`henry`, report): Synthesize mean temperature `<T>`, mean total energy `<E>`, g(r) first peak position over the production phase, and compute the total-energy relative drift `ΔE/<E>`, producing a final report.

**Success Criteria (Machine-Verifiable)**:
- stage-8 (`henry`) output contains `<!-- TEMP_K: <value> -->` marker (mean production temperature, expected ≈ 120 K ± 20)
- stage-8 output contains `<!-- RDF_PEAK_A: <value> -->` marker (g(r) first peak position, unit Å, expected 3.50–3.80 Å; dense LJ liquid g(r) first peak literature values 3.65–3.90 Å, simulation results are consistent with these, not at σ)
- stage-8 output contains `<!-- ENERGY_DRIFT: <value> -->` marker (NVE production phase total-energy relative drift `|ΔE|/|<E>|`, expected < 0.05)
- Check script only reads the final-stage `henry.md` (pipeline semantics: the first 7 stage outputs are auto-prefixed by the framework onto `henry`'s task, so the final-stage output is the complete product)

### 4.2 Team Configuration

```json
{
  "name": "lj-pipeline",
  "description": "Lennard-Jones MD pipeline (8 stages): force-field -> init -> minimize -> equilibrate -> produce -> sample -> rdf -> report",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are stage 1 (force-field) of an 8-stage Lennard-Jones molecular dynamics pipeline simulating 100 argon atoms under periodic boundary conditions. Define the Lennard-Jones potential V(r) = 4*epsilon*[(sigma/r)^12 - (sigma/r)^6] and its force F(r) = -dV/dr. Parameters: epsilon = 0.998 kJ/mol (approx 119.8 K * k_B), sigma = 3.40 Angstrom, cutoff r_cut = 2.5*sigma (shifted to zero at r_cut). Argon atomic mass m_Ar = 39.948 u. State the reduced-unit convention (length in sigma, energy in epsilon, mass in m_Ar, time in sigma*sqrt(m_Ar/epsilon)) and the derived box length from rho = 1.38 g/cm^3 and N = 100. Embed any code in a fenced block. Hand the force-field definition and all constants forward. Your output MUST end with a line exactly formatted: <!-- FORCE_FIELD: LJ_epsilon_0.998_kJ_mol_sigma_3.40A_rcut_2.5sigma -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are stage 2 (init) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. The previous stage fixed LJ params (epsilon=0.998 kJ/mol, sigma=3.40 Angstrom, r_cut=2.5*sigma) and reduced units. Your job: build the cubic simulation box with periodic boundary conditions from rho = 1.38 g/cm^3 and N = 100 (compute box length L), place atoms on an FCC lattice (explain how you handle N=100 not being a perfect FCC filling), and initialize velocities from a Maxwell-Boltzmann distribution at T0 = 120 K, removing the center-of-mass velocity. Embed the code in a fenced block. Hand the initial configuration (positions, velocities, L) forward. Your output MUST end with a line exactly formatted: <!-- INIT: N_100_rho_1.38_T0_120K -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are stage 3 (minimize) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. Previous stages fixed the LJ force-field (epsilon=0.998 kJ/mol, sigma=3.40 Angstrom, r_cut=2.5*sigma) and built the initial FCC lattice in a periodic box. Your job: run STEEPEST DESCENT energy minimization on the initial positions (with PBC minimum-image convention) until the maximum per-atom force magnitude drops below 1e-4 (state the unit system used). Embed the code in a fenced block. Hand the minimized positions forward. Your output MUST end with a line exactly formatted: <!-- MINIMIZE: Fmax_below_1e-4 -->"
    },
    {
      "name": "dave",
      "role": "simulator",
      "prompt": "You are stage 4 (equilibrate) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. Previous stages defined the LJ force-field, built the FCC initial configuration, and minimized it. Your job: integrate the equations of motion in the NVT ensemble at T = 120 K for 10^4 steps with timestep h = 2 fs using velocity Verlet plus a thermostat of your choice (Berendsen or Langevin, state which). Use PBC minimum-image and the r_cut = 2.5*sigma cutoff. Embed the code in a fenced block. Report the equilibrated mean temperature and potential energy over the second half of the run. Hand the equilibrated state (positions, velocities) forward. Your output MUST end with a line exactly formatted: <!-- EQUIL: NVT_120K_1e4steps_h_2fs -->"
    },
    {
      "name": "erin",
      "role": "simulator",
      "prompt": "You are stage 5 (produce) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. Previous stages ran NVT equilibration at 120 K. Your job: switch to the NVE ensemble (microcanonical, NO thermostat) and integrate 10^5 steps with timestep h = 2 fs using velocity Verlet (PBC minimum-image, r_cut = 2.5*sigma). Record the total energy E_total at regular intervals to quantify drift. Embed the code in a fenced block. Report the mean total energy <E> and the relative drift |E_end - E_start| / |<E>| over the production run. Hand the production trajectory forward. Your output MUST end with a line exactly formatted: <!-- PRODUCE: NVE_1e5steps_h_2fs -->"
    },
    {
      "name": "frank",
      "role": "simulator",
      "prompt": "You are stage 6 (sample) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. The previous stage produced a 10^5-step NVE trajectory. Your job: down-sample the production trajectory to EXACTLY 1000 equally spaced frames of positions (with PBC wrapping applied). Embed the code in a fenced block. Hand the 1000-frame trajectory forward as the input for radial-distribution-function analysis. Your output MUST end with a line exactly formatted: <!-- SAMPLE: 1000_frames -->"
    },
    {
      "name": "grace",
      "role": "simulator",
      "prompt": "You are stage 7 (rdf) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. The previous stage handed a 1000-frame trajectory in the periodic box. Your job: compute the radial distribution function g(r) from the 1000 frames using bin width 0.02*sigma over r in [0, L/2] (L is the box length), with PBC minimum-image. Normalize correctly for a uniform-ideal-gas reference. Embed the code in a fenced block. Report the position of the FIRST peak of g(r) in Angstrom (dense LJ liquids peak at r* ≈ 1.07–1.10 sigma; for sigma = 3.40 A this corresponds to ~3.64–3.74 A). Hand g(r) and the first-peak position forward. Your output MUST end with a line exactly formatted: <!-- RDF_PEAK: <first_peak_position_in_Angstrom> -->"
    },
    {
      "name": "henry",
      "role": "simulator",
      "prompt": "You are stage 8 (report, FINAL) of an 8-stage Lennard-Jones MD pipeline for 100 argon atoms. All previous stages (force-field -> init -> minimize -> NVT equilibrate at 120 K -> NVE produce 1e5 steps -> 1000-frame sampling -> g(r)) have run and their outputs are prefixed above. Your job: synthesize the FINAL report containing (1) mean temperature <T> over the NVE production in Kelvin, (2) mean total energy <E> over production, (3) the g(r) first peak position in Angstrom (from stage 7), and (4) the relative total-energy drift |E_end - E_start| / |<E>| over the NVE production run. Your output MUST end with EXACTLY THREE lines, each on its own line, formatted as: <!-- TEMP_K: <mean_temperature_Kelvin> --> then <!-- RDF_PEAK_A: <first_peak_Angstrom> --> then <!-- ENERGY_DRIFT: <relative_drift> -->"
    }
  ]
}
```

**Role Selection Rationale**: All 8 stages are numerical simulation (force field, initialization, minimization, NVT/NVE integration, sampling, RDF post-processing, report). `simulator` is designed specifically for PDE/MC/MD/HPC numerical simulation, consistently used throughout without role switching, and the `oct-junior` agent can write code + run + perform numerical verification.

### 4.3 Master Launch Call

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "lj-pipeline",
    "stages": [
      { "member": "alice",  "task": "Run stage 1 now: define the LJ force-field (epsilon=0.998 kJ/mol, sigma=3.40 A, r_cut=2.5*sigma), reduced units, and box length from rho=1.38 g/cm^3; produce your FORCE_FIELD marker." },
      { "member": "bob",    "task": "Run stage 2 now: build the cubic PBC box, place 100 atoms on an FCC lattice, Maxwell-Boltzmann velocities at T0=120 K, remove COM velocity; produce your INIT marker." },
      { "member": "carol",  "task": "Run stage 3 now: steepest-descent minimize the initial configuration to Fmax < 1e-4 (PBC minimum-image); produce your MINIMIZE marker." },
      { "member": "dave",   "task": "Run stage 4 now: NVT equilibrate at 120 K for 10^4 steps, h=2 fs, velocity Verlet + thermostat; produce your EQUIL marker." },
      { "member": "erin",   "task": "Run stage 5 now: NVE produce 10^5 steps, h=2 fs, velocity Verlet; record total-energy drift; produce your PRODUCE marker." },
      { "member": "frank",  "task": "Run stage 6 now: down-sample the production trajectory to exactly 1000 PBC-wrapped frames; produce your SAMPLE marker." },
      { "member": "grace",  "task": "Run stage 7 now: compute g(r) over the 1000 frames (bin 0.02*sigma, r in [0,L/2]); produce your RDF_PEAK marker (first peak in Angstrom)." },
      { "member": "henry",  "task": "Run stage 8 now (FINAL): assemble the report with <T>, <E>, g(r) first peak, and relative energy drift; produce your TEMP_K, RDF_PEAK_A, and ENERGY_DRIFT markers." }
    ],
    "timeout_ms": 5400000
  }
}
```

**Parameter Selection**:
- `stages` eight members **unique** (pipeline strict requirement: `alice` / `bob` / `carol` / `dave` / `erin` / `frank` / `grace` / `henry` must not repeat)
- `signoff_policy` default `none` — the long pipeline relies on final-stage summary product; no review gate added to avoid further lengthening
- `timeout_ms: 5400000` (90 min) — 8 stages serial, estimated ~60 min (each stage 5-8 min including dispatch + run), 50% margin
- Each stage's `task` only writes current stage instructions; prior stage markdown output is auto-prefixed by the framework, no manual concatenation needed

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_pipeline (8 stages)
T+0m     dispatch stage-1 (alice)
T+0~7m   alice: LJ force field + reduced units + box length → FORCE_FIELD marker → idle
T+7m     stage-1 output prefixed to stage-2 → dispatch bob
T+7~14m  bob: FCC init + Maxwell velocities → INIT marker → idle
T+14m    → dispatch carol
T+14~21m carol: steepest descent minimization → MINIMIZE marker → idle
T+21m    → dispatch dave
T+21~30m dave: NVT equilibration 10^4 steps → EQUIL marker → idle
T+30m    → dispatch erin
T+30~40m erin: NVE production 10^5 steps + energy drift → PRODUCE marker → idle
T+40m    → dispatch frank
T+40~46m frank: extract 1000 frames → SAMPLE marker → idle
T+46m    → dispatch grace
T+46~54m grace: g(r) + first peak → RDF_PEAK marker → idle
T+54m    → dispatch henry
T+54~60m henry: synthesize <T>/<E>/g(r) peak/energy drift → three markers → idle
T+60m    final-stage output summarized, delivered to master
T+60m    run: bun check-physics-md-pipeline.ts <run_dir>
```

### 4.5 Check Script

[`check-physics-md-pipeline.ts`](./check-physics-md-pipeline.ts)

- **Load**: `runs/<run_id>/henry.md` (final-stage member; under pipeline semantics the first 7 stage outputs are already prefixed onto henry's task by the framework, so the final-stage output is the complete product; the check reads only this one file)
- **Extract**: three regexes
  - `<!--\s*TEMP_K:\s*([\d.eE+-]+)\s*-->`
  - `<!--\s*RDF_PEAK_A:\s*([\d.eE+-]+)\s*-->`
  - `<!--\s*ENERGY_DRIFT:\s*([\d.eE+-]+)\s*-->`
- **Assert**:
  1. All three markers exist and are parseable as numbers
  2. `100 <= TEMP_K <= 140` (NVT locked at 120 K, NVE production temperature fluctuation within ±20 K)
  3. `3.50 <= RDF_PEAK_A <= 3.80` (dense LJ liquid g(r) first peak literature values 3.65–3.90 Å (Yarnell 1973 neutron diffraction 3.68 Å, Lund 1974 3.65–3.75 Å, Smelser 1969 3.85 Å), the window covers published baselines plus bin quantization tolerance)
  4. `ENERGY_DRIFT < 0.05` (velocity Verlet relative energy drift over h=2 fs, 10⁵ steps)

---

## Acceptance Checklist

- [ ] 4 check scripts pass `tsc --noEmit` (no type errors)
- [ ] Each team config role is valid (`mathematician` / `simulator` / `coder` are all presets)
- [ ] Each master call parameters conform to `team_pipeline` schema (`stages[].member` unique)
- [ ] Scenarios 1-3 total duration ≤ 15 min (well under 30 min ceiling; subtask per member ≤ 8 min); Scenario 4 is challenge-level (8 stages, ~60 min, timeout 90 min), separately noted
- [ ] Member prompts explicitly specify output format conventions (marker); check scripts read **final-stage member** output and align with it

---

## Quick-Start Prompt (Copy and Use)

> Paste any of the following prompts to a master session, and the AI will automatically complete the full closed loop. Pipeline evaluation reads only the **final-stage member's** output (prior stage outputs are automatically prepended to the final-stage task).

### Scenario 1: Gaussian Integral Full Pipeline (Math)

```text
Run the full closed loop of demos/03-team-pipeline/README.md "Scenario 1" and auto-evaluate.

Steps:
1. Read README "1.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "1.3 Master Launch Invocation", start the orchestration using the team_pipeline JSON (3 stages sequential)
4. team_results poll until master receives summary
5. Locate <run_dir> (final-stage member's .md is the final output)
6. Run: bun demos/03-team-pipeline/check-math-gaussian-integral.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: final stage (carol) reports ERROR < 1e-8 (Gauss-Legendre n=8 has extremely high precision for e^(-x²)).
```

### Scenario 2: Pendulum Small-Angle Simulation (Physics)

```text
Run the full closed loop of demos/03-team-pipeline/README.md "Scenario 2" and auto-evaluate.

Steps:
1. Read README "2.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "2.3 Master Launch Invocation", start the orchestration using the team_pipeline JSON
4. team_results poll until master receives summary
5. Locate <run_dir>
6. Run: bun demos/03-team-pipeline/check-physics-pendulum.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: final stage (carol) reports MAX_ERR < 1e-4 (RK4 h=0.001 run one period).
```

### Scenario 3: Fibonacci TDD Line (Programming)

```text
Run the full closed loop of demos/03-team-pipeline/README.md "Scenario 3" and auto-evaluate.

Steps:
1. Read README "3.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "3.3 Master Launch Invocation", start the orchestration using the team_pipeline JSON
4. team_results poll until master receives summary
5. Locate <run_dir> (final-stage member carol's .md)
6. Run: bun demos/03-team-pipeline/check-coding-fib-tdd.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: final stage (carol) code passes 4 test cases: fib(0)=0, fib(1)=1, fib(10)=55, fib(20)=6765.
```

### Scenario 4: Lennard-Jones Molecular Dynamics Full Simulation Chain (Challenge-Level, Physics)

```text
Run the full closed loop of demos/03-team-pipeline/README.md "Scenario 4" and auto-evaluate (challenge-level: 8 stages serial, ~60 min).

Steps:
1. Read README "4.2 Team Config", create the team using the team_create JSON (8 simulator members alice..henry)
2. team_activate
3. Read README "4.3 Master Launch Invocation", start the orchestration using the team_pipeline JSON (8 stages sequential, timeout_ms=5400000)
4. team_results poll until master receives summary (note long duration; can lengthen poll interval)
5. Locate <run_dir> (final-stage member henry.md is the final output; previous 7 stage outputs are auto-prepended to henry's task)
6. Run: bun demos/03-team-pipeline/check-physics-md-pipeline.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: final stage (henry) reports TEMP_K ∈ [100,140] K, RDF_PEAK_A ∈ [3.50,3.80] Å, ENERGY_DRIFT < 0.05.
```
