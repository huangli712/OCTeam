# OCTeam

Persistent multi-agent teams for OpenCode. OCTeam is an OpenCode plugin that
lets you create long-lived teams of up to 8 OpenCode sessions and orchestrate
them with nine workflow primitives.

**Version:** 0.9.13  
**License:** MIT  
**Runtime:** Bun (TypeScript)

## Install

OCTeam registers as an `oc-plugin` with two entrypoints (server + TUI sidebar):

```
opencode plugin install octeam
```

Peer dependencies (`@opencode-ai/plugin` >=1.4.7, `@opencode-ai/sdk` >=1.4.7,
`@opentui/solid` >=0.1.99, `solid-js` >=1.9.0) are resolved by OpenCode's
plugin host.

## Tool surface (35 tools)

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

### Orchestration (9 primitives)

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

All nine are master-only: only the team's leader session may start an
orchestration. Only one orchestration can be active per team at a time.

### Observability and recovery

| Tool | Purpose |
|------|---------|
| `team_done` | Member-side done acknowledgement (require_done_ack barrier) |
| `team_results` | List recent orchestration run records |
| `team_result_get` | Fetch a specific run's full record and member outputs |
| `team_progress` | Show live progress and event timeline |
| `team_intervene` | Inject a directive into a member's mailbox mid-run |
| `team_approve` | Approve a pending human-in-the-loop pause and resume the run |
| `team_reject` | Reject a pending human-in-the-loop pause and apply the mode-specific rejection path |
| `team_metrics` | Aggregate token/message/success metrics across runs |
| `team_resume` | Resume an interrupted orchestration from a crash checkpoint |

## Key concepts

**Team.** A named group of up to 8 members. Each team has a leader session
("master") and a set of member sessions. Teams live in a storage scope:
project-scope (`<dir>/.octeam`) or user-scope (`~/.octeam`).

**Member.** A member is an OpenCode session with a role, system prompt, and
optional model/agent configuration. Members can optionally run in isolated git
worktrees.

**Master-only orchestration.** Only the team's leader session starts workflows.
Other sessions call tools like `team_done`, `team_send_message`, and
`team_task_*`.

**Single-active-per-session.** A session can have at most one team activated at
a time. `team_activate` refuses if another team is already active — call
`team_deactivate` on it first (auto-switching is disabled).

**State.** All team state is JSON-serializable, persisted under
`<scope>/.octeam/teams/<name>/`. Each team has a `config.json` (immutable
spec), `state.json` (mutable runtime state), plus `mailbox/`, `tasks/`, `runs/`,
and optional `worktrees/` directories.

**Orchestration runs.** Every workflow produces a run record under
`runs/<runId>/` with per-member output files and an append-only event timeline.
Run history persists across plugin restarts.

**Human-in-the-loop approvals.** `team_pipeline`, `team_tollgate`, and
`team_loop` can pause at supported mid-run boundaries when `human_approval` is
enabled. The leader resumes with `team_approve` or rejects with `team_reject`.
This is distinct from `signoff`: HITL is a mid-run human approval gate, while
signoff is a post-completion member-agent review.

**Crash recovery.** On plugin restart, OCTeam reconciles any team left "busy"
by a crashed process, rebuilds the session index from disk, and makes the
interrupted task resumable via `team_resume`.

**TUI sidebar.** The `tui` plugin entrypoint renders a team status panel in the
OpenCode interface showing member states, active orchestration type, and task
progress.

## Commands

All commands run through Bun (npm is not used):

```
bun run typecheck    # TypeScript type checking (tsc --noEmit)
bun test             # Run tests (bun test)
bun run build        # Build server + TUI bundles and emit declarations
```

## Minimal usage example

Create a team with two members, activate it, and run a parallel task:

```
# 1. Create a team
team_create(name="reviewers", description="Code review team")
# 2. Add members
team_add_member(team_id="reviewers", role="reviewer", prompt="You review code for bugs.")
team_add_member(team_id="reviewers", role="reviewer", prompt="You review code for style.")
# 3. Activate the team
team_activate(team_id="reviewers")
# 4. Run a parallel review
team_parallel(team_id="reviewers", mode="isolated",
  task="Review src/server.ts for correctness and style issues.")
# 5. Check progress
team_progress(team_id="reviewers")
# 6. View results
team_results(team_id="reviewers")
```

## Security

Security issues are handled through the project's security policy on GitHub.
To report a vulnerability, use the repository's **Security** tab
("Report a vulnerability") rather than opening a public issue. Please do not
disclose security problems publicly until they have been addressed.
