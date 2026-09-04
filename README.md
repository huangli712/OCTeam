# OCTeam

OCTeam is a multi-agent team orchestration system for OpenCode. It is an OpenCode plugin that lets you create long-lived teams of up to 12 agent sessions — each with its own role, prompt, and optional agent — and orchestrate them with twelve workflow primitives.

**Version:** 0.14.8

## Why OCTeam?

A single agent session gives you one context window, one model, and one line of reasoning. For large or high-stakes work that is not enough: you want parallel throughput, specialized roles, and independent verification. OCTeam gives you a durable team of agent sessions plus the orchestration primitives to drive them:

| | Single session | OCTeam |
|---|---|---|
| Context | One context window | Up to 12 member sessions, each with its own context |
| Reasoning | One model, one line of thought | Different roles, models, and agents in parallel |
| Lifetime | Session-scoped | Team state persists on disk across restarts |

Around the team, the engine adds master-only orchestration, human-in-the-loop approval pauses, isolated per-member git worktrees, and crash recovery via checkpoints. Teams are long-lived: members, mailboxes, shared task lists, and run records persist on disk, survive restarts, and stay observable and repairable mid-run (`team_progress`, `team_results`, `team_fix_workflow`, `team_resume`).

## Typical scenarios

- **Parallel review.** Several reviewers read the same change from correctness, security, and style angles at once; you merge their findings (`team_parallel`).
- **Pipeline handoffs.** Spec → implement → test → review, each stage run by a member whose output feeds the next (`team_pipeline`).
- **Debate, voting, and ruling.** Members argue opposing positions and an arbiter issues a binding ruling — for design decisions where a single answer is easy to get wrong (`team_consensus`, `team_arbitrate`); N members answer the same question independently and strict majority wins (`team_quorum`).
- **Competitive arena.** Candidates implement rival solutions in isolated git worktrees; an evaluator scores them and one winner is delivered (`team_arena`).
- **Recursive decomposition.** A large goal splits into subtasks, subtasks into sub-subtasks, and results aggregate back up (`team_recurse`); idle members self-claim work from a shared task market (`team_delegate`).
- **Verdict-gated work.** A stage runs only after a verifier passes the previous stage's output; FAIL sends it back with a diff (`team_tollgate`, `team_loop`).
- **Dynamic routing.** A router inspects each input and selects the branch(es) that handle it — triage, classification, fan-out by topic (`team_route`).
- **Composed workflows.** Declarative task/gate/fanout/join DAGs with engine-driven retry, recovery, and join policies (`team_workflow`).

In short: OCTeam is not a smarter agent — it is the coordination layer that turns several agents into one team.

## Key concepts

**Team.** A named group of up to 12 members (the `maxMembers` default; configurable per team). Each team has a leader session ("master") and a set of member sessions. Teams live in a storage scope: project-scope (`<dir>/.octeam`) or user-scope (`~/.octeam`).

**Member.** A member is an OpenCode session with a role, system prompt, and optional model/agent configuration. Members can optionally run in isolated git worktrees.

**Master-only orchestration.** Only the team's leader session starts workflows. Other sessions call tools like `team_done`, `team_send_message`, and `team_task_*`.

**Single-active-per-session.** A session can have at most one team activated at a time. `team_activate` refuses if another team is already active — call `team_deactivate` on it first (auto-switching is disabled).

**State.** All team state is JSON-serializable, persisted under `<scope>/.octeam/teams/<name>/`. Each team has a `config.json` (immutable spec), `state.json` (mutable runtime state), plus `mailbox/`, `tasks/`, `runs/`, and optional `worktrees/` directories.

**Orchestration runs.** Every workflow produces a run record under `runs/<runId>/` with per-member output files and an append-only event timeline. Run history persists across plugin restarts.

**Human-in-the-loop approvals.** `team_pipeline`, `team_tollgate`, `team_loop`, `team_route`, `team_recurse`, `team_arbitrate`, `team_consensus`, and `team_workflow` can pause at supported mid-run boundaries when `human_approval` is enabled. The leader resumes with `team_approve` or rejects with `team_reject`. This is distinct from `signoff`: HITL is a mid-run human approval gate, while signoff is a post-completion member-agent review.

**Crash recovery.** On plugin restart, OCTeam reconciles any team left "busy" by a crashed process, rebuilds the session index from disk, and makes the interrupted task resumable via `team_resume`.

**TUI sidebar.** The `tui` plugin entrypoint renders a team status panel in the OpenCode interface showing member states, active orchestration type, and task progress.

## Installation

OCTeam is distributed as an npm package (`octeam`). Install it in three steps:

1. **Download** the latest release package from the [Releases page](https://github.com/huangli712/OCTeam/releases) (e.g. `octeam-<version>.tgz`).

2. **Extract** it:

   ```
   tar -xzf octeam-<version>.tgz
   ```

3. **Install** the extracted directory with the opencode CLI:

   ```
   opencode plugin install ./octeam-<version>
   ```

OCTeam registers as an `oc-plugin` with two entrypoints (server + TUI sidebar). Peer dependencies (`@opencode-ai/plugin` >=1.4.7, `@opencode-ai/sdk` >=1.4.7, `@opentui/solid` >=0.1.99, `solid-js` >=1.9.0) are resolved by OpenCode's plugin host.

## Configuration

OCTeam registers nine built-in subagents — `oct-oracle`, `oct-librarian`, `oct-explore`, `oct-metis`, `oct-momus`, `oct-multimodal-looker`, `oct-junior`, `oct-deep`, and `oct-ultrabrain` — each preset with a hardened prompt and permission map. You can pin a model (and tune a few non-security fields) per agent in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "oct-oracle": {
      "model": "anthropic/claude-opus-5",
      "variant": "max"
    },
    "oct-librarian": {
      "model": "anthropic/claude-opus-5",
      "variant": "max"
    },
    "oct-explore": {
      "model": "yinhe/glm-5.2",
      "variant": "max"
    },
    "oct-junior": {
      "model": "yinhe/glm-5.2",
      "variant": "max"
    },
    "oct-ultrabrain": {
      "model": "anthropic/claude-fable-5",
      "variant": "max"
    }
  }
}
```

Recognized user-tunable fields: `model`, `variant`, `temperature`, `top_p`, `color`, `steps`, `maxSteps`, and `hidden`. Everything security-critical — `mode`, `prompt`, `description`, and `permission` — always comes from OCTeam's hardened presets and cannot be overridden from user config; user permission entries are honored only where they tighten the preset.

Agents without an explicit entry fall back to the configured default `model`, then to the leader session's model. To use these agents, pass one as a member's `agent` when creating a team (`team_create`) or adding a member (`team_add_member`).

## Tools

OCTeam exposes 42 tools in six categories: **lifecycle** (create and manage teams and members), **messaging** (member-to-member mailbox), **shared task list** (tasks with blockedBy dependencies), **orchestration** (the 12 workflow primitives), **workflow authoring** (planner), and **observability and recovery** (progress, results, metrics, resume, repair).

### Lifecycle

| Tool | Purpose |
|------|---------|
| `team_create` | Create a new team |
| `team_activate` | Make a team the session's active team (at most one per session) |
| `team_deactivate` | Deactivate the active team |
| `team_add_member` | Add a member to an existing team |
| `team_remove_member` | Remove a member from a team |
| `team_rename` | Rename a team |
| `team_delete` | Delete a team and its on-disk state |
| `team_list` | List all teams in the current scope |
| `team_query` | Query a specific member's details |
| `team_details` | Show a team's current status, orchestration progress, and token usage |
| `team_fix_member` | Modify a member's name, role, prompt, or agent |
| `team_fix_workflow` | Surgically repair a stuck team_workflow run (redispatch/skip/advance/fail/reassign) |
| `team_cancel` | Cancel the in-flight orchestration on a busy team |

### Messaging

| Tool | Purpose |
|------|---------|
| `team_send_message` | Send a message to a teammate's mailbox (point-to-point or broadcast) |

### Shared task list

| Tool | Purpose |
|------|---------|
| `team_task_create` | Create a task with optional blockedBy dependencies |
| `team_task_list` | List tasks, filterable by status and owner |
| `team_task_update` | Update a task's status (claim, progress, complete, delete) |
| `team_task_get` | Get full details of a single task |

### Orchestration

| Tool | Description |
|------|-------------|
| `team_parallel` | Run a task across all members in parallel (isolated or cooperative) |
| `team_consensus` | Multi-round structured debate until all members agree |
| `team_pipeline` | Linear pipeline where stage N's output feeds stage N+1 |
| `team_loop` | Corrective loop: code, review, decide, repeat |
| `team_delegate` | Publish tasks; idle members self-claim, execute, report |
| `team_route` | Content-based routing: a router inspects input, selects branch(es) |
| `team_arbitrate` | Debaters argue, an arbiter issues a binding ruling |
| `team_recurse` | Hierarchical recursive decomposition with blockedBy DAG |
| `team_tollgate` | Verdict-gated pipeline (PASS/FAIL/INVALID gates between stages) |
| `team_arena` | Competitive arena: N candidates implement in isolated worktrees, an evaluator scores them, deterministic winner is delivered |
| `team_workflow` | Deterministic declarative workflow: task/gate/fanout/join steps with engine-driven retry, recovery, and join policies |
| `team_quorum` | Replicated k-of-n voting: N members independently answer the same fixed-schema question; strict majority (k > valid_ballots/2) wins |

All twelve are master-only: only the team's leader session may start an orchestration. Only one orchestration can be active per team at a time.

### Workflow authoring

| Tool | Purpose |
|------|---------|
| `team_planner` | Master-only planner: propose/revise/write team + workflow JSON from a natural-language goal (HITL authoring, no model call on write) |

### Observability and recovery

| Tool | Purpose |
|------|---------|
| `team_done` | Member-side done acknowledgement (require_done_ack barrier) |
| `team_results` | List recent orchestration run records |
| `team_result_get` | Fetch a specific run's full record and member outputs |
| `team_run_dir` | Return the absolute path to a run's output directory |
| `team_root_dir` | Return the absolute path to a team's root directory |
| `team_progress` | Show live progress and event timeline; `format="mermaid"` renders a live team_workflow graph |
| `team_intervene` | Inject a directive into a member's mailbox mid-run |
| `team_approve` | Approve a pending human-in-the-loop pause and resume the run |
| `team_reject` | Reject a pending human-in-the-loop pause and apply the mode-specific rejection path |
| `team_metrics` | Aggregate token/message/success metrics across runs |
| `team_resume` | Resume an interrupted orchestration from a crash checkpoint |

## Commands

All commands run through Bun (npm is not used):

```
bun run typecheck    # TypeScript type checking (tsc --noEmit)
bun test             # Run tests (bun test)
bun run build        # Build server + TUI bundles and emit declarations
```

## Minimal usage example

You drive OCTeam from the team's leader session in natural language; the leader session translates your intent into OCTeam tool calls that orchestrate the member sessions.

**1. Create a team**

You type:

> Set up a code review team named `reviewers` with two reviewers, and make it my active team.

The leader session runs:

```
team_create(name="reviewers", description="Code review team")
team_add_member(team_id="reviewers", role="reviewer", prompt="You review code for bugs.")
team_add_member(team_id="reviewers", role="reviewer", prompt="You review code for style.")
team_activate(team_id="reviewers")
```

**2. Run a parallel review**

You type:

> Have the reviewers review `src/server.ts` for correctness and style issues.

The leader session runs:

```
team_parallel(team_id="reviewers", mode="isolated",
  task="Review src/server.ts for correctness and style issues.")
```

**3. Follow up**

You type:

> What's the progress? Show me the results.

The leader session runs:

```
team_progress(team_id="reviewers")
team_results(team_id="reviewers")
```

## Security

Security issues are handled through the project's security policy on GitHub. To report a vulnerability, use the repository's **Security** tab ("Report a vulnerability") rather than opening a public issue. Please do not disclose security problems publicly until they have been addressed.

## License

MIT
