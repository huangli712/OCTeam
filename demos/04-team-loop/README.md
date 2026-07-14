# team_loop Orchestration Scenario Design

> **Pattern**: `team_loop` — Runs a corrective loop `code → review → decide → repeat`. Each round the stage members produce output in sequence, the `decider` (a member, not master) emits `<decision>{"decision":"done"|"continue",...}</decision>`; stops when the `decider` says `done`, reaches `max_rounds`, times out, or has 3 consecutive parse failures.
> **Source**: [`src/tools/loop.ts`](../../src/tools/loop.ts) (`teamLoopTool`)
> **Timing Design**: 3 members (2 stage + 1 decider), `max_rounds=3`; typically converges in 1-2 rounds, each stage per round ≤ 5 min, total duration ≈ 10-15 min (well under 30 min ceiling).

## Scenario Overview

| # | Domain | Scenario | Members | Role | Key Param | Estimated Duration |
|---|------|------|--------|------|-----------|-----------|
| 1 | Math | Bisection root-finding boundary bug fix | 3 | `coder` / `tester` / `reviewer` | `max_rounds=3` | ~12 min |
| 2 | Computational Physics | Spring-mass energy drift debugging | 3 | `simulator` / `analyst` / `reviewer` | `max_rounds=3` | ~13 min |
| 3 | Programming | Interval merge off-by-one fix | 3 | `coder` / `tester` / `reviewer` | `max_rounds=3` | ~10 min |
| 4 | Programming | Lock-free Queue four-class concurrency bug fix (Challenge-level) | 7 | `coder` ×4 / `tester` ×2 / `reviewer` | `max_rounds=5` | ~60 min |

---

## Scenario 1: Bisection Root-Finding Boundary Bug Fix

### 1.1 Scenario Description

**Background**: Bisection is a classic robust method for finding single roots of continuous functions, but its correctness strongly depends on three preconditions: valid inputs (non-NaN), opposite signs at interval endpoints (ensuring a root exists), and convergence criteria based on bracket half-width rather than function residual (otherwise it returns prematurely on flat functions). The following initial implementation violates all three:

```typescript
// Buggy bisection — three latent defects (A/B/C).
function bisect(f: (x: number) => number, a: number, b: number, tol: number, maxIter: number): number {
    let lo = a, hi = b;
    for (let i = 0; i < maxIter; i++) {
        const mid = (lo + hi) / 2;
        const fmid = f(mid);
        // (C) BUG: terminates on residual |f(mid)|, not bracket half-width (hi-lo)/2.
        if (Math.abs(fmid) < tol) return mid;
        // (B) BUG: no validation that f(lo), f(hi) actually bracket a root.
        if (fmid * f(lo) < 0) hi = mid; else lo = mid;
        // (A) BUG: NaN in a/b/f propagates silently (no guard).
    }
    return (lo + hi) / 2;
}
```

**Goal**: `alice` minimally fixes the three defects; `bob` runs the edge-case suite (NaN, same-sign interval, flat-function threshold); `carol` reviews and decides whether to converge.

**Success Criteria (Machine-Verifiable)**:
- `alice` output ends with `<!-- FIXES: <count> -->`
- `bob` output ends with `<!-- FAILING: <count> -->`
- `carol`'s final `<decision>` JSON contains `"decision": "done"` and `"testsPass": true`

### 1.2 Team Configuration

```json
{
  "name": "bisection-loop",
  "description": "Bisection root-finder: coder fixes 3 edge-case bugs, tester runs the edge suite, reviewer decides convergence.",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You fix the bisection() function minimally. Three defects to address: (A) no NaN guard on a/b/f outputs, (B) no sign-change (bracket) validation at start, (C) convergence checks the residual |f(mid)| instead of the bracket half-width (hi-lo)/2. Make the MINIMAL change: throw a descriptive Error on NaN inputs or when f(a)*f(b) >= 0 (no bracket), and terminate when (hi-lo)/2 < tol. Embed the full corrected TypeScript function in a single ```typescript fenced block with signature `function bisect(f, a, b, tol, maxIter)`. Count only the distinct bugs you fixed. Your output MUST end with a line exactly formatted: <!-- FIXES: <count> -->"
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You run the edge-case suite against the coder's CURRENT bisect() implementation (read coder.md, extract the ```typescript block). Report exactly three cases: (1) NaN input -> bisect(f, NaN, 2, 1e-6, 100) for f=x*x-2 MUST throw; (2) same-sign interval -> bisect(f, 0, 1, 1e-6, 100) for f=x*x+1 (always positive) MUST throw; (3) flat-function threshold -> bisect(f, 0, 1, 1e-9, 100) for f=(x-0.5)^3 MUST return within 1e-6 of 0.5 (bracket-width convergence, not residual). For each case state PASS/FAIL with a one-line reason. Count how many FAIL. Your output MUST end with a line exactly formatted: <!-- FAILING: <count> -->"
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are the loop DECIDER. Read coder.md (the fix + FIXES count) and tester.md (the FAILING count + per-case reasons). Decide whether the bisection routine is correct: 'done' only when tester reports 0 failing cases AND coder's fix is minimal/non-degenerate; otherwise 'continue' with concrete nextActions for the coder. In EVERY <decision> block you emit, include the standard fields (decision, rationale, nextActions) PLUS the additional boolean field \"testsPass\": true|false reflecting whether the tester reported 0 failing cases. The literal English tags <decision> and </decision> are required."
    }
  ]
}
```

**Role Selection Rationale**: `coder` (`oct-junior` agent, can modify code), `tester` (read-only review/run), `reviewer` (default read-only, suitable as decider) — the three responsibilities naturally align with `team_loop`'s `modify` / `read_only` / `read_only` three stages.

### 1.3 Master Launch Call

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "bisection-loop",
    "stages": [
      { "member": "alice", "task": "Fix the three bisection defects minimally. Emit the corrected function and the FIXES marker.", "action": "modify" },
      { "member": "bob", "task": "Run the three edge cases against the coder's current bisect() and report the FAILING count.", "action": "read_only" }
    ],
      "decider": "carol",
    "max_rounds": 3,
    "initial_task": "Here is the BUGGY bisection to fix (three defects: A no-NaN-guard, B no-bracket-validation, C residual-based convergence). Fix all three minimally.\n\n```typescript\nfunction bisect(f: (x: number) => number, a: number, b: number, tol: number, maxIter: number): number {\n    let lo = a, hi = b;\n    for (let i = 0; i < maxIter; i++) {\n        const mid = (lo + hi) / 2;\n        const fmid = f(mid);\n        if (Math.abs(fmid) < tol) return mid;\n        if (fmid * f(lo) < 0) hi = mid; else lo = mid;\n    }\n    return (lo + hi) / 2;\n}\n```\n\nRequirements: throw on NaN a/b/f outputs; throw when f(a)*f(b) >= 0 (no bracket); terminate on (hi-lo)/2 < tol. Keep the signature. End with <!-- FIXES: <count> -->."
  }
}
```

**Parameter Selection**:
- `stages` only lists `alice` (`modify`) and `bob` (`read_only`) — the `decider` is not in stages; OCTeam auto-appends it as the final `read_only` stage (source: `loop.ts` buildTask branch).
- `decider: "carol"` — member name, not master (schema enforced).
- `max_rounds: 3` — typically converges in 1 round; 3-round cap as safety for occasional regression.
- `initial_task` — contains the full buggy code, dispatched to stages[0] (alice) for round 1.
- Stage member names unique (`alice` / `bob`), conforming to schema validation.

### 1.4 Execution Flow (Timeline)

```
T+0m     master calls team_loop; round 1 starts
T+0m     alice (modify) receives initial_task -> fixes three defects -> writes alice.md + FIXES marker
T+3m     bob (read_only) reads alice.md -> runs 3 edge cases -> writes bob.md + FAILING marker
T+5m     carol (decider, read_only) reads alice+bob -> emits <decision>
         if testsPass=true -> decision="done" -> loop ends (typical path)
         if testsPass=false -> decision="continue" -> round 2 redispatches alice
T+5~12m  at most 3 rounds; done or max_rounds triggers stop
T+12m    run: bun check-math-bisection-fix.ts <run_dir>
```

### 1.5 Check Script

[`check-math-bisection-fix.ts`](./check-math-bisection-fix.ts)

- **Load**: `runs/<run_id>/carol.md` (decider), with `alice.md` / `bob.md` for diagnostics
- **Extract**: regex `<decision>([\s\S]*?)</decision>` take the last occurrence (final round), `JSON.parse`
- **Assert**:
  1. `decision.decision === "done"`
  2. `decision.testsPass === true` (boolean exists and is true)

---

## Scenario 2: Spring-Mass Energy Drift Debugging

### 2.1 Scenario Description

**Background**: The undamped spring-mass system (`k=1, m=1`, i.e. `ẍ = -x`, angular frequency ω=1) should strictly conserve energy `E = ½(x² + ẋ²)`. Initial conditions `x0=1, v0=0`, so `E0 = 0.5`. **Explicit Euler** integration has a one-step amplification matrix `[[1,h],[-h,1]]` whose eigenvalue modulus is `√(1+h²) > 1`, causing energy to diverge monotonically — at `h=0.05`, 1000 steps, energy amplifies ~12× (relative drift ~1100%, well beyond acceptable range). **Velocity Verlet** is a symplectic integrator, energy oscillates bounded, drift ≪ 1e-3.

```typescript
// Buggy integrator: EXPLICIT (forward) Euler on the spring-mass system.
// k=1, m=1, x0=1, v0=0, h=0.05, 1000 steps. Energy drifts severely (~12x growth).
function simulate(h: number, steps: number): { x: number; v: number } {
    let x = 1, v = 0;
    const omega2 = 1; // k/m
    for (let i = 0; i < steps; i++) {
        const a = -omega2 * x;   // acceleration from CURRENT x
        x = x + h * v;           // Euler update of position
        v = v + h * a;           // Euler update of velocity (explicit)
    }
    return { x, v };
}
// E = 0.5*(x*x + v*v); E0 = 0.5; relative drift = |E_end - E0|/E0.
```

**Goal**: `alice` replaces explicit Euler with Velocity Verlet (minimal change); `bob` computes the relative energy drift before and after the fix; `carol` reviews and decides.

**Success Criteria (Machine-Verifiable)**:
- `alice` output ends with `<!-- INTEGRATOR: <name> -->` (should be Velocity Verlet)
- `bob` output ends with `<!-- DRIFT_AFTER: <number> -->` (and contains `<!-- DRIFT_BEFORE: <number> -->`)
- `carol`'s final `<decision>` JSON contains `"decision": "done"` and `"driftAcceptable": true`
- `bob`'s `DRIFT_AFTER < 1e-3` (symplectic integrator threshold)

### 2.2 Team Configuration

```json
{
  "name": "spring-loop",
  "description": "Spring-mass (k=m=1) energy drift: simulator swaps explicit Euler for Velocity Verlet, analyst measures drift before/after, reviewer decides.",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You replace the BUGGY explicit-Euler integrator with VELOCITY VERLET for the spring-mass system (k=1, m=1, omega^2=1). Same params: x0=1, v0=0, h=0.05, exactly 1000 steps. Velocity Verlet update per step: a_n = -omega2*x_n; v_{n+1/2} = v_n + 0.5*h*a_n; x_{n+1} = x_n + h*v_{n+1/2}; a_{n+1} = -omega2*x_{n+1}; v_{n+1} = v_{n+1/2} + 0.5*h*a_{n+1}. Make the MINIMAL change to the simulate() function (keep signature `function simulate(h, steps)` returning {x,v}). Embed the full corrected TypeScript in a single ```typescript fenced block. Name the integrator. Your output MUST end with a line exactly formatted: <!-- INTEGRATOR: <name> -->"
    },
    {
      "name": "bob",
      "role": "analyst",
      "prompt": "You compute the relative energy drift |E_end - E0|/E0 where E = 0.5*(x^2 + v^2), E0 = 0.5 (x0=1, v0=0), for BOTH integrators at h=0.05, 1000 steps: (1) the BUGGY explicit Euler from the initial_task, (2) the simulator's CURRENT Velocity Verlet from simulator.md (extract the ```typescript block, run both). Report both numbers. Your output MUST contain a line exactly formatted: <!-- DRIFT_BEFORE: <numeric_drift_euler> --> AND MUST end with a line exactly formatted: <!-- DRIFT_AFTER: <numeric_drift_verlet> -->"
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are the loop DECIDER. Read simulator.md (integrator name) and analyst.md (DRIFT_BEFORE and DRIFT_AFTER). Decide whether the energy drift is acceptable: 'done' only when the simulator used Velocity Verlet AND DRIFT_AFTER < 1e-3; otherwise 'continue' with concrete nextActions. In EVERY <decision> block you emit, include the standard fields (decision, rationale, nextActions) PLUS the additional boolean field \"driftAcceptable\": true|false reflecting whether DRIFT_AFTER < 1e-3. The literal English tags <decision> and </decision> are required."
    }
  ]
}
```

**Role Selection Rationale**: `simulator` (numerical simulation specialist), `analyst` (read-only data measurement), `reviewer` (decider) — aligned with `modify` / `read_only` / `read_only` stages.

### 2.3 Master Launch Call

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "spring-loop",
    "stages": [
      { "member": "alice", "task": "Replace explicit Euler with Velocity Verlet. Emit the corrected simulate() and the INTEGRATOR marker.", "action": "modify" },
      { "member": "bob", "task": "Measure relative energy drift before (Euler) and after (Verlet) at h=0.05, 1000 steps. Emit DRIFT_BEFORE and DRIFT_AFTER markers.", "action": "read_only" }
    ],
      "decider": "carol",
    "max_rounds": 3,
    "initial_task": "Here is the BUGGY explicit-Euler integrator for the spring-mass system (k=1, m=1). Energy drifts severely (~12x growth over 1000 steps at h=0.05). Replace it with VELOCITY VERLET (minimal change).\n\n```typescript\nfunction simulate(h: number, steps: number): { x: number; v: number } {\n    let x = 1, v = 0;\n    const omega2 = 1;\n    for (let i = 0; i < steps; i++) {\n        const a = -omega2 * x;\n        x = x + h * v;\n        v = v + h * a;\n    }\n    return { x, v };\n}\n```\n\nRequirements: keep signature `function simulate(h, steps)`; use the velocity-Verlet update; exactly 1000 steps; x0=1, v0=0. End with <!-- INTEGRATOR: <name> -->."
  }
}
```

**Parameter Selection**:
- `stages` only lists `alice` (`modify`) and `bob` (`read_only`); `decider` auto-appended.
- `max_rounds: 3` — Verlet replacement typically qualifies in one round; margin as safety.
- `initial_task` embeds full Euler code + physical parameters, ensuring `alice` and `bob` reference the same baseline.

### 2.4 Execution Flow (Timeline)

```
T+0m     master calls team_loop; round 1 starts
T+0m     alice (modify) receives initial_task -> rewrites to Velocity Verlet -> alice.md + INTEGRATOR
T+4m     bob (read_only) reads alice.md -> runs Euler and Verlet each 1000 steps -> bob.md + DRIFT_BEFORE/AFTER
T+7m     carol (decider) reads both outputs -> emits <decision>
         if driftAcceptable=true -> decision="done" (typical path)
         otherwise -> decision="continue" -> round 2
T+7~13m  at most 3 rounds
T+13m    run: bun check-physics-spring-energy.ts <run_dir>
```

### 2.5 Check Script

[`check-physics-spring-energy.ts`](./check-physics-spring-energy.ts)

- **Load**: `runs/<run_id>/carol.md` (decider) and `bob.md` (cross-verification), with `alice.md` for diagnostics
- **Extract**:
  - decider: regex `<decision>([\s\S]*?)</decision>` take the last occurrence, `JSON.parse`
  - bob: regex `<!-- DRIFT_BEFORE:\s*([\d.eE+-]+)\s*-->` and `<!-- DRIFT_AFTER:\s*([\d.eE+-]+)\s*-->`
- **Assert**:
  1. `bob` `DRIFT_AFTER < DRIFT_BEFORE` (fix indeed reduces drift)
  2. `bob` `DRIFT_AFTER < 1e-3` (symplectic integrator threshold)
  3. `decision.decision === "done"`
  4. `decision.driftAcceptable === true`

---

## Scenario 3: Interval Merge Off-by-One Fix

### 3.1 Scenario Description

**Background**: Merging overlapping/adjacent intervals is a primitive in scheduling, genomics, typesetting, and other domains. The standard implementation sorts by start first, then merges sequentially: merge when the current interval's start ≤ the last merged interval's end. The following implementation mistakenly writes `<=` as `<`, causing **exactly adjacent** intervals (e.g. `[[1,3],[3,5]]`, which should merge to `[[1,5]]`) to be incorrectly kept as two intervals — a classic off-by-one.

```typescript
// Buggy interval merge — off-by-one in the overlap test.
function mergeIntervals(intervals: number[][]): number[][] {
    if (intervals.length === 0) return [];
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        const cur = sorted[i];
        if (cur[0] < last[1]) {        // BUG: should be <= (touching intervals merge)
            last[1] = Math.max(last[1], cur[1]);
        } else {
            merged.push(cur);
        }
    }
    return merged;
}
```

**Goal**: `alice` minimally fixes (`<` → `<=`); `bob` runs a hidden 5-case suite (including the touching-interval critical case); `carol` reviews and decides.

**Success Criteria (Machine-Verifiable)**:
- `alice` output ends with `<!-- BUGFIX: <one-line-description> -->`
- `bob` output ends with `<!-- PASS_COUNT: <n>/5 -->`
- `carol`'s final `<decision>` JSON contains `"decision": "done"` and `"allPass": true`

### 3.2 Team Configuration

```json
{
  "name": "interval-loop",
  "description": "Interval merge off-by-one: coder fixes the <= vs < bug, tester runs the hidden 5-case suite, reviewer decides.",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You fix the off-by-one in mergeIntervals() minimally: the overlap test `cur[0] < last[1]` must become `cur[0] <= last[1]` so that touching intervals (e.g. [[1,3],[3,5]]) merge. Change ONLY that comparison; do not refactor anything else. Embed the full corrected TypeScript function in a single ```typescript fenced block with signature `function mergeIntervals(intervals)`. Write a one-line description of the fix. Your output MUST end with a line exactly formatted: <!-- BUGFIX: <one-line-description> -->"
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You run the hidden 5-case suite against the coder's CURRENT mergeIntervals() (read coder.md, extract the ```typescript block). The cases (input -> expected): (1) [[1,3],[2,6],[8,10],[15,18]] -> [[1,6],[8,10],[15,18]]; (2) [[1,4],[4,5]] -> [[1,5]] (TOUCHING, must merge — the regression case); (3) [[1,4],[0,4]] -> [[0,4]] (unsorted input); (4) [] -> []; (5) [[1,5]] -> [[1,5]]. Deep-equal each actual vs expected. Count how many pass. Your output MUST end with a line exactly formatted: <!-- PASS_COUNT: <n>/5 -->"
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are the loop DECIDER. Read coder.md (the BUGFIX description) and tester.md (the PASS_COUNT and per-case results). Decide whether the fix is correct: 'done' only when tester reports 5/5 pass AND the fix is the minimal <= change (not a refactor); otherwise 'continue' with concrete nextActions. In EVERY <decision> block you emit, include the standard fields (decision, rationale, nextActions) PLUS the additional boolean field \"allPass\": true|false reflecting whether the tester reported 5/5. The literal English tags <decision> and </decision> are required."
    }
  ]
}
```

**Role Selection Rationale**: `coder` (minimal fix), `tester` (hidden tests read-only run), `reviewer` (decider) — three-stage mapping is clear.

### 3.3 Master Launch Call

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "interval-loop",
    "stages": [
      { "member": "alice", "task": "Fix the off-by-one in mergeIntervals minimally. Emit the corrected function and the BUGFIX marker.", "action": "modify" },
      { "member": "bob", "task": "Run the hidden 5-case suite against the coder's current mergeIntervals() and report PASS_COUNT.", "action": "read_only" }
    ],
      "decider": "carol",
    "max_rounds": 3,
    "initial_task": "Here is the BUGGY mergeIntervals with an off-by-one in the overlap test (`<` should be `<=`; touching intervals must merge). Fix it minimally.\n\n```typescript\nfunction mergeIntervals(intervals: number[][]): number[][] {\n    if (intervals.length === 0) return [];\n    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);\n    const merged: number[][] = [sorted[0]];\n    for (let i = 1; i < sorted.length; i++) {\n        const last = merged[merged.length - 1];\n        const cur = sorted[i];\n        if (cur[0] < last[1]) {\n            last[1] = Math.max(last[1], cur[1]);\n        } else {\n            merged.push(cur);\n        }\n    }\n    return merged;\n}\n```\n\nRequirement: change ONLY the `<` to `<=` on the overlap test; keep the signature. End with <!-- BUGFIX: <one-line-description> -->."
  }
}
```

**Parameter Selection**:
- `stages` only lists `alice` (`modify`) and `bob` (`read_only`); `decider` auto-appended.
- `max_rounds: 3` — single-character fix typically passes 5/5 in one round; margin for occasional typos.
- `initial_task` embeds full buggy code and explicitly notes `<` → `<=`, constraining `alice` to make minimal change.

### 3.4 Execution Flow (Timeline)

```
T+0m     master calls team_loop; round 1 starts
T+0m     alice (modify) receives initial_task -> changes < to <= -> alice.md + BUGFIX
T+2m     bob (read_only) reads alice.md -> runs 5 cases (including touching-interval critical case) -> bob.md + PASS_COUNT
T+4m     carol (decider) reads both outputs -> emits <decision>
         if allPass=true -> decision="done" (typical path)
         otherwise -> decision="continue" -> round 2
T+4~10m  at most 3 rounds
T+10m    run: bun check-coding-interval-merge.ts <run_dir>
```

### 3.5 Check Script

[`check-coding-interval-merge.ts`](./check-coding-interval-merge.ts)

- **Load**: `runs/<run_id>/carol.md` (decider), with `alice.md` / `bob.md` for diagnostics
- **Extract**: regex `<decision>([\s\S]*?)</decision>` take the last occurrence (final round), `JSON.parse`
- **Assert**:
  1. `decision.decision === "done"`
  2. `decision.allPass === true` (boolean exists and is true)

---

## Scenario 4: Lock-free Queue Four-Class Concurrency Bug Fix (Challenge-Level)

### 4.1 Scenario Description

**Background**: The Michael-Scott style lock-free MPSC (multiple-producer single-consumer) queue is a classic concurrency primitive test case. The following TypeScript pedagogical implementation uses `AtomicRef` (with version `tag`) to simulate atomic semantics of real runtimes (`Atomics` over `SharedArrayBuffer`), **embedding four mutually independent bug classes**:

- **(A) ABA on head pointer**: `AtomicRef.cas()` compares only `ref` identity, ignoring the version `tag` — a recycled sentinel object can cause CAS to spuriously succeed, corrupting the queue.
- **(B) missing acquire-load on tail->next**: `dequeue()` reads the producer-published `sentinel.next` without an acquire barrier, potentially seeing `next` set but node fields as stale values (reordering/torn reads).
- **(C) empty-queue spin does not yield**: When the queue is empty, `while (sentinel.next === null)` busy-waits without yielding, starving the event loop and blocking producer progress.
- **(D) dequeue returns success on null sentinel**: When popping a sentinel with `value === null`, it still returns `{ ok: true, value: null }`, misreporting an empty queue as success.

```typescript
// Buggy Michael-Scott-style MPSC lock-free queue.
// FOUR distinct bug classes are present (A/B/C/D); each coder fixes exactly ONE.
// Pedagogical TS model: the atomic substrate is a hand-rolled AtomicRef.

interface Node<T> {
    value: T | null;        // null marks the sentinel node
    next: Node<T> | null;   // producer publishes, consumer observes
}

class AtomicRef<T> {
    private ref: T | null;
    private tag: number;
    constructor(initial: T | null) {
        this.ref = initial;
        this.tag = 0;
    }
    load(): T | null {
        return this.ref;
    }
    store(v: T | null): void {
        this.ref = v;
        this.tag++;
    }
    // BUG (A) ABA on head pointer: CAS compares ONLY ref identity, ignoring the
    // version tag. A recycled sentinel object makes the CAS spuriously succeed.
    cas(expected: T | null, desired: T | null): boolean {
        if (this.ref === expected) {   // <-- ignores this.tag (ABA)
            this.ref = desired;
            return true;
        }
        return false;
    }
}

export class MPSCQueue<T> {
    private readonly head: AtomicRef<Node<T>>;  // consumer end
    private tail: Node<T>;                      // producer end

    constructor() {
        const sentinel: Node<T> = { value: null, next: null };
        this.head = new AtomicRef(sentinel);
        this.tail = sentinel;
    }

    enqueue(value: T): void {
        const node: Node<T> = { value, next: null };
        const prev = this.tail;
        prev.next = node;   // publish
        this.tail = node;
    }

    dequeue(): { ok: true; value: T } | { ok: false } {
        const sentinel = this.head.load();
        if (sentinel === null) return { ok: false };
        // BUG (C) empty-queue spin does not yield: busy-waits without yielding,
        // starving the event loop so producers cannot run.
        while (sentinel.next === null) {
            /* spin — should yield to the event loop */
        }
        // BUG (B) missing acquire-load on tail->next: reads a producer-published
        // node without an acquire fence; may observe stale node fields.
        const next = sentinel.next;   // <-- no acquire fence
        this.head.cas(sentinel, next);   // (A) ABA-prone CAS
        // BUG (D) returns success on a null sentinel value, masking empty state.
        return { ok: true, value: next.value as T };
    }

    isEmpty(): boolean {
        const h = this.head.load();
        return h !== null && h.next === null && this.tail === h;
    }
}
```

**Goal**: 4 `coder` members each **minimally fix one bug class** (non-overlapping), layered along the stage chain — `alice` fixes A, `bob` on top of `alice` fixes B, `carol` on top fixes C, `dave` on top fixes D; `erin` writes a property test, `frank` runs a 10^7 stress test; `grace` (decider) reviews and decides convergence.

**Success Criteria (Machine-Verifiable)**:
- 4 coders each output ending with `<!-- FIX_APPLIED: <bug-class> -->` (four distinct bug-classes: `ABA-HEAD` / `ACQUIRE-TAIL-NEXT` / `YIELD-SPIN` / `NULL-SENTINEL`)
- `erin` output ends with `<!-- PROP_TEST: <pass|fail> -->`
- `frank` output contains `<!-- STRESS_OPS: 10000000 -->` and ends with `<!-- STRESS_RESULT: <pass|fail> -->`
- `grace`'s final `<decision>` JSON contains `"decision": "done"`, `"allFixed": true`, and `"stressPass": true`

### 4.2 Team Configuration

```json
{
  "name": "queue-loop",
  "description": "Lock-free MPSC queue: four coders each fix one distinct concurrency bug class (A/B/C/D), two testers write+run a property test and a 10^7 stress, reviewer decides.",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You fix exactly ONE bug in the MPSCQueue: BUG (A) ABA on the head pointer. AtomicRef.cas() compares ONLY ref identity and ignores the version `tag`, so a recycled sentinel object can make the CAS spuriously succeed. Make the MINIMAL change so the CAS also verifies the tag has not changed (tagged-CAS): either accept an expected-tag parameter or snapshot the tag at load time and compare it inside cas(). Touch ONLY the ABA logic; do NOT alter bugs B/C/D. Embed the full corrected TypeScript (AtomicRef + MPSCQueue classes, signature `export class MPSCQueue<T>`) in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- FIX_APPLIED: ABA-HEAD -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You fix exactly ONE bug in the MPSCQueue: BUG (B) missing acquire-load on tail->next. In dequeue(), the line `const next = sentinel.next` reads a node the producer published via `prev.next = node` WITHOUT an acquire fence, so the consumer may observe `next` set but read stale node fields. Make the MINIMAL change: insert an acquire fence immediately before reading sentinel.next (model it as an `acquireFence()` function you also define, or annotate the load as acquire). Touch bug B. You MAY also restore bug A if the code you inherited from alice has regressed it — return it to its intended correct behavior, nothing more. You MUST NOT touch bugs C or D (owned by later coders). Embed the full corrected TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- FIX_APPLIED: ACQUIRE-TAIL-NEXT -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You fix exactly ONE bug in the MPSCQueue: BUG (C) the empty-queue spin does not yield. In dequeue(), `while (sentinel.next === null) { /* spin */ }` busy-waits without yielding, starving the event loop so producers cannot run. Make the MINIMAL change so dequeue is NON-BLOCKING on empty: convert dequeue to `async`, replace the infinite `while (sentinel.next === null)` busy-wait with a SINGLE cooperative `await Promise.resolve()` (yield once to let pending producers run), then if `sentinel.next` is still null return `{ ok: false }` (a try-dequeue that gives up cleanly on empty). Keep the return type `Promise<{ ok: true; value: T } | { ok: false }>`. Do NOT make dequeue block forever — the empty case MUST resolve to `{ ok: false }`. Touch bug C. You MAY also restore bugs A or B if the code you inherited from bob has regressed them — return each to its intended correct behavior, nothing more. You MUST NOT touch bug D (owned by a later coder). Embed the full corrected TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- FIX_APPLIED: YIELD-SPIN -->"
    },
    {
      "name": "dave",
      "role": "coder",
      "prompt": "You fix exactly ONE bug in the MPSCQueue: BUG (D) dequeue returns success on a null sentinel value. When `next` is a (recycled) sentinel with value === null, dequeue reports `{ ok: true, value: null }`, masking the empty condition. Make the MINIMAL change: when next.value === null, return `{ ok: false }` instead of `{ ok: true, value: null }`. Touch bug D. You MAY also restore bugs A, B, or C if the code you inherited from carol has regressed them — return each to its intended correct behavior, nothing more. As the final coder there are no downstream bugs to avoid. Embed the full corrected TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- FIX_APPLIED: NULL-SENTINEL -->"
    },
    {
      "name": "erin",
      "role": "tester",
      "prompt": "You write a PROPERTY TEST for the MPSCQueue. Read dave.md (the fully-fixed queue with all four bugs addressed) — extract the ```typescript block. Write a property test that, over many random enqueue/dequeue sequences, asserts: (a) dequeued values come out in strict FIFO enqueue order, (b) no value is lost or duplicated, (c) a dequeue on an empty queue returns { ok: false } (NOT { ok: true, value: null }). Run it and report pass/fail with a one-line summary. Your output MUST end with a line exactly formatted: <!-- PROP_TEST: <pass|fail> -->"
    },
    {
      "name": "frank",
      "role": "tester",
      "prompt": "You run a HIGH-VOLUME STRESS TEST on the MPSCQueue. Read dave.md (the fully-fixed queue) and erin.md (the property test). Execute exactly 10^7 (10000000) mixed operations (random enqueue/dequeue, roughly 50/50, across simulated producers/consumers) and assert strict FIFO ordering with ZERO lost or duplicated items. Report the exact operation count and the pass/fail verdict with a one-line summary. Your output MUST contain a line exactly formatted: <!-- STRESS_OPS: 10000000 --> AND MUST end with a line exactly formatted: <!-- STRESS_RESULT: <pass|fail> -->"
    },
    {
      "name": "grace",
      "role": "reviewer",
      "prompt": "You are the loop DECIDER for the lock-free MPSC queue fix. Read alice.md (FIX_APPLIED: ABA-HEAD), bob.md (ACQUIRE-TAIL-NEXT), carol.md (YIELD-SPIN), dave.md (NULL-SENTINEL) — confirm each coder applied exactly ONE distinct fix and the four are disjoint; read erin.md (PROP_TEST: pass|fail) and frank.md (STRESS_OPS + STRESS_RESULT). Decide 'done' ONLY when: (1) all four fix markers are present and distinct, (2) erin's PROP_TEST=pass, AND (3) frank's STRESS_RESULT=pass with STRESS_OPS=10000000; otherwise 'continue' with concrete nextActions naming which coder must redo their fix. In EVERY <decision> block you emit, include the standard fields (decision, rationale, nextActions) PLUS two additional boolean fields: \"allFixed\": true|false (all four distinct fixes applied) and \"stressPass\": true|false (frank's 10^7 stress passed). The literal English tags <decision> and </decision> are required."
    }
  ]
}
```

**Role Selection Rationale**: 4 `coder` members (`oct-junior` agent, can modify code, `modify`) correspond to minimal fixes for four bug classes; 2 `tester` members (read-only, `read_only`) respectively handle property testing and 10^7 stress testing; `reviewer` (default read-only) serves as decider — `grace` is not in `stages`; OCTeam auto-appends it as the final `read_only` stage (source: `loop.ts` buildTask branch).

### 4.3 Master Launch Call

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "queue-loop",
    "stages": [
      { "member": "alice", "task": "Starting from the buggy MPSCQueue in initial_task, apply ONLY the ABA-head fix (bug A). Emit the full corrected code. End with <!-- FIX_APPLIED: ABA-HEAD -->.", "action": "modify" },
      { "member": "bob",   "task": "Read alice.md (bug A fixed). Apply the acquire-tail-next fix (bug B) on top of alice's code; if alice's code has regressed bug A, restore it too. Emit the full corrected code. End with <!-- FIX_APPLIED: ACQUIRE-TAIL-NEXT -->.", "action": "modify" },
      { "member": "carol", "task": "Read bob.md (bugs A+B fixed). Apply the yield-spin fix (bug C) on top of bob's code; if bob's code has regressed bug A or B, restore them too. Emit the full corrected code. End with <!-- FIX_APPLIED: YIELD-SPIN -->.", "action": "modify" },
      { "member": "dave",  "task": "Read carol.md (bugs A+B+C fixed). Apply the null-sentinel fix (bug D) on top of carol's code; if carol's code has regressed bug A, B, or C, restore them too. Emit the full corrected code. End with <!-- FIX_APPLIED: NULL-SENTINEL -->.", "action": "modify" },
      { "member": "erin",  "task": "Read dave.md (fully-fixed queue). Write + run a property test (FIFO order, no loss/dup, empty -> { ok: false }). End with <!-- PROP_TEST: <pass|fail> -->.", "action": "read_only" },
      { "member": "frank", "task": "Read dave.md and erin.md. Run exactly 10^7 mixed-op stress asserting strict FIFO, zero loss/dup. Emit <!-- STRESS_OPS: 10000000 --> and end with <!-- STRESS_RESULT: <pass|fail> -->.", "action": "read_only" }
    ],
    "decider": "grace",
    "max_rounds": 5,
    "timeout_ms": 1800000,
    "initial_task": "Here is the BUGGY Michael-Scott-style MPSC lock-free queue with FOUR distinct bug classes. Each coder fixes exactly ONE; the four fixes compose across the four coder stages (alice -> bob -> carol -> dave).\n\n- BUG (A) ABA on head pointer: AtomicRef.cas() ignores the version tag.\n- BUG (B) missing acquire-load on tail->next in dequeue().\n- BUG (C) empty-queue spin does not yield (busy-waits, starving producers).\n- BUG (D) dequeue returns { ok: true, value: null } on a null sentinel.\n\n```typescript\ninterface Node<T> {\n    value: T | null;\n    next: Node<T> | null;\n}\n\nclass AtomicRef<T> {\n    private ref: T | null;\n    private tag: number;\n    constructor(initial: T | null) { this.ref = initial; this.tag = 0; }\n    load(): T | null { return this.ref; }\n    store(v: T | null): void { this.ref = v; this.tag++; }\n    cas(expected: T | null, desired: T | null): boolean {\n        if (this.ref === expected) { this.ref = desired; return true; }\n        return false;\n    }\n}\n\nexport class MPSCQueue<T> {\n    private readonly head: AtomicRef<Node<T>>;\n    private tail: Node<T>;\n    constructor() {\n        const sentinel: Node<T> = { value: null, next: null };\n        this.head = new AtomicRef(sentinel);\n        this.tail = sentinel;\n    }\n    enqueue(value: T): void {\n        const node: Node<T> = { value, next: null };\n        const prev = this.tail;\n        prev.next = node;\n        this.tail = node;\n    }\n    dequeue(): { ok: true; value: T } | { ok: false } {\n        const sentinel = this.head.load();\n        if (sentinel === null) return { ok: false };\n        while (sentinel.next === null) { /* spin */ }\n        const next = sentinel.next;\n        this.head.cas(sentinel, next);\n        return { ok: true, value: next.value as T };\n    }\n    isEmpty(): boolean {\n        const h = this.head.load();\n        return h !== null && h.next === null && this.tail === h;\n    }\n}\n```\n\nalice: fix ONLY bug A. bob: fix ONLY bug B on top of alice's output. carol: fix ONLY bug C on top of bob's. dave: fix ONLY bug D on top of carol's. Each coder ends with <!-- FIX_APPLIED: <bug-class> -->."
  }
}
```

**Parameter Selection**:
- `stages` lists 6 stages (4 coder `modify` + 2 tester `read_only`); `decider: "grace"` is not in `stages`; OCTeam auto-appends it as the final `read_only` stage (source: `loop.ts` buildTask branch: `if (!stages.some(s => s.member === args.decider))` push).
- Stage member names unique (`alice` / `bob` / `carol` / `dave` / `erin` / `frank`), conforming to schema validation; `decider` differs from all six, conforming to "not master, not in stages" constraint.
- `max_rounds: 5` — challenge-level: 4 bug-class minimal fixes + property test + 10^7 stress typically converges in 2-3 rounds; 5-round cap as safety for occasional regression (e.g. a coder accidentally modifies adjacent bug, stress flakiness).
- `timeout_ms: 1800000` — explicitly set to OCTeam's hard ceiling (`bounds.maxWallClockMinutes=30`, clamped by `effectiveTimeoutMs`). Scenario 4 includes 7 members serial + frank's 10^7 stress (single run ~100 s+), single round typically ~15 min; using default timeout (15 min) would terminate during frank's stress phase (observed: frank running to ~107 s was killed by default timeout, `frank.md`/`grace.md` missing). Note: this scenario's estimated total ~60 min exceeds the 30 min hard ceiling; multi-round convergence scenarios need the decider to `done` early (typically round 1 converges).
- `initial_task` embeds full buggy code (all four bug classes present) and explicitly names each person's single fix, constraining the layered minimal changes.
- 7 members (≤ 8 ceiling), four bug classes one-to-one with four coders, no overlapping responsibilities.

### 4.4 Execution Flow (Timeline)

```
T+0m      master calls team_loop; round 1 starts
T+0m      alice  (modify)   receives initial_task -> fixes bug A (ABA-head)        -> alice.md + FIX_APPLIED: ABA-HEAD
T+5m      bob    (modify)   reads alice.md -> fixes bug B on top                  -> bob.md   + FIX_APPLIED: ACQUIRE-TAIL-NEXT
T+10m     carol  (modify)   reads bob.md   -> fixes bug C on top                  -> carol.md + FIX_APPLIED: YIELD-SPIN
T+15m     dave   (modify)   reads carol.md -> fixes bug D on top                  -> dave.md  + FIX_APPLIED: NULL-SENTINEL
T+20m     erin   (read_only) reads dave.md  -> writes property test and runs       -> erin.md  + PROP_TEST
T+30m     frank  (read_only) reads dave/erin -> runs 10^7 stress                    -> frank.md + STRESS_OPS / STRESS_RESULT
T+45m     grace  (decider, read_only) reads 6 outputs -> emits <decision>
                   if allFixed=true and stressPass=true -> decision="done" (typical path)
                   otherwise -> decision="continue" + nextActions naming a coder to redo -> round 2
T+45~60m  at most 5 rounds; done or max_rounds triggers stop
T+60m     run: bun check-coding-lockfree-queue.ts <run_dir>
```

### 4.5 Check Script

[`check-coding-lockfree-queue.ts`](./check-coding-lockfree-queue.ts)

- **Load**: `runs/<run_id>/grace.md` (decider) and `frank.md` (cross-verification), with `alice/bob/carol/dave.md` (4 FIX_APPLIED diagnostics) and `erin.md` (PROP_TEST diagnostics)
- **Extract**:
  - decider: regex `<decision>([\s\S]*?)</decision>` take the last occurrence (final round), `JSON.parse`
  - frank: regex `<!--\s*STRESS_OPS:\s*(\d+)\s*-->` and `<!--\s*STRESS_RESULT:\s*(pass|fail)\s*-->`
- **Assert**:
  1. `frank` `STRESS_OPS >= 10^7` (10^7 threshold)
  2. `frank` `STRESS_RESULT === "pass"` (10^7 stress no FIFO violations)
  3. `decision.decision === "done"`
  4. `decision.allFixed === true` (all four bug classes fixed)
  5. `decision.stressPass === true` and consistent with `frank`'s `STRESS_RESULT` (cross-verification: decider and stress tester agree)

---

## Acceptance Checklist

- [ ] 4 check scripts pass `bunx tsc -p demos/tsconfig.json` (no type errors)
- [ ] Each team config role is valid (`coder` / `tester` / `simulator` / `analyst` / `reviewer` are all presets)
- [ ] Each master call parameters conform to `team_loop` schema (`stages` member names unique, `decider` not master and not in stages, `max_rounds` / `initial_task` present)
- [ ] Scenarios 1-3 total duration ≤ 15 min (well under 30 min ceiling; `max_rounds=3` safety); Scenario 4 (challenge-level) ≈ 60 min, 7 members, `max_rounds=5`, deliberately exceeds standard timing ceiling as a harder sample
- [ ] Member prompts explicitly specify output format conventions (marker), decider prompt explicitly specifies mode-specific boolean fields, check scripts aligned with them

---

## Quick-Start Prompt (Copy and Use)

> Paste any of the following prompts to a master session, and the AI will automatically complete the full closed loop. The loop mode's evaluation reads the **decider** member's final-round output (containing the `<decision>` block).

### Scenario 1: Fix Bisection Root-Finding Boundary Bugs (Math)

```text
执行 demos/04-team-loop/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_loop JSON 启动编排（注意 initial_task 是待修的 buggy 代码）
4. team_results 轮询至 master 收到汇总（最多 max_rounds 轮，decider 说 done 即停）
5. 定位 <run_dir>（含 decider 成员的 .md）
6. 运行：bun demos/04-team-loop/check-math-bisection-fix.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decider 最终轮 `"decision": "done"` 且 `"testsPass": true`（NaN / 单侧区间 / 收敛阈值三类边界 bug 全修）。
```

### Scenario 2: Debug Spring-Mass Energy Drift (Physics)

```text
执行 demos/04-team-loop/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_loop JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>（含 decider 与 analyst 成员的 .md）
6. 运行：bun demos/04-team-loop/check-physics-spring-energy.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decider decision="done" 且 `"driftAcceptable": true`；analyst 报 DRIFT_AFTER < 1e-3（Verlet 替换 Euler 后）。
```

### Scenario 3: Fix Off-by-One Interval Merge Bug (Programming)

```text
执行 demos/04-team-loop/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_loop JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun demos/04-team-loop/check-coding-interval-merge.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decider decision="done" 且 `"allPass": true`（5 个用例含 [[1,3],[3,5]] 这类 touching 区间正确合并）。
```

### Scenario 4: Fix Lock-free Queue Four-Class Concurrency Bugs (Challenge-Level)

```text
执行 demos/04-team-loop/README.md「场景 4」的完整闭环并自动评判。

步骤：
1. 读 README「4.2 Team 配置」，按 team_create JSON 创建团队（7 成员：alice/bob/carol/dave 为 coder，erin/frank 为 tester，grace 为 reviewer）
2. team_activate 激活
3. 读 README「4.3 Master 启动调用」，按 team_loop JSON 启动编排（注意 initial_task 是含四类 bug 的 MPSCQueue；stages 共 6 个，decider=grace 由 OCTeam 自动追加）
4. team_results 轮询至 master 收到汇总（最多 max_rounds=5 轮，decider 说 done 即停）
5. 定位 <run_dir>（含 grace/frank 等 7 个成员的 .md）
6. 运行：bun demos/04-team-loop/check-coding-lockfree-queue.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：decider decision="done" 且 `"allFixed": true` 且 `"stressPass": true`；frank 报 STRESS_OPS=10^7 且 STRESS_RESULT=pass（四类并发 bug ABA/acquire/yield/null-sentinel 全修，10^7 FIFO 压测无违例）。
```
