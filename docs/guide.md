# OCTeam User Guide

This guide takes you from a fresh install to a running team in a few minutes, then walks the paths you will use daily: picking a mode, watching a run, steering it, and recovering from crashes. Every section links to the reference documents for full detail — [tools.md](./tools.md) (all 42 tools), [modes.md](./modes.md) (the 11 orchestration modes), [workflow.md](./workflow.md) (the workflow engine), and [arch.md](./arch.md) (internals).

## What is OCTeam?

OCTeam is an OpenCode plugin for **persistent multi-agent teams**: one leader session (the "master" — you) coordinates up to 12 member sessions, each running a hardened read-only or write-capable agent preset. Teams are declared once with roles and prompts, spawn lazily when work starts, and persist entirely on disk — a team survives OpenCode restarts, and an interrupted orchestration can be resumed.

## The mental model

Five facts explain almost every tool:

1. **Master and members.** Your session creates the team and becomes its master. Only the master starts orchestrations; members do the work. Members run `oct-*` agent presets (read-only roles cannot edit files; write-capable roles can, in the project directory).
2. **One active team per session.** Creating a team does not activate it. `team_activate` makes it the session's active (available) team — at most one at a time; switch explicitly by deactivating first. After a restart, project-scope teams are never auto-active; activate again (user-scope teams may keep their activation — they can be in use by sibling processes).
3. **One orchestration at a time.** A team is `live` (idle) or `busy` (one orchestration running). Lifecycle edits (add/remove/rename/delete) require the live state.
4. **Everything is on disk.** Under `.octeam/` (project scope, segmented per lead session) or `~/.octeam/` (user scope): team config and state, member mailboxes, the shared task list, and one directory per run with full member outputs and an event timeline. Teams survive crashes; nothing important lives only in memory.
5. **Members emit decision blocks.** Orchestration modes parse strict XML-tagged JSON (`<decision>`, `<verdict>`, ...) from member output rather than free-form text — that is what makes runs deterministic and auditable (see [modes.md](./modes.md#the-decision-block-protocol)).

The lifecycle you will repeat: **create → activate → orchestrate → observe → (steer) → deactivate/delete**.

## Quickstart: your first run

Installation is covered in the [README](../README.md#install). Once the plugin is loaded, the 42 `team_*` tools are available in your session.

**1. Create a team** — members need a role (unknown roles fall back to the read-only `reviewer`) and a prompt describing their job. Names are auto-assigned from a preset pool when omitted:

```json
team_create {
  "name": "docs-team",
  "description": "Maintain the project documentation",
  "members": [
    { "name": "alice", "role": "writer",   "prompt": "You write clear, concise English documentation." },
    { "name": "bob",   "role": "reviewer", "prompt": "You review docs for accuracy and tone. Be specific." }
  ]
}
```

**2. Activate it** — until activated, orchestration tools refuse the team:

```json
team_activate { "team_id": "docs-team" }
```

**3. Start an orchestration** — the simplest mode runs one task across all members:

```json
team_parallel {
  "team_id": "docs-team",
  "mode": "isolated",
  "task": "Read README.md and propose three concrete improvements. Output only the list."
}
```

Member sessions spawn now (lazily — this is the first moment they exist). The run returns asynchronously; your session stays free.

**4. Watch it finish** — the master is notified with a summary when the run completes. To check in at any time:

```json
team_progress { "team_id": "docs-team" }   // live member states + event timeline
team_results  { "team_id": "docs-team" }   // index of finished runs
```

Fetch a finished run's full output (omit `run_id` for the latest):

```json
team_result_get { "team_id": "docs-team", "run_id": "run_..." }
```

That's the whole loop. Everything else is variation: different modes, workflows, steering, recovery.

## Picking the right mode

The full decision table lives in [modes.md](./modes.md#choosing-a-mode). The short version:

- **Independent answers to one question** → `team_quorum` (fixed options, majority) or `team_consensus` (open debate, unanimous).
- **Independent chunks of work, merged at the end** → `team_parallel` (+ a `reduce_policy` to combine).
- **Sequential pipeline, each stage feeding the next** → `team_pipeline`.
- **Iterate until a reviewer says done** → `team_loop`.
- **Push tasks to whoever is free** → `team_delegate`.
- **Route each input to the right specialist** → `team_route`.
- **Settle a dispute with a binding ruling** → `team_arbitrate`.
- **Unknown-size work, decompose as you go** → `team_recurse`.
- **Every stage verified before the next** → `team_tollgate` (simple chain) or `team_workflow` (branching, conditions, fanout).
- **Competing implementations of the same task** → `team_arena` (needs `worktree: true` members).

All orchestration tools share run bounds (`timeout_ms`, `token_budget`, `max_retries`), an optional post-run **signoff** review gate, and optional **human-approval pauses** mid-run (see [tools.md](./tools.md#shared-conventions-for-the-orchestration-tools)).

## Your first workflow

`team_workflow` composes task, gate, fanout, and join steps into a deterministic engine-run sequence. A minimal gated workflow — implement, then verify:

```json
team_workflow {
  "team_id": "docs-team",
  "steps": [
    { "kind": "task", "id": "write", "member": "alice",
      "task": "Draft the missing INSTALL section for README.md." },
    { "kind": "gate", "id": "check", "verifier": "bob",
      "criteria": "The draft is accurate, concise, and matches the repo's actual install steps." }
  ]
}
```

The gate's verifier emits a PASS/FAIL/INVALID verdict; on FAIL the run fails (default) or retries the producer with the diff (`on_fail: "retry"`). Add branching with `fanout`/`join`, conditional jumps with `on_pass_goto` + `where` thresholds, and parallel verifiers with `verifiers` + `ensemble_policy` — the full authoring format is in [workflow.md](./workflow.md).

Prefer not to hand-write JSON? Use the planner:

```json
team_planner { "op": "propose", "team_id": "release-team",
               "goal": "A team that cuts, verifies, and documents releases" }
```

Review the preview, `revise` with feedback, then `write` — which persists `team.release-team.json` + `workflow.release-team.json` in the workspace. Create the team from the plan (or let the planner's team spec guide your `team_create`), then run it with `team_workflow { "workflow_file": "workflow.release-team.json" }`.

## Watching and steering a run

Observability (all safe to call any time):

| Tool | Use it for |
|---|---|
| `team_details` | Team status, active run progress, per-member states and tokens |
| `team_progress` | Live member states + the run's event timeline; `format:"mermaid"` renders a live workflow graph |
| `team_results` / `team_result_get` | Index of finished runs / one run's full record and member outputs |
| `team_metrics` | Token and success-rate aggregates over recent runs |
| `team_query` | One member's configuration and status |

Steering, when a run needs a human decision:

| Tool | Use it when |
|---|---|
| `team_cancel` | Kill the run; team returns to idle and stays reusable |
| `team_approve` / `team_reject` | A `human_approval` pause is waiting on you (feedback is forwarded) |
| `team_intervene` | Inject a high-priority directive into a member mid-run (does not alter control flow) |
| `team_fix_workflow` | A workflow step is stuck: redispatch / skip / advance / fail / reassign it |
| `team_resume` | An interrupted (crashed) run should continue from its checkpoint |

## Members cooperating directly

During cooperative runs (and outside runs generally), members talk through mailboxes and a shared task list:

- `team_send_message` — point-to-point or `to: "*"` broadcast (master-only). Recipients see messages injected on their next turn.
- `team_task_create` / `team_task_list` / `team_task_update` / `team_task_get` — the shared list with `blocked_by` dependencies. Members claim tasks atomically (`status: "claimed"` makes them the owner; one active task per member) and complete them when done. In `team_recurse` runs this list is the backbone — members claim, solve, or `<decompose>` (see [modes.md](./modes.md#team_recurse--recursive-decomposition)).

## Crashes and restarts

Nothing is lost when OpenCode exits:

- **Teams** are fully on disk; after restart, `team_list` still shows them. Project-scope teams start inactive — `team_activate` again (a user-scope team may still be active if a sibling process kept it so).
- **A run that was in flight** is marked failed with a preserved checkpoint; `team_resume` re-dispatches it from where it stopped.
- **Mailboxes** are crash-safe JSONL with at-least-once delivery (reserved lines are never lost; a crash between reservation and acknowledgment can requeue them).
- **Stale task claims** for active delegate/recurse runs are reaped by the background sweep timer (timestamp-based); stale file locks are recovered when their lock path is next acquired.

The internals of the startup reconciliation are in [arch.md](./arch.md#startup-and-crash-recovery).

## Troubleshooting quick hits

| Symptom | First check |
|---|---|
| `Error: ... requires team_activate` (activation gate) | Teams are never auto-active; call `team_activate` after create and after every restart. |
| `Error: team already has an active orchestration` | One orchestration at a time; `team_progress` to watch, `team_cancel` to stop. |
| `Error: team "<id>" is busy ... (workflow calls)` | Lifecycle edits (add/remove/rename) need the `live` state; wait or cancel first. |
| Run finished `failed` with `member_error:<name>` | A member session errored past its retry budget; `team_query` the member, then retry the run. |
| Run finished `failed` with `decision_parse_failure` (loop/route/arbitrate) or `workflow_invalid:parse_failure:<verifier>` | A member kept emitting malformed decision blocks; check the member's prompt expectations in [modes.md](./modes.md#the-decision-block-protocol). |
| Workflow failed `workflow_failed:jump_limit:<verifier>` | A gate's conditional jump looped more than `max_jumps` (default 3); fix the loop or raise the cap. |
| Workflow stuck on an incomplete step | `team_fix_workflow` (redispatch/skip/advance/reassign) — see [tools.md](./tools.md#team_fix_workflow). |
| Member never gets work in a cooperative run | Cooperative `tasks` map by member name — unassigned members get a placeholder; check spelling. |
| `team_arena` startup error about worktrees | Candidates must be created with `worktree: true`. |
| Team invisible after restart | Project scope segments teams per lead session — reuse the same session, or check the scope option (`["octeam", { "scope": "user" }]`). |

## Where to go next

- **"I want the full parameter list for a tool"** → [tools.md](./tools.md)
- **"How does a mode decide success/failure?"** → [modes.md](./modes.md)
- **"I need branching, gates, or fanout"** → [workflow.md](./workflow.md)
- **"How does this work internally?"** → [arch.md](./arch.md)
- **"Show me complete real-world scenarios"** → [demos/](../demos/README.md)
