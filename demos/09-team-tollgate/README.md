# team_tollgate Orchestration Scenario Demo

`team_tollgate` runs a verdict-gated pipeline. After each stage produces output it must pass through an independent verifier who issues a three-valued verdict (PASS / FAIL / INVALID). PASS releases the downstream; FAIL returns the output with the diff back to the producer (up to `max_gate_retries` times); INVALID isolates the issue and escalates to the verifier side without penalizing the producer.

---

## Scenario Overview

| # | Domain | Scenario | Members | Role (producer / verifier) | Gates | Est. Duration |
|---|------|------|--------|----------------------------|---------|-----------|
| 1 | Math | Fast modular exponentiation (binary square-and-multiply) implementation + verification | 2 | `mathematician` / `reviewer` | 1 | ~8 min |
| 2 | Computational Physics | Velocity Verlet integrator (energy conservation) implementation + verification | 2 | `simulator` / `physicist` | 1 | ~8 min |
| 3 | Programming | Unicode-safe string reverse (surrogate pair) implementation + verification | 2 | `coder` / `tester` | 1 | ~7 min |
| 4 | Computational Physics (challenge) | 2D heat equation solver V&V certification (3 serial gates) | 6 | `simulator` ×3 / `reviewer` / `physicist` ×2 | 3 | ~60 min |

---

## Scenario 1: Fast Modular Exponentiation (Binary Square-and-Multiply) Implementation + Verification

### 1.1 Scenario Description

**Background**: Fast modular exponentiation `base^exp mod mod` is a core primitive in public-key cryptography such as RSA. The naive loop `O(exp)` is infeasible for large exponents; binary exponentiation (square-and-multiply) reduces complexity to `O(log exp)` while taking modulo `mod` throughout to avoid large-number overflow. `exp=0` must return `1` (convention for any positive modulus).

**Goal**: The producer implements an iterative `modPow(base, exp, mod)` in TypeScript; the verifier runs three known-answer test cases and passes or rejects.

**Success criteria (machine-evaluable)**:
- Producer output contains `<!-- IMPL: modPow -->` marker and embeds a loadable ```typescript code block
- Code passes three cases: `modPow(2,10,1000)=24`, `modPow(3,0,7)=1`, `modPow(7,256,13)=9`
- `exp=0` returns `1`
- Verifier output contains `<verdict>{"result":"PASS",...}</verdict>` tagged JSON block

### 1.2 Team Configuration

```json
{
  "name": "modpow-gate",
  "description": "Fast modular exponentiation: implement (mathematician) then gate-verify (reviewer) against 3 known cases",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematician. You implement numerical algorithms in TypeScript with rigor, using minimal code. When asked to produce an implementation, embed the full TypeScript in a single ```typescript fenced block and declare it with an IMPL marker.\n\nYour output MUST end with a line exactly formatted: <!-- IMPL: modPow -->"
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a reviewer. You verify mathematical implementations by running them against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise (naming the failing case).\n\nYour output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case or measured value if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Producer uses `mathematician` (`oct-junior` agent, can write code and do numerical verification); verifier uses `reviewer` (read-only agent, independent judge, avoids same-agent bias with the producer).

### 1.3 Master Launch Call

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "modpow-gate",
    "stages": [
      {
        "member": "alice",
        "task": "Implement `modPow(base, exp, mod)` computing base^exp mod mod via binary exponentiation (iterative square-and-multiply). Use `number` type for all parameters and return value (NOT bigint). Handle exp=0 (return 1 for any mod>0). Embed TypeScript code in a fenced block.",
        "verifier": "bob",
        "criteria": "Verify modPow(2,10,1000)=24, modPow(3,0,7)=1, modPow(7,256,13)=9. Also confirm exp=0 returns 1. If all pass emit PASS, else FAIL with the failing case."
      }
    ],
    "max_gate_retries": 1,
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- Single stage (implement → verify) — tollgate's minimal meaningful unit; gate is the endpoint
- `verifier != member` (`bob` ≠ `alice`) — satisfies the "no self-verification" hard constraint
- `max_gate_retries: 1` — gives the producer one chance to fix after FAIL (novice implementations easily miss the `exp=0` edge case)
- `timeout_ms: 900000` (15 min) — serial two-hop, normal completion in 8 min, with margin

### 1.4 Execution Flow (Timeline)

```
T+0m    master calls team_tollgate
T+0m    OCTeam dispatches stage-0 producer (alice, mathematician)
T+0~5m  alice writes modPow → embeds ```typescript block + IMPL marker → idle
T+5m    gate triggers: dispatches verifier (bob, reviewer), feeds producer output + criteria
T+5~8m  bob runs three test cases → outputs VERDICT marker
T+8m    PASS → pipeline ends, result delivered to master
T+8m    Run: bun check-math-fast-pow.ts <run_dir>
```

(If FAIL and `attempts < max_gate_retries`, the producer is sent back with the diff to redo, then goes through the gate once more.)

### 1.5 Check Script

[`check-math-fast-pow.ts`](./check-math-fast-pow.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
  - Producer code: grab ` ```typescript ... ``` ` code block
  - Verifier verdict: `<verdict>{...}</verdict>` tagged JSON block (`JSON.parse` to get `result`)
- **Assertions**:
  1. Producer code can be loaded via `new Function` as `modPow` function
  2. `modPow(2,10,1000)===24`, `modPow(3,0,7)===1`, `modPow(7,256,13)===9`
  3. Verifier `result` is `PASS`

---

## Scenario 2: Velocity Verlet Integrator (Energy Conservation) Implementation + Verification

### 2.1 Scenario Description

**Background**: The harmonic oscillator `ẍ = -ω²x` (with ω=1, initial `x0=1, v0=0`) is a standard test problem for energy-conserving systems, with theoretical energy `E = ½(x² + v²) = 0.5` constant. Velocity Verlet is a **symplectic integrator**; under finite step sizes its energy exhibits bounded oscillation rather than systematic drift — this is its essential difference from explicit Euler.

**Goal**: The producer implements Velocity Verlet, runs 1000 steps (h=0.01), and reports the relative energy drift; the verifier checks whether the drift satisfies the symplectic conservation bound.

**Success criteria (machine-evaluable)**:
- Producer output contains `<!-- DRIFT: <value> -->` marker (relative drift `|E_end - E0|/E0`)
- Drift `< 1e-3` (hallmark of a symplectic integrator)
- Verifier output contains `<verdict>{"result":"PASS",...}</verdict>` tagged JSON block

### 2.2 Team Configuration

```json
{
  "name": "verlet-gate",
  "description": "Velocity Verlet on harmonic oscillator: implement (simulator) then gate-verify (physicist) energy conservation",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are a simulator. You implement numerical integrators in TypeScript and run them to report measured quantities. Embed runnable code in a ```typescript fenced block and always end with the requested numeric marker.\n\nYour output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
    },
    {
      "name": "bob",
      "role": "physicist",
      "prompt": "You are a physicist. You verify numerical results against physical conservation laws and known tolerances. Emit a verdict: PASS if the criterion holds, FAIL otherwise (with the measured value).\n\nYour output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case or measured value if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Producer uses `simulator` (specialized in numerical simulation); verifier uses `physicist` (understands symplectic integrators and energy conservation, can independently recompute and judge).

### 2.3 Master Launch Call

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "verlet-gate",
    "stages": [
      {
        "member": "alice",
        "task": "Implement Velocity Verlet for the harmonic oscillator (omega=1, x0=1, v0=0). Run 1000 steps h=0.01. Embed the integrator code. Report the relative energy drift.",
        "verifier": "bob",
        "criteria": "Verify |E_end - E0|/E0 < 1e-3 (Verlet is symplectic). Compare the producer's reported drift to a recomputation if possible. If drift < 1e-3 emit PASS, else FAIL."
      }
    ],
    "max_gate_retries": 1,
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- `max_gate_retries: 1` — symplectic integrator implementations easily make mistakes in "update position first or velocity first" order (breaking symplecticity), so give one correction chance
- Verifier uses `physicist` role to independently recompute drift rather than blindly trusting the producer's reported number

### 2.4 Execution Flow (Timeline)

```
T+0m    master calls team_tollgate
T+0m    dispatches producer (alice, simulator)
T+0~5m  alice writes Velocity Verlet → runs 1000 steps → reports DRIFT marker → idle
T+5m    gate triggers: dispatches verifier (bob, physicist)
T+5~8m  bob recomputes/verifies drift < 1e-3 → outputs VERDICT marker
T+8m    PASS → result delivered to master
T+8m    Run: bun check-physics-verlet.ts <run_dir>
```

### 2.5 Check Script

[`check-physics-verlet.ts`](./check-physics-verlet.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
  - Producer drift: regex `<!--\s*DRIFT:\s*([\d.eE+-]+)\s*-->`
  - Verifier verdict: `<verdict>{...}</verdict>` tagged JSON block (`JSON.parse` to get `result`)
- **Assertions**:
  1. Drift value exists and `Number.isFinite`
  2. `drift < 1e-3` (symplectic conservation bound)
  3. Verifier `result` is `PASS`

---

## Scenario 3: Unicode-Safe String Reverse (Surrogate Pair) Implementation + Verification

### 3.1 Scenario Description

**Background**: JavaScript strings are stored as UTF-16 code units. Emoji (e.g. `🚀`, U+1F680) are represented by a surrogate pair. The naive `s.split('').reverse().join('')` breaks apart surrogate pairs, producing garbled output after reversal. The correct approach must reverse by **code points** — e.g. `[...s].reverse().join('')` or an explicit `for...of` loop.

**Goal**: The producer implements `reverseStr(s: string): string` that correctly handles ASCII, the empty string, and surrogate pairs; the verifier runs three test cases (including an emoji).

**Success criteria (machine-evaluable)**:
- Producer output contains `<!-- IMPL: reverseStr -->` marker, embedding a loadable code block
- `reverseStr('abc')==='cba'`, `reverseStr('')===''`, `reverseStr('a🚀b')==='b🚀a'` (surrogate pair stays intact)
- Verifier output contains `<verdict>{"result":"PASS",...}</verdict>` tagged JSON block

### 3.2 Team Configuration

```json
{
  "name": "string-gate",
  "description": "Unicode-safe string reverse: implement (coder) then gate-verify (tester) including a surrogate-pair case",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement functions in clean TypeScript with minimal code. Embed the full TypeScript in a single ```typescript fenced block and declare it with an IMPL marker.\n\nYour output MUST end with a line exactly formatted: <!-- IMPL: reverseStr -->"
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You are a tester. You verify implementations by running them against the gate's test cases, including edge cases. Emit a verdict: PASS if every case holds, FAIL otherwise (naming the failing case).\n\nYour output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case or measured value if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Producer uses `coder` (focused on implementation); verifier uses `tester` (specialized in running test cases, including edge cases).

### 3.3 Master Launch Call

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "string-gate",
    "stages": [
      {
        "member": "alice",
        "task": "Implement `reverseStr(s: string): string` that reverses a string AND correctly handles Unicode surrogate pairs (e.g. emoji). Embed TypeScript code in a fenced block.",
        "verifier": "bob",
        "criteria": "Verify reverseStr('abc')='cba', reverseStr('')='', reverseStr('a🚀b')='b🚀a' (surrogate pair stays intact). Run these 3 cases. If all pass emit PASS, else FAIL."
      }
    ],
    "max_gate_retries": 1,
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- The surrogate pair edge case is a classic trap (naive split is wrong), `max_gate_retries: 1` gives one correction chance
- Verifier uses `tester` role, with the three test cases (including empty string and emoji) encoded directly in `criteria`

### 3.4 Execution Flow (Timeline)

```
T+0m    master calls team_tollgate
T+0m    dispatches producer (alice)
T+0~4m  alice writes reverseStr → embeds code + IMPL marker → idle
T+4m    gate triggers: dispatches verifier (bob, tester)
T+4~7m  bob runs three test cases (including emoji) → outputs VERDICT marker
T+7m    PASS → result delivered to master
T+7m    Run: bun check-coding-reverse-str.ts <run_dir>
```

### 3.5 Check Script

[`check-coding-reverse-str.ts`](./check-coding-reverse-str.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
  - Producer code: grab ` ```typescript ... ``` ` code block
  - Verifier verdict: `<verdict>{...}</verdict>` tagged JSON block (`JSON.parse` to get `result`)
- **Assertions**:
  1. Producer code can be loaded via `new Function` as `reverseStr` function
  2. `reverseStr('abc')==='cba'`, `reverseStr('')===''`, `reverseStr('a🚀b')==='b🚀a'`
  3. Verifier `result` is `PASS`

---

## Scenario 4: 2D Heat Equation Solver V&V Certification (Challenge-Level)

**Challenge-level notes**: This scenario breaks the baseline constraints of scenarios 1-3 (2 members / 1 gate / ≤8 min), using **6 members and 3 serial gates** to fully demonstrate a pre-release V&V (Verification & Validation) certification workflow. The three gates independently verify three distinct properties of the solver: **correctness → convergence order → conservation**. If any gate fails, release is denied.

### 4.1 Scenario Description

**Background**: The 2D heat equation `∂u/∂t = α(∂²u/∂x² + ∂²u/∂y²)` is a standard benchmark for parabolic PDEs. The explicit FTCS (forward-time, centered-space) scheme is second-order in space and first-order in time: `u^{n+1}_{ij} = u^n_{ij} + dt·α·(δ²x u + δ²y u)/dx²`. Before release, the solver must pass three independent V&V checks:
1. **Correctness (manufactured solution)**: Choose the analytic solution `u_ex = sin(πx)·sin(πy)·exp(-2πα²t)` and compare the maximum error between the numerical and exact solutions.
2. **Grid convergence order (grid convergence study)**: Run the same boundary-value problem on 3 meshes (e.g. 21×21, 41×41, 81×81) and estimate the convergence order using Richardson extrapolation or log-log regression — a second-order spatial scheme should yield p ≥ 2.
3. **Conservation (heat conservation)**: Under zero-flux (Neumann) boundaries, total heat `Σu·dx·dy` should be conserved; after 1000 steps the relative drift must be < 1e-4.

**Goal**: Six members form a V&V certification team; 3 gates advance serially — each gate has one producer producing evidence and one independent verifier issuing PASS/FAIL. Release is granted only if all three pass.

**Success criteria (machine-evaluable)**:
- G1 producer (alice) output contains `<!-- GATE1_RESULT: <max_error> -->`; G1 verifier (bob) output contains `<verdict>{"result":"PASS",...}</verdict>`
- G2 producer (carol) output contains `<!-- GATE2_RESULT: <order> -->`; G2 verifier (dave) output contains `<verdict>{"result":"PASS",...}</verdict>`
- G3 producer (erin) output contains `<!-- GATE3_RESULT: <drift> -->`; G3 verifier (frank) output contains `<verdict>{"result":"PASS",...}</verdict>`
- Cross-check: G1 `max_error < 1e-3`, G2 `order ≥ 2`, G3 `drift < 1e-4`

### 4.2 Team Configuration

```json
{
  "name": "heat2d-vv-gate",
  "description": "2D heat-equation solver V&V certification: 3 sequential gates (correctness -> convergence order -> conservation) across 6 members",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are a simulator. You implement numerical PDE solvers in TypeScript and run them to report measured quantities. Embed runnable code in a ```typescript fenced block when asked.\n\nYour output MUST end with a line exactly formatted: <!-- GATE1_RESULT: <numeric_max_error> -->"
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a reviewer. You verify numerical correctness against a manufactured (analytic) solution by comparing the producer's reported max-error to the tolerance. Emit a verdict: PASS if the criterion holds, FAIL otherwise.\n\nYour output MUST end with exactly one line formatted: <verdict>{"result": "PASS" (or "FAIL"), "rationale": "<one-sentence why>", "diff": "<measured value if FAIL, else empty>"}</verdict>."
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are a simulator. You run grid-convergence studies (multiple mesh sizes) and estimate convergence order via Richardson or log-log regression.\n\nYour output MUST end with a line exactly formatted: <!-- GATE2_RESULT: <numeric_order> -->"
    },
    {
      "name": "dave",
      "role": "physicist",
      "prompt": "You are a physicist. You verify that a measured convergence order matches the theoretical expectation for the discretization (>= 2 for centered-space). Emit a verdict: PASS if the criterion holds, FAIL otherwise.\n\nYour output MUST end with exactly one line formatted: <verdict>{"result": "PASS" (or "FAIL"), "rationale": "<one-sentence why>", "diff": "<measured order if FAIL, else empty>"}</verdict>."
    },
    {
      "name": "erin",
      "role": "simulator",
      "prompt": "You are a simulator. You run long-time conservation checks (total heat under Neumann BCs) and report relative drift over many steps.\n\nYour output MUST end with a line exactly formatted: <!-- GATE3_RESULT: <numeric_relative_drift> -->"
    },
    {
      "name": "frank",
      "role": "physicist",
      "prompt": "You are a physicist. You verify heat conservation: under zero-flux boundaries total heat is invariant up to round-off. Emit a verdict: PASS if the drift criterion holds, FAIL otherwise.\n\nYour output MUST end with exactly one line formatted: <verdict>{"result": "PASS" (or "FAIL"), "rationale": "<one-sentence why>", "diff": "<measured drift if FAIL, else empty>"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Three `simulator` members (alice/carol/erin) each handle numerical output for one V&V dimension; one `reviewer` (bob) independently checks correctness; two `physicist` members (dave/frank) use physics knowledge to check convergence order and conservation law. Each gate's verifier role is a different person from the producer, satisfying tollgate's hard constraint.

### 4.3 Master Launch Call

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "heat2d-vv-gate",
    "stages": [
      {
        "member": "alice",
        "task": "Implement solveHeat2D(nx, ny, dt, nSteps) in TypeScript using the explicit FTCS scheme for the 2D heat equation (alpha=1, unit square [0,1]x[0,1], Dirichlet u=0 on the boundary). Manufactured solution: u_ex = sin(pi*x)*sin(pi*y)*exp(-2*pi^2*t). Set IC = u_ex(t=0), run to t_final = 0.1 with a grid fine enough that dt satisfies the CFL stability condition dt <= dx^2/4. Report the max absolute error max|u_num - u_ex| over all grid points at t_final. Embed code in a fenced block.",
        "verifier": "bob",
        "criteria": "Verify the producer's reported max-error against the manufactured solution is < 1e-3. If so emit PASS, else FAIL with the measured value."
      },
      {
        "member": "carol",
        "task": "Run a grid-convergence study for the 2D heat equation FTCS solver on 3 meshes (nx=ny=21, 41, 81). Use the same manufactured solution u_ex = sin(pi*x)*sin(pi*y)*exp(-2*pi^2*t). Scale dt with dx^2 to stay stable and isolate spatial error. Compute the max-error on each mesh, then estimate the observed convergence order p via log2((e_coarse - e_medium)/(e_medium - e_fine)) or a log-log slope of error vs dx. Report the observed order p. Embed code in a fenced block.",
        "verifier": "dave",
        "criteria": "Verify the observed spatial convergence order p >= 2 (centered second-difference is 2nd-order). If p >= 2 emit PASS, else FAIL with the measured order."
      },
      {
        "member": "erin",
        "task": "Implement solveHeat2D with zero-flux (Neumann) boundaries (du/dn=0 on all 4 edges) so total heat is physically conserved. Use alpha=1, nx=ny=41, dt = dx^2/4, IC = a smooth positive field (e.g. 1 + 0.1*sin(pi*x)*sin(pi*y)). Run nSteps=1000 and report the relative drift |sum(u_end) - sum(u_0)| / sum(u_0) of total heat. Embed code in a fenced block.",
        "verifier": "frank",
        "criteria": "Verify the relative heat drift over 1000 steps is < 1e-4 (Neumann BC => total heat conserved to round-off). If drift < 1e-4 emit PASS, else FAIL with the measured drift."
      }
    ],
    "max_gate_retries": 1,
    "timeout_ms": 3600000
  }
}
```

**Parameter selection**:
- 3 gates run **serially** (correctness → convergence → conservation) — the latter gates depend on the solver credibility established by the former; tollgate's cascade semantics naturally express this dependency
- Each gate has `verifier != member` (bob≠alice, dave≠carol, frank≠erin) — satisfies the "no self-verification" hard constraint
- `max_gate_retries: 1` — V&V challenge-level, give each gate one chance to fix after FAIL (FTCS CFL condition and Neumann boundary implementation are both easy to get wrong on first attempt)
- `timeout_ms: 3600000` (60 min) — 3 gates × (producer ~10 min + verifier ~7 min) serial ≈ 50 min, with 10 min margin

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_tollgate (3 gates)
T+0m     dispatches G1 producer (alice, simulator)
T+0~12m  alice implements FTCS solver → runs manufactured solution → reports GATE1_RESULT → idle
T+12m    G1 gate: dispatches verifier (bob, reviewer)
T+12~19m bob checks max-error < 1e-3 → outputs VERDICT1
T+19m    G1 PASS → G2 producer starts (carol, simulator)
T+19~31m carol runs 3-mesh grid convergence study → reports GATE2_RESULT → idle
T+31m    G2 gate: dispatches verifier (dave, physicist)
T+31~38m dave checks order >= 2 → outputs VERDICT2
T+38m    G2 PASS → G3 producer starts (erin, simulator)
T+38~50m erin runs 1000-step conservation check → reports GATE3_RESULT → idle
T+50m    G3 gate: dispatches verifier (frank, physicist)
T+50~57m frank checks drift < 1e-4 → outputs VERDICT3
T+57m    G3 PASS → pipeline ends, result delivered to master
T+57m    Run: bun check-physics-heat-vv.ts <run_dir>
```

(If any gate fails and attempts <= max_gate_retries, the producer is sent back with the diff to redo and go through that gate again; exceeding retries causes the entire pipeline to fail.)

### 4.5 Check Script

[`check-physics-heat-vv.ts`](./check-physics-heat-vv.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,dave,erin,frank}.md` (6 files)
- **Extract**:
  - G1 error: alice.md regex `<!--\s*GATE1_RESULT:\s*([\d.eE+-]+)\s*-->`
  - G1 verdict: bob.md `<verdict>{...}</verdict>` tagged JSON block
  - G2 order: carol.md regex `<!--\s*GATE2_RESULT:\s*([\d.eE+-]+)\s*-->`
  - G2 verdict: dave.md `<verdict>{...}</verdict>` tagged JSON block
  - G3 drift: erin.md regex `<!--\s*GATE3_RESULT:\s*([\d.eE+-]+)\s*-->`
  - G3 verdict: frank.md `<verdict>{...}</verdict>` tagged JSON block
- **Assertions**:
  1. All three GATE_RESULT values are finite numbers
  2. Cross-check thresholds: G1 `max_error < 1e-3`, G2 `order >= 2`, G3 `drift < 1e-4`
  3. All three verifier `result` values are `PASS`

---


## Quick-Start Prompt

Paste any of the following prompts into the master session and the AI will automatically complete the full loop. In tollgate mode, evaluation reads the **producer + verifier** members' .md files: the producer's implementation/numerical results + the verifier's VERDICT.

### Scenario 1: Implement Fast Power + Verify (Math)

```text
Execute the full closed loop for demos/09-team-tollgate/README.md "Scenario 1" with automatic evaluation.

Steps:
1. Read README "1.2 Team Configuration", create the team with team_create JSON (producer + verifier, 2 members)
2. team_activate to activate
3. Read README "1.3 Master Launch Call", start orchestration with the team_tollgate JSON (1 gate: implement → verify)
4. team_results poll until master receives summary (verifier PASS before delivery; FAIL sends producer back to redo, constrained by max_gate_retries) (poll every 30s)
5. Locate <run_dir> (containing producer and verifier .md files)
6. Run: bun demos/09-team-tollgate/check-math-fast-pow.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: producer modPow passes 3 test cases (2^10 mod 1000 = 24, 3^0 mod 7 = 1, 7^256 mod 13 = 9); verifier VERDICT = PASS.
```

### Scenario 2: Implement Verlet Solver + Verify (Physics)

```text
Execute the full closed loop for demos/09-team-tollgate/README.md "Scenario 2" with automatic evaluation.

Steps:
1. Read README "2.2 Team Configuration", create the team with team_create JSON
2. team_activate to activate
3. Read README "2.3 Master Launch Call", start orchestration with the team_tollgate JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir>
6. Run: bun demos/09-team-tollgate/check-physics-verlet.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: producer reports DRIFT < 1e-3 (Verlet is symplectic/conserving); verifier VERDICT = PASS.
```

### Scenario 3: Implement String Reverse + Verify (Programming)

```text
Execute the full closed loop for demos/09-team-tollgate/README.md "Scenario 3" with automatic evaluation.

Steps:
1. Read README "3.2 Team Configuration", create the team with team_create JSON
2. team_activate to activate
3. Read README "3.3 Master Launch Call", start orchestration with the team_tollgate JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir>
6. Run: bun demos/09-team-tollgate/check-coding-reverse-str.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: producer reverseStr passes 3 test cases ('abc'→'cba', ''→'', 'a🚀b'→'b🚀a' with surrogate pair intact); verifier VERDICT = PASS.
```

### Scenario 4: 2D Heat Equation Solver V&V Certification (Challenge-Level)

```text
Execute the full closed loop for demos/09-team-tollgate/README.md "Scenario 4" with automatic evaluation (challenge-level: 6 members, 3 serial V&V gates).

Steps:
1. Read README "4.2 Team Configuration", create the team with team_create JSON (6 members: alice/bob/carol/dave/erin/frank)
2. team_activate to activate
3. Read README "4.3 Master Launch Call", start orchestration with the team_tollgate JSON (3 serial gates: correctness -> convergence -> conservation)
4. team_results poll until master receives summary (each gate verifier must PASS before the next gate proceeds; FAIL sends producer back to redo, constrained by max_gate_retries=1) (poll every 30s)
5. Locate <run_dir> (containing 6 member .md files: alice/bob/carol/dave/erin/frank)
6. Run: bun demos/09-team-tollgate/check-physics-heat-vv.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: G1 max-error < 1e-3 AND VERDICT1 = PASS; G2 convergence order >= 2 AND VERDICT2 = PASS; G3 heat drift < 1e-4 AND VERDICT3 = PASS. All three gates must PASS for overall PASS.
```
