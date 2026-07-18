# Human-in-the-Loop Approval Scenario Demo

HITL demonstrates the `human_approval` parameter across multiple orchestration modes. When enabled, the orchestration pauses at supported mid-run boundaries (between pipeline stages, at tollgate verification gates, between arbitrate debate rounds, at workflow `approval_before`/`approval_after` steps) and the leader session receives an `[Human approval required]` notification. The leader must call `team_approve` to resume or `team_reject` to reject with feedback.

---

## HITL Mechanism

When `human_approval: true` is set in the master invocation, the orchestration pauses at eligible mid-run boundaries. The leader session receives a notification:

```
[Human approval required] Team "xxx" is paused at pipeline_stage (stage 1).
Approval id: abc-123
Call team_approve(team_id="xxx", approval_id="abc-123") to continue,
or team_reject(team_id="xxx", approval_id="abc-123", feedback="...") to reject.
```

The leader then calls `team_approve` to resume the run, or `team_reject` to apply the mode-specific rejection path (e.g. skip the gate, fail the pipeline stage, end the debate).

## Scenario Overview

| # | Domain | Scenario | Tool | HITL Pause Points | Members | Est. Duration |
|---|------|------|------|-------------------|--------|-----------|
| 1 | Programming | Config parser pipeline (baseline) | `team_pipeline` | 2 (between stages) | 3 | ~12 min |
| 2 | Computational physics | Spring-mass velocity Verlet tollgate (baseline) | `team_tollgate` | 1 (at gate) | 2 | ~10 min |
| 3 | Math | Gauss-Legendre vs Simpson integration arbitrate (baseline) | `team_arbitrate` | 1 (before ruling) | 3 | ~15 min |
| 4 | Programming | Release pipeline workflow (challenge-level) | `team_workflow` | 3 (approval_after on key steps) | 6 | ~25 min |

---

## Scenario 1: Config Parser Pipeline

### 1.1 Scenario Description

**Background**: A `key=value` config format with comment lines (`#`) and empty-line skipping is a common pattern in dotenv files and INI alternatives. Building it via a three-stage pipeline (spec → implement → test) is the natural way to separate concerns, and human approval between stages lets the leader inspect each hand-off before proceeding.

**Goal**: Three `coder` members relay serially: alice writes the spec, bob implements `parseConfig` following the spec, carol writes and runs three test cases. Human approval pauses between each stage hand-off.

**Success criteria (machine-evaluable)**:
- Alice's output ends with `<!-- SPEC_OK: true -->`
- Bob's output ends with `<!-- IMPL: parseConfig -->`
- Carol's output ends with `<!-- PASS_COUNT: 3/3 -->`
- Check script loads `parseConfig` from bob's code block and runs 3 cases:
  - `parseConfig("a=1\nb=2")` → Map with 2 entries
  - `parseConfig("")` → empty Map
  - `parseConfig("no_equals")` → throws Error

### 1.2 Team Configuration

```json
{
  "name": "config-hitl",
  "description": "Config parser pipeline with human-in-the-loop approval between stages",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are stage 1 (spec) of a 3-stage pipeline building a config parser. Define a spec for `parseConfig(input: string): Map<string, string>`: input is `key=value` lines (one per line), output is a `Map<string, string>`. Lines starting with `#` are comments and skipped. Empty lines are skipped. Malformed lines (no `=`) throw an Error. Document the spec concisely.\n\nYour output MUST end with: <!-- SPEC_OK: true -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are stage 2 (implement) of a 3-stage pipeline building a config parser. Implement `function parseConfig(input: string): Map<string, string>` following the spec from the previous stage. Skip `#` comments and empty lines. Throw Error on malformed lines (no `=`). Embed the full TypeScript code in a single ```typescript fenced block.\n\nYour output MUST end with: <!-- IMPL: parseConfig -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are stage 3 (test) of a 3-stage pipeline building a config parser. Write and run 3 test cases against bob's parseConfig implementation: (1) normal input 'a=1\\nb=2' -> Map with 2 entries; (2) empty input '' -> empty Map; (3) malformed input 'no_equals' -> throws Error. Extract the code from bob's ```typescript block. Report how many pass.\n\nYour output MUST end with: <!-- PASS_COUNT: <n>/3 -->"
    }
  ]
}
```

**Role selection rationale**: All three stages use `coder` (the `oct-junior` agent), which can write specs, implement TypeScript functions, and run test cases.

### 1.3 Master Launch Call

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "config-hitl",
    "stages": [
      {
        "member": "alice",
        "task": "Define the config parser spec (key=value lines, # comments, malformed throws). Produce SPEC_OK marker."
      },
      {
        "member": "bob",
        "task": "Implement parseConfig following the spec. Produce IMPL marker."
      },
      {
        "member": "carol",
        "task": "Write and run 3 test cases. Produce PASS_COUNT marker."
      }
    ],
    "human_approval": true,
    "timeout_ms": 900000
  }
}
```

**Parameter selection**:
- `human_approval: true` — Enables HITL; pauses between each stage hand-off (stage 1→2 and stage 2→3)
- `timeout_ms: 900000` (15 min) — 3 stages serial with 2 approval pauses, normally completes in ~12 min
- No `signoff_*` — The check script verifies correctness directly

### 1.4 Execution Timeline

```
T+0m    master calls team_pipeline (human_approval=true)
T+0m    dispatches stage-1 (alice)
T+0~3m  alice writes spec -> SPEC_OK marker -> idle
T+3m    [HITL PAUSE] pipeline_stage (stage 0 -> 1). Leader receives notification.
T+3m    Leader reads alice.md, presents summary to user, WAITS for user decision
T+?     User says "approve" -> Leader calls team_approve -> stage-1 dispatched
T+?~?   bob implements parseConfig -> IMPL marker -> idle
T+?     [HITL PAUSE] pipeline_stage (stage 1 -> 2). Leader receives notification.
T+?     Leader reads bob.md, presents summary to user, WAITS for user decision
T+?     User says "approve" -> Leader calls team_approve -> stage-2 dispatched
T+?~?   carol runs 3 test cases -> PASS_COUNT marker -> idle
T+?     final-stage output summarized, delivered to master
T+?     Run: bun demos/12-team-hitl/check-coding-config-pipeline.ts <run_dir>
```

### 1.5 Check Script

[`check-coding-config-pipeline.ts`](./check-coding-config-pipeline.ts)

- **Load**: `runs/<run_id>/carol.md` (final stage) and `runs/<run_id>/bob.md` (implementation)
- **Extract**:
  - Carol marker: regex `<!--\s*PASS_COUNT:\s*(\d+)\s*/\s*3\s*-->`
  - Bob code: grab the last ` ```typescript ... ``` ` code block
- **Assertions**:
  1. PASS_COUNT = 3
  2. Code loads as `parseConfig` via Bun.Transpiler + `new Function`
  3. `parseConfig("a=1\nb=2")` produces Map with 2 entries
  4. `parseConfig("")` produces empty Map
  5. `parseConfig("no_equals")` throws Error

---

## Scenario 2: Spring-Mass Velocity Verlet Tollgate

### 2.1 Scenario Description

**Background**: The harmonic oscillator `ẍ = -k/m·x` (with `k=1, m=1, x0=1, v0=0`) has constant energy `E = 0.5·(x² + v²) = 0.5`. Velocity Verlet is a symplectic integrator whose energy oscillates within a bounded band instead of drifting. Running 1000 steps at `h=0.05` and measuring the relative drift is a standard verification check.

**Goal**: One producer (alice) implements Velocity Verlet and reports the energy drift; one verifier (bob) checks whether the drift satisfies the symplectic conservation bound. Human approval pauses at the verification gate before the verdict is applied.

**Success criteria (machine-evaluable)**:
- Producer output contains `<!-- DRIFT: <value> -->` marker
- Drift `< 1e-3` (hallmark of a symplectic integrator)
- Verifier output contains `<verdict>{"result":"PASS",...}</verdict>` tagged JSON block

### 2.2 Team Configuration

```json
{
  "name": "spring-hitl",
  "description": "Spring-mass velocity Verlet tollgate with human-in-the-loop approval at the verification gate",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are a simulator implementing numerical integration. Implement Velocity Verlet for the spring-mass system (k=1, m=1, x0=1, v0=0) and run exactly 1000 steps with h=0.05. Compute E = 0.5*(x^2 + v^2) and E0 = 0.5. Report the relative drift |E_end - E0|/E0. Embed the code in a ```typescript fenced block.\n\nYour output MUST end with: <!-- DRIFT: <numeric_drift> -->"
    },
    {
      "name": "bob",
      "role": "physicist",
      "prompt": "You are a physicist verifying numerical results. Check whether the reported energy drift satisfies the symplectic conservation bound (< 1e-3). Emit a verdict: PASS if drift < 1e-3, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<measured value if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Producer uses `simulator` (numerical integration specialist); verifier uses `physicist` (understands symplectic integrators and conservation laws).

### 2.3 Master Launch Call

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "spring-hitl",
    "stages": [
      {
        "member": "alice",
        "task": "Implement Velocity Verlet for spring-mass (k=1,m=1), x0=1, v0=0, h=0.05, 1000 steps. Report energy drift. End with <!-- DRIFT: <value> -->.",
        "verifier": "bob",
        "criteria": "Energy drift must be < 1e-3 for a symplectic integrator (Velocity Verlet) over 1000 steps at h=0.05."
      }
    ],
    "human_approval": true,
    "timeout_ms": 600000
  }
}
```

**Parameter selection**:
- `human_approval: true` — Pauses at the verification gate; leader inspects the producer's output and the verifier's verdict before the gate actually applies
- `verifier != member` (`bob` != `alice`) — Satisfies the tollgate "no self-verification" constraint
- `timeout_ms: 600000` (10 min) — Single gate, serial two-hop, normally completes in ~8 min
- No `max_gate_retries` — Single attempt; the gate either passes or fails

### 2.4 Execution Timeline

```
T+0m    master calls team_tollgate (human_approval=true)
T+0m    dispatches producer (alice)
T+0~5m  alice implements Velocity Verlet -> runs 1000 steps -> DRIFT marker -> idle
T+5m    [HITL PAUSE] tollgate_gate. Leader receives notification.
T+5m    Leader reads alice.md, presents summary to user, WAITS for user decision
T+?     User says "approve" -> Leader calls team_approve -> gate verifier dispatched
T+?~?   bob runs verification -> outputs verdict
T+?     PASS -> result delivered to master
T+?     Run: bun demos/12-team-hitl/check-physics-spring-tollgate.ts <run_dir>
```

### 2.5 Check Script

[`check-physics-spring-tollgate.ts`](./check-physics-spring-tollgate.ts)

- **Load**: `runs/<run_id>/alice.md` (producer)
- **Extract**: regex `<!--\s*DRIFT:\s*([\d.eE+-]+)\s*-->`
- **Assertions**:
  1. DRIFT value exists and `Number.isFinite`
  2. `drift < 1e-3` (symplectic conservation bound)

---

## Scenario 3: Integration Method Arbitrate

### 3.1 Scenario Description

**Background**: The definite integral `∫₀¹ e^(-x²) dx` is a classic problem where different quadrature methods offer different trade-offs. Gauss-Legendre quadrature (with optimally placed nodes) converges exponentially for smooth integrands, giving higher accuracy with fewer function evaluations. Simpson's rule is a simple fixed-interval method. A formal debate between these two approaches demonstrates the comparative reasoning that `team_arbitrate` excels at.

**Goal**: Two debaters (alice and bob) each defend one method; an arbiter (carol) weighs both positions and issues a ruling. Human approval pauses before the arbitration phase so the leader can inspect the debate before the ruling is delivered.

**Dispute proposition**: *"For computing the definite integral of e^(-x^2) on [0,1], should you use Gauss-Legendre quadrature or Simpson's rule?"*

**Success criteria (machine-evaluable)**:
- Both debater outputs each contain `<!-- ARG: <one-line position> -->` marker
- Arbiter output contains `<ruling>{"decision":"<choice>","rationale":"<text>"}</ruling>` tag JSON block
- Expected `decision` = `gauss-legendre` (higher accuracy for smooth functions with fewer nodes)
- `rationale` mentions `accuracy` or `exponential` or `smooth` or `nodes` (case-insensitive)

### 3.2 Team Configuration

```json
{
  "name": "integral-hitl",
  "description": "Arbitrate Gauss-Legendre vs Simpson's rule for integrating e^(-x^2) on [0,1]",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are the proponent of GAUSS-LEGENDRE quadrature for computing the definite integral of e^(-x^2) on [0,1]. Argue: Gauss-Legendre nodes are optimally placed (roots of Legendre polynomials), achieving exact integration for polynomials up to degree 2n-1 with just n nodes. For a smooth function like e^(-x^2), the error decays exponentially with n. Rebut Simpson's rule: it uses fixed equally spaced points and has slower (polynomial) convergence for smooth integrands.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are the proponent of SIMPSON'S RULE for computing the definite integral of e^(-x^2) on [0,1]. Argue the Simpson case as strongly as you can: Simpson's rule is simple to implement, requires only 3 equally spaced points per subinterval, generalizes to composite rules for arbitrary precision, and is well understood by engineers. For e^(-x^2) on [0,1] the function is smooth enough that composite Simpson converges reasonably fast. Rebut the Gauss-Legendre side.\n\nYour output MUST end with a line exactly formatted: <!-- ARG: <one-line summary of your position> -->"
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are the ARBITER. Two mathematicians debated whether to integrate e^(-x^2) on [0,1] with Gauss-Legendre quadrature or Simpson's rule. Weigh both sides objectively, then deliver a single BINDING ruling. Recall the numerical integration principle: for smooth analytic integrands, Gaussian quadrature achieves exponential (spectral) convergence with optimally-placed nodes, far outperforming fixed-interval Newton-Cotes rules like Simpson's. The reference value is (sqrt(pi)/2)*erf(1) ≈ 0.7468241328.\n\nLANGUAGE REQUIREMENT: Your entire output, including the rationale string inside the JSON, MUST be written in English. Do NOT use any other language. The rationale MUST contain at least one of these exact lowercase English keywords: \"accuracy\", \"exponential\", \"smooth\", or \"nodes\". The check script matches these keywords literally and is case-sensitive to lowercase.\n\nYour output MUST end with exactly one line formatted: <ruling>{\"decision\": \"<gauss-legendre or simpson>\", \"rationale\": \"<one-sentence English rationale containing one of: accuracy / exponential / smooth / nodes>\"}</ruling>."
    }
  ]
}
```

**Role selection rationale**: Debaters use `mathematician` (can articulate convergence rates, node placement, and error analysis); arbiter uses `reviewer` (read-only role, specialized in weighing evidence and issuing binding rulings).

### 3.3 Master Launch Call

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "integral-hitl",
    "task": "For computing the definite integral of e^(-x^2) on [0,1], should you use Gauss-Legendre quadrature or Simpson's rule?",
    "arbiter": "carol",
    "debaters": ["alice", "bob"],
    "max_rounds": 2,
    "human_approval": true,
    "timeout_ms": 1200000
  }
}
```

**Parameter selection**:
- `human_approval: true` — Pauses before the arbitration phase (after both debate rounds complete but before the arbiter's ruling is issued); leader can inspect the debate quality before the binding ruling
- `arbiter: "carol"` — Points to the `reviewer` member; arbiter must not be a debater or master
- `debaters: ["alice", "bob"]` — Exactly 2 unique debaters
- `max_rounds: 2` — Opening statements + rebuttal
- `timeout_ms: 1200000` (20 min) — 2 debate rounds + ruling; normally completes in ~15 min

### 3.4 Execution Timeline

```
T+0m    master calls team_arbitrate (max_rounds=2, human_approval=true)
T+0m    Round 1: parallel dispatch 2 debaters opening statements
T+0~5m  each debater writes arguments + ARG marker
T+5m    Round 2: parallel dispatch 2 debaters rebutting
T+5~10m each debater rebuts, refreshes ARG marker
T+10m   [HITL PAUSE] arbitrate_arbitration. Leader receives notification.
T+10m   Leader reads alice.md + bob.md, presents debate summary to user, WAITS for user decision
T+?     User says "approve" -> Leader calls team_approve -> arbiter dispatched
T+?~?   arbiter reviews rounds 1-2, issues binding ruling
T+?     ruling delivered to master
T+?     Run: bun demos/12-team-hitl/check-math-integration-arbitrate.ts <run_dir>
```

### 3.5 Check Script

[`check-math-integration-arbitrate.ts`](./check-math-integration-arbitrate.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**:
  - Debaters `<!-- ARG:\s*(.+?)\s*-->`
  - Arbiter `<ruling>{...}</ruling>` tag JSON block (`JSON.parse` to read `decision` and `rationale`)
- **Assertions**:
  1. Both debaters produced `ARG` markers
  2. Arbiter `decision == "gauss-legendre"`
  3. `rationale` non-empty and contains `accuracy` or `exponential` or `smooth` or `nodes` (case-insensitive)

---

## Scenario 4: Release Pipeline Workflow (Challenge-Level)

### 4.1 Scenario Description

**Challenge-level**: 6 members, 6 workflow steps (3 with `approval_after`), est. ~25 min. Demonstrates HITL integrated into a declarative `team_workflow` with explicit gate steps and per-step approval controls.

**Background**: A release pipeline involves sequential dependent steps: spec definition → spec verification → version bump implementation → testing → release notes → final review. Human approval at key steps (after implementation, testing, and final review) lets the release manager inspect the work products before proceeding. The declarative `team_workflow` engine orchestrates this with native gate-verdict semantics and per-step `approval_before`/`approval_after` hooks.

**Goal**: Six members execute a 6-step release workflow. Frank verifies alice's spec (gate step). Human approval pauses after bob's implementation, carol's testing, and erin's final review.

**Success criteria (machine-evaluable)**:
- Alice's output ends with `<!-- SPEC_OK: true -->`
- Bob's output ends with `<!-- IMPL: bumpVersion -->`
- Carol's output ends with `<!-- PASS_COUNT: 2/2 -->`
- Dave's output ends with `<!-- NOTES_OK: true -->`
- Erin's output ends with `<!-- REVIEW_OK: true -->`
- Check script verifies `PASS_COUNT = 2/2` (carol) and `REVIEW_OK = true` (erin), plus loads `bumpVersion` from bob.md:
  - `bumpVersion("1.0.0") === "1.0.1"`
  - `bumpVersion("2.3.9") === "2.3.10"`

### 4.2 Team Configuration

```json
{
  "name": "release-hitl",
  "description": "Release pipeline workflow with human-in-the-loop approval on key steps",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You define the release spec. Describe: version bump type (patch), changelog format, rollback plan. Your output MUST end with: <!-- SPEC_OK: true -->"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You implement the version bump script. Write `function bumpVersion(v: string): string` that increments the patch number. Embed in a single ```typescript fenced block. Your output MUST end with: <!-- IMPL: bumpVersion -->"
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You write and run test cases for bumpVersion. Test: '1.0.0' -> '1.0.1', '2.3.9' -> '2.3.10'. Extract the code from bob's block and run. Your output MUST end with: <!-- PASS_COUNT: <n>/2 -->"
    },
    {
      "name": "dave",
      "role": "coder",
      "prompt": "You write the release notes summary based on the spec and implementation. Your output MUST end with: <!-- NOTES_OK: true -->"
    },
    {
      "name": "erin",
      "role": "coder",
      "prompt": "You perform the final review checklist: verify version bump, tests, changelog. Your output MUST end with: <!-- REVIEW_OK: true -->"
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You verify the release spec for completeness. Emit a verdict: PASS if the spec mentions version, changelog, and rollback. FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<deficiency if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role selection rationale**: Five `coder` members handle the implementation-heavy steps (spec, code, test, notes, review); one `reviewer` (frank) performs the formal gate verification of the spec.

### 4.3 Master Launch Call

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "release-hitl",
    "steps": [
      {
        "kind": "task",
        "id": "define-spec",
        "member": "alice",
        "task": "Define the release spec: version bump type (patch), changelog format, rollback plan. End with <!-- SPEC_OK: true -->"
      },
      {
        "kind": "gate",
        "id": "verify-spec",
        "verifier": "frank",
        "target_step": "define-spec",
        "criteria": "Spec must mention version, changelog, and rollback."
      },
      {
        "kind": "task",
        "id": "implement-bump",
        "member": "bob",
        "task": "Implement `function bumpVersion(v: string): string` that increments the patch number. Embed in ```typescript block. End with <!-- IMPL: bumpVersion -->",
        "approval_after": true
      },
      {
        "kind": "task",
        "id": "run-tests",
        "member": "carol",
        "task": "Write 2 test cases for bumpVersion: '1.0.0'->'1.0.1', '2.3.9'->'2.3.10'. Run against bob's code. End with <!-- PASS_COUNT: <n>/2 -->",
        "approval_after": true
      },
      {
        "kind": "task",
        "id": "release-notes",
        "member": "dave",
        "task": "Write release notes summary based on the spec and implementation. End with <!-- NOTES_OK: true -->"
      },
      {
        "kind": "task",
        "id": "final-review",
        "member": "erin",
        "task": "Final review checklist: verify version bump, tests, changelog. End with <!-- REVIEW_OK: true -->",
        "approval_after": true
      }
    ],
    "timeout_ms": 2400000
  }
}
```

**Parameter selection**:
- `approval_after: true` on steps 3 (implement), 4 (test), and 6 (review) — Three HITL pause points at the critical hand-offs
- Step 2 is a `gate` step (frank verifies alice's spec) — Demonstrates gate-verdict integration within a workflow that also uses HITL
- `timeout_ms: 2400000` (40 min) — 6 steps with 3 approval pauses; normally completes in ~25 min

### 4.4 Execution Timeline

```
T+0m    master calls team_workflow (6 steps, approval_after on steps 3/4/6)
T+0m    Step 1 (alice): define spec -> SPEC_OK -> idle
T+0m    Step 2 (frank): gate-verify spec -> PASS -> advance
T+0m    Step 3 (bob): implement bumpVersion -> IMPL marker -> idle
T+0m    [HITL PAUSE] approval_after step "implement-bump". Leader receives notification.
T+?     Leader reads bob.md, presents summary to user, WAITS for user decision
T+?     User says "approve" -> Leader calls team_approve -> advance
T+?     Step 4 (carol): run 2 test cases -> PASS_COUNT marker -> idle
T+?     [HITL PAUSE] approval_after step "run-tests". Leader receives notification.
T+?     Leader reads carol.md, presents summary to user, WAITS for user decision
T+?     User says "approve" -> Leader calls team_approve -> advance
T+?     Step 5 (dave): release notes -> NOTES_OK -> idle
T+?     Step 6 (erin): final review -> REVIEW_OK -> idle
T+?     [HITL PAUSE] approval_after step "final-review". Leader receives notification.
T+?     Leader reads erin.md, presents summary to user, WAITS for user decision
T+?     User says "approve" -> Leader calls team_approve -> workflow complete
T+?     Run: bun demos/12-team-hitl/check-coding-release-workflow.ts <run_dir>
```

### 4.5 Check Script

[`check-coding-release-workflow.ts`](./check-coding-release-workflow.ts)

- **Load**: `runs/<run_id>/{carol,bob,erin}.md`
- **Extract**:
  - Carol marker: regex `<!--\s*PASS_COUNT:\s*2\s*/\s*2\s*-->`
  - Erin marker: `<!-- REVIEW_OK: true -->`
  - Bob code: grab the last ` ```typescript ... ``` ` code block
- **Assertions**:
  1. Carol PASS_COUNT = 2
  2. Erin REVIEW_OK = true
  3. Code loads as `bumpVersion` via Bun.Transpiler + `new Function`
  4. `bumpVersion("1.0.0") === "1.0.1"`
  5. `bumpVersion("2.3.9") === "2.3.10"`

---


## Quick-Start Prompts (Copy and Use)

Paste any of the following prompts to the master session; the AI will automatically complete the full closed loop. **Critical**: when the orchestration pauses for human approval (you will receive an `[Human approval required]` notification with an `approval_id`), you MUST first read the completed stage output from `<run_dir>/<member>.md`, present a concise summary to the user, and WAIT for the user to explicitly say "approve" or "reject" (with feedback). Only then call `team_approve` or `team_reject`. Do NOT auto-approve. The whole point of HITL is human judgment — the user needs time to review the output before deciding.

### Scenario 1: Config Parser Pipeline (Programming, baseline)

```text
Execute the full closed loop for demos/12-team-hitl/README.md "Scenario 1" with automatic evaluation.

Steps:
1. Read README "1.2 Team Configuration", create the team with team_create JSON (3 coder members)
2. team_activate to activate
3. Read README "1.3 Master Launch Call", start orchestration with the team_pipeline JSON (human_approval=true)
4. When the orchestration pauses for human approval (you will receive an [Human approval required] notification with an approval_id), do NOT auto-approve. Instead: (a) use team_run_dir to find the run_dir, (b) read the completed stage member's .md file, (c) present a concise summary of the output to the user, (d) WAIT for the user to explicitly say "approve" or "reject". Only then call team_approve(team_id="config-hitl", approval_id=...) or team_reject(team_id="config-hitl", approval_id=..., feedback="..."). There will be 2 pause points: after stage 0 (alice spec) and after stage 1 (bob implementation).
5. team_results poll until master receives summary (poll every 30s)
6. Locate <run_dir> (containing carol member .md)
7. Run: bun demos/12-team-hitl/check-coding-config-pipeline.ts <run_dir>
8. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: carol reports PASS_COUNT = 3/3; parseConfig handles normal input, empty input, and malformed input correctly.
```

### Scenario 2: Spring-Mass Velocity Verlet Tollgate (Physics, baseline)

```text
Execute the full closed loop for demos/12-team-hitl/README.md "Scenario 2" with automatic evaluation.

Steps:
1. Read README "2.2 Team Configuration", create the team with team_create JSON (2 members: simulator + physicist)
2. team_activate to activate
3. Read README "2.3 Master Launch Call", start orchestration with the team_tollgate JSON (human_approval=true)
4. When the orchestration pauses for human approval (you will receive an [Human approval required] notification with an approval_id), do NOT auto-approve. Instead: (a) use team_run_dir to find the run_dir, (b) read the completed stage member's .md file, (c) present a concise summary of the output to the user, (d) WAIT for the user to explicitly say "approve" or "reject". Only then call team_approve(team_id="spring-hitl", approval_id=...) or team_reject(team_id="spring-hitl", approval_id=..., feedback="..."). There will be 1 pause point: at the verification gate after alice's producer output.
5. team_results poll until master receives summary (poll every 30s)
6. Locate <run_dir> (containing alice member .md)
7. Run: bun demos/12-team-hitl/check-physics-spring-tollgate.ts <run_dir>
8. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: producer reports DRIFT < 1e-3 (Velocity Verlet is symplectic, energy oscillates in a bounded band).
```

### Scenario 3: Integration Method Arbitrate (Math, baseline)

```text
Execute the full closed loop for demos/12-team-hitl/README.md "Scenario 3" with automatic evaluation.

Steps:
1. Read README "3.2 Team Configuration", create the team with team_create JSON (2 debaters + 1 arbiter)
2. team_activate to activate
3. Read README "3.3 Master Launch Call", start orchestration with the team_arbitrate JSON (human_approval=true, max_rounds=2)
4. When the orchestration pauses for human approval (you will receive an [Human approval required] notification with an approval_id), do NOT auto-approve. Instead: (a) use team_run_dir to find the run_dir, (b) read the completed stage member's .md file(s), (c) present a concise summary of the debate to the user, (d) WAIT for the user to explicitly say "approve" or "reject". Only then call team_approve(team_id="integral-hitl", approval_id=...) or team_reject(team_id="integral-hitl", approval_id=..., feedback="..."). There will be 1 pause point: before the arbitration phase (after both debate rounds complete).
5. team_results poll until master receives summary (poll every 30s)
6. Locate <run_dir> (containing carol member .md)
7. Run: bun demos/12-team-hitl/check-math-integration-arbitrate.ts <run_dir>
8. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: arbiter rules "gauss-legendre"; rationale mentions accuracy / exponential / smooth / nodes (Gauss quadrature converges faster for smooth integrands).
```

### Scenario 4: Release Pipeline Workflow (Programming, challenge-level)

```text
Execute the full closed loop for demos/12-team-hitl/README.md "Scenario 4" with automatic evaluation (challenge-level: 6 members, 6 workflow steps, 3 approval points).

Steps:
1. Read README "4.2 Team Configuration", create the team with team_create JSON (5 coder + 1 reviewer)
2. team_activate to activate
3. Read README "4.3 Master Launch Call", start orchestration with the team_workflow JSON (approval_after on steps 3, 4, 6)
4. When the orchestration pauses for human approval (you will receive an [Human approval required] notification with an approval_id), do NOT auto-approve. Instead: (a) use team_run_dir to find the run_dir, (b) read the completed step member's .md file, (c) present a concise summary of the output to the user, (d) WAIT for the user to explicitly say "approve" or "reject". Only then call team_approve(team_id="release-hitl", approval_id=...) or team_reject(team_id="release-hitl", approval_id=..., feedback="..."). This will happen three times: after step 3 (bob implement), step 4 (carol test), and step 6 (erin review).
5. team_results poll until master receives summary (poll every 30s)
6. Locate <run_dir> (containing erin member .md)
7. Run: bun demos/12-team-hitl/check-coding-release-workflow.ts <run_dir>
8. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: carol reports PASS_COUNT = 2/2; erin reports REVIEW_OK = true; bumpVersion("1.0.0") === "1.0.1" and bumpVersion("2.3.9") === "2.3.10".
```
