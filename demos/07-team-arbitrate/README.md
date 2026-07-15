# team_arbitrate Orchestration Scenario Demo

`team_arbitrate` has two debaters argue over a dispute for up to `max_rounds` rounds, then an arbiter (not a debater, not master) weighs both sides and issues a binding ruling.

---

## Scenario Overview

| # | Domain | Scenario | Members | Role | max_rounds | Est. total time |
|---|------|------|--------|------|-----------|-----------|
| 1 | Math | 4×4 matrix inversion debate (direct vs iterative) | 3 | `mathematician` / `reviewer` | 2 | ~15 min |
| 2 | Computational physics | Stiff ODE method debate (explicit vs implicit) | 3 | `simulator` / `physicist` | 2 | ~15 min |
| 3 | Programming | Cache eviction policy debate (LRU vs LFU) | 3 | `coder` / `reviewer` | 2 | ~12 min |
| 4 | Computational physics | Complex-boundary PDE five-method debate (challenge-level) | 6 | `physicist` / `reviewer` | 3 | ~40 min |

---

## Scenario 1: 4×4 Matrix Inversion Debate

### 1.1 Scenario description

**Background**: For inverting a dense, well-conditioned (condition number ~10) small 4×4 matrix, the classic divide is "direct method (Gaussian elimination / Gauss-Jordan)" vs "iterative method (e.g. Jacobi)". The two approaches differ sharply in accuracy, cost, and convergence, making this a standard debate in numerical linear algebra.

**Goal**: Two debaters each defend one approach; the arbiter synthesizes arguments from both sides and issues a ruling.

**Dispute proposition** (the `task`): *"For inverting a dense, well-conditioned 4×4 matrix (condition number ~10), should you use direct Gaussian elimination or an iterative method (e.g. Jacobi)?"*

**Success criteria (machine-evaluable)**:
- Both debater outputs each contain `<!-- ARG: <one-line position> -->` marker
- Arbiter output contains `<ruling>{"decision":"<choice>","rationale":"<text>"}</ruling>` tag JSON block (expected `decision` = `direct`)
- `rationale` is non-empty and mentions the key term (`condition` or `dense`)

### 1.2 Team configuration

```json
{
  "name": "matrix-debate",
  "description": "Arbitrate whether direct Gaussian elimination or an iterative method should invert a dense, well-conditioned 4x4 matrix",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are the proponent of DIRECT inversion (Gaussian elimination / Gauss-Jordan) for a dense, well-conditioned 4x4 matrix (condition number ~10). Argue precisely: a 4x4 system is tiny (fixed O(n^3)=O(64) flops), direct methods are exact up to round-off (no convergence criterion), need no diagonal dominance / SPD assumption, and iterative methods only shine for large sparse systems. Cite the operation count and the absence of a convergence loop.\n\nRebut the iterative side's points.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are the proponent of ITERATIVE inversion (e.g. Jacobi) for a dense, well-conditioned 4x4 matrix (condition number ~10). Argue the iterative case as strongly as you can: iterative methods reuse matrix-vector products, avoid pivot instabilities, and their cost scales with desired accuracy. Note that for this specific small dense well-conditioned case the iteration converges fast (spectral radius of the Jacobi iteration matrix is well below 1), so few sweeps suffice.\n\nRebut the direct side's points.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are the ARBITER. Two mathematicians debated whether to invert a dense, well-conditioned 4x4 matrix (condition number ~10) via DIRECT Gaussian elimination or an ITERATIVE method (e.g. Jacobi). Weigh both sides objectively, then deliver a single BINDING ruling.\n\nYour output MUST end with exactly one line formatted: <ruling>{\"decision\": \"<direct or iterative>\", \"rationale\": \"<one-sentence rationale referencing why, for this specific matrix class, the winner dominates>\"}</ruling>."
    }
  ]
}
```

**Role selection rationale**: Debaters use `mathematician` (`oct-junior` agent, can compute flop counts / spectral radius to support arguments); arbiter uses `reviewer` (read-only role, specialized in weighing evidence and issuing rulings without favoring either side).

### 1.3 Master launch call

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "matrix-debate",
    "task": "For inverting a dense, well-conditioned 4x4 matrix (condition number ~10), should you use direct Gaussian elimination or an iterative method (e.g. Jacobi)?",
    "arbiter": "carol",
    "debaters": ["alice", "bob"],
    "max_rounds": 2,
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- `arbiter: "carol"` — Points to the member named `carol` (role=`reviewer`); arbiter **must not** be a debater or master
- `debaters: ["alice", "bob"]` — Exactly 2 unique debaters, each holding one position
- `max_rounds: 2` — Opening statement + rebuttal, two rounds total, sufficient to expose the disagreement (time-controlled)
- `timeout_ms: 1200000` (20 min) — Hard cap for 2 debate rounds + ruling; normally completes in ~15 min
- No `signoff_*` — The arbiter's ruling itself is the endpoint (equivalent to `none` gate)

### 1.4 Execution flow (timeline)

```
T+0m    master calls team_arbitrate (max_rounds=2)
T+0m    Round 1: parallel dispatch 2 mathematician debaters opening statements
T+0~4m  each debater writes arguments (flop count / convergence / spectral radius) + ARG marker
T+4m    arbiter reviews Round 1 outputs from both sides
T+5m    Round 2: parallel dispatch 2 debaters rebutting each other
T+5~8m  each debater adds rebuttal, refreshes ARG marker
T+8m    arbiter reviews Round 2, issues binding ruling (RULING + REASON)
T+9m    ruling delivered to master
T+9m    Run: bun check-math-matrix-inverse.ts <run_dir>
```

### 1.5 Check script

[`check-math-matrix-inverse.ts`](./check-math-matrix-inverse.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**:
  - Debaters `<!-- ARG:\s*(.+?)\s*-->`
  - Arbiter `<ruling>{...}</ruling>` tag JSON block (`JSON.parse` to read `decision` and `rationale`)
- **Assertions**:
  1. Both debaters produced `ARG` markers
  2. Arbiter `decision == "direct"`
  3. `rationale` non-empty and contains `condition` or `dense` (case-insensitive)

---

## Scenario 2: Stiff ODE Method Debate

### 2.1 Scenario description

**Background**: The stiff equation `dy/dt = -1000·y`, `y(0)=1`, integrated to `t=1`, is the textbook example of stability dominating accuracy. Explicit RK4, though high-order, is subject to a CFL-like stiffness constraint (`dt < 2/1000 = 0.002`) to remain stable; implicit backward Euler is unconditionally stable, only first-order but can advance with large step sizes.

**Goal**: Two debaters defend the explicit and implicit approaches respectively; the arbiter focuses on "stability vs accuracy under stiffness" and issues a ruling.

**Dispute proposition** (the `task`): *"For the stiff ODE dy/dt = -1000·y, y(0)=1, integrated to t=1, should you use explicit RK4 or implicit backward Euler?"*

**Success criteria (machine-evaluable)**:
- Both debater outputs each contain `<!-- ARG: <one-line position> -->` marker
- Arbiter output contains `<ruling>{"decision":"implicit","rationale":"<text>"}</ruling>` tag JSON block
- `rationale` is non-empty and mentions the key term (`stiff` or `stability`)

### 2.2 Team configuration

```json
{
  "name": "ode-debate",
  "description": "Arbitrate whether explicit RK4 or implicit backward Euler should integrate the stiff ODE dy/dt=-1000y to t=1",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are the proponent of EXPLICIT RK4 for the stiff ODE dy/dt = -1000*y, y(0)=1, integrated to t=1. Argue the explicit case: RK4 is 4th-order accurate (local error O(dt^5)), cheap per step (no linear solve), and trivially parallelizable. Compute the stability limit: RK4's stable for |1 + z + z^2/2 + z^3/6 + z^4/24| <= 1 with z=-1000*dt, requiring dt < ~0.0028 (roughly 2/1000); at dt=0.001 you need ~1000 steps but each is cheap.\n\nRebut the implicit side.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are the proponent of IMPLICIT backward Euler for the stiff ODE dy/dt = -1000*y, y(0)=1, integrated to t=1. Argue the implicit case: backward Euler is A-stable / unconditionally stable (amplification factor 1/(1+1000*dt) is always < 1), so you can take HUGE steps (e.g. dt=0.1, ~10 steps total) without blow-up; RK4 would need ~1000+ tiny steps (dt<0.0028) just to stay stable, swamping its accuracy advantage.\n\nFor stiff problems stability dominates accuracy.\n\nRebut the explicit side.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "physicist",
      "prompt": "You are the ARBITER. Two simulators debated whether to integrate the stiff ODE dy/dt = -1000*y (y(0)=1, to t=1) with EXPLICIT RK4 or IMPLICIT backward Euler. Weigh both sides objectively, then deliver a single BINDING ruling. Recall the governing principle: for stiff systems, the step size is dictated by stability (the fast mode -1000), not accuracy. RK4's explicit stability region forces dt < 2/1000 = 0.002 (hundreds-to-thousands of steps); backward Euler is A-stable and advances in a handful of large steps.\n\nStability wins over per-step accuracy for stiff problems.\n\nYour output MUST end with exactly one line formatted: <ruling>{"decision": "<implicit or explicit>", "rationale": "<one-sentence rationale referencing stiffness / CFL-like stability constraint>"}</ruling>."
    }
  ]
}
```

**Role selection rationale**: Debaters use `simulator` (PDE/ODE numerical simulation experts, can derive stability regions and amplification factors); arbiter uses `physicist` (physical intuition to judge that stability outweighs accuracy under stiffness).

### 2.3 Master launch call

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "ode-debate",
    "task": "For the stiff ODE dy/dt = -1000*y, y(0)=1, integrated to t=1, should you use explicit RK4 or implicit backward Euler?",
    "arbiter": "carol",
    "debaters": ["alice", "bob"],
    "max_rounds": 2,
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- `arbiter: "carol"` — role=`physicist` arbiter, ruling on stiffness / stability trade-off
- `debaters: ["alice", "bob"]` — Explicit camp vs implicit camp, exactly 2 unique debaters
- `max_rounds: 2` — Opening (stability region derivation) + rebuttal (step-count comparison), two rounds
- `timeout_ms: 1200000` (20 min) — Hard cap

### 2.4 Execution flow (timeline)

```
T+0m    master calls team_arbitrate (max_rounds=2)
T+0m    Round 1: parallel dispatch 2 simulator debaters opening statements
T+0~4m  each debater derives stability region / amplification factor / step-count estimate + ARG marker
T+4m    arbiter (physicist) reviews Round 1
T+5m    Round 2: parallel dispatch 2 debaters rebutting
T+5~8m  each debater rebuts, refreshes ARG marker
T+8m    arbiter reviews Round 2, issues ruling (RULING=implicit + REASON)
T+9m    ruling delivered to master
T+9m    Run: bun check-physics-stiff-ode.ts <run_dir>
```

### 2.5 Check script

[`check-physics-stiff-ode.ts`](./check-physics-stiff-ode.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**:
  - Debaters `<!-- ARG:\s*(.+?)\s*-->`
  - Arbiter `<ruling>{...}</ruling>` tag JSON block (`JSON.parse` to read `decision` and `rationale`)
- **Assertions**:
  1. Both debaters produced `ARG` markers
  2. Arbiter `decision == "implicit"`
  3. `rationale` non-empty and contains `stiff` or `stability` (case-insensitive)

---

## Scenario 3: Cache Eviction Policy Debate

### 3.1 Scenario description

**Background**: A single-process cache of capacity 8 serving a workload with strong **temporal locality** (recently-accessed keys are likely re-accessed soon) and uniform frequencies. LRU (Least Recently Used) and LFU (Least Frequently Used) show significantly different hit rates for this workload — a classic debate in cache design.

**Goal**: Two debaters defend LRU and LFU respectively; the arbiter focuses on "should temporal locality prioritize eviction by recency or frequency" and issues a ruling.

**Dispute proposition** (the `task`): *"For a single-process cache of capacity 8 serving a workload with strong temporal locality (recently-accessed keys likely re-accessed soon) and uniform frequencies, should you use LRU or LFU eviction?"*

**Success criteria (machine-evaluable)**:
- Both debater outputs each contain `<!-- ARG: <one-line position> -->` marker
- Arbiter output contains `<ruling>{"decision":"lru","rationale":"<text>"}</ruling>` tag JSON block
- `rationale` is non-empty and mentions the key term (`temporal` or `recency`)

### 3.2 Team configuration

```json
{
  "name": "cache-debate",
  "description": "Arbitrate LRU vs LFU eviction for a capacity-8 cache under strong temporal locality and uniform frequencies",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are the proponent of LRU (Least Recently Used) eviction for a single-process cache of capacity 8 under a workload with STRONG TEMPORAL LOCALITY (recently-accessed keys are likely re-accessed soon) and UNIFORM frequencies. Argue: LRU orders by recency, which directly tracks temporal locality; it promotes the just-touched key and evicts the one longest unseen, matching the reuse pattern. It is O(1) per op (hash map + doubly-linked list), simple, and adapts to access-pattern shifts. Cite that with uniform frequencies, LFU's frequency signal carries no discriminating information, so recency is the only useful signal.\n\nRebut the LFU side.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are the proponent of LFU (Least Frequently Used) eviction for a single-process cache of capacity 8 under a workload with STRONG TEMPORAL LOCALITY and UNIFORM frequencies. Argue the LFU case as strongly as you can: LFU retains frequently-used items, giving stable hit rates for repeated popular keys; it is not fooled by a single recent touch; and frequency is a robust long-term signal. Acknowledge the uniform-frequency caveat but argue LFU degrades gracefully and avoids LRU's vulnerability to scan/churn patterns.\n\nRebut the LRU side.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are the ARBITER. Two coders debated whether a single-process capacity-8 cache under STRONG TEMPORAL LOCALITY (recently-accessed keys likely re-accessed soon) and UNIFORM frequencies should use LRU or LFU eviction. Weigh both sides objectively, then deliver a single BINDING ruling. Recall the caching principle: when temporal locality dominates and frequencies are uniform, recency (LRU) is the signal that tracks the access pattern; frequency (LFU) carries little information when frequencies are uniform and can even retain stale popular items.\n\nYour output MUST end with exactly one line formatted: <ruling>{"decision": "<lru or lfu>", "rationale": "<one-sentence rationale referencing temporal locality / recency>"}</ruling>."
    }
  ]
}
```

**Role selection rationale**: Debaters use `coder` (can articulate O(1) implementation, linked list + hashmap, scan resistance, and other engineering details); arbiter uses `reviewer` (weighs engineering arguments from both camps and issues a ruling).

### 3.3 Master launch call

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "cache-debate",
    "task": "For a single-process cache of capacity 8 serving a workload with strong temporal locality (recently-accessed keys likely re-accessed soon) and uniform frequencies, should you use LRU or LFU eviction?",
    "arbiter": "carol",
    "debaters": ["alice", "bob"],
    "max_rounds": 2,
    "timeout_ms": 1080000
  }
}
```

**Parameter selection**:
- `arbiter: "carol"` — role=`reviewer`, ruling on locality / recency trade-off
- `debaters: ["alice", "bob"]` — LRU camp vs LFU camp
- `max_rounds: 2` — Opening (implementation + complexity) + rebuttal (scan resistance / uniform frequencies), two rounds
- `timeout_ms: 1080000` (18 min) — Pure text debate, slightly shorter than numerical scenarios

### 3.4 Execution flow (timeline)

```
T+0m    master calls team_arbitrate (max_rounds=2)
T+0m    Round 1: parallel dispatch 2 coder debaters opening statements
T+0~4m  each debater writes eviction strategy arguments (complexity / scan resistance / locality) + ARG marker
T+4m    arbiter reviews Round 1
T+5m    Round 2: parallel dispatch 2 debaters rebutting
T+5~7m  each debater rebuts, refreshes ARG marker
T+7m    arbiter reviews Round 2, issues ruling (RULING=lru + REASON)
T+8m    ruling delivered to master
T+8m    Run: bun check-coding-cache-eviction.ts <run_dir>
```

### 3.5 Check script

[`check-coding-cache-eviction.ts`](./check-coding-cache-eviction.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**:
  - Debaters `<!-- ARG:\s*(.+?)\s*-->`
  - Arbiter `<ruling>{...}</ruling>` tag JSON block (`JSON.parse` to read `decision` and `rationale`)
- **Assertions**:
  1. Both debaters produced `ARG` markers
  2. Arbiter `decision == "lru"`
  3. `rationale` non-empty and contains `temporal` or `recency` (case-insensitive)

---

## Scenario 4: Complex-Boundary PDE Five-Method Debate (challenge-level)

**Challenge-level**: 6 members (5 debaters + 1 arbiter), `max_rounds=3`, est. ~40 min, deliberately exceeds the standard template (≤4 members / ≤30 min) to stress-test `team_arbitrate` scalability under a five-way debate.

### 4.1 Scenario description

**Background**: A class of PDEs simultaneously possessing three difficulties — **complex curved boundary** (requires unstructured mesh conformity), **advection-dominated transport** (prone to numerical oscillation, needs stabilization), **nonlinear source term** (rules out methods that only work for linear problems). Five mainstream discretization approaches (FEM, FDM, FVM, Spectral, BEM) each involve trade-offs in geometric adaptability, advection stabilization, and nonlinear handling, making this one of the most open-ended numerical method selection debates in computational physics.

**Goal**: Five debaters each defend one discretization approach; the arbiter synthesizes across three dimensions — "geometric adaptability + advection stabilization + nonlinear handling" — and issues a ruling.

**Dispute proposition** (the `task`): *"For a PDE with a complex CURVED boundary, advection-dominated transport, AND a nonlinear source term, which numerical method should you choose: FEM, FDM, FVM, Spectral, or BEM?"*

**Success criteria (machine-evaluable)**:
- All five debater outputs each contain `<!-- ARG: <one-line position> -->` marker
- Arbiter output contains `<ruling>{"decision":"<method>","rationale":"<text>"}</ruling>` tag JSON block (`decision` ∈ {fem, fdm, fvm, spectral, bem})
- `rationale` non-empty and mentions at least two of `{curved, boundary, advection, nonlinear, flux, mesh}` (case-insensitive)
- **Physical expectation**: FEM or FVM should win — both can conform to curved boundaries via unstructured meshes, handle advection dominance via stabilization / flux limiting, and naturally incorporate the nonlinear source term; Spectral struggles with complex geometry, FDM is strained on curved boundaries, BEM is only applicable to linear problems (nonlinear source term directly disqualifies BEM).

### 4.2 Team configuration

```json
{
  "name": "pde-debate",
  "description": "Arbitrate among FEM, FDM, FVM, Spectral, and BEM for a PDE with a complex curved boundary, advection-dominated transport, and a nonlinear source term",
  "members": [
    {
      "name": "alice",
      "role": "physicist",
      "prompt": "You are the proponent of FEM (Finite Element Method) for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue: FEM handles arbitrary geometries via unstructured (triangular / tetrahedral) meshes that conform to curved boundaries; advection dominance is tamed by SUPG / GLS stabilization or discontinuous Galerkin; the nonlinear source term is incorporated naturally via the weak form and solved by Newton iteration. The variational framework is mathematically rigorous (Lax-Milgram / Galerkin orthogonality).\n\nRebut the other four methods.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "physicist",
      "prompt": "You are the proponent of FDM (Finite Difference Method) for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue the FDM case as strongly as you can: FDM is conceptually simple and trivially vectorizable, and the nonlinear source term is a local pointwise evaluation (no integration needed). Modern immersed-boundary / cut-cell / overset-grid techniques adapt structured differences to curved geometries without unstructured meshes, and high-order compact schemes rival spectral accuracy on smooth regions.\n\nRebut the other four methods.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "physicist",
      "prompt": "You are the proponent of FVM (Finite Volume Method) for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue: FVM is exactly locally conservative (integral flux form), which is essential for advection-dominated transport; upwind / flux-limiter / MUSCL / WENO schemes suppress oscillations without excessive numerical diffusion; unstructured FVM meshes conform to curved boundaries just like FEM; the nonlinear source term is a cell-average contribution. FVM is the workhorse of CFD for exactly these reasons.\n\nRebut the other four methods.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "dave",
      "role": "physicist",
      "prompt": "You are the proponent of SPECTRAL methods for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue the spectral case as strongly as you can: spectral methods achieve exponential convergence for smooth solutions (error ~ exp(-N)), far outperforming algebraic-order FEM / FDM / FVM; spectral-element / nodal-DG variants patch spectral bases onto curved elements to recover geometric flexibility; dealiasing (the 3/2 rule) handles the nonlinear source term; advection is treated with spectral upwinding.\n\nRebut the other four methods.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "erin",
      "role": "physicist",
      "prompt": "You are the proponent of BEM (Boundary Element Method) for a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Argue the BEM case as strongly as you can: BEM discretizes ONLY the boundary (dimensionality reduction by one — a 3D PDE becomes a 2D surface mesh), so the curved boundary is its natural input; the far-field is exact (no artificial truncation); the resulting system is smaller and dense. Address the advection and nonlinearity concerns via domain-integral formulations or hybrid BEM-FEM coupling.\n\nRebut the other four methods.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are the ARBITER. Five physicists debated which numerical method — FEM, FDM, FVM, Spectral, or BEM — should solve a PDE with a COMPLEX CURVED BOUNDARY, ADVECTION-DOMINATED transport, AND a NONLINEAR source term. Weigh all five sides objectively across three dimensions — (1) geometry adaptability to the curved boundary, (2) stability under advection dominance, (3) handling the nonlinear source — then deliver a single BINDING ruling. Recall the governing trade-offs: FEM and FVM conform to curved boundaries via unstructured meshes and tame advection via SUPG / flux-limiting respectively, and both admit the nonlinear source term naturally; FDM struggles to conform to curved boundaries; Spectral methods lose their exponential-convergence advantage and geometric flexibility on complex domains; BEM requires a linear PDE with a known fundamental solution, so the nonlinear source term fundamentally disqualifies it.\n\nYour output MUST end with exactly one line formatted: <ruling>{"decision": "<fem | fdm | fvm | spectral | bem>", "rationale": "<one-sentence rationale referencing at least two of: curved boundary, advection, nonlinearity, flux, mesh>"}</ruling>."
    }
  ]
}
```

**Role selection rationale**: All 5 debaters use `physicist` (computational physics numerical method experts, can articulate arguments about weak form / flux conservation / stability regions / spectral convergence / Green's functions); arbiter uses `reviewer` (read-only role, objectively weighs across five camps without favoring any method).

### 4.3 Master launch call

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "pde-debate",
    "task": "For a PDE with a complex CURVED boundary, advection-dominated transport, AND a nonlinear source term, which numerical method should you choose: FEM, FDM, FVM, Spectral, or BEM?",
    "arbiter": "frank",
    "debaters": ["alice", "bob", "carol", "dave", "erin"],
    "max_rounds": 3,
    "timeout_ms": 2400000
  }
}
```

**Parameter selection**:
- `arbiter: "frank"` — role=`reviewer` arbiter, not a debater, not master; rules on the geometry / advection / nonlinearity three-dimensional trade-off
- `debaters: ["alice", "bob", "carol", "dave", "erin"]` — Exactly 5 unique debaters, holding FEM / FDM / FVM / Spectral / BEM respectively
- `max_rounds: 3` — Opening + cross-rebuttal + closing arguments, three rounds total (five-way divergence is large; two rounds are insufficient to expose all trade-offs)
- `timeout_ms: 2400000` (40 min) — Hard cap for 5 debaters × 3 rounds + ruling; challenge-level scenario deliberately relaxed
- No `signoff_*` — The arbiter's ruling itself is the endpoint (equivalent to `none` gate)

### 4.4 Execution flow (timeline)

```
T+0m     master calls team_arbitrate (max_rounds=3)
T+0m     Round 1: parallel dispatch 5 physicist debaters opening statements
T+0~6m   each debater writes method arguments (weak form / flux conservation / stabilization / spectral convergence / Green's function) + ARG marker
T+6m     arbiter (reviewer) reviews Round 1 five-way outputs
T+7m     Round 2: parallel dispatch 5 debaters cross-rebutting
T+7~14m  each debater rebuts the other four camps, refreshes ARG marker
T+14m    arbiter reviews Round 2
T+15m    Round 3: parallel dispatch 5 debaters closing arguments
T+15~22m each debater delivers closing arguments, refreshes ARG marker
T+22m    arbiter reviews Round 3, issues binding ruling (RULING + REASON)
T+24m    ruling delivered to master
T+24m    Run: bun check-physics-pde-arbitrate.ts <run_dir>
```

### 4.5 Check script

[`check-physics-pde-arbitrate.ts`](./check-physics-pde-arbitrate.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,dave,erin,frank}.md`
- **Extract**:
  - Debaters `<!-- ARG:\s*(.+?)\s*-->`
  - Arbiter `<ruling>{...}</ruling>` tag JSON block (`JSON.parse` to read `decision` and `rationale`)
- **Assertions**:
  1. All five debaters produced `ARG` markers
  2. Arbiter `decision` ∈ {fem, fdm, fvm, spectral, bem}
  3. `rationale` non-empty and contains at least two of `{curved, boundary, advection, nonlinear, flux, mesh}` (case-insensitive)

---


## Quick-start Prompts (copy and use)

Paste any of the following prompts to the master session; the AI will automatically complete the full closed loop. Arbitrate mode evaluation reads the arbiter member's final ruling (containing the `<ruling>{"decision":"...","rationale":"..."}</ruling>` tag JSON block).

### Scenario 1: 4×4 Matrix Inversion Debate (math)

```text
Execute the full closed loop for demos/07-team-arbitrate/README.md "Scenario 1" with automatic evaluation.

Steps:
1. Read README "1.2 Team Configuration", create the team with team_create JSON (2 debaters + 1 arbiter)
2. team_activate to activate
3. Read README "1.3 Master Launch Call", start orchestration with the team_arbitrate JSON
4. team_results poll until master receives summary (arbiter issues ruling after debaters debate) (poll every 30s)
5. Locate <run_dir> (containing carol member .md)
6. Run: bun demos/07-team-arbitrate/check-math-matrix-inverse.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: arbiter RULING = direct; REASON contains condition or dense (direct method wins for the 4x4 dense well-conditioned matrix).
```

### Scenario 2: Stiff ODE Method Debate (physics)

```text
Execute the full closed loop for demos/07-team-arbitrate/README.md "Scenario 2" with automatic evaluation.

Steps:
1. Read README "2.2 Team Configuration", create the team with team_create JSON
2. team_activate to activate
3. Read README "2.3 Master Launch Call", start orchestration with the team_arbitrate JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir>
6. Run: bun demos/07-team-arbitrate/check-physics-stiff-ode.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: arbiter RULING = implicit; REASON contains stiff or stability (explicit method for dy/dt=-1000y is constrained by dt<0.002).
```

### Scenario 3: Cache Eviction Policy Debate (programming)

```text
Execute the full closed loop for demos/07-team-arbitrate/README.md "Scenario 3" with automatic evaluation.

Steps:
1. Read README "3.2 Team Configuration", create the team with team_create JSON
2. team_activate to activate
3. Read README "3.3 Master Launch Call", start orchestration with the team_arbitrate JSON
4. team_results poll until master receives summary (poll every 30s)
5. Locate <run_dir>
6. Run: bun demos/07-team-arbitrate/check-coding-cache-eviction.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: arbiter RULING = lru; REASON contains temporal or recency (strong temporal locality workload favors LRU).
```

### Scenario 4: Complex-Boundary PDE Five-Method Debate (physics · challenge-level)

```text
Execute the full closed loop for demos/07-team-arbitrate/README.md "Scenario 4" with automatic evaluation.

Steps:
1. Read README "4.2 Team Configuration", create the team with team_create JSON (5 debaters + 1 arbiter, challenge-level)
2. team_activate to activate
3. Read README "4.3 Master Launch Call", start orchestration with the team_arbitrate JSON (max_rounds=3)
4. team_results poll until master receives summary (arbiter issues ruling after five-way three-round debate) (poll every 30s)
5. Locate <run_dir> (containing frank member .md)
6. Run: bun demos/07-team-arbitrate/check-physics-pde-arbitrate.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: arbiter RULING ∈ {fem, fdm, fvm, spectral, bem}; REASON contains at least two of {curved, boundary, advection, nonlinear, flux, mesh} (complex boundary + advection-dominated + nonlinear source term, physically FEM/FVM expected to win).
```
