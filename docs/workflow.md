# The Workflow Engine

`team_workflow` is OCTeam's deterministic orchestration primitive: a declaratively-composed array of steps that the engine — not the master LLM — drives to completion, keeping intermediate results out of the leader's context. This document explains the authoring format, how steps are lowered and executed, gate semantics, jumps and loops, fanout/join, and the planner. Full parameter tables live in [tools.md](./tools.md#team_workflow); mode-selection guidance lives in [modes.md](./modes.md).

## Authoring format

A workflow is either an inline `steps` array or a `workflow_file` (never both). Steps come in four kinds:

- **task** — a member does work and produces output.
- **gate** — a verifier evaluates prior task (or join) output and emits a PASS/FAIL/INVALID verdict; may jump conditionally.
- **fanout** — parallel branches (explicit `branches`, or generated from `matrix`/`foreach`), immediately followed by a **join** marker step.
- **join** — the join marker closing a fanout; carries no authoring fields of its own (join policy lives on the fanout).

Every field of every step is tabulated in [tools.md](./tools.md#team_workflow). The sections below explain what the fields *mean* at runtime.

## Workflow files

`workflow_file` is a JSON file relative to the workspace root:

```json
{
  "version": 1,
  "steps": [ { "kind": "task", "id": "probe", "member": "alice", "task": "..." } ]
}
```

Rules and resource caps (fail-fast on abuse, since the file lives in member-writable workspace space):

- `version` is optional (an absent version is treated as `1`); when present it must be a listed supported version (currently only `1`) — unlisted versions are rejected loudly rather than mis-parsed.
- The path must be relative, end in `.json`, and resolve **inside the workspace** (path containment + symlink-traversal checks).
- Raw file cap **1 MiB**; total step count (linear + nested, including matrix/foreach expansion) capped at **256**; raw `branches` arrays capped at **64** per fanout; fanout nesting depth capped at **8** (matrix/foreach templates recurse under the same depth budget).
- `vars` (top-level argument) substitutes `${name}` into every string field of the file before validation. Substitution is lenient by default — a `${name}` with no matching `vars` entry stays literal; strict mode is opt-in per file by setting `"strict_vars": true` in the file's raw JSON (unknown placeholders then error). Each variable value is byte-capped at 64 KiB (truncated with a `[...truncated]` suffix). Template recursion is depth-capped (20) and expansion output is byte-capped (512 KiB) against OOM.

Use `dry_run: true` to validate and render the numbered step ledger (exactly what the engine would execute, including fanout expansion) without starting anything.

## Lowering: authoring form → flat step array

The engine never sees the authoring JSON. `src/tools/workflow/lower.ts` lowers it first (`lowerWorkflowSteps`), in two phases so that **forward references resolve** (a gate's goto may point past a fanout):

1. **Phase 1** computes the complete public-index → flat-index map (`computePublicToFlat`), treating each fanout+branches+join trio as its future flat footprint.
2. **Phase 2** lowers each step through that map:
   - task/gate steps: 1-based step numbers in `target_step`/`targets`/`inputs`/gotos are converted to flat indices; string ids are preserved as-is (resolved later against lowered step ids at runtime). Step ids are preserved on the lowered steps.
   - fanout: becomes a **fanout marker** carrying the join configuration (branch ids, per-branch flat ranges, join index, join policy fields), followed by each branch's steps flattened in order (each tagged with branch metadata: fanout index, branch id, join index), followed by a **join marker** wired to that fanout (`fanoutIndex`, `branchTailIndices`, `maxErrored`, policy fields).
   - matrix/foreach fanouts are expanded into explicit `branches` **after** the file/shape validation pass and before lowering, with `${name}` (matrix) / `${as}` (foreach, default `item`) substituted into branch step text.

Goto references are scope-checked during lowering: a gate inside a branch may only jump within the same branch (branch-local refs), and a top-level gate may not jump to a branch-internal step. Gate **targets** (`target_step`/`targets`) are a different matter: a numeric target is index-checked, but a string-id target is resolved by an unrestricted backward search, so a top-level gate CAN target a branch-internal task step by id.

## Execution model

The engine (`src/orchestration/workflow/engine.ts`) is event-driven like every other mode, but walks the **active frontier**: at each advance it computes the sorted set of ready steps (`activeStepIndices`), dispatches what is not already in flight, and returns. Member idle events re-enter `advanceWorkflowStep`; the sweep timer enforces per-step timeouts and run bounds.

Key semantics:

- **Upstream context.** A task step implicitly receives the outputs of upstream task/join steps; `inputs: [...]` restricts this to explicit refs, and `expose_output: false` removes a step's output from implicit downstream context (explicit `inputs` refs can still include it). Upstream context is byte-budgeted at 65,536 bytes — the truncation marker and separators are not counted against the budget, so the assembled text can slightly exceed it.
- **Input guard.** If a task's declared `inputs` reference a step that is incomplete or was skipped, the run fails with `workflow_input_skipped` rather than dispatching with a missing dependency.
- **Task auto-retry.** `retry_on` + `max_task_retries` re-dispatch the same step when the output matches the condition (empty / contains / not-contains / regex — exactly one key).
- **Per-step timeout.** `timeout_ms` per step (from dispatch), with `on_timeout: fail | retry | skip` and `max_timeout_retries` — branch steps inside a fanout may only use the default `fail` policy (`retry`/`skip` and `max_timeout_retries` are rejected by validation; a branch timeout is handled as a fanout branch error under tolerance). Timeouts reset on backward jumps so an exhausted budget from a prior pass cannot fail the re-run immediately.
- **Output capture.** `max_output_bytes` caps the stored snapshot (head + tail preserved).
- **HITL pauses.** `approval_before` / `approval_after` pause for `team_approve` around a step (not allowed inside fanout branches). When the run itself has `human_approval: true`, a completed join also pauses before downstream steps continue.
- **Completion.** When no incomplete step remains: signoff (if configured) fires, then the run finishes `workflow_complete` (status idle).
- **Frontier deadlock.** If steps remain incomplete but none are ready (a corrupted or hand-repaired state), the run fails fast with `workflow_frontier_deadlock` instead of hanging to the wall-clock timeout.
- **Fallback actors.** `fallback_member` (task) / `fallback_verifier` (gate) are used when the primary has no live session; the reducer of a crashed reduce/select join is re-dispatched automatically.

## Gates

A gate verifies the output of its target step(s) — the nearest preceding task **or join** by default (gates and the fanout marker in between are skipped by the implicit-target scan), or `target_step`/`targets` refs. The verifier (distinct from every target's actor) receives the producer output, the criteria, and the verdict contract, and emits `<verdict>{"result":"PASS|FAIL|INVALID","rationale":"...","diff":"...","score":0-10,"confidence":0-1,"issues":[...]}</verdict>` (parsing rules in [modes.md](./modes.md#the-decision-block-protocol)).

Verdict meaning:

- **PASS** — the target output satisfies the criteria; the gate settles and the workflow advances.
- **FAIL** — the output is wrong (verifier supplies diff magnitude/location). Routed per `on_fail`: `fail` (default) terminates `workflow_failed:<verifier>`; `retry` re-dispatches the target **with the diff appended as feedback** up to `max_retries`; `skip` marks the gate complete and advances.
- **INVALID** — the verifier could not evaluate (broken reference, missing build, alignment failure) and the producer is **not** penalized. Routed per `on_invalid`: `fail`; `retry_verifier` (up to `max_invalid_retries`); or `escalate`, which pauses for leader approval (`team_approve`/`team_reject`, kind `workflow_step`) — approve advances, reject fails the run as `workflow_human_rejected`.
- **Malformed verdict** (missing/invalid `<verdict>` block) is treated as INVALID-shaped and routed per `on_malformed` (`fail` | `retry_verifier` | `skip` | `escalate`).

### Ensembles

`verifiers` (≥ 2) + `ensemble_policy` replace the single verifier. All verifiers are dispatched in parallel; when all have responded, `aggregateEnsembleVerdict` decides:

- **majority** — PASS only if pass > total/2; FAIL only if fail > total/2; otherwise INVALID (no majority).
- **quorum** — pass/total ≥ `ensemble_quorum` → PASS; fail/total ≥ threshold → FAIL; if **both** meet the threshold (a tie, e.g. 1P/1F at 0.5) → INVALID; otherwise INVALID (no quorum).
- **unanimous** — all PASS → PASS; all FAIL → FAIL; anything mixed → INVALID.

Any malformed verifier verdict makes the aggregate INVALID (with a parse-failure note), and a fully-unavailable ensemble (no verifier dispatched at all) never reaches aggregation — it takes the no-session failure path instead, so an empty result set cannot produce a vacuous PASS. Scores, confidences, and issues are aggregated **only from verifiers that support the final verdict** — dissenting scores can never trigger a `where` jump the verdict doesn't support. A score/confidence is recorded only when every supporting verifier supplied one (otherwise `where` on it is unevaluable).

### `where` conditions and gotos

A gate with `on_pass_goto` / `on_fail_goto` / `on_invalid_goto` jumps instead of linearly advancing. An optional `where` threshold (exactly one key: `score_gte` / `score_lt` 0-10, `confidence_gte` 0-1, `has_issue_severity` low|medium|high|critical) may gate the jump — validation requires a `where` to accompany `on_pass_goto` or `on_fail_goto`, and `where` is only evaluated for those two gotos: an `on_invalid_goto` fires unconditionally without consulting `where`. Evaluation of a gated jump is **tri-state**:

- `matches` — condition holds → jump fires.
- `does_not_match` — the verifier supplied the field and the condition is false → default successor (linear advance).
- `unevaluable` — the verifier **omitted** the field (or the configured threshold is out of range) → routed as INVALID, never fail-open. A verifier that neglected to report `issues` did not confirm their absence.

Jump mechanics (`gotoWorkflowStep`):

- **Forward jumps** mark every not-yet-completed intermediate step `completed + skipped` (steps that were already completed are left untouched) and settle the triggering gate; the target dispatches immediately.
- **Backward jumps** reset the whole target..gate range for re-execution: task outputs and retry counters cleared, gate verdicts/ensemble caches cleared, all gate retry counters (fail/invalid/malformed/timeout) zeroed **including the triggering gate**, and join runtime state (errored/survivor branches, selections, joined output) cleared so a re-run fanout starts clean.
- **Bounds.** Each jump increments the gate's `jumpCount`; exceeding `max_jumps` (default 3) terminates `workflow_failed:jump_limit:<verifier>`. A gate with `loop: { max_iterations: 1-20, on_exhaust: fail | continue }` and `on_fail_goto` counts backward FAIL iterations via `loopIterations` instead of `jumpCount`; on exhaustion the run fails (or continues, per `on_exhaust`). Retry counters and jump/loop bounds compose safely: retries reset on re-entry, loop bounds never do.

## Fanout and join

A fanout runs each branch's steps in parallel (branch steps may themselves be task or gate — no nested fanout). Every branch has a stable `id`. A **join marker must immediately follow** the fanout; the engine completes the fanout marker instantly and shepherds branches until the join can fire.

Branch generation: explicit `branches`, or `matrix` (cartesian product of named string arrays, `${name}` substituted into branch step text), or `foreach` (one branch per value, `${as}` substituted). The three are mutually exclusive.

A join fires when **all branches are terminal** (completed or errored) and the policy is satisfied (`joinPolicySatisfied`) — except `any_success`, which opens the join immediately when its first branch reaches a terminal successful state and marks every remaining non-terminal branch skipped (late results are ignored). A branch error that makes the policy unsatisfiable fails the run early (`joinPolicyImpossible` fail-fast):

| join_policy (on fanout) | join fires when | fails fast when |
|---|---|---|
| *(unset)* — tolerance | survivors ≥ 1 **and** errored ≤ `max_errored` | no survivors left, or errors exceed `max_errored` |
| `all` | zero errors | any branch errors |
| `quorum` | survivors/total ≥ `quorum` | survivors/total already < `quorum` |
| `any_success` | at least one survivor | no survivors left |
| `required_branches` | every id in `required_branches` survived | any required branch errored |
| `reduce` | zero errors, then the reducer combines | any branch errors |
| `select` | zero errors, then the selector picks | any branch errors |
| `use_survivors: true` (any policy) | at least one survivor | no survivors left |

- `reduce` dispatches `reducer_member` with all branch outputs: "Combine the branch outputs into ONE joined result; output ONLY the final result."
- `select` dispatches the selector with the surviving branch ids that expose a non-empty output (survivors whose branch output is empty are filtered out of the selection): it must emit `<selection>{"winner":"<branch_id>","rationale":"..."}</selection>`; the winning branch's output becomes the join output.
- With neither, the join output is the concatenation of branch outputs. The join output then feeds downstream steps like any task output (`inputs` can reference the join by number/id).

On member error inside a branch, `markWorkflowFanoutBranchErrored` applies tolerance semantics (within tolerance → the barrier continues with survivors; over tolerance → the run fails), scoped to the fanout, independent of the run-level `max_errored_members`.

## The planner (`team_planner`)

The planner authors team + workflow pairs through a human-in-the-loop flow — it never dispatches member sessions itself:

1. **`propose`** — an `oct-metis` child session drafts a team + workflow from `goal` (+ optional `constraints`) and returns a preview. Nothing is written.
2. **`revise`** — a fresh child session (each propose/revise call opens its own planner session, used for that call's correction rounds, then deleted) refines the previous plan from `feedback`. Preview only.
3. **`write`** — deterministic validation only (no model): the team must match `team_id`, use pool member names and valid roles/bounds; the workflow must be schema v1 with member/verifier references that resolve and producers ≠ verifiers. On success it persists **`team.<id>.json`** and **`workflow.<id>.json`** under the workspace via atomic writes under a `planner.lock` (no-overwrite by default; `overwrite: true` backs up originals and rolls back on failure; `dry_run: true` validates and shows target paths only).

The written workflow file is consumed by `team_workflow` via `workflow_file` (+ `vars`), so a planned pipeline is inspectable, versionable, and reusable.

## Repair and observability

- **`team_fix_workflow`** surgically repairs a stuck run — `redispatch` / `skip` / `advance` / `fail` / `reassign` — under atomic snapshot/rollback with invariant re-validation. Full semantics in [tools.md](./tools.md#team_fix_workflow).
- **`team_progress`** with `format: "mermaid"` renders the live step graph; `team_result_get` renders the persisted step tree (verdicts, retries, jumps, durations) after the run.
- **`team_resume`** restarts an interrupted workflow from its checkpoint (workflow mode is fully resumable).
- Structural **invariants** (`invariants.ts`) are re-checked by `team_fix_workflow` around its state mutations (skip/advance check before mutating, reassign after; `fail` does not check) — resume does not re-check them.

## Troubleshooting validation errors

Common `validate`/`lower` rejections and their meaning:

| Error (condensed) | Cause / fix |
|---|---|
| `either steps or workflow_file is required` / `steps must contain at least one step` | Pass exactly one of the two (the active check reads `Error: team_workflow must set exactly one of steps or workflow_file`). |
| `workflow expands to N steps, exceeding the 256 limit` | Total step count (linear + nested + matrix/foreach expansion) is too large; split the workflow. (Workflow-file expansion overruns surface as `matrix/foreach expansion (N branches × M steps) exceeds the 256-step budget`.) |
| `duplicate step id "<id>" at steps N and M` | Step ids must be unique across the whole workflow. |
| `join step N has no matching fanout step` | A `join` marker must immediately follow its fanout. |
| `join step has join-policy fields` / `quorum`/`required_branches`/`reducer_member` only with join_policy | Join policy fields belong on the **fanout**, not the join marker; `quorum`/`required_branches`/`reducer_member` require the corresponding `join_policy`. |
| `gate ... must not cross fanout boundaries` | Branch gotos are branch-local; a top-level gate cannot target a branch-internal step. Use a top-level step ref. |
| `matrix`/`foreach`/`branches` exclusivity errors | Provide exactly one of branches / matrix / foreach per fanout. |
| `workflow_file must be relative to the workspace` / `... a .json file` / `... stay inside the workspace` | Path must be workspace-relative JSON without traversal. |
| Unknown `${name}` template variable | Only in strict mode (`"strict_vars": true` in the file): every placeholder needs a `vars` entry. By default unknown placeholders stay literal. |
| `unsupported workflow file version` | The file's `version` must be `1`. |
| `failed to load team state for dry-run` | dry_run still needs a readable, valid team state. |

Runtime failure reasons worth recognizing (from `reasons.ts`): `workflow_failed:<verifier>` (FAIL with `on_fail: fail`), `workflow_failed:jump_limit:<verifier>` (`max_jumps` exceeded), `workflow_failed:no_session:<actor>` (no live actor or fallback), `workflow_failed:fanout:<step>:all_errored` / `...:over_tolerance` (branch error tolerance), `workflow_invalid:<reason>:<verifier>` (INVALID with `on_invalid: fail`), `workflow_human_rejected` (a rejected `workflow_step` escalation approval), `workflow_failed:<reason>` (operator `fail` via team_fix_workflow), plus `workflow_input_skipped`, `workflow_frontier_deadlock` (incomplete but no ready step — usually a hand-edited state), and the shared `timeout` / `budget_exceeded` / `member_turn_limit:<name>` termination rules (see [modes.md](./modes.md#shared-termination-semantics)).
