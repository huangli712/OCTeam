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

`core/utils.ts` is a cross-cutting helper for output text formatting
(`truncateOutput`, `extractOutputFromParts`) with **no state-layer dependencies**
— the session index and member resolution logic live in `state/resolve.ts`.
The `tui/` modules are an independent read-only consumer of the same on-disk
state.

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
per team at a time. The eleven workflow primitives are:

| Primitive | Shape |
|-----------|-------|
| `team_parallel` | Run a task across all members in parallel (isolated or cooperative) |
| `team_consensus` | Multi-round structured debate until all members agree |
| `team_pipeline` | Linear pipeline where stage N's output feeds stage N+1 |
| `team_loop` | Corrective loop: code, review, decide, repeat |
| `team_delegate` | Publish tasks; idle members self-claim, execute, report |
| `team_route` | Content-based routing: a router selects branch(es) |
| `team_arbitrate` | Debaters argue, an arbiter issues a binding ruling |
| `team_recurse` | Hierarchical recursive decomposition with a blockedBy DAG |
| `team_tollgate` | Verdict-gated pipeline (PASS/FAIL/INVALID gates between stages) |
| `team_arena` | Competitive arena: N candidates implement in isolated worktrees |
| `team_workflow` | Deterministic, declaratively-composed linear step engine |
| `team_quorum` | Replicated k-of-n voting; strict majority (k > valid_ballots/2) wins |

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

### Trust boundaries

- **Master vs member.** Authorization is enforced at a single chokepoint
  (`resolveCallerInTeam` in `state/resolve.ts`): member sessions can only reach
  the team they are indexed under (a member of team A passing `team_id="B"` is
  rejected), and the 11 orchestration tools plus `team_intervene` are master-only.
  Unknown role names fall back to `reviewer` (read-only), never `almighty`.

- **Path safety.** Every caller-supplied path segment (team/member/task/run ids)
  is validated by `state/paths.ts` (`assertSafeSegment`) before it reaches the
  filesystem, with defense-in-depth at the tool schema layer. There is no raw
  `fs` call that bypasses this chokepoint.

- **Mailbox authenticity — accepted limitation.** The file mailbox lives under
  `<project>/.octeam/mailbox/`. Messages carry **no cryptographic integrity tag**:
  the `from` and `kind` fields are stored verbatim and only XML-escaped on
  injection, never re-authenticated on read. Because write-capable member agents
  (any role mapped to `oct-junior`: coder/debugger/optimizer/tester/...) share
  the same OpenCode process and can write the project directory, a member with
  filesystem write access to `.octeam/` CAN append a forged line (e.g.
  `from:"master", kind:"directive"`) that will be honored as a high-priority
  directive. OCTeam treats `.octeam/` as a trusted directory and assumes
  cooperative member agents. The robust defense — excluding `.octeam/` from
  member write paths — belongs to the host permission layer and is outside this
  plugin's control. A per-team HMAC was considered and rejected: the key cannot
  be hidden from a member that can read the key file in the same process, so it
  would not close the hole while adding real complexity.

  **Partial fix on the master drain path.** `deliverQueuedResultsToMaster`
  (called when the master session goes idle) filters out any queued entry with
  `kind==="directive"` or `from==="master"` — the master never legitimately
  sends directives to itself, so those entries are unconditionally forged.
  This prevents the most severe sub-case (master weaponizing its own session
  via forged self-directives) without requiring an HMAC. Forging directives
  into other members' mailboxes remains the documented accepted limitation.

- **Member agent permissions — hardened `oct-*` presets.** Every role maps to
  an OCTeam-hardened agent (`oct-*` prefix, defined in `src/agents/*.ts`):
  read-only roles (`reviewer`/`architect`/`explorer`/`researcher`) map to
  `oct-oracle`/`oct-explore`/`oct-librarian` which carry explicit `deny`
  permissions on `edit`/`bash`/`webfetch`; write-capable roles
  (`coder`/`debugger`/`optimizer`/...) map to `oct-junior` which permits `edit`
  and `bash` (deny: `task`). The member agent is validated against the
  `OCTEAM_AGENTS` allowlist on every entry point (`team_create`, `team_add`,
  `team_fix_member`) and on disk reload (`isValidTeamState`); a missing or
  unrecognized agent fails safe to `oct-oracle` (read-only) at dispatch time
  (`safeMemberAgent`). This is defense-in-depth against a tampered `state.json`
  — it does not prevent lateral escalation within the `oct-*` set itself (a
  write-capable member can rewrite another member's `agent` field), but it
  closes the path to unhardened bare host agents like `build`. The host-side
  agent definitions are part of the trusted configuration surface.
