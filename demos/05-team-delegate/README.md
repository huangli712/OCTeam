# team_delegate Orchestration Scenario Design

> **Pattern**: `team_delegate` — Publish tasks to a shared list; idle members self-claim, execute, and report back to master; supports `blocked_by` dependencies forming a DAG.
> **Source**: [`src/tools/delegate.ts`](../../src/tools/delegate.ts)
> **Timing Design**: Scenarios 1-3 baseline: 3 members self-claiming, subtask per member ≤ 6 min; dependency-free scenario total ≈ ceil(tasks/members) rounds × 3 min; DAG scenario total ≈ critical path × 3 min (scenarios 1-3 all ≤ 15 min, well under 30 min ceiling). **Scenario 4 is challenge-level**: deliberately breaks baseline constraints (8 members / 100 tasks / ~90 min), stress-testing delegate mode stability and task distribution fairness under high-concurrency self-claiming.

## Scenario Overview

| # | Domain | Scenario | Members | Role | Tasks / Deps | Estimated Duration |
|---|------|------|--------|------|-------------|-----------|
| 1 | Math | Five independent number-theory problems | 3 | `mathematician` | 5, no deps | ~10 min |
| 2 | Computational Physics | Three classic ODE system simulations | 3 | `simulator` | 3, no deps | ~8 min |
| 3 | Programming | CLI calculator blockedBy DAG | 3 | `coder` | 4, DAG | ~12 min |
| 4 | Math (Challenge-level) | 100 programmatic number-theory problems (4 families) | 8 | `mathematician` | 100, no deps | ~90 min |

---

## Scenario 1: Five Independent Number-Theory Problems

### 1.1 Scenario Description

**Background**: Elementary number theory is a classic domain in algorithm interviews (LeetCode easy level). Five independent problems covering prime counting, Euclidean GCD, primality testing, divisor sum, and modular inverse — mutually independent, naturally suited to delegate mode's parallel self-claiming.

**Goal**: Publish 5 independent number-theory tasks to the shared list; 3 mathematician members self-claim, solve, and report answers.

**Success Criteria (Machine-Verifiable)**:
- Combined member outputs contain all 5 `<!-- ANSWER: <value> -->` markers
- 5 answers match expected values respectively: 25, 21, `true`, 56, 4

### 1.2 Team Configuration

```json
{
  "name": "num-suite",
  "description": "Number-theory puzzle suite: 5 independent tasks self-claimed by 3 mathematicians",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks, claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies, then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks, claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies, then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks, claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies, then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    }
  ]
}
```

**Role Selection Rationale**: `mathematician` uses the `oct-junior` agent, capable of writing code for enumeration/verification, fully matching number-theory solving needs. Three members share the same prompt (roles are symmetric in delegate mode, differences come from the tasks claimed).

### 1.3 Master Launch Call

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "num-suite",
    "tasks": [
      {
        "ref": "p1",
        "subject": "Count primes below 100",
        "description": "Count the number of prime numbers strictly less than 100. Use the Sieve of Eratosthenes or direct trial division. Show your method briefly, then state the final count. End your report to master with a line exactly formatted: <!-- ANSWER: <your_count> -->"
      },
      {
        "ref": "p2",
        "subject": "GCD of 1071 and 462",
        "description": "Compute the greatest common divisor (GCD) of 1071 and 462 using the Euclidean algorithm. Show the successive division steps, then state the result. End your report to master with a line exactly formatted: <!-- ANSWER: <your_gcd> -->"
      },
      {
        "ref": "p3",
        "subject": "Is 997 prime?",
        "description": "Determine whether 997 is a prime number. Check divisibility by all primes up to sqrt(997) (~31.6): 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31. State the boolean result (true if prime, false otherwise). End your report to master with a line exactly formatted: <!-- ANSWER: <true_or_false> -->"
      },
      {
        "ref": "p4",
        "subject": "Sum of divisors of 28",
        "description": "Compute the sum of all positive divisors of 28 (including 1 and 28 itself). List the divisors, sum them, and report. End your report to master with a line exactly formatted: <!-- ANSWER: <your_sum> -->"
      },
      {
        "ref": "p5",
        "subject": "Modular inverse of 3 mod 11",
        "description": "Compute the modular inverse of 3 modulo 11, i.e. the integer x in {0,...,10} such that 3*x is congruent to 1 (mod 11). Report x. End your report to master with a line exactly formatted: <!-- ANSWER: <your_inverse> -->"
      }
    ],
    "timeout_ms": 900000,
    "max_errored_members": 0
  }
}
```

**Parameter Selection**:
- No `blocked_by` — five problems fully independent, any member can claim any task
- `timeout_ms: 900000` (15 min) — 5 problems / 3 members = 2 rounds, each round 3 min, normally 6-8 min to complete
- `max_errored_members: 0` — any member failure means overall failure (missing any of 5 problems means incomplete)
- No `signoff_policy` set — delegate defaults to `none`, tasks delivered directly on completion

### 1.4 Execution Flow (Timeline)

```
T+0m    master calls team_delegate, publishes 5 tasks to shared list
T+0m    OCTeam dispatches 3 mathematician members (generic self-claiming prompt)
T+0m    each member team_task_list → claims their first task (3 claimed)
T+0~3m  each member independently solves → team_send_message reports ANSWER marker → releases task
T+3m    remaining 2 tasks claimed by idle members (second round)
T+3~6m  second round solving + reporting
T+6m    all 5 problems complete, OCTeam summarizes and delivers to master
T+6m    run: bun check-math-number-theory.ts <run_dir>
```

### 1.5 Check Script

[`check-math-number-theory.ts`](./check-math-number-theory.ts)

- **Load**: `readdir(<run_dir>)` reads all `*.md` member outputs (in delegate mode it's unknown which member claimed which problem, so scan all)
- **Extract**: regex `<!--\s*ANSWER:\s*(.+?)\s*-->` global match, collect all answers
- **Assert**:
  1. At least 5 ANSWER markers after combining
  2. Expected values {25, 21, `true`, 56, 4} each appear at least once (numeric values compared via `Number()`, boolean via case-insensitive string comparison)

---

## Scenario 2: Three Classic ODE System Simulations

### 2.1 Scenario Description

**Background**: Classic ordinary differential equation systems (Lotka-Volterra predator-prey, Van der Pol limit cycle, damped oscillator) are standard teaching cases for numerical simulation. Three independent problems, each with different ODE forms, parameters, and reported quantities, naturally suited to delegate mode's parallel self-claiming.

**Goal**: Publish 3 independent ODE simulation tasks; 3 simulator members each claim one, integrate using RK4, and report key quantities.

**Success Criteria (Machine-Verifiable)**:
- Lotka-Volterra member output contains `<!-- PREY_X20: <value> -->`, x(20) ∈ [3.5, 5.5] (expected ≈ 4.5)
- Van der Pol member output contains `<!-- AMPLITUDE: <value> -->`, limit-cycle amplitude ∈ [1.8, 2.2] (expected ≈ 2.0)
- Damped oscillator member output contains `<!-- UNDERDAMPED: yes -->`

### 2.2 Team Configuration

```json
{
  "name": "ode-suite",
  "description": "Classic ODE simulation suite: 3 independent systems self-claimed by 3 simulators",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are a numerical simulator specializing in ODE integration. You work in delegate mode: use team_task_list to find available simulation tasks, claim one with team_task_update (status 'claimed'), simulate exactly as the task description specifies (use classical RK4 with the given step size), then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are a numerical simulator specializing in ODE integration. You work in delegate mode: use team_task_list to find available simulation tasks, claim one with team_task_update (status 'claimed'), simulate exactly as the task description specifies (use classical RK4 with the given step size), then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are a numerical simulator specializing in ODE integration. You work in delegate mode: use team_task_list to find available simulation tasks, claim one with team_task_update (status 'claimed'), simulate exactly as the task description specifies (use classical RK4 with the given step size), then report your result to master via team_send_message and release the task. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    }
  ]
}
```

**Role Selection Rationale**: `simulator` is designed for numerical simulation (ODE/PDE/MC/MD/HPC), fully matching the ODE integration scenario.

### 2.3 Master Launch Call

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "ode-suite",
    "tasks": [
      {
        "ref": "lv",
        "subject": "Lotka-Volterra predator-prey: final prey x(20)",
        "description": "Simulate the Lotka-Volterra predator-prey system with parameters alpha=1.1, beta=0.4, delta=0.1, gamma=0.1. The equations are dx/dt = alpha*x - beta*x*y (prey) and dy/dt = delta*x*y - gamma*y (predator). Use initial conditions x(0)=1.6, y(0)=4.8. Integrate from t=0 to t=20 with step h=0.01 using classical RK4 (2000 steps). Report the final prey population x(20). End your report to master with a line exactly formatted: <!-- PREY_X20: <your_value> -->"
      },
      {
        "ref": "vdp",
        "subject": "Van der Pol oscillator: limit-cycle amplitude",
        "description": "Simulate the Van der Pol oscillator with mu=1: d2x/dt2 - mu*(1 - x^2)*dx/dt + x = 0. Rewrite as the first-order system [dx/dt, dy/dt] = [y, mu*(1-x^2)*y - x]. Use initial conditions x(0)=1, xdot(0)=0. Integrate from t=0 to t=10 with step h=0.01 using classical RK4 (1000 steps). Report the limit-cycle amplitude, defined as max|x| over the full simulation interval. End your report to master with a line exactly formatted: <!-- AMPLITUDE: <your_value> -->"
      },
      {
        "ref": "osc",
        "subject": "Damped harmonic oscillator: is it underdamped?",
        "description": "Analyze the damped harmonic oscillator x'' + 2*gamma*x' + omega0^2*x = 0 with omega0=2 and gamma=0.5. The damping ratio is zeta = gamma/omega0. Compute zeta and classify: underdamped (zeta < 1), critically damped (zeta = 1), or overdamped (zeta > 1). Report whether the system is underdamped. End your report to master with a line exactly formatted: <!-- UNDERDAMPED: yes --> (or <!-- UNDERDAMPED: no --> if not underdamped)."
      }
    ],
    "timeout_ms": 600000,
    "max_errored_members": 0
  }
}
```

**Parameter Selection**:
- No `blocked_by` — the three ODE systems are fully independent
- `timeout_ms: 600000` (10 min) — 3 problems / 3 members = 1 round, each round 5-8 min
- `max_errored_members: 0` — any simulation failure means overall failure

### 2.4 Execution Flow (Timeline)

```
T+0m    master calls team_delegate, publishes 3 ODE tasks
T+0m    OCTeam dispatches 3 simulator members
T+0m    each member team_task_list → each claims 1 task (1:1 assignment)
T+0~6m  each member independently writes RK4 code → integrates → reports PREY_X20/AMPLITUDE/UNDERDAMPED
T+6m    all three tasks complete, summarized and delivered to master
T+6m    run: bun check-physics-ode-suite.ts <run_dir>
```

### 2.5 Check Script

[`check-physics-ode-suite.ts`](./check-physics-ode-suite.ts)

- **Load**: `readdir(<run_dir>)` reads all `*.md`, concatenates into a single blob
- **Extract**:
  - `<!--\s*PREY_X20:\s*([\d.eE+-]+)\s*-->`
  - `<!--\s*AMPLITUDE:\s*([\d.eE+-]+)\s*-->`
  - `<!--\s*UNDERDAMPED:\s*(\w+)\s*-->`
- **Assert**:
  1. All three markers exist (each appears at least once)
  2. PREY_X20 ∈ [3.5, 5.5]
  3. AMPLITUDE ∈ [1.8, 2.2]
  4. UNDERDAMPED = `yes` (case-insensitive)

---

## Scenario 3: CLI Calculator blockedBy DAG

### 3.1 Scenario Description

**Background**: Delegate mode's core differentiating capability is `blocked_by` dependencies — tasks are not claimable until their dependencies complete, forming a directed acyclic graph (DAG). A mini CLI calculator naturally has a four-step dependency chain: define the API spec first → then implement core logic and output format in parallel → finally write tests.

**Goal**: Publish 4 tasks with dependencies; 3 coder members claim, implement, and report in DAG topological order.

**Task Dependency Graph**:

```
  api (spec) ──┬──> core (calculate) ──┐
               │                        ├──> tests (4 cases)
               └──> output (format) ───┘
```

**Success Criteria (Machine-Verifiable)**:
- Combined output contains `<!-- SPEC_OK: true -->`
- Combined output contains `<!-- IMPL: calculate -->`, and the corresponding ```typescript code block can be loaded as a `calculate(op, a, b)` function
- Combined output contains `<!-- IMPL: format -->`
- Combined output contains `<!-- PASS_COUNT: 4/4 -->`
- The extracted `calculate` function passes 4 standard test cases: add(2,3)=5, sub(10,4)=6, mul(3,7)=21, div(20,4)=5

### 3.2 Team Configuration

```json
{
  "name": "cli-dag",
  "description": "CLI calculator with blockedBy DAG: spec -> core+output -> tests, self-claimed by 3 coders",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You work in delegate mode: use team_task_list to find available tasks, claim one with team_task_update (status 'claimed'), implement exactly as the task description specifies, then report your result to master via team_send_message and release the task. Tasks with unmet blocked_by dependencies are not claimable — wait for them to clear. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are a coder. You work in delegate mode: use team_task_list to find available tasks, claim one with team_task_update (status 'claimed'), implement exactly as the task description specifies, then report your result to master via team_send_message and release the task. Tasks with unmet blocked_by dependencies are not claimable — wait for them to clear. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a coder. You work in delegate mode: use team_task_list to find available tasks, claim one with team_task_update (status 'claimed'), implement exactly as the task description specifies, then report your result to master via team_send_message and release the task. Tasks with unmet blocked_by dependencies are not claimable — wait for them to clear. Each task description specifies the exact output marker your report must contain — include that marker line verbatim. Repeat until no tasks remain."
    }
  ]
}
```

**Role Selection Rationale**: `coder` uses the `oct-junior` agent, focused on implementation with minimal changes, fitting the step-by-step build requirements. Member prompts additionally emphasize blocked_by semantics — tasks with unsatisfied dependencies are not claimable.

### 3.3 Master Launch Call

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "cli-dag",
    "tasks": [
      {
        "ref": "api",
        "subject": "Define CLI argument-parsing spec",
        "description": "Define the CLI argument-parsing specification for a calculator that accepts an operator and two numeric operands. The operator must be one of {add, sub, mul, div}. The operands are real numbers (integers or decimals). Document: (1) the input format, (2) valid operators and their semantics, (3) operand constraints, (4) error behavior for unknown operator or non-numeric operands. Keep the spec concise. End your report to master with a line exactly formatted: <!-- SPEC_OK: true -->"
      },
      {
        "ref": "core",
        "subject": "Implement calculate(op, a, b) in TypeScript",
        "blocked_by": ["api"],
        "description": "Implement the core calculation function calculate(op, a, b) in TypeScript, where op is one of {add, sub, mul, div} and a, b are numbers. Returns the numeric result. For div with b === 0, throw an Error. Embed the full TypeScript code in a ```typescript fenced block. End your report to master with a line exactly formatted: <!-- IMPL: calculate -->"
      },
      {
        "ref": "output",
        "subject": "Implement result formatter in TypeScript",
        "blocked_by": ["api"],
        "description": "Implement the result formatter formatResult(a, op, b, result) in TypeScript that returns the string formatted as: a op b = result (e.g. formatResult(2, 'add', 3, 5) returns '2 add 3 = 5'). Embed the full TypeScript code in a ```typescript fenced block. End your report to master with a line exactly formatted: <!-- IMPL: format -->"
      },
      {
        "ref": "tests",
        "subject": "Write and run 4 calculator test cases",
        "blocked_by": ["core", "output"],
        "description": "Write 4 test cases for the calculator and verify they pass. The cases are: add(2, 3) = 5, sub(10, 4) = 6, mul(3, 7) = 21, div(20, 4) = 5. If the calculate implementation is available from the core task, run the 4 cases against it and report how many pass. End your report to master with a line exactly formatted: <!-- PASS_COUNT: <n>/4 -->"
      }
    ],
    "timeout_ms": 900000,
    "max_errored_members": 0
  }
}
```

**Parameter Selection**:
- `blocked_by` DAG: `api` executes first with no dependencies; `core` and `output` depend on `api` (unlocked in parallel); `tests` depends on `core` + `output` (unlocked last)
- `ref` field — `blocked_by` references via `ref` string, not array index or UUID
- `timeout_ms: 900000` (15 min) — critical path api(2m) → core/output(3m) → tests(2m) ≈ 7m, ample margin
- `max_errored_members: 0` — any node failure in a DAG blocks all successors forever, must fail overall

### 3.4 Execution Flow (Timeline)

```
T+0m    master calls team_delegate, publishes 4 tasks (api, core[blocked:api], output[blocked:api], tests[blocked:core,output])
T+0m    OCTeam dispatches 3 coder members
T+0m    only api claimable (core/output/tests blocked) → a member claims api
T+0~2m  that member defines spec → reports SPEC_OK → releases api
T+2m    api complete → core and output simultaneously unlocked
T+2m    two idle members respectively claim core and output (parallel)
T+2~5m  core (calculate) + output (format) implemented in parallel → each reports IMPL marker
T+5m    core + output both complete → tests unlocked
T+5m    a member claims tests → runs 4 test cases → reports PASS_COUNT
T+7m    all 4 tasks complete, summarized and delivered to master
T+7m    run: bun check-coding-cli-calc.ts <run_dir>
```

### 3.5 Check Script

[`check-coding-cli-calc.ts`](./check-coding-cli-calc.ts)

- **Load**: `readdir(<run_dir>)` reads all `*.md`, concatenates into a blob for marker scanning; also retains a per-file map for locating code blocks
- **Extract**:
  - Markers: `SPEC_OK_RE`, `IMPL_CALC_RE`, `IMPL_FORMAT_RE`, `PASS_COUNT_RE`
  - Code: in the file containing the `IMPL: calculate` marker, grab the ` ```typescript ... ``` ` code block
- **Assert**:
  1. `SPEC_OK: true` exists
  2. `IMPL: calculate` marker exists, and the same file has a loadable `calculate` function
  3. `IMPL: format` marker exists
  4. `PASS_COUNT: 4/4` (numerator must be 4)
  5. The loaded `calculate` function passes 4 standard test cases (add/sub/mul/div)

---

## Scenario 4: 100 Programmatic Number-Theory Problems (Challenge-Level)

### 4.1 Scenario Description

**Background**: The first 3 scenarios validated delegate mode's basic capabilities (parallel self-claiming, ODE simulation, blockedBy DAG). This **challenge-level** scenario pushes scale to the limit — **100 programmatically verifiable number-theory problems, 8 mathematician members self-claiming in parallel**, deliberately breaking baseline constraints (≤ 4 members / ≤ 30 min). Each problem asks for a deterministic integer-valued function of its index n, with answers strictly verifiable by an independent script (Sieve of Eratosthenes / divisor sum / modPow / Euler totient sieve). **Scale is the core of this scenario**: 100 tasks / 8 members = average 12.5 problems per person, testing delegate mode's stability and task distribution fairness under high-concurrency self-claiming — dependencies are deliberately omitted, emphasizing throughput over topology.

**Goal**: Publish 100 **fully independent** number-theory tasks to the shared list; 8 mathematician members self-claim, solve, and report `<!-- ANSWER_<n>: <value> -->` markers.

**Problem families (4 families × 25 problems = 100, ref scheme `p1`..`p100`)**:

| Family | Refs | Problem | Expected Example |
|--------|------|------|---------|
| A. Prime count π | `p1`..`p25` | π(10·k), k=1..25 → π(10), π(20), …, π(250) | π(10)=4, π(100)=25 |
| B. Divisor sum σ | `p26`..`p50` | σ(n), n=101..125 | σ(101)=102 (prime), σ(125)=156 |
| C. Modular exponentiation | `p51`..`p75` | 2^n mod (10⁹+7), n=51..75 (base=2, exponent=problem number, modulus=1_000_000_007) | 2⁵¹ mod (10⁹+7)=797922655 |
| D. Euler totient φ | `p76`..`p100` | φ(n), n=201..225 | φ(201)=132, φ(225)=120 |

**Success Criteria (Machine-Verifiable)**: Out of 100 problems, **≥ 95** have `<!-- ANSWER_<n>: <value> -->` markers matching independently computed ground truth (tolerating a few flaky claims / individual member dropouts).

### 4.2 Team Configuration

```json
{
  "name": "num-theory-100",
  "description": "Challenge-level: 100 programmatically-verifiable number-theory problems self-claimed by 8 mathematicians",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "frank",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "grace",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    },
    {
      "name": "henry",
      "role": "mathematician",
      "prompt": "You are a mathematician. You work in delegate mode: use team_task_list to find available number-theory tasks (refs p1..p100), claim one with team_task_update (status 'claimed'), solve it exactly as the task description specifies — write and run code (Sieve of Eratosthenes for prime-count, trial division for divisor sum, BigInt modPow for modular exponent, totient sieve for Euler phi — whatever the problem family requires), then report your result to master via team_send_message and release the task. Each task description names its problem index n and requires your report to end with a line exactly formatted: <!-- ANSWER_<n>: <integer_value> -->. Repeat until no tasks remain."
    }
  ]
}
```

**Role Selection Rationale**: `mathematician` uses the `oct-junior` agent, capable of writing code for enumeration/verification, fully matching number-theory solving needs. Eight members share the same prompt (roles are symmetric in delegate mode, differences come from the tasks claimed) — deliberately symmetric to isolate "concurrent self-claiming" as the variable under test.

**Rationale for member count = 8 (breaking ≤ 4 baseline)**: The challenge-level scenario's core is scale stress-testing. 100 tasks need enough parallel slots to complete in reasonable time (100/8 ≈ 13 rounds vs 100/4 = 25 rounds), and 8-way concurrency is sufficient to expose task distribution contention (multiple members simultaneously team_task_list / claim the same task).

### 4.3 Master Launch Call

The `tasks` array contains **100 entries** (ref `p1`..`p100`, no `blocked_by`). Below are the 4 family templates with one concrete example each — the full 100 are generated following the same pattern.

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "num-theory-100",
    "tasks": [
      {
        "ref": "p1",
        "subject": "π(10) — count primes ≤ 10",
        "description": "Compute π(10), the count of prime numbers ≤ 10 (primes: 2,3,5,7 → expected 4). Use the Sieve of Eratosthenes. End your report to master with a line exactly formatted: <!-- ANSWER_1: <integer_value> -->"
      },

      {
        "ref": "p26",
        "subject": "σ(101) — sum of divisors of 101",
        "description": "Compute σ(101), the sum of all positive divisors of 101 (including 1 and 101; 101 is prime → expected 102). End your report to master with a line exactly formatted: <!-- ANSWER_26: <integer_value> -->"
      },

      {
        "ref": "p51",
        "subject": "2^51 mod (10^9+7)",
        "description": "Compute 2^51 mod 1000000007 using fast modular exponentiation (BigInt modPow). Report the integer in [0, 10^9+6]. End your report to master with a line exactly formatted: <!-- ANSWER_51: <integer_value> -->"
      },

      {
        "ref": "p76",
        "subject": "φ(201) — Euler totient of 201",
        "description": "Compute φ(201), Euler's totient: count of k in {1..201} with gcd(k,201)=1 (201=3·67 → expected 132). End your report to master with a line exactly formatted: <!-- ANSWER_76: <integer_value> -->"
      }
    ],
    "timeout_ms": 5400000,
    "max_errored_members": 1
  }
}
```

**Ref scheme (generation rules for the full 100 entries; master expands per schema)**:

| Ref | Problem | Description Template (substitute `<n>` / `<arg>`) |
|-----|------|------------------------------------------|
| `p<k>`, k=1..25 | π(10·k) | `Compute π(<10·k>), the count of primes ≤ <10·k>. Use the Sieve of Eratosthenes. End your report to master with a line exactly formatted: <!-- ANSWER_<k>: <integer_value> -->` |
| `p<k>`, k=26..50 | σ(k+75), i.e. σ(101)..σ(125) | `Compute σ(<k+75>), the sum of all positive divisors of <k+75> (including 1 and itself). End your report to master with a line exactly formatted: <!-- ANSWER_<k>: <integer_value> -->` |
| `p<k>`, k=51..75 | 2^k mod (10⁹+7) | `Compute 2^<k> mod 1000000007 using fast modular exponentiation. Report the integer in [0, 10^9+6]. End your report to master with a line exactly formatted: <!-- ANSWER_<k>: <integer_value> -->` |
| `p<k>`, k=76..100 | φ(k+125), i.e. φ(201)..φ(225) | `Compute φ(<k+125>), Euler's totient of <k+125> (count of k in {1..<k+125>} coprime to it). End your report to master with a line exactly formatted: <!-- ANSWER_<k>: <integer_value> -->` |

**Parameter Selection**:
- **No `blocked_by`** — 100 problems fully independent, deliberately emphasizing scale over dependencies (dependency stress-testing is in scenario 3)
- `timeout_ms: 5400000` (90 min) — 100 problems / 8 members ≈ 13 rounds × ~6 min/round
- `max_errored_members: 1` — allows 1 of 8 members to fail (remaining 7 can still cover 100 problems, average ~14.3 per person), paired with ≥ 95/100 evaluation threshold
- No `signoff_policy` set — delegate defaults to `none`, tasks delivered directly on completion

### 4.4 Execution Flow (Timeline)

```
T+0m     master calls team_delegate, publishes 100 tasks to shared list (all with no blocked_by)
T+0m     OCTeam dispatches 8 mathematician members
T+0m     8 members concurrently team_task_list → each claims 1 task (8 claimed simultaneously, testing claim contention)
T+0~6m   first round: 8 problems solved in parallel (sieve/divisor sum/modPow/totient) → each reports ANSWER_n → releases task
T+6m     8 members return to tasklist, continue claiming next batch (second round)
...
T+~75m   100/8 ≈ 13 rounds, average ~6 min/round → approximately 75-90 min for all (individual members may be slightly slower)
T+90m    master receives summarized delivery
T+90m    run: bun demos/05-team-delegate/check-math-100-problems.ts <run_dir>
```

### 4.5 Check Script

[`check-math-100-problems.ts`](./check-math-100-problems.ts)

- **Load**: `readdir(<run_dir>)` reads all 8 `*.md` member outputs (in delegate mode it's unknown which member claimed which problem, so scan all)
- **Extract**: regex `<!--\s*ANSWER_(\d+):\s*(\d+)\s*-->` global match, build `Map<problem number 1..100, bigint>` (duplicate problem numbers take the first; out-of-range 1..100 is skipped)
- **Ground truth (independently computed by script, 4 helpers)**:
  1. `sievePrimes(N)` + `primeCount(N)` — Sieve of Eratosthenes → π(10·k), k=1..25
  2. `sumOfDivisors(n)` — O(√n) trial division → σ(n), n=101..125
  3. `modPow(base, exp, mod)` — BigInt fast modular exponentiation → 2^k mod (10⁹+7), k=51..75
  4. `totientSieve(N)` — Euler totient sieve (linear: for each prime p, subtract ⌊φ/p⌋ from all multiples) → φ(n), n=201..225
- **Assert**: Out of 100 problems, the count where `reported[n] === expected[n]` is **≥ 95**; output per-family hit rate (pi/sigma/modpow/phi) and overall, print first 8 misses when failing

---

## Acceptance Checklist

- [ ] 4 check scripts pass `bunx tsc -p demos/tsconfig.json` (no type errors)
- [ ] Each team config role is valid (`mathematician` / `simulator` / `coder` are all presets)
- [ ] Each master call parameters conform to `team_delegate` schema (`tasks[]` includes `ref`/`subject`/`description`/`blocked_by`)
- [ ] `blocked_by` referenced `ref` values are all declared within the same `tasks` array, no cycles
- [ ] Scenarios 1-3 total duration ≤ 15 min (well under 30 min ceiling); **Scenario 4 challenge-level ~90 min, 8 members, deliberately stress-testing scale (the sole exception to baseline constraints)**
- [ ] Member prompts explicitly specify self-claiming workflow + output format conventions; check script markers aligned with task descriptions

---

## Quick-Start Prompt (Copy and Use)

> Paste any of the following prompts to a master session, and the AI will automatically complete the full closed loop. In delegate mode, members **self-claim** tasks (do not directly receive task text); each member reports results via `team_send_message` back to master; the run_dir contains each member's .md with their claimed task reports.

### Scenario 1: 5 Number-Theory Problems (Math)

```text
执行 demos/05-team-delegate/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_delegate JSON 启动编排（5 个独立任务发布到 tasklist）
4. team_results 轮询至 master 收到汇总（成员自取自报，无任务即停）
5. 定位 <run_dir>（含各成员 .md，ANSWER marker 分布其中）
6. 运行：bun demos/05-team-delegate/check-math-number-theory.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：5 个 ANSWER marker 全对（25, 21, true, 56, 4）。
```

### Scenario 2: 3 Classic ODE Short Simulations (Physics)

```text
执行 demos/05-team-delegate/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_delegate JSON 启动编排（3 个独立 ODE 任务）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun demos/05-team-delegate/check-physics-ode-suite.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：3 个结果 marker 落在预期范围（Lotka-Volterra prey(20)≈4.5；Van der Pol 振幅≈2.0；阻尼振荡 underdamped=yes）。
```

### Scenario 3: Mini CLI Calculator (Programming, blockedBy DAG)

```text
执行 demos/05-team-delegate/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_delegate JSON 启动编排（4 个任务含 blockedBy 依赖：api → core/output → tests）
4. team_results 轮询至 master 收到汇总（依赖解锁后下游任务才可被认领）
5. 定位 <run_dir>
6. 运行：bun demos/05-team-delegate/check-coding-cli-calc.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：4 个 marker 齐全（SPEC_OK=true、IMPL: calculate、IMPL: format、PASS_COUNT=4/4），且 calculate 通过 4 用例（2+3=5、10-4=6、3*7=21、20/4=5）。
```

### Scenario 4: 100 Programmatic Number-Theory Problems (Challenge-Level, 8 Members)

```text
执行 demos/05-team-delegate/README.md「场景 4」的完整闭环并自动评判。注意：此为挑战级场景，预计 ~90 min、8 成员并发。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（8 个 mathematician 成员 alice..henry，含 erin）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」+ Ref scheme 表，按 team_delegate JSON 启动编排：tasks[] 需展开为 100 条（p1..p100），按 4 个 family 模板生成（π(10·k) / σ(101..125) / 2^k mod 1e9+7 / φ(201..225)），全部无 blocked_by
4. team_results 轮询至 master 收到汇总（成员自取自报，无任务即停；100 题 / 8 成员 ≈ 13 轮）
5. 定位 <run_dir>（含 8 个成员 .md，ANSWER_n marker 分布其中）
6. 运行：bun demos/05-team-delegate/check-math-100-problems.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：100 题 ≥ 95 答案正确（脚本独立用筛法/除数和/modPow/totient 算 ground truth，容忍少量 flaky claim）。
```
