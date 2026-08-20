# OCTeam Orchestration Modes

This document is the reference for OCTeam's eleven orchestration modes: what each mode's shape is, what members must emit (the member contract), and when a run ends or fails. Full parameter tables for each `team_*` tool live in [tools.md](./tools.md); this document does not repeat them. The workflow engine (`team_workflow` / `team_planner`) is covered separately in [workflow.md](./workflow.md). Architecture context: [arch.md](./arch.md).

## The decision-block protocol

Members communicate decisions to the orchestrator by emitting XML-style tagged JSON blocks in their response text (not via `team_send_message`). All parsing lives in `src/orchestration/protocol/decisions.ts` and is deliberately strict — malformed output is counted and retried, never guessed at.

Shared parsing rules (`extractTaggedJSON`):

- The **last complete tag pair** in the output is authoritative. An unclosed opening tag (truncated output) or a stray opening tag after the last complete pair is a parse failure, not "no decision".
- Opening and closing tags must use the same language; most tags accept a Chinese alias (shown per tag below).
- The payload must contain **exactly one top-level JSON object** — balanced braces, no array wrapping, no concatenated objects.
- **Duplicate top-level JSON keys are rejected** (`{"approved":false,"approved":true}` fails rather than silently taking last-wins).
- String escapes are honored during brace scanning; nested objects inside string values cannot break the parse.

Tag catalog:

| Tag | Emitted by | Payload | On malformed / absent |
|-----|-----------|---------|----------------------|
| `<decision>` / `<决策>` | loop decider | `{"decision":"done"\|"continue","rationale":"...","nextActions":["..."]}` | parse failure counted; run fails after the cap (default 3) |
| `<route>` / `<路由>` | route router | `{"branch":"name","rationale":"..."}` or `{"branches":["a","b"],"rationale":"..."}` | parse failure counted; run fails after the cap (default 2) |
| `<ruling>` / `<裁决>` | arbitrate arbiter | `{"decision":"...","rationale":"..."}` (a `ruling` key is accepted as an alias; conflicting alias values fail) | parse failure counted; run fails after the cap (default 2) |
| `<verdict>` / `<判定>` | tollgate and workflow verifiers | `{"result":"PASS"\|"FAIL"\|"INVALID","rationale":"...","diff":"...","score":0-10,"confidence":0-1,"issues":[{"severity":"low"\|"medium"\|"high"\|"critical","message":"..."}]}` | treated as INVALID — the verifier could not evaluate — never as a producer FAIL |
| `<scoreboard>` / `<评分板>` | arena evaluator | `{"scores":[{"member":"...","score":1.5,"metrics":{"k":1},"passed":true,"rationale":"..."}],"rationale":"..."}` | one invalid entry or duplicate member fails the entire board (no lossy filtering) |
| `<decompose>` / `<分解>` | recurse members | `{"subtasks":[{"subject":"...","description":"..."}]}` (subject ≤ 500 chars, description ≤ 8192) | **absent tag is not a failure** — it means "solved directly"; an explicit tag with no valid subtasks is a parse failure |
| `<consensus>` / `<共识>` | consensus participants | `{"agreed":true\|false}` | parse failure; a participant without a valid block can never count as agreeing |
| `<vote>` / `<投票>` | quorum participants | `{"<vote_key>":"value","rationale":"..."}` where `vote_key` is the run's ballot field | ballot abstains (excluded from the denominator) |
| `<selection>` / `<选择>` | reduce/fanout `select` reducer | `{"winner":"...","rationale":"..."}` | parse failure |
| `<signoff>` / `<签核>` | signoff reviewers | `{"approved":true\|false,"rationale":"..."}` | missing or non-boolean `approved` is a parse failure (retried, up to 3) — distinct from an explicit `approved:false` rejection |
| `<no_issues/>` / `<无问题/>` | loop read-only stages | literal self-closing tag, must be the **last** thing in the output (after trailing-whitespace trim) | absent = normal output |

A few payloads have additional strictness worth knowing:

- `<decision>`: only the literal strings `"done"` / `"continue"` are accepted (misspellings fail). A boolean `done:true` is accepted if consistent with `decision`. `nextActions` must be an array of strings if present.
- `<route>`: accepts `branch`/`branches`/`target`/`targets` aliases, but if multiple aliases are present with **different** values the decision fails rather than silently picking one. Every array entry must be a non-empty string; branch existence is validated against the run's declared routes.
- `<ruling>`: the ruling text must be non-empty after trimming.
- `<verdict>`: `result` is upper-cased before matching; `score` must be a finite 0-10 number and `confidence` a finite 0-1 number to be recorded.
- `<scoreboard>`: every `score` and every `metrics` value must be a finite number; `passed` defaults to false.

## Shared termination semantics

Every mode runs under the same termination checker (`src/orchestration/lifecycle/termination.ts`), evaluated on idle events and by the background sweep timer:

- **Wall-clock timeout** (`timeout_ms`, clamped by `bounds.maxWallClockMinutes`): fails the run with reason `timeout`. Human-approval pauses **suspend** wall-clock accounting — approve/reject shifts `startedAt` forward by the paused duration.
- **Approval timeout** (`approval_timeout_ms`, HITL runs only): fails a pending approval pause with `approval_timeout:<kind>:<ms>` so an unavailable leader cannot leave the run busy forever.
- **Token budget** (`token_budget`): fails with `budget_exceeded` once `tokensUsed` exceeds it.
- **Member turn limit** (`bounds.maxMemberTurns`): fails with `member_turn_limit:<name>` — stops a runaway member.
- **Member errors**: a member whose session errors (dispatch failure after `max_retries` grace windows) sets its status to `errored`. Tolerance is mode-scoped:
  - Concurrent modes (parallel, delegate, recurse, quorum) tolerate up to `max_errored_members`; within tolerance the barrier delivers survivors' work.
  - Sequential modes (pipeline, loop, consensus, and single-target tollgate stages) have tolerance 0 — the first member error fails the run with `member_error:<name>:<error>`.
  - Arena is phase-scoped: during implement, candidate errors are checked against `max_errored_members` (zero survivors fails with `arena_failed:no_survivors`); during evaluate, only an errored evaluator fails the run.
  - During a signoff stage, errored reviewers are handled by the signoff quorum logic (excluded from the quorum denominator), not by generic fail-fast.
- **Cancel / resume**: `team_cancel` ends the run (outcome `cancelled`); a crashed run is resumable from its checkpoint via `team_resume` (see [tools.md](./tools.md#run-control)).

## Mode-by-mode reference

### team_parallel — run a task across all members

Shape: every non-master member receives a task at once (isolated: identical task, no inter-member messaging; cooperative: per-member tasks, free messaging via `team_send_message`). A barrier fires when all participants are done; an optional reduce sub-stage combines outputs.

Member contract: plain work output — no decision block for the work itself. Two optional contracts exist:

- With `require_done_ack: true`, each member calls `team_done` exactly once when finished (instead of just going idle); members that idle without acking are automatically re-prompted.
- When `reduce_policy` is `select`, `merge`, or `rubric`, a reducer member combines the outputs and (for `select`) emits `<selection>{"winner":"...","rationale":"..."}</selection>`; for other policies the reducer outputs only the final combined result.

Termination: all-idle (or all-acked) barrier → reduce (if configured) → signoff (if configured) → summary to leader. `max_errored_members` tolerates failed members; all participants errored fails the run.

Example:

```json
{
  "team_id": "refactor-batch",
  "mode": "cooperative",
  "tasks": { "alice": "Migrate src/a/ to the new API", "bob": "Migrate src/b/ to the new API" },
  "reduce_policy": "merge",
  "reducer_member": "carol",
  "max_errored_members": 1
}
```

### team_consensus — debate until everyone agrees

Shape: all non-master members (≥ 2 required) receive the topic each round; every participant must emit `<consensus>{"agreed": true|false}</consensus>`.

Member contract: state a position, end with the consensus block. A participant that never emits a valid block can never count as agreeing — `allMembersAgree` requires **every** named participant to have a response parsing to `agreed:true`.

Termination: success when all participants agree in the same round; failure when `max_rounds` (default 3) is exhausted without consensus. Tolerance to member errors is 0. No signoff gate — unanimous agreement is itself the completion gate.

Example:

```json
{ "team_id": "design-council", "topic": "Adopt SQLite or Postgres for the audit store", "max_rounds": 5 }
```

### team_pipeline — linear stage chain

Shape: stages run in order; each completed stage's output is prefixed onto the next stage's task (upstream context is capped). The final stage's output is summarized to the leader.

Member contract: plain work output. No decision blocks.

Termination: success after the last stage (plus optional signoff); any member error fails the run (tolerance 0); shared timeouts as usual. With `human_approval`, the run can pause between stages (`pipeline_stage` approval kind).

Example:

```json
{
  "team_id": "release-line",
  "stages": [
    { "member": "alice", "task": "Implement the exporter" },
    { "member": "bob", "task": "Write integration tests for the exporter" },
    { "member": "carol", "task": "Draft release notes from the test report" }
  ]
}
```

### team_loop — code, review, decide, repeat

Shape: round-based corrective loop. Each round dispatches `initial_task` (round 1) or the decider's next actions to the modify stages, then collects reviews; the decider closes the round.

Member contract:

- Work stages: plain output. Read-only stages get an extra contract: "If you find NO issues, end your reply with the literal tag `<no_issues/>` (or `<无问题/>`) — it ends the loop."
- Decider: must emit `<decision>{"decision":"done"|"continue","rationale":"...","nextActions":["..."]}</decision>`. The auto-appended decider stage instructs literal English tags; the parser also tolerates `<决策>`.

Termination: success when the decider rules `"done"`; early success when **every** read-only stage ends with `<no_issues/>` in the same round; failure on `max_rounds` exhaustion, `max_decision_parse_failures` (default 3) consecutive malformed decisions, timeout (default 15 min), or member error (tolerance 0). `loop_done` approvals allow the leader to gate completion; rejection (with feedback) forces another round.

Example:

```json
{
  "team_id": "bugfix-loop",
  "stages": [
    { "member": "alice", "task": "Fix the failing suite", "action": "modify" },
    { "member": "bob", "task": "Re-run the suite and report failures", "action": "read_only" }
  ],
  "decider": "carol",
  "max_rounds": 8,
  "initial_task": "tests/e2e/auth.spec.ts fails on refresh-token rotation"
}
```

### team_delegate — publish tasks, members self-claim

Shape: tasks are published to the shared task list (with `blocked_by` refs resolved to a DAG); idle members self-claim via `team_task_update(status="claimed")`, execute, and report via `team_send_message`.

Member contract: claim → work → report. One active task per member at a time (claim → complete → claim next); a claim is refused while any `blocked_by` blocker is not completed/deleted. Members may also delete their own tasks. Completion here is member-driven (unlike recurse).

Termination: the run ends when all published tasks reach a terminal status (completed/deleted) or the bounds expire; `max_errored_members` tolerates failed members. Signoff optional. A notification cooldown paces re-prompting of idle members toward claimable tasks.

Example:

```json
{
  "team_id": "docs-squad",
  "tasks": [
    { "ref": "api", "subject": "Document the REST API", "description": "Cover auth, pagination, errors." },
    { "ref": "sdk", "subject": "Document the SDK", "description": "Quickstart + examples.", "blocked_by": ["api"] }
  ]
}
```

### team_route — content-based routing

Shape: phase A dispatches **only** the router with the input and the branch list; the router's parsed selection determines which branch members run in parallel; their outputs are summarized.

Member contract: the router emits `<route>{"branch":"name"}` (or `{"branches":[...]}` for multiple). Branch members produce plain work output.

Termination: selected branches complete → summary (plus optional signoff). Unmatched input (no route selected) fails the run — there is no default route. Failure also on `max_route_parse_failures` (default 2) consecutive router parse failures, a selection naming a non-existent branch, or member error (tolerance 0). `route_decision` approvals can gate the dispatch.

Example:

```json
{
  "team_id": "triage",
  "router": "quinn",
  "input": "User report: payment webhook returns 500 intermittently",
  "routes": [
    { "name": "backend", "member": "alice", "description": "API/server-side defects" },
    { "name": "infra", "member": "bob", "description": "deployment/network issues" },
    { "name": "docs", "member": "carol", "task": "Draft a known-issue note", "description": "user-facing communication" }
  ]
}
```

### team_arbitrate — debate, then a binding ruling

Shape: debaters (2-12) argue for up to `max_rounds` (default 1); round 1 states positions, later rounds rebut; then the arbiter (never a debater) weighs every final position and issues a binding ruling.

Member contract: debaters produce plain argument text; the arbiter emits exactly one `<ruling>{"decision":"...","rationale":"..."}</ruling>`.

Termination: the ruling is delivered to the leader as the run result (optionally signed off). Failure on `max_ruling_parse_failures` (default 2) consecutive malformed rulings or member error (tolerance 0). `max_rounds` exhaustion is a normal transition to the ruling phase, not a failure. With `human_approval`, `hitl_phase` chooses the pause point(s): `pre` (after debate, before ruling — default), `post` (after ruling, before delivery), or `both`.

Example:

```json
{
  "team_id": "arch-court",
  "task": "Dispute: monolith-first vs service-split for v2",
  "arbiter": "wanda",
  "debaters": ["alice", "bob", "carol"],
  "max_rounds": 2,
  "hitl_phase": "pre"
}
```

### team_recurse — recursive decomposition

Shape: a root task (depth 0) is seeded into the shared task list; the decomposer is dispatched with the recursive contract; any member may claim leaf tasks; results aggregate up the `blocked_by` DAG until the root is solved.

Member contract (enforced by the dispatch prompt):

1. **Claim first** (`team_task_update(status="claimed")`), then read the task. Output from a member holding no claimed/in_progress task is ignored.
2. Either solve directly (final message is the result), or — if too large — emit exactly one `<decompose>{"subtasks":[{"subject":"...","description":"..."}]}</decompose>`.
3. If the claimed task's subtasks are complete, synthesize their results instead of re-decomposing.
4. Never call `team_task_create` (subtasks come only from the parsed block) and never self-complete — the orchestrator finalizes the task when the member goes idle, writing the captured output as the result.

Termination: success when the root task is completed by aggregation; failure on depth/subtask-cap violations being unrecoverable, `max_aggregation_dispatches` (default 3) aggregation stalls, task-cap exhaustion, or member errors beyond `max_errored_members`. A member that keeps re-emitting `<decompose>` after being forced to solve directly is failed after 3 retries. `recurse_decompose` approvals gate each decomposition.

Example:

```json
{
  "team_id": "migration-team",
  "task": "Port the 400-case legacy test suite to the new harness",
  "decomposer": "alice",
  "max_depth": 3,
  "max_subtasks": 5
}
```

### team_tollgate — verdict-gated pipeline

Shape: each stage has a producer and a distinct verifier. The producer works; the verifier then checks the output against `criteria` (optionally against a golden `reference` with dimension alignment and per-point differences) and emits `<verdict>{"result":"PASS|FAIL|INVALID",...}</verdict>`. The next stage starts only on PASS.

Member contract: producers output plain work; verifiers emit exactly one verdict block. Semantics enforced: PASS = correct within tolerance; FAIL = wrong (with diff magnitude and location); INVALID = the verifier **cannot evaluate** (broken reference/build/alignment) and is not the producer's fault. A missing/malformed verdict block is treated as INVALID.

Termination: all stages pass → summary (plus optional signoff). FAIL re-dispatches the producer with the diff up to `max_gate_retries` (default 0 — first FAIL fails the run with `tollgate_failed:<stage>`); INVALID escalates (`escalate_to` or the leader) without penalizing the producer, and repeated INVALID ping-pong fails after `max_invalid_cycles` (default 3) with `tollgate_invalid:exhausted`. Role separation is validated up front: a verifier never equals its producer, no member is producer in one gate and verifier in another, and producers are unique across stages. `tollgate_gate` approvals can pause before verification or on INVALID escalation.

Example:

```json
{
  "team_id": "numerics",
  "stages": [
    {
      "member": "alice",
      "task": "Run the crash simulation and export the grid",
      "verifier": "bob",
      "criteria": "Max relative error per grid point <= 1e-4 against the reference",
      "reference": "benchmarks/case7/golden.csv"
    },
    {
      "member": "carol",
      "task": "Fit the surrogate model on the verified grid",
      "verifier": "bob",
      "criteria": "Held-out RMSE within 5% of the baseline model"
    }
  ],
  "max_gate_retries": 1
}
```

### team_arena — competitive implementation

Shape: every candidate (worktree-isolated) implements the same task in its own worktree during the implement phase; the evaluator then scores every surviving candidate on the same basis and the winner is delivered directly (no signoff).

Member contract: candidates produce plain work output (in their worktrees); the evaluator emits exactly one `<scoreboard>{"scores":[{"member":"...","score":n,"metrics":{...},"passed":bool,"rationale":"..."}],"rationale":"..."}</scoreboard>`. The evaluator prompt pins the absolute worktree paths and — when an `eval_command` is given — instructs scoring the **working tree** (uncommitted agent edits included), never a committed ref.

Termination: the deterministic winner is selected on `winner_metric` (default `score`) with `score_direction` (default `max`); ties are broken deterministically. Failure when all candidates error during implement (`arena_failed:no_survivors`), more candidates error than `max_errored_members` allows, or the evaluator errors / exhausts `max_eval_retries` (default 1) on malformed scoreboards.

Example:

```json
{
  "team_id": "algo-bakeoff",
  "task": "Implement the fastest correct top-K aggregation in src/topk/",
  "evaluator": "referee",
  "eval_command": "bun test src/topk/ && bun bench src/topk/bench.ts",
  "winner_metric": "p99_ms",
  "score_direction": "min"
}
```

### team_quorum — replicated k-of-n voting

Shape: a single-round, fixed-schema question sent verbatim to all participants; everyone runs to completion (no early exit, no debate); ballots are tallied once all are in.

Member contract: each participant emits `<vote>{"<vote_key>":"<value>","rationale":"..."}</vote>` with the run's ballot field name (e.g. `vote_key:"decision"` → `{"decision":"ship"}`). A vote outside `vote_options` (when provided), a missing key, or a malformed block abstains — excluded from the denominator, never counted as the majority's opposite.

Termination: the option with **strict majority** (`k > valid_ballots / 2`) wins; the verdict is delivered to the leader. Failure when fewer than 2 participants, duplicate participants, or more runtime-errored members than `max_errored_members` (default: all but one) — but never a "no majority" failure: a tie simply means no option won and is reported as such.

Example:

```json
{
  "team_id": "release-board",
  "task": "Should v2.1 ship on Friday? Answer for the release go/no-go.",
  "vote_key": "decision",
  "vote_options": ["ship", "hold"],
  "members": ["alice", "bob", "carol", "dave", "erin"]
}
```

## Choosing a mode

| You need | Use |
|----------|-----|
| Same question, independent answers, one verdict | quorum (fixed options) or consensus (open debate) |
| Independent partitions of work, combined at the end | parallel (+ reduce) |
| Sequential transformation, each step feeding the next | pipeline |
| Iterate until a reviewer says done | loop |
| Push tasks to whoever is free | delegate |
| Send each input to the right specialist | route |
| Settle a dispute with a binding decision | arbitrate |
| Unknown-size work, decompose on demand | recurse |
| Every stage must be verified before the next | tollgate (simple) or workflow (branching/conditional) |
| Compare competing implementations of the same task | arena |
| Deterministic multi-step control flow with gates, fanout, jumps | workflow (see [workflow.md](./workflow.md)) |
