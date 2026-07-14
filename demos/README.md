# OCTeam Orchestration Scenario Catalog

A set of 11 orchestration primitive scenarios plus 6 feature-specific scenario sets, designed for real applications. Each primitive includes 4 sub-scenarios (math / computational physics / programming × 3 baseline + 1 challenge-level), complete with team configs, master invocations, execution timeline sequences, and runnable TypeScript check scripts. The feature-specific sets cross-cut multiple modes to demonstrate `human_approval` (HITL), `signoff_policy` (post-completion review), advanced tollgate gate parameters (INVALID escalation, reference comparison, retry), advanced workflow engine features (loops, ensemble verifiers, join_policy variants), workflow engine automation (retry_on, foreach, conditional jumps, resilience), and parallel isolated mode (same-task broadcast, done-ack barrier, fault tolerance).
>
> Scenario domains covered: **math / computational physics / programming**.

## Quick Reference

| # | Mode | One-liner | Best Use Case | Directory |
|---|------|--------|-------------|------|
| 01 | `team_parallel` | All members run in parallel | Batch independent tasks, multi-method comparison | [`01-team-parallel/`](./01-team-parallel/) |
| 02 | `team_consensus` | Multi-round debate to consensus | Selection decisions without absolute answers | [`02-team-consensus/`](./02-team-consensus/) |
| 03 | `team_pipeline` | Linear pipeline | Sequential processing chain | [`03-team-pipeline/`](./03-team-pipeline/) |
| 04 | `team_loop` | Corrective loop | Implement-review-fix iteration | [`04-team-loop/`](./04-team-loop/) |
| 05 | `team_delegate` | Self-service task claiming | Heterogeneous expert self-assignment | [`05-team-delegate/`](./05-team-delegate/) |
| 06 | `team_route` | Content routing | Route input to matching experts | [`06-team-route/`](./06-team-route/) |
| 07 | `team_arbitrate` | Debate + arbitration | Resolve two-sided disputes | [`07-team-arbitrate/`](./07-team-arbitrate/) |
| 08 | `team_recurse` | Recursive decomposition | Hierarchical breakdown of complex tasks | [`08-team-recurse/`](./08-team-recurse/) |
| 09 | `team_tollgate` | Verification-gate pipeline | Per-stage quality gating | [`09-team-tollgate/`](./09-team-tollgate/) |
| 10 | `team_workflow` | Declarative step engine (task/gate/fanout/join) | task→gate chains + fanout parallel integration | [`10-team-workflow/`](./10-team-workflow/) |
| 11 | `team_arena` | Competitive arena: N candidate implementations + evaluator scoring to select best | Multi-solution competition, objective benchmark selection | [`11-team-arena/`](./11-team-arena/) |
| 12 | `human_approval` | Human-in-the-loop approval gates across modes | Pipeline/tollgate/arbitrate/workflow with leader approval pauses | [`12-team-hitl/`](./12-team-hitl/) |
| 13 | `signoff_policy` | Post-completion review (decider / peer-quorum) | Delegate/parallel/pipeline with signoff gate | [`13-team-signoff/`](./13-team-signoff/) |
| 14 | `team_tollgate` (advanced) | Three-valued gate: reference / escalate_to / retry / INVALID cap | INVALID escalation, FAIL retry, golden-reference comparison | [`14-team-tollgate/`](./14-team-tollgate/) |
| 15 | `team_workflow` (advanced) | Declarative engine: loops / ensemble / join_policy variants | on_fail_goto loops, ensemble verifiers, select-join | [`15-team-workflow/`](./15-team-workflow/) |
| 16 | `team_workflow` (engine automation) | Engine auto-retry / foreach / conditional jumps / resilience | retry_on, foreach, on_pass_goto+where, on_timeout+fallback | [`16-team-workflow-engine/`](./16-team-workflow-engine/) |
| 17 | `team_parallel` (isolated) | Same-task broadcast / done-ack barrier / fault tolerance | isolated mode, require_done_ack, max_errored_members | [`17-team-parallel-isolated/`](./17-team-parallel-isolated/) |

## Scenario Matrix

| Mode | Math | Computational Physics | Programming | Challenge-Level Scenario |
|------|------|---------|------|-----------|
| parallel | Monte Carlo pi: 3 methods | Harmonic oscillator integrator energy drift | Two-sum multi-solution | 8 sorting algorithms × 10⁶ × 3 dataset benchmark (8 people, ~40min)|
| consensus | Small-scale sort selection | Heat conduction time scheme | String matching algorithm | 60-digit RSA modulus factoring algorithm selection (6 people, ~35min)|
| pipeline | Gaussian definite integration full pipeline | Simple pendulum small-angle simulation | Fibonacci TDD pipeline | Lennard-Jones molecular dynamics full chain (8 people, ~60min)|
| loop | Bisection boundary bug | Spring energy drift | Interval merge off-by-one | Lock-free queue 4 types of concurrency bugs fix (7 people, ~60min)|
| delegate | Number theory problem set (5 problems) | ODE suite (3 problems) | CLI calculator (DAG) | 100 procedural number theory problems (8 people, ~90min)|
| route | Math problem classification | PDE type routing | GitHub issue triage | Multi-faceted ticket 9-way routing (9 people, ~45min)|
| arbitrate | Matrix inversion method debate | Stiff ODE scheme debate | Cache eviction strategy debate | Complex boundary PDE 5-method debate (6 people, ~40min)|
| recurse | Derangement D_n derivation | Damped pendulum modeling | Markdown→HTML converter | Vandermonde identity multi-layer proof (6 people, ~50min)|
| tollgate | Fast exponentiation impl + verification | Verlet solver + verification | String reverse + verification | 2D heat conduction solver V&V certification (6 people, ~60min)|
| workflow | Bisection root-finding impl + verification | Projectile motion RK4 solver + energy verification | REST API handler impl + verification + refactor | Multi-module fanout parallel impl + join reduce integration verification (6 people, ~50min)|
| arena | Definite integral 3 quadrature methods accuracy face-off | 3 integrators energy drift pick the most stable | 3 sorting benchmarks pick the fastest | Poisson equation 5-solver comprehensive arena (5 candidates + 1 evaluator, ~40min)|

## Composite Scenarios (Multi-Team Multi-Orchestration)

Beyond the 11 single-primitive scenarios above, there is another category: **composite scenarios**: multiple teams × multiple orchestration primitives chained together to complete an end-to-end real workflow. Unlike single-primitive scenarios, composite scenarios are **runnable workflow templates (recipes)** — not tied to specific targets, without check scripts; the user judges the results themselves.

| Scenario | Workflow | Orchestration Primitives | Directory |
|------|--------|---------|------|
| Multi-team code review | Audit → Confirm → Plan → Fix → Review | parallel / consensus / delegate / loop | [`code-review/`](./code-review/) |
| OCTeam feature enhancement | Research → Discuss → Plan → Implement → Audit | parallel / consensus / loop / pipeline | [`feature-dev/`](./feature-dev/) |
| Matrix eigenvalue solver development | Research → Compare → Plan+Review → Implement → Optimize+Refactor → Code review | parallel / consensus / tollgate / pipeline / loop | [`eigen-solver/`](./eigen-solver/) |

## Feature-Specific Scenarios (Cross-Mode Parameters)

Beyond the 11 single-primitive scenarios, there are **feature-specific scenario sets** that demonstrate powerful cross-mode parameters not covered by the baseline demos: `human_approval` (HITL pause gates), `signoff_policy` (post-completion review), advanced tollgate gate parameters, advanced workflow engine features, workflow engine automation, and parallel isolated mode. Each set includes 3 baseline + 1 challenge-level scenario with check scripts.

| Feature | Parameter | What It Demonstrates | Modes Covered | Directory |
|---------|-----------|---------------------|---------------|-----------|
| Human-in-the-Loop | `human_approval: true` | Leader pauses at mid-run boundaries; approve via `team_approve` or reject via `team_reject` | pipeline / tollgate / arbitrate / workflow | [`12-team-hitl/`](./12-team-hitl/) |
| Post-Completion Signoff | `signoff_policy: "decider"` / `"peer-quorum"` | Reviewer(s) inspect output before delivery; decider or quorum vote | delegate / parallel / pipeline | [`13-team-signoff/`](./13-team-signoff/) |
| Advanced Tollgate Gates | `reference` / `escalate_to` / `max_gate_retries` / `max_invalid_cycles` | Three-valued gate INVALID escalation, FAIL retry, golden-reference comparison | tollgate | [`14-team-tollgate/`](./14-team-tollgate/) |
| Advanced Workflow Engine | `on_fail_goto` + `loop` / `verifiers` ensemble / `join_policy: "select"` | Engine-driven fix-verify loops, multi-verifier voting, competitive branch selection | workflow | [`15-team-workflow/`](./15-team-workflow/) |
| Workflow Engine Automation | `retry_on` / `foreach` / `on_pass_goto` + `where` / `on_timeout` + `fallback_member` / `on_malformed` | Auto-retry on output conditions, parameterized fanout, conditional quality-based jumps, timeout/fallback resilience | workflow | [`16-team-workflow-engine/`](./16-team-workflow-engine/) |
| Parallel Isolated Mode | `mode: "isolated"` / `require_done_ack` / `max_errored_members` | Same-task broadcast to all members, explicit done-ack barrier, fault-tolerant redundancy | parallel | [`17-team-parallel-isolated/`](./17-team-parallel-isolated/) |

## Scenario Directory Structure

Each mode directory contains 4 files:

- **`README.md`** — Complete design (3 baseline sub-scenarios: math / computational physics / programming + 1 challenge-level scenario), each sub-scenario includes:
  - Scenario description (background, goal, machine-verifiable success criteria)
  - `team_create` complete JSON config
  - Master's `team_*` launch invocation JSON + parameter selection notes
  - Execution timeline sequence diagram
  - Check script description
- **`check-math-*.ts`** — Math scenario check script (runnable with `bun`)
- **`check-physics-*.ts`** — Computational physics scenario check script
- **`check-coding-*.ts`** — Programming scenario check script

> **Challenge-level scenarios**: Beyond the 3 baseline scenarios (≤4 members, ≤30 min) per mode, there is 1 challenge-level scenario (6-10 members, larger scale, duration relaxed to 35-90 min), used to stress-test each primitive's scalability under large scale / high difficulty. Marked "(challenge-level)" in the mode READMEs; each mode's challenge topic is shown in column 4 of the "Scenario Matrix" above.

## Scenario Test Workflow

1. **Create team**: Call the `team_create` tool using the `team_create` JSON from the scenario README
2. **Activate team**: Call `team_activate` (not auto-activated by default)
3. **Launch orchestration**: Call the corresponding `team_*` tool using the master invocation JSON from the README
4. **Wait for completion**: Members execute in parallel/sequentially, OCTeam aggregates output to the master session
5. **Judge results**:

   ```bash
   bun demos/0N-team-<mode>/check-<theme>-<topic>.ts <run_dir>
   ```

   - `<run_dir>` is the output directory for that run (containing each member's `<member>.md` output)
   - Exit codes: `0` = PASS, `1` = FAIL (assertion failure), `2` = usage/IO error

## Scenario Quick-Start Prompts

Each scenario README ends with a "**Quick-Start Prompt (Copy and Use)**" section, providing one-click closed-loop prompts for all 3 baseline + 1 challenge-level sub-scenarios. Paste the corresponding prompt to the master session, and the AI will automatically complete "create team → activate → launch orchestration → wait for aggregation → run check script", reporting PASS / FAIL by exit code — **no manual JSON assembly needed**. The check scripts and quick-start prompts for challenge-level scenarios are consistent with the baseline scenarios.

For example, to launch the `01-team-parallel` Monte Carlo pi scenario: open [`01-team-parallel/README.md`](./01-team-parallel/README.md), go to "Quick-Start Prompt → Scenario 1", copy the `text` code block and paste it to the AI.

## Unified Time Control Design

Baseline scenarios follow:

| Dimension | Limit |
|------|------|
| End-to-end total duration | ≤ 30 min |
| Per-member subtask | ≤ 8 min |
| Member count | ≤ 4 |
| Sequential stages/rounds | ≤ 3 |
| Recursion depth | ≤ 2 |

**Challenge-level scenarios** relax to: 6-10 members, end-to-end 35-90 min; stages/rounds/depth vary by mode (see each mode's README).

## Related Documents

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — Official definitions and state persistence model for the 11 orchestration primitives
- parallel / consensus / pipeline / loop tool source: [`src/tools/parallel.ts`](../src/tools/parallel.ts) / [`consensus.ts`](../src/tools/consensus.ts) / [`pipeline.ts`](../src/tools/pipeline.ts) / [`loop.ts`](../src/tools/loop.ts)
- delegate / route / arbitrate / tollgate / arena / recurse / workflow tool source: [`src/tools/delegate.ts`](../src/tools/delegate.ts) / [`router.ts`](../src/tools/router.ts) / [`arbitrate.ts`](../src/tools/arbitrate.ts) / [`tollgate.ts`](../src/tools/tollgate.ts) / [`arena.ts`](../src/tools/arena.ts) / [`recurse.ts`](../src/tools/recurse.ts) / [`workflow.ts`](../src/tools/workflow.ts)
- [`src/core/role.ts`](../src/core/role.ts) — 22 role presets and their agent mappings
