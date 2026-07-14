# team_recurse Orchestration Scenario Design

> **Mode**: `team_recurse` — Hierarchical recursive decomposition: a root task is broken down into subtasks (which may be further decomposed up to `max_depth`), subtask results are aggregated bottom-up, ultimately solving the root task. Uses a shared task list + blockedBy DAG for layered aggregation.
> **Source**: [`src/tools/recurse.ts`](../../src/tools/recurse.ts)
> **Time-control design**: `max_depth=2`, `max_subtasks=3`, root → 3 leaf nodes (members claim in parallel), each leaf ≤ 8 min; decomposer summary ≈ slowest leaf + aggregation ≈ 10-12 min (well under the 30 min cap).

## Scenario Overview

| # | Domain | Scenario | Members | Role | Key param | Est. total time |
|---|------|------|--------|------|-----------|-----------|
| 1 | Math | Derangement D_n three-method derivation aggregation | 3 | `mathematician` | `max_depth=2, max_subtasks=3` | ~12 min |
| 2 | Computational physics | Damped pendulum piecewise small-angle model aggregation | 3 | `simulator` | `max_depth=2, max_subtasks=3` | ~12 min |
| 3 | Programming | Single-file Markdown→HTML modular build | 3 | `coder` | `max_depth=2, max_subtasks=3` | ~10 min |
| 4 | Math (challenge-level) | Vandermonde identity multi-layer proof | 6 | `mathematician` | `max_depth=4, max_subtasks=4` | ~50 min |

---

## Scenario 1: Derangement D_n Three-Method Derivation Aggregation

### 1.1 Scenario description

**Background**: The derangement number D_n (the count of permutations of n elements with no fixed points) has three classic independent derivation paths, and all conclusions must converge to the same closed form. Recursive decomposition fits naturally: break "derive D_n" into 3 independent proof subtasks, then have the decomposer aggregate them bottom-up.

**Goal**: The decomposer splits the root task into 3 subtasks — inclusion-exclusion, recurrence D_n=(n-1)(D_{n-1}+D_{n-2}), exponential generating function — 3 members each claim one method and independently derive D_4; finally the decomposer aggregates the closed form D_n = n!·Σ_{k=0}^{n} (-1)^k/k! and the numeric value D_4 = 9.

**Success criteria (machine-evaluable)**:
- Decomposer (`alice`) output contains `<!-- D4_FINAL: 9 -->` (the numeric closed-form value after three-method aggregation)
- At least 1 of the other members outputs `<!-- D4_VALUE: 9 -->` (D_4 computed via their respective method)

### 1.2 Team configuration

```json
{
  "name": "derangement-derive",
  "description": "Derive D_n (derangements) via 3 independent proof methods, aggregated bottom-up",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "ROOT TASK: Derive the formula for D_n (the number of derangements of n elements) and aggregate across proof methods.\n\nYou are the DECOMPOSER.\n  STEP 0 (CRITICAL): Claim the root task FIRST (team_task_update status=\"claimed\" on the root). Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator only parses output from members holding a claimed/in_progress task.\n  STEP 1: Decompose the root into 3 subtasks (emit a <decompose> block — the orchestrator creates the subtasks automatically; do NOT call team_task_create): (a) inclusion-exclusion proof, (b) recurrence D_n = (n-1)(D_{n-1}+D_{n-2}) with D_0=1, D_1=0, (c) exponential generating function e^{-x}/(1-x). After the orchestrator creates the subtasks, claim one (e.g. (a)) for yourself; let teammates claim the others. Coordinate via team_send_message.\n\nFor YOUR subtask (a): derive D_n = n! * sum_{k=0}^{n} (-1)^k/k! and compute D_4 = 9 explicitly (D_4 = 24*(1 - 1 + 1/2 - 1/6 + 1/24) = 9). End your subtask writeup with a line exactly formatted: <!-- D4_VALUE: 9 -->\n\nAfter all 3 subtasks report back, AGGREGATE: confirm all three methods yield the same closed form and the same D_4, then write the unified result. Your final aggregated report MUST end with a line exactly formatted: <!-- D4_FINAL: 9 -->\n\nCOMPLETION PROTOCOL for YOUR subtask (a):\n  STEP 1: team_task_update(status=\"claimed\") to acquire your subtask.\n  STEP 2: Solve it, emit the D4_VALUE marker, then STOP (go idle). Do NOT call team_task_update(status=\"completed\") — the orchestrator finalizes your task automatically when you go idle.\nFor aggregation: poll team_task_list periodically; once all three subtasks show status=completed, claim the root task (team_task_update status=\"claimed\"), read each subtask result via team_task_get, aggregate, then emit D4_FINAL and go idle (do NOT mark root completed — the orchestrator finalizes it)."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team derivation of D_n (derangements of n elements). You are a solver member. Watch the shared task list (team_task_list) for subtask (b): the RECURRENCE D_n = (n-1)(D_{n-1}+D_{n-2}) with base cases D_0=1, D_1=0. COMPLETION PROTOCOL:\n  STEP 1 (CLAIM): Call team_task_update(status=\"claimed\") on subtask (b) to acquire it.\n  STEP 2 (SOLVE): Unfold the recurrence, compute D_2=1, D_3=2, D_4=9 step by step, verify it matches the closed form, emit the D4_VALUE marker, then STOP (go idle). Do NOT call team_task_update(status=\"completed\") — the orchestrator finalizes your task automatically when you go idle. Coordinate with the decomposer via team_send_message. Your report MUST end with a line exactly formatted: <!-- D4_VALUE: 9 -->"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team derivation of D_n (derangements of n elements). You are a solver member. Watch the shared task list (team_task_list) for subtask (c): the EXPONENTIAL GENERATING FUNCTION G(x) = sum_{n>=0} D_n x^n/n! = e^{-x}/(1-x). COMPLETION PROTOCOL:\n  STEP 1 (CLAIM): Call team_task_update(status=\"claimed\") on subtask (c) to acquire it.\n  STEP 2 (SOLVE): Extract coefficients D_n = n! * [x^n] e^{-x}/(1-x), evaluate at n=4 to get D_4 = 9, confirm equivalence to the closed form, emit the D4_VALUE marker, then STOP (go idle). Do NOT call team_task_update(status=\"completed\") — the orchestrator finalizes your task automatically when you go idle. Coordinate with the decomposer via team_send_message. Your report MUST end with a line exactly formatted: <!-- D4_VALUE: 9 -->"
    }
  ]
}
```

**Role selection rationale**: `mathematician` uses the `oct-junior` agent, capable of deriving, computing numeric values, and writing proofs — a perfect fit for this scenario. `alice` also serves as the decomposer (both a valid member and the aggregator).

### 1.3 Master launch call

```json
{
  "tool": "team_recurse",
  "args": {
    "team_id": "derangement-derive",
    "task": "Derive the formula for D_n (number of derangements of n elements). Decompose into proof approaches, then aggregate.",
    "decomposer": "alice",
    "max_depth": 2,
    "max_subtasks": 3,
    "timeout_ms": 900000,
    "max_retries": 0
  }
}
```

**Parameter selection**:
- `decomposer: alice` — Must be a member name, not `master`; chosen because inclusion-exclusion naturally yields the closed form, convenient for aggregation
- `max_depth: 2` — Root (depth 0) → 3 leaf proofs (depth 1), leaf nodes directly produce conclusions, no further decomposition needed
- `max_subtasks: 3` — Exactly matches the three independent proof paths, controlling fan-out
- `timeout_ms: 900000` (15 min) — Generous margin; normal completion ~8 min
- `max_retries: 0` — Derivation tasks are high-certainty; failure means overall failure

### 1.4 Execution flow (timeline)

```
T+0m    master calls team_recurse; root task enters shared task list (depth=0)
T+0m    only decomposer (alice) dispatched, with recursion contract
T+0~1m  alice decomposes root → creates 3 subtasks (blockedBy DAG)
T+1m    bob / carol awakened by tail re-prompt, claim respective subtasks
T+1~7m  three members derive in parallel: alice=inclusion-exclusion, bob=recurrence, carol=generating-function
T+7m    three leaf subtasks complete, results backfilled → triggers root aggregation
T+8m    alice aggregates three methods → closed form D_n and D_4=9, writes D4_FINAL
T+9m    Run: bun check-math-derangement.ts <run_dir>
```

### 1.5 Check script

[`check-math-derangement.ts`](./check-math-derangement.ts)

- **Load**: Read all `*.md` under `<run_dir>/` (recurse output scattered across task list + member reports)
- **Extract**: Regex `<!-- D4_FINAL:\s*(\d+)\s*-->` and `<!-- D4_VALUE:\s*(\d+)\s*-->`
- **Assertions**:
  1. Decomposer (`alice.md`) exists and contains `D4_FINAL: 9`
  2. At least 1 other member contains `D4_VALUE: 9` (proving at least one independent path computed the same value)

---

## Scenario 2: Damped Pendulum Piecewise Small-Angle Model Aggregation

### 2.1 Scenario description

**Background**: The damped pendulum equation θ̈ + γθ̇ + (g/L)sin(θ) can be approximated in layers at small angles: undamped simple harmonic solution → linear damping envelope → nonlinear sin correction. The three parts can be solved independently, then aggregated by the decomposer into a piecewise valid model.

**Goal**: The decomposer splits the root task into 3 subtasks — undamped SHO solution θ₀cos(ωt), linear damping envelope e^{-(γ/2)t}, nonlinear sin correction (single perturbation term) — members each claim one, and finally aggregate into a piecewise model valid when "γ small, θ small".

**Success criteria (machine-evaluable)**:
- Decomposer (`alice`) output contains `<!-- MODEL_VALID: true -->` (aggregated model is self-consistent within its valid domain)
- At least 1 other member outputs `<!-- ENVELOPE_DECAY: <value> -->`, value = γ/2 = 0.1 (the decay constant of the damping envelope e^{-(γ/2)t} at γ=0.2)

### 2.2 Team configuration

```json
{
  "name": "pendulum-damped",
  "description": "Damped pendulum small-angle model: decompose into SHO + linear damping + nonlinear correction, then aggregate",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "ROOT TASK: Model a damped pendulum d2theta/dt2 + gamma*dtheta/dt + (g/L)*sin(theta) for small angles. Decompose into the undamped solution, the linear-damping perturbation, and the nonlinear correction, then aggregate.\n\nYou are the DECOMPOSER.\n  STEP 0 (CRITICAL): Claim the root task FIRST (team_task_update status=\"claimed\" on the root). Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator only parses output from members holding a claimed/in_progress task.\n  STEP 1: Decompose the root into 3 subtasks (emit a <decompose> block — the orchestrator creates the subtasks automatically; do NOT call team_task_create): (a) undamped SHO solution theta0*cos(w*t) with w=sqrt(g/L), (b) linear-damping envelope exp(-(gamma/2)*t), (c) nonlinear sin-correction via one perturbation term (sin(theta) ~ theta - theta^3/6). After the orchestrator creates the subtasks, claim one (e.g. (a)) for yourself; let teammates claim the others. Coordinate via team_send_message.\n\nFor YOUR subtask (a): set g/L=1 (so w=1), gamma=0.2, theta0 small; give the undamped solution theta(t) = theta0*cos(t) and note its energy. End your subtask writeup with a one-line summary.\n\nAfter all 3 subtasks report back, AGGREGATE a piecewise model valid for gamma small and theta small: theta(t) ~ theta0*exp(-(gamma/2)*t)*cos(w_d*t) with the nonlinear correction noted. Confirm internal consistency. Your final aggregated report MUST end with a line exactly formatted: <!-- MODEL_VALID: true -->"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "ROOT TASK context: recursive team modeling of a damped pendulum. You are a solver member. Watch the shared task list (team_task_list) for subtask (b): the LINEAR-DAMPING envelope of the underdamped small-angle oscillator theta'' + gamma*theta' + w0^2*theta = 0. When claimable, claim it (team_task_update) and solve: for gamma=0.2 and w0=1, the underdamped envelope is exp(-(gamma/2)*t); identify the decay constant gamma/2 = 0.1 and give the e-folding behavior. Coordinate with the decomposer via team_send_message. Your report MUST end with a line exactly formatted: <!-- ENVELOPE_DECAY: 0.1 -->"
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "ROOT TASK context: recursive team modeling of a damped pendulum. You are a solver member. Watch the shared task list (team_task_list) for subtask (c): the NONLINEAR sin-correction. When claimable, claim it (team_task_update) and solve: expand sin(theta) = theta - theta^3/6 + ..., derive the leading (cubic) correction to the frequency (amplitude-dependent softening, domega ~ -theta0^2/16 for w0=1), and state the small-angle validity bound. Coordinate with the decomposer via team_send_message. Your report MUST end with a one-line summary of the correction magnitude."
    }
  ]
}
```

**Role selection rationale**: `simulator` is designed for numerical/analytical simulation, fitting the physics modeling scenario. `alice` also serves as the decomposer.

### 2.3 Master launch call

```json
{
  "tool": "team_recurse",
  "args": {
    "team_id": "pendulum-damped",
    "task": "Model a damped pendulum d2theta/dt2 + gamma*dtheta/dt + (g/L)*sin(theta) for small angles. Decompose into the undamped solution, the linear-damping perturbation, and the nonlinear correction.",
    "decomposer": "alice",
    "max_depth": 2,
    "max_subtasks": 3,
    "timeout_ms": 900000,
    "max_retries": 0
  }
}
```

**Parameter selection**:
- `decomposer: alice` — The undamped SHO is the backbone of the aggregated model (the other two are perturbations to it), making it a suitable aggregation anchor
- `max_depth: 2` — Root → 3 independent modeling subtasks, leaf nodes directly produce analytical expressions
- `max_subtasks: 3` — Corresponding to undamped / linear damping / nonlinear correction three segments
- `timeout_ms: 900000` (15 min) — Generous cap for analytical derivation + aggregation

### 2.4 Execution flow (timeline)

```
T+0m    master calls team_recurse; root task enters shared task list (depth=0)
T+0m    only decomposer (alice) dispatched, with recursion contract
T+0~1m  alice decomposes root → creates 3 subtasks (blockedBy DAG)
T+1m    bob / carol awakened by re-prompt, claim respective subtasks
T+1~7m  three members model in parallel: alice=undamped SHO, bob=envelope, carol=correction
T+7m    three leaf subtasks complete, backfilled → triggers root aggregation
T+8m    alice aggregates piecewise model, validates domain, writes MODEL_VALID
T+9m    Run: bun check-physics-damped-pendulum.ts <run_dir>
```

### 2.5 Check script

[`check-physics-damped-pendulum.ts`](./check-physics-damped-pendulum.ts)

- **Load**: Read all `*.md` under `<run_dir>/`
- **Extract**: Regex `<!-- MODEL_VALID:\s*(true|false)\s*-->` and `<!-- ENVELOPE_DECAY:\s*([\d.eE+-]+)\s*-->`
- **Assertions**:
  1. Decomposer (`alice.md`) contains `MODEL_VALID: true`
  2. At least 1 other member contains `ENVELOPE_DECAY`, value ≈ 0.1 (±0.01, i.e., γ/2 = 0.1)

---

## Scenario 3: Single-File Markdown→HTML Modular Build

### 3.1 Scenario description

**Background**: A single-file Markdown→HTML converter can be modularized by parse level: block-level parsing (headings + lists), inline parsing (bold + inline code), test cases. The three modules naturally have dependencies (tests depend on the first two); recursive decomposition with blockedBy DAG correctly orders them.

**Goal**: The decomposer splits the root task into 3 subtasks — block parser (headings + lists), inline parser (bold + code), test cases — members each claim one, and finally aggregate into a runnable `convert(markdown: string): string`.

**Success criteria (machine-evaluable)**:
- Decomposer (`alice`) output contains `<!-- CONVERTS: true -->` (a usable convert was aggregated)
- Test member (`carol`) output contains `<!-- PASS_COUNT: <n> -->`, n ≥ 5 (covers 5 features with all passing)
- Independently extract the `convert` function from any member's report and execute: `convert("# Hi")` contains `<h1`; `convert("**bold**")` contains `<strong>` or `<b>`

### 3.2 Team configuration

```json
{
  "name": "md-converter",
  "description": "Single-file Markdown-to-HTML converter: decompose into block parser + inline parser + tests, then aggregate",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "ROOT TASK: Build a single-file Markdown-to-HTML converter supporting headings (#, ##, ###), bold (**), inline code (`), and unordered lists (-). Decompose into modules.\n\nYou are the DECOMPOSER.\n  STEP 0 (CRITICAL): Claim the root task FIRST (team_task_update status=\"claimed\" on the root). Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator only parses output from members holding a claimed/in_progress task.\n  STEP 1: Decompose the root into 3 subtasks (emit a <decompose> block — the orchestrator creates the subtasks automatically; do NOT call team_task_create): (a) block-parser handling headings (#/##/### -> <h1>/<h2>/<h3>) and unordered lists (- -> <ul><li>), (b) inline-parser handling bold (** -> <strong>) and inline code (` -> <code>), (c) test-cases that assemble a convert(markdown: string): string and assert all features. After the orchestrator creates the subtasks, claim one (e.g. (a)) for yourself; let teammates claim the others. Coordinate via team_send_message.\n\nFor YOUR subtask (a): implement parseBlocks(markdown: string): string producing the block-level HTML (headings + lists). End your subtask writeup with a line exactly formatted: <!-- IMPL: blockParser -->\n\nAfter all 3 subtasks report back, AGGREGATE: compose a single convert(markdown: string): string that runs block-parser then inline-parser, embed the full TypeScript in a ```typescript fenced block, and confirm it works on the canonical cases. Your final aggregated report MUST end with a line exactly formatted: <!-- CONVERTS: true -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "ROOT TASK context: recursive team build of a single-file Markdown-to-HTML converter. You are a solver member. Watch the shared task list (team_task_list) for subtask (b): the INLINE parser handling bold (**text** -> <strong>text</strong>) and inline code (`code` -> <code>code</code>). When claimable, claim it (team_task_update) and implement parseInline(text: string): string. Embed the TypeScript in a ```typescript fenced block. Coordinate with the decomposer via team_send_message. Your report MUST end with a line exactly formatted: <!-- IMPL: inlineParser -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "ROOT TASK context: recursive team build of a single-file Markdown-to-HTML converter. You are a solver member. Your subtask (c) is BLOCKED BY subtasks (a) block-parser and (b) inline-parser (see blockedBy in the shared task list). Wait until both are done, then claim (c) via team_task_update. Assemble convert(markdown: string): string from the two parsers and write a test suite covering: heading level 1 (#), level 2 (##), level 3 (###), bold (**), inline code (`), unordered list (-). Run the suite (at least 6 cases) and report the number of PASSING cases. Your report MUST end with a line exactly formatted: <!-- PASS_COUNT: <n_passing> --> where <n_passing> is the count of passing test cases."
    }
  ]
}
```

**Role selection rationale**: `coder` uses the `oct-junior` agent, focused on implementation with minimal changes — fitting the modular build scenario. `alice` also serves as the decomposer (it holds the top-level `convert` assembly responsibility).

### 3.3 Master launch call

```json
{
  "tool": "team_recurse",
  "args": {
    "team_id": "md-converter",
    "task": "Build a single-file Markdown-to-HTML converter supporting headings (#, ##, ###), bold (**), inline code (`), and unordered lists (-). Decompose into modules.",
    "decomposer": "alice",
    "max_depth": 2,
    "max_subtasks": 3,
    "timeout_ms": 900000,
    "max_retries": 0
  }
}
```

**Parameter selection**:
- `decomposer: alice` — Block parsing is the entry point of convert, making its assembly of the final convert most natural
- `max_depth: 2` — Root → 3 module subtasks; test subtask is sequenced after both parsers via blockedBy
- `max_subtasks: 3` — Block / inline / test three modules
- `timeout_ms: 900000` (15 min) — Includes blockedBy serial wait (tests after parsers), still well under cap

### 3.4 Execution flow (timeline)

```
T+0m    master calls team_recurse; root task enters shared task list (depth=0)
T+0m    only decomposer (alice) dispatched, with recursion contract
T+0~1m  alice decomposes root → creates 3 subtasks (carol blockedBy two parsers)
T+1m    bob awakened by re-prompt and claims (b); alice does (a) herself
T+1~5m  alice and bob implement in parallel
T+5m    both parsers complete → carol's blockedBy resolved, awakened to claim (c)
T+5~8m  carol assembles convert, runs test suite, backfills PASS_COUNT
T+8m    alice aggregates final convert, writes CONVERTS
T+9m    Run: bun check-coding-md-converter.ts <run_dir>
```

### 3.5 Check script

[`check-coding-md-converter.ts`](./check-coding-md-converter.ts)

- **Load**: Read all `*.md` under `<run_dir>/`
- **Extract**:
  - Markers: Regex `<!-- CONVERTS:\s*(true|false)\s*-->`, `<!-- PASS_COUNT:\s*(\d+)\s*-->`
  - Code: Scan each `*.md` for ` ```typescript ... ``` ` blocks, locate the block containing the `convert` definition
- **Assertions**:
  1. Decomposer (`alice.md`) contains `CONVERTS: true`
  2. `carol.md` contains `PASS_COUNT: <n>`, n ≥ 5 (covers 5 features with all passing)
  3. Extracted `convert` function: `convert("# Hi")` contains `<h1`; `convert("**bold**")` contains `<strong>` or `<b>`

---

## Scenario 4: Vandermonde Identity Multi-Layer Proof (challenge-level)

> **Challenge-level**: This scenario deliberately exceeds the standard budget (30 min total / ≤4 members / `max_depth=2`) to stress-test `team_recurse` under deeper (`max_depth=4`), wider (`max_subtasks=4`), and more members (6 people) for multi-layer recursive decomposition and bottom-up aggregation.

### 4.1 Scenario description

**Background**: The Vandermonde identity C(m+n, k) = Σ_{i=0}^{k} C(m,i)·C(n, k-i) is one of the core identities in combinatorics, with three mutually independent standard proof paths — algebraic (binomial expansion), combinatorial (bijective counting), generating-function (coefficient extraction from (1+x)^{m+n}). Each path can be further broken into 2-3 sub-lemmas (e.g., algebraic path: first prove (1+x)^{m+n}=(1+x)^m·(1+x)^n, then equate x^k coefficients). This "root → multiple paths → sub-lemmas → base identities" multi-layer structure is a natural fit for `team_recurse`'s deep recursive decomposition.

**Goal**: The decomposer (`alice`) splits the root task into 3 independent proof paths (algebraic / combinatorial / generating-function), each path further decomposed into 2-3 sub-lemmas, drilling down to base identities if needed (deepest to depth=4); 6 members claim leaf-node lemmas along paths in parallel and each complete their proofs; finally `alice` aggregates bottom-up, confirming all three paths converge, producing a complete proof of the Vandermonde identity.

**Success criteria (machine-evaluable)**:
- Decomposer (`alice`) output contains `<!-- VANDERMONDE_PROVEN: true -->` (identity confirmed after three-path aggregation)
- `<!-- APPROACH: <name> -->` markers collected from all members' leaf nodes show ≥2 distinct path names (must include at least `algebraic` and `combinatorial`)
- All `<!-- LEMMA_HOLDS: ... -->` markers found are `true` (no leaf lemma falsified)

### 4.2 Team configuration

```json
{
  "name": "vandermonde-prove",
  "description": "Prove the Vandermonde identity via 3 independent paths (algebraic / combinatorial / generating-function), each decomposed into sub-lemmas, aggregated bottom-up",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "ROOT TASK: Prove the Vandermonde identity C(m+n, k) = sum_{i=0}^{k} C(m,i)*C(n, k-i). Decompose into independent proof approaches, then sub-lemmas, down to base identities.\n\nYou are the DECOMPOSER.\n  STEP 0 (CRITICAL): Claim the root task FIRST (team_task_update status=\"claimed\" on the root). Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator only parses output from members holding a claimed/in_progress task.\n  STEP 1: Decompose the root into 3 independent proof PATHS (emit a <decompose> block — the orchestrator creates the subtasks automatically; do NOT call team_task_create): (A) algebraic -- expand (1+x)^{m+n} = (1+x)^m*(1+x)^n and equate coefficients of x^k; (B) combinatorial -- count C(m+n,k) directly and biject to the RHS split by how many elements come from the m-group; (C) generating-function -- extract the x^k coefficient from both sides of (1+x)^{m+n}=(1+x)^m*(1+x)^n. Then decompose each PATH into 2-3 sub-lemmas (depth 2); where useful, decompose a sub-lemma further into a base identity (depth 3), and continue down to depth-4 leaves. You may decompose up to max_depth=4 with max_subtasks=4. Coordinate via team_send_message.\n\nEXPECTED sub-lemma breakdown:\n- Algebraic path: (a) prove (1+x)^{m+n} = (1+x)^m*(1+x)^n by the binomial theorem; (b) equate coefficients of x^k on both sides to get sum_i C(m,i)*C(n,k-i) = C(m+n,k).\n- Combinatorial path: (a) count C(m+n,k) as the number of k-subsets of an (m+n)-set; (b) biject by partitioning on i = how many of the k chosen elements lie in a fixed m-subset, giving sum_i C(m,i)*C(n,k-i).\n- Generating-function path: (a) show [x^k](1+x)^{m+n} = C(m+n,k); (b) show [x^k](1+x)^m*(1+x)^n = sum_i C(m,i)*C(n,k-i) via the Cauchy product of power series.\n\nAfter the orchestrator creates the subtasks, claim the algebraic sub-lemma (a) for yourself; let teammates claim the rest.\n\nFor YOUR leaf sub-lemma (algebraic (a)): prove (1+x)^{m+n} = (1+x)^m*(1+x)^n by applying the binomial theorem to each factor on the RHS and combining exponents. Confirm it holds for all non-negative integers m, n. End your leaf writeup with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: algebraic -->\n\nAfter all leaf subtasks report back, AGGREGATE bottom-up: collect each path's conclusion, confirm all three paths yield C(m+n,k) = sum_{i=0}^{k} C(m,i)*C(n, k-i), and write the unified proof. Your final aggregated report MUST end with a line exactly formatted: <!-- VANDERMONDE_PROVEN: true -->"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity C(m+n,k) = sum_{i=0}^{k} C(m,i)*C(n,k-i). You are a solver member on the ALGEBRAIC path. Watch the shared task list (team_task_list) for the algebraic sub-lemma (b): EQUATE COEFFICIENTS of x^k on both sides of (1+x)^{m+n} = (1+x)^m*(1+x)^n. When it is claimable, claim it (team_task_update) and solve: expand (1+x)^m = sum_i C(m,i)*x^i and (1+x)^n = sum_j C(n,j)*x^j; multiply and collect the coefficient of x^k as sum_{i=0}^{k} C(m,i)*C(n,k-i); equate to C(m+n,k) from the LHS. Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: algebraic -->"
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity. You are a solver member on the COMBINATORIAL path. Watch the shared task list (team_task_list) for the combinatorial sub-lemma (a): COUNT C(m+n,k) directly as the number of k-element subsets of a fixed set of size m+n. When it is claimable, claim it (team_task_update) and solve: establish the base identity (subset count = n!/(k!*(n-k)!)) and state C(m+n,k) = (m+n)!/(k!*(m+n-k)!). Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: combinatorial -->"
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity. You are a solver member on the COMBINATORIAL path. Watch the shared task list (team_task_list) for the combinatorial sub-lemma (b): BIJECT by partitioning on i = how many of the k chosen elements lie in a fixed m-subset (the remaining k-i come from the n-subset). When it is claimable, claim it (team_task_update) and solve: show the number of k-subsets with exactly i elements from the m-group is C(m,i)*C(n,k-i); summing over i=0..k counts every k-subset exactly once, giving sum_i C(m,i)*C(n,k-i) = C(m+n,k). Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: combinatorial -->"
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity. You are a solver member on the GENERATING-FUNCTION path. Watch the shared task list (team_task_list) for the generating-function sub-lemma (a): show [x^k](1+x)^{m+n} = C(m+n,k) (the coefficient of x^k in the binomial expansion). When it is claimable, claim it (team_task_update) and solve: by the binomial theorem (1+x)^{m+n} = sum_t C(m+n,t)*x^t, so the coefficient of x^k is C(m+n,k). Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: generating-function -->"
    },
    {
      "name": "frank",
      "role": "mathematician",
      "prompt": "ROOT TASK context: recursive team proof of the Vandermonde identity. You are a solver member on the GENERATING-FUNCTION path. Watch the shared task list (team_task_list) for the generating-function sub-lemma (b): show [x^k](1+x)^m*(1+x)^n = sum_{i=0}^{k} C(m,i)*C(n,k-i) via the Cauchy product of power series. When it is claimable, claim it (team_task_update) and solve: write (1+x)^m = sum_i C(m,i)*x^i and (1+x)^n = sum_j C(n,j)*x^j; the x^k coefficient of their product is sum_{i=0}^{k} C(m,i)*C(n,k-i). Equate to the LHS coefficient C(m+n,k). Coordinate with the decomposer via team_send_message. Your leaf report MUST end with two lines exactly formatted:\n<!-- LEMMA_HOLDS: true -->\n<!-- APPROACH: generating-function -->"
    }
  ]
}
```

**Role selection rationale**: `mathematician` uses the `oct-junior` agent, capable of independent derivation, lemma proofs, and multi-layer proofs — a perfect fit for this scenario. All 6 are `mathematician`; `alice` also serves as the decomposer (both a valid member and the root aggregator). Member assignments are distributed along three paths: algebraic (alice + bob), combinatorial (carol + dave), generating-function (erin + frank), with 2 leaf lemmas per path.

### 4.3 Master launch call

```json
{
  "tool": "team_recurse",
  "args": {
    "team_id": "vandermonde-prove",
    "task": "Prove the Vandermonde identity: C(m+n, k) = Σ_{i=0}^{k} C(m,i)·C(n, k-i). Decompose into independent proof approaches, then sub-lemmas, down to base identities.",
    "decomposer": "alice",
    "max_depth": 4,
    "max_subtasks": 4,
    "timeout_ms": 3000000,
    "max_retries": 0
  }
}
```

**Parameter selection**:
- `decomposer: alice` — Must be a member name, not `master`; chosen because alice also handles one algebraic leaf, convenient for aggregation anchoring
- `max_depth: 4` — Root(0) → paths(1) → sub-lemmas(2) → base identities(3) → deep leaves(4); deliberately deeper than the standard depth=2 to stress-test multi-layer stepwise aggregation
- `max_subtasks: 4` — Allows up to 4 subtasks per level, accommodating the fan-out of 3 paths × 2-3 sub-lemmas; wider than the standard `max_subtasks=3`
- `timeout_ms: 3000000` (50 min) — Generous cap for 6 members parallel + multi-layer stepwise aggregation (challenge-level, exceeding the standard 30 min budget)
- `max_retries: 0` — Mathematical proofs are high-certainty; failure means overall failure

### 4.4 Execution flow (timeline)

```
T+0m     master calls team_recurse; root task enters shared task list (depth=0)
T+0m     only decomposer (alice) dispatched, with recursion contract
T+0~3m   alice decomposes root → 3 path tasks (depth=1: algebraic / combinatorial / generating-function)
T+3~6m   each path further decomposed into 2-3 sub-lemmas (depth=2); some sub-lemmas drill down to base identities (depth=3), individual ones reach depth-4 leaves
T+6m     bob / carol / dave / erin / frank awakened by tail re-prompt, claim respective leaf lemmas
T+6~38m  six members prove leaf lemmas in parallel (alice also handles one algebraic leaf), each backfills LEMMA_HOLDS + APPROACH
T+38m    all leaf lemmas complete → triggers depth-3 → depth-2 → depth-1 stepwise aggregation
T+38~46m path-level aggregation: three paths each converge to C(m+n,k) = Σ_i C(m,i)·C(n,k-i)
T+46m    alice aggregates three paths all roads leading to Rome, writes VANDERMONDE_PROVEN
T+50m    Run: bun check-math-vandermonde.ts <run_dir>
```

### 4.5 Check script

[`check-math-vandermonde.ts`](./check-math-vandermonde.ts)

- **Load**: Read all `*.md` under `<run_dir>/` (6 members' leaf lemma reports scattered across task list + member outputs)
- **Extract**:
  - Root aggregation marker: Regex `<!-- VANDERMONDE_PROVEN:\s*(true|false)\s*-->`
  - Leaf path markers: Global regex `<!-- APPROACH:\s*([A-Za-z0-9_-]+)\s*-->`
  - Leaf conclusion markers: Global regex `<!-- LEMMA_HOLDS:\s*(true|false)\s*-->`
- **Assertions**:
  1. Decomposer (`alice.md`) exists and contains `VANDERMONDE_PROVEN: true`
  2. APPROACH names collected from all members, deduplicated, ≥2 distinct, and must include both `algebraic` and `combinatorial` (proving ≥2 independent paths succeeded)
  3. All LEMMA_HOLDS markers found are `true` (no leaf lemma falsified)

---

## Acceptance Checklist

- [ ] 3 check scripts pass `tsc -p demos/tsconfig.json` (no type errors)
- [ ] Each team config uses valid roles (`mathematician` / `simulator` / `coder` are all presets)
- [ ] Each master call parameters conform to `team_recurse` schema (`decomposer` is a member name, not `master`; `max_depth=2`, `max_subtasks=3`)
- [ ] Per-scenario total time ≤ 15 min (well under the 30 min cap)
- [ ] Member prompts explicitly state output format conventions (markers), check scripts aligned with them
- [ ] Decomposer prompt uses `<decompose>` tag block (not manual team_task_create); aggregation markers (D4_FINAL / MODEL_VALID / CONVERTS / VANDERMONDE_PROVEN) and at least one leaf-node marker come from different members


---

## Quick-start Prompts (copy and use)

> Paste any of the following prompts to the master session; the AI will automatically complete the full closed loop. Recurse mode evaluation scans **all members'** .md files: finds the decomposer's aggregation marker + at least 1 leaf's sub-result marker.

### Scenario 1: Derangement D_n Derivation (math)

```text
执行 demos/08-team-recurse/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（3 个 mathematician，decomposer 由团队配置指定）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_recurse JSON 启动编排（root task = 推导 D_n）
4. team_results 轮询至 master 收到汇总（decomposer 拆子任务 → 成员自取 → 底层聚合回根）
5. 定位 <run_dir>（含所有成员 .md）
6. 运行：bun demos/08-team-recurse/check-math-derangement.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decomposer 的 D4_FINAL = 9；且至少 1 个叶子成员 D4_VALUE = 9（容斥/递推/生成函数三路均应得 9）。
```

### Scenario 2: Damped Pendulum Modeling (physics)

```text
执行 demos/08-team-recurse/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_recurse JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun demos/08-team-recurse/check-physics-damped-pendulum.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decomposer 的 MODEL_VALID = true；且至少 1 叶子报 ENVELOPE_DECAY（γ=0.2 时 e-folding 常数 ≈ 0.1，即 2/γ）。
```

### Scenario 3: Single-Page Markdown→HTML Converter (programming)

```text
执行 demos/08-team-recurse/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_recurse JSON 启动编排（root = 构建转换器）
4. team_results 轮询至 master 收到汇总（子任务：alice / bob / carol）
5. 定位 <run_dir>
6. 运行：bun demos/08-team-recurse/check-coding-md-converter.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decomposer 的 CONVERTS = true；且聚合出的 convert() 通过：convert("# Hi") 含 <h1>、convert("**b**") 含 <strong> 或 <b>。
```

### Scenario 4: Vandermonde Identity Multi-Layer Proof (math · challenge-level)

```text
执行 demos/08-team-recurse/README.md「场景 4」的完整闭环并自动评判（挑战级：6 成员、max_depth=4，预计 ~50 min）。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（6 个 mathematician，decomposer 为 alice）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_recurse JSON 启动编排（root = 证明 Vandermonde 恒等式；max_depth=4, max_subtasks=4）
4. team_results 轮询至 master 收到汇总（alice 拆 3 路径 → 各路径拆子引理 → 成员认领叶引理 → 自底向上逐层聚合回根）
5. 定位 <run_dir>（含所有 6 名成员 .md）
6. 运行：bun demos/08-team-recurse/check-math-vandermonde.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：alice 的 VANDERMONDE_PROVEN = true；叶节点 APPROACH 出现 ≥2 个不同名称（必含 algebraic 与 combinatorial）；所有 LEMMA_HOLDS 均为 true。
```
