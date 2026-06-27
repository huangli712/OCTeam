# OCTeam Architecture

OCTeam is an OpenCode plugin that manages persistent multi-agent teams. This
document summarizes the module layering, the on-disk state model, and the
orchestration primitives. For the user-facing tool reference, see the
[README](../README.md).

## Plugin entrypoints

The plugin registers two `oc-plugin` entrypoints:

- **`server`** (`src/server.ts`) — the composition root. It builds the shared
  `PluginContext`, rebuilds the session index from disk (crash recovery),
  reconciles activation and crashed teams, starts the background sweep timer,
  and wires the tools plus the event/transform/compacting/config hooks.
- **`tui`** (`src/tui/index.tsx`) — the sidebar entrypoint. It renders team and
  subagent status by reading `.octeam` state straight from disk, since the TUI
  and server share the same process filesystem.

## Module layering

Dependencies flow in one direction, from foundational types up to the tool
surface:

```
core/types        pure data types (TeamSpec, TeamState, Task, Message, ...)
   |
state/            paths, file locks, team store, shared task list
   |
messaging/        mailbox (inbox/processed/reserved), wake hints
   |
orchestration/    dispatch, workflow handlers, run records, summaries
   |
tools/            tool handlers exposed to OpenCode (lifecycle, workflow, ...)
   |
server.ts         composition root + hooks
```

`core/utils.ts` is a cross-cutting helper used across layers (session index,
member resolution, output formatting); it also reads `state/store`. The `tui/`
modules are an independent read-only consumer of the same on-disk state.

## State persistence model

All team state is JSON-serializable and persisted on disk under a storage
scope. Path construction is centralized in `src/state/paths.ts`, which validates
every caller-supplied path segment to prevent traversal outside the scope.

- **Project scope** — `<dir>/.octeam/<leadSessionId>/teams/<name>/`
  (teams are segmented under their lead session).
- **User scope** — `~/.octeam/teams/<name>/` (flat, shared across sessions).

Each team directory contains:

| Path | Purpose |
|------|---------|
| `config.json` | `TeamSpec` — immutable team spec, written at `team_create` |
| `state.json` | `TeamState` — mutable runtime state, lock-protected |
| `state.json.lock` | Cross-process file lock guarding `state.json` writes |
| `mailbox/` | Per-recipient `*.jsonl` inbox, `*.processed.jsonl` audit log, and `*.reserved/` in-flight reservations |
| `tasks/` | One `*.json` per task, plus `claims/` claim/update locks |
| `runs/` | One directory per orchestration run (`record.json`, `<member>.md`, `events.jsonl`) |
| `worktrees/` | Optional per-member git worktrees (only when a member sets `worktree: true`) |

## Orchestration primitives

A team has one leader ("master") session and up to eight member sessions. Only
the master may start an orchestration, and only one orchestration can be active
per team at a time. The nine workflow primitives are:

| Primitive | Shape |
|-----------|-------|
| `team_parallel` | Run a task across all members in parallel (isolated or collaborative) |
| `team_consensus` | Multi-round structured debate until all members agree |
| `team_pipeline` | Linear pipeline where stage N's output feeds stage N+1 |
| `team_loop` | Corrective loop: code, review, decide, repeat |
| `team_delegate` | Publish tasks; idle members self-claim, execute, report |
| `team_route` | Content-based routing: a router selects branch(es) |
| `team_arbitrate` | Debaters argue, an arbiter issues a binding ruling |
| `team_recurse` | Hierarchical recursive decomposition with a blockedBy DAG |
| `team_tollgate` | Verdict-gated pipeline (PASS/FAIL/INVALID gates between stages) |

## Runtime and recovery

The event handler and a background sweep timer drive the per-team locked state
machine. Every orchestration produces a run record under `runs/<runId>/` with
per-member output files and an append-only event timeline that persists across
plugin restarts. On restart the server rebuilds the session index from disk,
clears stale activation, reconciles teams left "busy" by a crashed process, and
makes interrupted orchestrations resumable via `team_resume`.

## Security

Security issues are handled through the project's security policy on GitHub; see
the [README Security section](../README.md#security).
