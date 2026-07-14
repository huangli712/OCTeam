# team_route Orchestration Scenario Design

> **Mode**: `team_route` — Content-based routing: the router member analyzes the input, selects matching branch member(s) to process it; selected branches execute in parallel, then results are summarized. No default route — unmatched input causes the entire run to fail.
> **Source**: [`src/tools/router.ts`](../../src/tools/router.ts)
> **Time-control design**: The routing mode is naturally energy-efficient — each run only dispatches **router + 1 matched branch** for execution (remaining branches exist only as classification candidates and are never dispatched). Therefore even with a team of 4-5 members, active members ≤ 2, total time ≈ router classification (~1 min) + matched branch solving (~5-8 min) ≈ 10 min (well under the 30 min cap).

## Scenario Overview

| # | Domain | Scenario | Members | Roles (router / branch) | Key param | Est. total time |
|---|------|------|--------|------------------------|-----------|-----------|
| 1 | Math | Single-problem classifier (calculus/algebra/number-theory/combinatorics) | 5 | `mathematician` / `mathematician` | `input` carries problem, routes have no `task` | ~8 min |
| 2 | Computational physics | PDE type routing (parabolic/elliptic/hyperbolic) | 4 | `physicist` / `simulator` | `input` carries PDE, routes have no `task` | ~8 min |
| 3 | Programming | GitHub issue triage (bug/feature/docs/refactor) | 5 | `analyst` / `coder` | `input` carries issue body, routes have no `task` | ~8 min |
| 4 | Programming (challenge-level) | Multi-faceted ticket nine-way routing (bug/refactor/test/docs/perf/security/dependency/question) | 9 | `analyst` / `coder` | `input` carries 200-word ticket, `branches` multi-select | ~45 min |

---

## Scenario 1: Single-problem classifier (math calculus routing)

### 1.1 Scenario description

**Background**: Given a concrete math problem, the correct discipline classification determines which expert it should be sent to. Here we use a derivative problem requiring the product rule to verify that the router can precisely select `calculus` from four closely related math sub-domains and trigger the corresponding calculus expert to produce the correct answer.

**Goal**: The router member reads the request to differentiate `f(x) = x^3·sin(x)`, routes to the `calculus` branch; the other three branches (algebra / number-theory / combinatorics) should **not** be triggered. The matched branch outputs the derivative simplified via the product rule.

**Success criteria (machine-evaluable)**:
- Router output contains `<route>{"branch":"calculus",...}</route>`
- Only `bob.md` contains the `<!-- ANSWER: ... -->` marker (remaining branches were never dispatched, no output files)
- `ANSWER` after normalization contains both terms `3x^2*sin(x)` and `x^3*cos(x)` (order-independent, tolerates `*`/`**`/whitespace differences)

### 1.2 Team configuration

```json
{
  "name": "math-classifier",
  "description": "Math problem router: classifies a single problem into calculus/algebra/number-theory/combinatorics",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematics problem classifier. Given a concrete math problem, identify which single sub-domain it belongs to and route it to the matching branch. The sub-domains are: calculus (derivatives, integrals, limits, differential calculus), algebra (equations, polynomials, symbolic manipulation, solving for unknowns), number-theory (integers, primes, divisibility, modular arithmetic), combinatorics (counting, permutations, combinations, graphs). A derivative or integral problem is calculus, not algebra. Pick exactly one branch. Your output MUST end with a line exactly formatted: <route>{\"branch\": \"<name>\", \"rationale\": \"<one sentence why>\"}</route>"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are a calculus specialist (derivatives, integrals, limits, series). When given a problem, first decide if it genuinely belongs to calculus. If it does, solve it step by step and put the final simplified closed-form result in the marker. If it does NOT belong to calculus, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ANSWER: <simplified_result> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are an algebra specialist (equations, polynomials, symbolic manipulation, solving for unknowns). When given a problem, first decide if it genuinely belongs to algebra. If it does, solve it step by step and put the final simplified result in the marker. If it does NOT belong to algebra, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ANSWER: <simplified_result> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "You are a number-theory specialist (integers, primes, divisibility, modular arithmetic, Diophantine equations). When given a problem, first decide if it genuinely belongs to number theory. If it does, solve it step by step and put the final result in the marker. If it does NOT belong to number theory, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ANSWER: <result> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "You are a combinatorics specialist (counting, permutations, combinations, graphs, generating functions). When given a problem, first decide if it genuinely belongs to combinatorics. If it does, solve it step by step and put the final result in the marker. If it does NOT belong to combinatorics, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ANSWER: <result> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    }
  ]
}
```

**Role selection rationale**: `mathematician` uses the `oct-junior` agent, which can read problems, derive, and write symbolic computation code for verification when needed — the router and all four branches use it, ensuring consistent classification and solution quality.

### 1.3 Master launch call

```json
{
  "tool": "team_route",
  "args": {
    "team_id": "math-classifier",
    "router": "alice",
    "input": "Compute the derivative of f(x) = x^3 · sin(x) and simplify.",
    "routes": [
      { "name": "calculus", "member": "bob", "description": "derivatives, integrals, limits, differential calculus" },
      { "name": "algebra", "member": "carol", "description": "equations, polynomials, symbolic manipulation" },
      { "name": "number-theory", "member": "dave", "description": "integers, primes, divisibility, modular arithmetic" },
      { "name": "combinatorics", "member": "erin", "description": "counting, permutations, combinations, graphs" }
    ],
    "timeout_ms": 600000
  }
}
```

**Parameter selection**:
- `router: "alice"` — The router must be a member name, not master, and cannot be a branch target (schema hard constraint, see `router.ts:298-300`).
- `input` carries the problem body — all routes omit `task`, so the matched branch member **directly receives `input`** (the schema-documented idiomatic pattern, see the `b.task ?? task.task` fallback in `router.ts:63`); avoids redundantly embedding the problem into every route.
- No `signoff_policy` set — defaults to `none`, branches deliver results upon completion without extra review gates.
- `timeout_ms: 600000` (10 min) — router classification ~1 min + bob differentiation ~3 min, ample margin.

### 1.4 Execution flow (timeline)

```
T+0m    master calls team_route (input = differentiation problem)
T+0m    Phase A: only alice dispatched (other 4 members wait)
T+0~1m  router reads problem → classifies → outputs <route>{"branch":"calculus",...}</route>
T+1m    Phase B: only bob dispatched (algebra/nt/combo three branches not triggered)
T+1~6m  bob applies product rule → simplifies → ANSWER marker
T+6m    target barrier converges → summary delivered to master
T+6m    Run: bun check-math-problem-router.ts <run_dir>
```

### 1.5 Check script

[`check-math-problem-router.ts`](./check-math-problem-router.ts)

- **Load**: `<run_dir>/alice.md` and `<run_dir>/bob.md`
- **Extract**:
  - Router decision: regex `<route>([\s\S]*?)</route>` → `JSON.parse` → read `branch` (or `branches[0]`)
  - Branch answer: regex `<!--\s*ANSWER:\s*([\s\S]*?)\s*-->`
- **Assertions**:
  1. Router selected branch === `calculus`
  2. `bob` did not output `DOMAIN_MATCH: false` (i.e., claimed the problem)
  3. `bob` output the `ANSWER` marker
  4. Answer after normalization (strip whitespace, `**`→`^`, strip `*`, lowercase) contains both `3x^2sin(x)` and `x^3cos(x)` (order-independent)

---

## Scenario 2: PDE type routing (computational physics)

### 2.1 Scenario description

**Background**: Partial differential equations are classified by the eigenvalue signs of the principal-part coefficient matrix into parabolic (heat/diffusion, first-order in time, second-order in space), elliptic (steady-state, Laplace/Poisson), and hyperbolic (wave, second-order in time). The equation type determines the numerical method choice — parabolic requires implicit schemes like Crank-Nicolson for stability, elliptic uses multigrid/Gauss-Seidel, hyperbolic uses explicit upwind. Correct classification is the first step in numerical solution.

**Goal**: The router member reads an initial value problem with Dirichlet boundary conditions, of the form `u_t = u_xx + u_yy`, correctly identifies it as `parabolic` (heat equation) and routes it; the matched branch provides an appropriate numerical method name.

**Success criteria (machine-evaluable)**:
- Router output contains `<route>{"branch":"parabolic",...}</route>`
- `bob.md` contains `<!-- METHOD: <name> -->`, and `<name>` ∈ {`crank-nicolson`, `implicit`, `ftcs`} (case-insensitive)
- `bob` did not output `DOMAIN_MATCH: false`

### 2.2 Team configuration

```json
{
  "name": "pde-classifier",
  "description": "PDE type router: classifies a PDE problem as parabolic/elliptic/hyperbolic",
  "members": [
    {
      "name": "alice",
      "role": "physicist",
      "prompt": "You are a partial differential equation (PDE) classifier. Given a PDE problem with its boundary/initial conditions, classify it by type and route to the matching branch. Types: parabolic (first-order in time, second-order in space, diffusion/heat, e.g. u_t = u_xx or u_t = u_xx + u_yy), elliptic (steady-state, no time derivative, Laplace/Poisson, e.g. u_xx + u_yy = 0 or = f(x,y)), hyperbolic (second-order in time, wave propagation, e.g. u_tt = u_xx). The presence of u_t with second spatial derivatives is the signature of parabolic. Pick exactly one branch. Your output MUST end with a line exactly formatted: <route>{\"branch\": \"<name>\", \"rationale\": \"<one sentence why>\"}</route>"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are a numerical PDE simulator specializing in parabolic equations (heat/diffusion, u_t = L*u). When given a PDE problem, first decide if it is genuinely parabolic. If it is, name the most appropriate numerical method (e.g. Crank-Nicolson, backward/implicit Euler, FTCS) and state the key stability constraint in one line. If it is NOT parabolic, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- METHOD: <method_name> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are a numerical PDE simulator specializing in elliptic equations (steady-state, Laplace/Poisson, L*u = f with no time derivative). When given a PDE problem, first decide if it is genuinely elliptic. If it is, name the most appropriate numerical method (e.g. Gauss-Seidel, SOR, multigrid, finite-element) in one line. If it is NOT elliptic, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- METHOD: <method_name> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "dave",
      "role": "simulator",
      "prompt": "You are a numerical PDE simulator specializing in hyperbolic equations (wave propagation, u_tt = c^2*L*u, advection). When given a PDE problem, first decide if it is genuinely hyperbolic. If it is, name the most appropriate numerical method (e.g. Lax-Wendroff, upwind, leapfrog) and the CFL constraint in one line. If it is NOT hyperbolic, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- METHOD: <method_name> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    }
  ]
}
```

**Role selection rationale**: Router uses `physicist` (focus on physical equation interpretation), branches use `simulator` (designed for PDE/MC/HPC numerical simulation, can produce method names and stability constraints).

### 2.3 Master launch call

```json
{
  "tool": "team_route",
  "args": {
    "team_id": "pde-classifier",
    "router": "alice",
    "input": "Solve u_t = u_xx + u_yy on a square domain with Dirichlet BC u=0 on the boundary, initial condition u(x,y,0)=sin(pi*x)sin(pi*y).",
    "routes": [
      { "name": "parabolic", "member": "bob", "description": "heat/diffusion, first-order in time, e.g. u_t = u_xx + u_yy" },
      { "name": "elliptic", "member": "carol", "description": "steady-state Laplace/Poisson, no time derivative" },
      { "name": "hyperbolic", "member": "dave", "description": "wave propagation, second-order in time" }
    ],
    "timeout_ms": 600000
  }
}
```

**Parameter selection**:
- `router: "alice"` — Member name, not master, not in routes (schema constraint).
- `input` directly embeds the complete PDE initial-boundary-value problem — all three routes omit `task`, so the matched branch (`bob`) directly receives this input; branch member system prompts already encode domain judgment and `METHOD` marker conventions.
- Route `description` values provide classification hints for the router (optional, schema-encouraged).

### 2.4 Execution flow (timeline)

```
T+0m    master calls team_route (input = heat equation IBVP)
T+0m    Phase A: only alice dispatched
T+0~1m  router recognizes u_t + second-order spatial terms → parabolic → <route>{"branch":"parabolic",...}</route>
T+1m    Phase B: only bob dispatched (elliptic/hyperbolic not triggered)
T+1~7m  bob selects Crank-Nicolson/implicit → explains stability → METHOD marker
T+7m    target barrier converges → summary delivered to master
T+7m    Run: bun check-physics-pde-router.ts <run_dir>
```

### 2.5 Check script

[`check-physics-pde-router.ts`](./check-physics-pde-router.ts)

- **Load**: `<run_dir>/alice.md` and `<run_dir>/bob.md`
- **Extract**:
  - Router decision: regex `<route>([\s\S]*?)</route>` → `JSON.parse` → read `branch`
  - Branch method: regex `<!--\s*METHOD:\s*(.*?)\s*-->`
- **Assertions**:
  1. Router selected branch === `parabolic`
  2. `bob` did not output `DOMAIN_MATCH: false`
  3. `METHOD` value (lowercased, whitespace-stripped) ∈ {`crank-nicolson`, `implicit`, `ftcs`}

---

## Scenario 3: GitHub issue triage (programming)

### 3.1 Scenario description

**Background**: Open-source project issue queues receive a flood of reports daily; manual triage is expensive. A router that can read issue bodies and auto-classify them (bug / feature / docs / refactor) is the core of automated triage. This scenario uses a real bug report (negative id lacking parameter validation) to verify that the router can select `bug` from four categories and trigger a fix strategy generation.

**Goal**: The router reads the issue body and correctly routes to the `bug` branch; the matched branch provides a minimal fix strategy (which function to add what guard to).

**Success criteria (machine-evaluable)**:
- Router output contains `<route>{"branch":"bug",...}</route>`
- `bob.md` contains `<!-- FIX_STRATEGY: <text> -->`, and `<text>` (lowercased) mentions at least one of `guard` / `throw` / `rangeerror`
- `bob` did not output `DOMAIN_MATCH: false`

### 3.2 Team configuration

```json
{
  "name": "issue-triage",
  "description": "GitHub issue router: classifies an issue as bug/feature/docs/refactor",
  "members": [
    {
      "name": "alice",
      "role": "analyst",
      "prompt": "You are a GitHub issue triage classifier. Given an issue report body, classify it into exactly one category and route to the matching branch. Categories: bug (the code does something wrong: incorrect result, crash, wrong return value, exception that should be thrown but is not, or vice versa), feature (a request for new functionality that does not yet exist), docs (documentation, examples, or readability improvement with no code-behavior change), refactor (code quality/structure change with no behavior change). A report that the code returns a value when it should throw is a bug. Pick exactly one branch. Your output MUST end with a line exactly formatted: <route>{\"branch\": \"<name>\", \"rationale\": \"<one sentence why>\"}</route>"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are a bug-fix coder. When given an issue, first decide if it genuinely reports a bug (broken or incorrect behavior). If it does, propose a minimal fix strategy: name the file/function to change and describe the concrete edit in one or two sentences (e.g. 'add a guard at the top of getUser that throws RangeError for negative ids'). If the issue is NOT a bug, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- FIX_STRATEGY: <file/function + change description> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a feature-implementing coder. When given an issue, first decide if it genuinely requests a new feature. If it does, sketch the implementation plan (new function/module, API surface) in one or two sentences. If the issue is NOT a feature request, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- FIX_STRATEGY: <implementation plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "dave",
      "role": "coder",
      "prompt": "You are a documentation coder. When given an issue, first decide if it genuinely is a documentation/docs request. If it does, describe the doc change needed in one or two sentences. If the issue is NOT a docs request, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- FIX_STRATEGY: <doc change description> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "erin",
      "role": "coder",
      "prompt": "You are a refactoring coder. When given an issue, first decide if it genuinely is a refactor request (behavior-preserving structural improvement). If it does, describe the refactor in one or two sentences. If the issue is NOT a refactor request, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- FIX_STRATEGY: <refactor description> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    }
  ]
}
```

**Role selection rationale**: Router uses `analyst` (focus on reading issues and classification judgment), four branches use `coder` (focus on locating files/functions and providing fix strategies).

### 3.3 Master launch call

```json
{
  "tool": "team_route",
  "args": {
    "team_id": "issue-triage",
    "router": "alice",
    "input": "When I call getUser(-1) the function returns a user instead of throwing. Expected: throw RangeError for negative ids.",
    "routes": [
      { "name": "bug", "member": "bob", "description": "incorrect behavior, crash, wrong result, missing exception" },
      { "name": "feature", "member": "carol", "description": "request for new functionality" },
      { "name": "docs", "member": "dave", "description": "documentation or readability improvement" },
      { "name": "refactor", "member": "erin", "description": "behavior-preserving structural change" }
    ],
    "timeout_ms": 600000
  }
}
```

**Parameter selection**:
- `router: "alice"` — Member name, not master, not in routes.
- `input` is a real issue body — all four routes omit `task`, matched branch (`bob`) directly receives the body; classification hints are in route `description` values.
- `description` clearly distinguishes the four categories (especially the "missing exception" hint helping the router classify "should throw but doesn't" as a bug rather than a feature).

### 3.4 Execution flow (timeline)

```
T+0m    master calls team_route (input = bug report body)
T+0m    Phase A: only alice dispatched
T+0~1m  router judges "should throw but doesn't" → bug → <route>{"branch":"bug",...}</route>
T+1m    Phase B: only bob dispatched (feature/docs/refactor not triggered)
T+1~6m  bob locates getUser → suggests negative id guard throwing RangeError → FIX_STRATEGY marker
T+6m    target barrier converges → summary delivered to master
T+6m    Run: bun check-coding-issue-router.ts <run_dir>
```

### 3.5 Check script

[`check-coding-issue-router.ts`](./check-coding-issue-router.ts)

- **Load**: `<run_dir>/alice.md` and `<run_dir>/bob.md`
- **Extract**:
  - Router decision: regex `<route>([\s\S]*?)</route>` → `JSON.parse` → read `branch`
  - Branch strategy: regex `<!--\s*FIX_STRATEGY:\s*([\s\S]*?)\s*-->`
- **Assertions**:
  1. Router selected branch === `bug`
  2. `bob` did not output `DOMAIN_MATCH: false`
  3. `FIX_STRATEGY` text (lowercased) matches at least one keyword from `guard|throw|rangeerror`

---

## Scenario 4: Multi-faceted ticket nine-way routing (challenge-level)

### 4.1 Scenario description

**Background**: Real-world engineering tickets are rarely single-category. A 200-word ticket often simultaneously reports a crash (bug), requests splitting a long function (refactor), exposes test blind spots (test), flags outdated docs (docs), and comes with a performance regression (perf) — and may even surface input trust (security), dependency upgrade (dependency), spec ambiguity (question), and other extended concerns. A simple "pick one route" router would stuff such a ticket into a single bucket and discard the remaining dimensions. This scenario deliberately constructs a ticket touching 5+ concern areas to stress-test whether the router can recognize "multi-facetedness" and use the framework's native `{"branches":[...]}` multi-select form (`router.ts:222`) to trigger multiple branches in parallel; each matched branch independently produces a one-line action plan for that dimension.

> **Challenge-level note**: This scenario has 9 members, up to 8 branches triggered in parallel, deliberately exceeding the AUTHORING.md "≤4 members, ≤30 min" standard budget, used to stress-test the routing mode's time control and stability under "router classification + multi-branch parallel".

**Goal**: The router member (alice) reads a 200-word ticket, identifies ≥4 concern areas, and uses `<route>{"branches":[...]}</route>` to trigger the corresponding branches in parallel; each matched branch member outputs `<!-- ACTION: <one-line plan> -->` for that dimension; unmatched branches output `<!-- DOMAIN_MATCH: false -->`.

**Success criteria (machine-evaluable)**:
- Router output contains `<route>{"branches":[...]}</route>`, and the `branches` array length ≥ 4
- Selected branches include at least 4 of the 5 categories: `bug`/`refactor`/`test`/`docs`/`perf`
- Each selected branch member's `.md` contains `<!-- ACTION: ... -->` and does not contain `<!-- DOMAIN_MATCH: false -->`
- `bug` must be in the selected branches, and `bob`'s (bug branch) ACTION text (lowercased) contains one of `guard|throw|empty|null|undefined|check` (a fix for an empty-input crash must name some kind of guard)

### 4.2 Team configuration

9 members: 1 `analyst` router (alice) + 8 `coder` branches (bob..iris). The router does not serve as any branch target (schema hard constraint, see `router.ts:273`).

```json
{
  "name": "ticket-router",
  "description": "Multi-faceted ticket router: routes a 200-word ticket spanning bug/refactor/test/docs/perf/security/dependency/question to 1+ of 8 coder branches",
  "members": [
    {
      "name": "alice",
      "role": "analyst",
      "prompt": "You are a software ticket triage analyst. Given an engineering ticket body, identify EVERY concern type it genuinely touches and route to ALL matching branches (not just one). Concern types: bug (broken behavior: crash, wrong result, missing exception), refactor (behavior-preserving structural improvement), test (missing or inadequate tests), docs (documentation wrong/stale/missing), perf (performance regression or optimization), security (input trust / untrusted-data handling / sanitization), dependency (third-party library bump/replace/audit), question (spec ambiguity needing clarification before action). A single ticket often spans several concerns — when in doubt, select ALL that apply rather than picking one. Your output MUST end with the <route> decision line (exact format provided by the system above), listing every matching branch name under branches."
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are a bug-fix coder. Given a ticket, decide if it genuinely reports a bug (broken/incorrect behavior: crash, wrong result, missing exception). If it does, name the file/function to change and the concrete defensive edit in one sentence (e.g. 'add a guard at the top of parseConfig that throws TypeError for null/undefined/empty input and returns the defaults'). If the ticket does NOT report a bug, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ACTION: <one-line fix plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a refactoring coder. Given a ticket, decide if it genuinely requests a behavior-preserving structural improvement (split a long function, extract a module, rename for clarity). If it does, name the file/function and the concrete split/extraction in one sentence. If the ticket does NOT request a refactor, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ACTION: <one-line refactor plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "dave",
      "role": "coder",
      "prompt": "You are a test coder. Given a ticket, decide if it genuinely reports missing or inadequate tests (uncovered edge cases, no regression coverage). If it does, name the file/function and the concrete test cases to add in one sentence. If the ticket does NOT concern tests, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ACTION: <one-line test plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "erin",
      "role": "coder",
      "prompt": "You are a documentation coder. Given a ticket, decide if it genuinely reports that documentation is wrong, stale, or missing. If it does, name the doc file/section and the concrete update in one sentence. If the ticket does NOT concern docs, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ACTION: <one-line docs plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "frank",
      "role": "coder",
      "prompt": "You are a performance coder. Given a ticket, decide if it genuinely reports a performance regression or optimization opportunity (slow path, repeated work, allocation churn). If it does, name the file/function and the concrete optimization in one sentence. If the ticket does NOT concern performance, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ACTION: <one-line perf plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "grace",
      "role": "coder",
      "prompt": "You are a security coder focused on input trust. Given a ticket, decide if it genuinely raises an input-trust / untrusted-data / sanitization concern (parsing untrusted user input, missing sanitization, injection surface). If it does, name where input enters and the concrete defensive measure in one sentence. If the ticket does NOT raise an input-trust concern, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ACTION: <one-line security plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "henry",
      "role": "coder",
      "prompt": "You are a dependency-management coder. Given a ticket, decide if it genuinely raises a third-party dependency concern (library needs a bump, replacement, audit, or compatibility check). If it does, name the dependency and the concrete action in one sentence. If the ticket does NOT concern a dependency, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ACTION: <one-line dependency plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "iris",
      "role": "coder",
      "prompt": "You are a spec-clarification coder. Given a ticket, decide if it genuinely contains a spec ambiguity or open question that must be answered before action (behavior undefined, requirements unclear). If it does, state the clarifying question and who must answer it in one sentence. If the ticket does NOT contain an open question, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ACTION: <one-line clarification plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    }
  ]
}
```

**Role selection rationale**: Router uses `analyst` (reads tickets, classification judgment); 8 branches uniformly use `coder` (locate files/functions, produce action plans). The 8 branch prompts are structurally isomorphic — first judge domain fit, then produce `ACTION` / `DOMAIN_MATCH` — ensuring consistent markers across parallel branches for uniform extraction by the check script. The router's `<route>` exact format is injected at dispatch time by the framework's `buildRouterPrompt` (`router.ts:210-226`), so alice's member prompt only needs to emphasize "select ALL that apply" without repeating the JSON template.

### 4.3 Master launch call

```json
{
  "tool": "team_route",
  "args": {
    "team_id": "ticket-router",
    "router": "alice",
    "input": "The `parseConfig` function (src/config.ts:45) crashes with `TypeError: Cannot read properties of undefined` when called as `parseConfig()` with no arguments or `parseConfig(null)`, instead of returning the defaults — this is a production P0 regression (bug). Its body is a 300-line monolith mixing tokenizing, schema validation, and file loading; it should be split into `parse` / `validate` / `load` modules (refactor). No unit tests exist for empty/null/undefined/unknown-key edge cases, so the crash shipped to prod undetected (test). The `## Configuration` section of `README.md` still documents the v1 boolean flag `--json` which was removed in v2; users are confused (docs). The v2 `parseConfig` benchmarks 5x slower than v1 (420ms vs 85ms per 10k files) due to repeated regex compilation inside the hot loop (perf). It is unclear whether the bundled `yaml` parser dependency needs a bump to support YAML 1.2 merge-key syntax we now want (dependency). Also: should untrusted user-supplied config strings be sanitized before parsing? (question).",
    "routes": [
      { "name": "bug", "member": "bob", "description": "broken behavior: crash, wrong result, missing exception" },
      { "name": "refactor", "member": "carol", "description": "behavior-preserving structural change (split/extract/rename)" },
      { "name": "test", "member": "dave", "description": "missing or inadequate tests for edge cases" },
      { "name": "docs", "member": "erin", "description": "documentation is wrong, stale, or missing" },
      { "name": "perf", "member": "frank", "description": "performance regression or optimization opportunity" },
      { "name": "security", "member": "grace", "description": "untrusted input trust / sanitization concern" },
      { "name": "dependency", "member": "henry", "description": "third-party library bump / replace / audit" },
      { "name": "question", "member": "iris", "description": "spec ambiguity needing clarification before action" }
    ],
    "timeout_ms": 2700000
  }
}
```

**Parameter selection**:
- `router: "alice"` — Member name, not master, not in routes (schema constraint `router.ts:273`).
- `input` is a ~200-word multi-faceted ticket — all 8 routes omit `task`, so **all** selected branch members directly receive this complete ticket (`b.task ?? task.task` fallback, `router.ts:63`); classification hints are written both in the ticket body's parenthetical notes at the end of each sentence and in route `description` values, double-insuring the router recognizes multi-facetedness.
- Routing form: The framework natively supports multi-select — the router's dispatch prompt embeds the `<route>{"branches": ["a","b"], ...}</route>` directive (`router.ts:222`); matched branches execute in **parallel**, then results are summarized.
- No `signoff_policy` set — defaults to `none`, each branch delivers upon completion without extra review gates (avoiding timeout for a 9-person challenge-level run).
- `timeout_ms: 2700000` (45 min) — Challenge-level budget: router classification ~2 min + matched branch parallel solving (wall clock = slowest branch) + dispatch/summary margin; still under the team_route framework hard cap.

### 4.4 Execution flow (timeline)

```
T+0m      master calls team_route (input = 200-word multi-faceted ticket)
T+0m      Phase A: only alice dispatched (other 8 members wait)
T+0~2m    router identifies bug+refactor+test+docs+perf (+extended) → <route>{"branches":[...]}</route>
T+2m      Phase B: dispatch all selected branches (parallel)
T+2~20m   each matched branch reads ticket → judges domain → writes ACTION (parallel wall clock ≈ slowest branch)
          unmatched branches produce no .md (schema: only selected branches dispatched)
T+~20m    target barrier converges → summary delivered to master
T+~20m    Run: bun check-coding-multi-ticket-router.ts <run_dir>
```

### 4.5 Check script

[`check-coding-multi-ticket-router.ts`](./check-coding-multi-ticket-router.ts)

- **Load**: `<run_dir>/alice.md` + each selected branch member's `.md` (branch-name to member-name mapping at top of script in `BRANCH_TO_MEMBER`)
- **Extract**:
  - Router decision: regex `<route>([\s\S]*?)</route>` → `JSON.parse` → read `branches` array (compatible with single-select `branch` automatically wrapped into array)
  - Branch actions: regex `<!--\s*ACTION:\s*([\s\S]*?)\s*-->`
- **Assertions**:
  1. Router selected branch count ≥ 4 (ticket genuinely covers ≥4 concern areas)
  2. Selected branches include at least 4 of `bug`/`refactor`/`test`/`docs`/`perf`
  3. `bug` must be in selected branches (empty-input crash is indisputable)
  4. Each selected branch member's `.md` contains `ACTION` marker and does not contain `DOMAIN_MATCH: false`
  5. Bug branch (bob)'s ACTION text (lowercased) matches one of `guard|throw|empty|null|undefined|check`

---

## Acceptance Checklist

- [ ] 4 check scripts pass `bunx tsc -p demos/tsconfig.json` (no type errors)
- [ ] Each team config uses valid roles (`mathematician` / `physicist` / `simulator` / `analyst` / `coder` are all presets)
- [ ] Each master call parameters conform to `team_route` schema: `router` not master, not a branch target; route `name`/`member` are unique; `input` ≤ 32768 characters
- [ ] Route mode actual dispatched members = router + N matched branches: Scenarios 1-3 single-select (≤ 2 active, ≤ 10 min); Scenario 4 multi-select parallel (≤ 9 active, ≤ 30 min cap)
- [ ] Router member prompt ends with `<route>` format directive; branch member prompts end with `DOMAIN_MATCH`/`ANSWER`/`METHOD`/`FIX_STRATEGY`/`ACTION` marker directives; check script regexes are strictly aligned with them


---

## Quick-start Prompts (copy and use)

> Paste any of the following prompts to the master session; the AI will automatically complete the full closed loop. Route mode evaluation reads the **router** member's `<route>` decision + selected branch members' outputs.

### Scenario 1: Math problem classification routing (math)

```text
执行 demos/06-team-route/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（1 router + 4 分支成员）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_route JSON 启动编排（input 是一道具体数学题）
4. team_results 轮询至 master 收到汇总（router 先决策，命中分支再执行）
5. 定位 <run_dir>（含 router 与各分支成员 .md）
6. 运行：bun demos/06-team-route/check-math-problem-router.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：router 选 calculus 分支；bob 的 ANSWER 含 3x²·sin(x)+x³·cos(x)（或等价导数表达式）。
```

### Scenario 2: PDE type routing (physics)

```text
执行 demos/06-team-route/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_route JSON 启动编排（input 是一个具体 PDE）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun demos/06-team-route/check-physics-pde-router.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：router 选 parabolic 分支（热扩散方程 u_t=u_xx+u_yy）；METHOD ∈ {crank-nicolson, implicit, ftcs}。
```

### Scenario 3: GitHub issue triage (programming)

```text
执行 demos/06-team-route/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_route JSON 启动编排（input 是一段 issue 正文）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun demos/06-team-route/check-coding-issue-router.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：router 选 bug 分支；FIX_STRATEGY 含 guard / throw / RangeError 之一（针对负 id 的修复思路）。
```

### Scenario 4: Multi-faceted ticket nine-way routing (challenge-level, programming)

```text
执行 demos/06-team-route/README.md「场景 4」的完整闭环并自动评判（挑战级，9 成员、8 分支多选）。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（1 router + 8 分支成员）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_route JSON 启动编排（input 是一段 200 字多面性工单）
4. team_results 轮询至 master 收到汇总（router 先多选分类，命中分支并行执行）
5. 定位 <run_dir>（含 router 与各命中分支成员 .md）
6. 运行：bun demos/06-team-route/check-coding-multi-ticket-router.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：router 以 {"branches":[...]} 选中 ≥4 分支（至少含 bug/refactor/test/docs/perf 中 4 个）；每个命中分支产 ACTION 计划；bug 分支的 ACTION 含 guard/throw/empty/null/undefined/check 之一。
```
