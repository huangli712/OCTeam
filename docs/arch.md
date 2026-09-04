# OCTeam Architecture

OCTeam is an OpenCode plugin that manages persistent multi-agent teams: one leader ("master") session coordinates up to `bounds.maxMembers` member sessions (default 12, configurable per team) through twelve orchestration primitives, with all state persisted on disk so teams survive plugin and process restarts.

This document is the contributor-facing architecture overview: how the process, session, and module layers fit together, how state is persisted and recovered, and where the security boundaries sit. For the user-facing tool reference, see the [README](../README.md).

## Process and session model

OCTeam runs inside the OpenCode host process and registers two `oc-plugin` entrypoints:

- **`server`** (`src/server.ts`) — the composition root. It reads the storage scope from plugin options (`["octeam", { scope: "user" }]`; default `"project"`), builds the shared `PluginContext`, performs crash recovery (see [Startup and crash recovery](#startup-and-crash-recovery)), starts the background sweep timer, and wires the 42 tools plus the event, transform, compacting, and config hooks.
- **`tui`** (`src/tui/index.tsx`) — the sidebar entrypoint. It renders team and member status by reading `.octeam` state straight from disk (project-scope teams of the current session only — user-scope `~/.octeam` teams are intentionally excluded from the sidebar); the TUI and server share the same process filesystem, so no IPC is needed.

A team has exactly one master session (the session that created it) and up to `bounds.maxMembers` members, each a separate OpenCode session running a hardened `oct-*` agent (see [Security model](#security-model)). Only the master may start an orchestration, and at most one orchestration is active per team at a time.

Session identity is resolved through an **in-memory session index** (`state/resolve.ts`): `sessionID → member` (1:1) and `sessionID → set of teams` for masters (1:many, with a single active-team pointer). The index is rebuilt once from trusted on-disk state at startup and never re-read per call, which is what makes disk-tampered `state.json` unable to grant master privileges in project scope (in user scope, a team whose `master.sentinel` is missing falls back to trusting the mutable `leadSessionId` with a warning — see `master.sentinel` below).

## Module layering

Dependencies flow in one direction, from foundational types up to the tool surface:

```
core/             pure types (core/types/*), logging, roles, utils, PluginContext
    |
state/            paths, cross-process locks + atomic writes, team store,
    |             shared task list, session index, activation, worktrees
    |
messaging/        mailbox JSONL, directive authentication, delivery, wake hints
    |
orchestration/    control/ (dispatch, approval, signoff, completion),
    |             lifecycle/ (idle, startup, reconcile, resume, termination),
    |             modes/ (one handler per orchestration primitive),
    |             protocol/ (member output parsing: decisions, verdicts),
    |             records/ (run records, events, summaries, mermaid),
    |             workflow/ (the declarative workflow engine)
    |
agents/           oct-* hardened agent presets + the config hook
    |
tools/            tool handlers exposed to OpenCode (lifecycle, modes, ...)
    |
hooks.ts + server.ts   event handler, sweep timer, transform hooks, composition
```

Two side notes:

- `tui/` is an independent read-only consumer of the same on-disk state (project scope only — see above) and shares no runtime state with `server.ts`.
- `core/utils.ts` is a small cross-cutting helper (ENOENT-style filesystem-error classification and a polling `waitUntil`) with no state-layer dependencies.

### Source tree

```
src/
├── server.ts              composition root: PluginContext, crash recovery, hooks
├── hooks.ts               event handler, sweep timer, transform/compacting hooks
├── core/                   pure types, logging, roles, utils, PluginContext
│   └── types/              team, task, messaging, orchestration, runs, workflow
├── state/                  paths, locks + atomic writes, store, tasks, resolve,
│                           activation, naming, worktrees
├── messaging/              mailbox JSONL, directive auth, deliver, format, wake hints
├── orchestration/
│   ├── control/            dispatch, members, approval, signoff, completion, barriers
│   ├── lifecycle/          startup, idle, reconcile, resume, termination, status
│   ├── modes/              one handler per orchestration primitive (+ defaults, reduce, stages)
│   ├── protocol/           member output parsing: decisions, output truncation
│   ├── records/            runs, capture, events, ledger, renderers, schemas, mermaid, summary
 │   └── workflow/           engine, handler, loader, lower-side validate, gate, verdict,
 │                           fanout, join-policy, gate-targets, dag, invariants, upstream,
 │                           reasons (failure-reason builders)
├── tools/
│   ├── index.ts            registry: createTools → the 42 tool map
│   ├── schema.ts           shared tool-schema helpers
│   ├── support.ts          shared tool helpers (defaults, auth guards)
│   ├── lifecycle/          create, activate, add/remove, rename, delete, list, details, fixmember
│   ├── modes/              one tool wrapper per orchestration primitive
│   ├── exchange/           send_message, task create/list/update/get
│   ├── control/            cancel, resume, approve/reject, intervene, done, fixflow
│   ├── query/              query, metrics, progress, results, result_get, run_dir, root_dir
│   └── workflow/           engine, lower, validate, planner, format
├── agents/                 oct-* hardened presets + config hook (index + one file per agent)
└── tui/                    index.tsx, sidebar.tsx, teams.ts, tree.ts (read-only disk consumer)
```

## On-disk state model

All team state is JSON-serializable and persisted under a storage scope. Path construction is centralized in `state/paths.ts`, which validates every caller-supplied path segment (`assertSafeSegment`) to prevent traversal outside the scope (a few internal artifacts — quarantine paths and some run-record side files — are joined directly at their single call sites).

- **Project scope** — `<dir>/.octeam/<leadSessionId>/teams/<name>/`. Teams are segmented under the session that created them, so sessions see only their own teams.
- **User scope** — `~/.octeam/teams/<name>/` (flat, shared across sessions).

Each team directory contains:

| Path | Purpose |
|------|---------|
| `config.json` | `TeamSpec` — the team spec (members/bounds). Written at `team_create` and rewritten by the lifecycle editors (`team_add_member`, `team_remove_member`, `team_rename`, `team_fix_member`) under their locks |
| `state.json` | `TeamState` — mutable runtime state, lock-protected |
| `state.json.lock` | Cross-process file lock guarding `state.json` writes |
| `master.sentinel` | Marker of the team's true lead session, verified at index rebuild (created mode 0644 then chmod'd 0444; the chmod is best-effort, so on-disk read-onlyness is not guaranteed) |
| `mailbox/` | Per-recipient `*.jsonl` inbox, `*.processed.jsonl` audit log, and `*.reserved/` in-flight reservations |
| `tasks/` | One `*.json` per shared task, plus `claims/` claim/update locks |
| `runs/` | One directory per orchestration run (`record.json`, per-member `<member>.md` output files accumulated across turns and capped at 256 KiB, `events.jsonl`, plus run-level artifacts such as `reduce.md`, `signoff-<reviewer>.md`, and `join-<step>.md`) |
| `worktrees/` | Optional per-member git worktrees (only when a member sets `worktree: true`) |

Two state-layer mechanisms are worth understanding before touching the code:

- **Atomic writes** (`state/locks.ts` `atomicWrite`) — content is written to a randomized temp file, fsync'd, renamed into place, and the parent directory is fsync'd on a best-effort basis (a directory-fsync failure is logged, not fatal), so a crash can leave at worst a fully-written or absent state file. Symlink targets and symlinked ancestor directories are refused (ancestor checks run when a trusted root is supplied).
- **Cross-process merge** (`state/store.ts`) — writers hold `state.json.lock`, re-read disk, and three-way-merge (disk vs last-known snapshot vs current runtime state), so two OpenCode processes mutating the same team do not clobber each other's fields. An in-memory per-team registry keys the live `Team` object (with its process-local mutex) by resolved directory.

## Orchestration runtime

The engine is event-driven, not threaded: member sessions finish a turn, emit an idle event, and the event handler (`hooks.ts`) plus a background sweep timer drive the per-team locked state machine forward. All dispatches go through `promptAsync`; the event handler is the single top-level error catcher, so individual mode handlers do not wrap dispatch calls in their own try/catch.

The twelve orchestration primitives (`orchestration/modes/`):

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
| `team_workflow` | Deterministic, declaratively-composed step engine (see below) |
| `team_quorum` | Replicated k-of-n voting; strict majority wins |

Member outputs are parsed by a strict protocol layer (`orchestration/protocol/decisions.ts`): members must emit exact XML decision blocks (`<verdict>`, `<decision>`, `<vote>`, ...). Malformed output is counted and handled per the mode's tolerance policy rather than silently accepted. Every run produces a record under `runs/<runId>/` — a `record.json` summary, one Markdown file per member's accumulated output (capped), and an append-only `events.jsonl` timeline that survives restarts.

Run control is master-only and lives in `orchestration/control/` and `tools/control/`: `team_cancel`, `team_resume` (restart an interrupted run), `team_approve`/`team_reject` (human-in-the-loop approval pauses), `team_intervene` (inject a high-priority directive into a member), and `team_fix_workflow` (surgically repair a stuck workflow run).

## The workflow engine

`team_workflow` (`orchestration/workflow/`) is the most complex primitive and has its own sub-engine:

- **Authoring vs lowered form** — users write a compact JSON of steps (task, gate, fanout, join); `tools/workflow/lower.ts` lowers it into the flat step array the engine executes, expanding branches, resolving step references, and computing fanout/join ranges. `tools/workflow/validate.ts` rejects invalid authoring before any dispatch.
- **Execution** (`engine.ts`) walks steps under the same event-driven state machine, with goto jumps, bounded retries per gate (attempt counters for fail/invalid/malformed/timeout), backward-jump counter resets, and loop bounds.
- **Gates** (`gate.ts`, `verdict.ts`) verify a preceding task or join output against criteria. A gate may use a single verifier or an ensemble (majority/quorum/unanimous aggregation) and an optional `where` threshold condition with tri-state evaluation (`matches` / `does_not_match` / `unevaluable` — unevaluable always routes to INVALID, never fail-open).
- **Fanout/join** (`fanout.ts`, `join-policy.ts`) run steps in per-branch parallel with matrix/foreach expansion and configurable join policies (all / quorum / any_success / required_branches / reduce / select).
- **Structural invariants** (`invariants.ts`) are re-checked by `team_fix_workflow` around its repair mutations (resume does not re-check them), so a repaired run cannot skip verification.
- **`team_planner`** (`tools/workflow/planner.ts`) generates a team + workflow plan via a child planner session through propose → revise → write stages, with dry-run validation before any file is written.

## Messaging plane

Members and the master communicate through a per-team file mailbox (`messaging/mailbox.ts`): each recipient has a `*.jsonl` inbox; reads atomically reserve lines into `*.reserved/` and move them to `*.processed.jsonl` on ACK, truncating the inbox after reservation. A crash between reservation and ACK requeues the reserved lines, giving crash-safe at-least-once delivery (no loss; a redelivery is possible). Wake hints (`messaging/wake-hint.ts`) suggest which session to nudge next.

**Directive authentication** (`messaging/auth.ts`): the mailbox JSONL itself lives in member-writable `.octeam/` space and must be treated as forgeable. High-priority directives are therefore authenticated through a separate in-process registry that only the host plugin writes: at send time the authenticated content (`id`, `from`, `to`, `body`, `correlationId`) is recorded under a `(teamName, to, id)` key; at consumption the replayed mailbox line must match the registered content exactly, and each entry is one-shot (consumed on ACK, after which a replay is downgraded to a regular message). A forged or tampered mailbox line cannot satisfy this check. The registry is capped (512 entries, oldest-first eviction) and recipient-scoped so broadcast recipients authenticate independently.

## Startup and crash recovery

`server.ts` runs a fail-closed startup sequence — any step throwing aborts plugin startup, because a half-recovered index would rather deny legitimate sessions than authorize the wrong ones:

1. **Rebuild the session index** from disk (`rebuildSessionIndex`), verifying each team's `master.sentinel` against the directory layout so a tampered `state.json.leadSessionId` cannot redirect master privilege.
2. **Reconcile activation** — clear project-scope teams' `activatedAt` (user-scope teams are skipped deliberately: they may be legitimately active in sibling processes, so their persisted activation survives a restart of this process). Teams are never auto-activated for a scope this process owns; the user must `team_activate` explicitly.
3. **Reconcile crashed teams** — release stale mailbox reservations (except those held by members persisted as `running`, which the crashed run's failure handling owns) and fail orchestrations left "busy" by a crashed process, making them resumable via `team_resume`.

After startup, a background **sweep timer** (`hooks.ts` `startSweepTimer`) runs for the plugin's lifetime: it reaps stale task claims for active delegate/recurse runs (timestamp-based), checks file locks opportunistically on acquisition (stale zero-byte locks after a 1 s grace; dead-owner locks after the 30 s TTL), enforces termination conditions, and reconciles idle events the event handler might have missed.

## Security model

- **Master vs member.** Authorization centers on `resolveCallerInTeam` in `state/resolve.ts` (member sessions can only reach the team they are indexed under — a member of team A passing `team_id="B"` is rejected); several lifecycle tools additionally re-verify mastership directly via `isIndexedMasterOf` on the loaded state. The orchestration and run-control tools are master-only.

- **Path safety.** Every caller-supplied path segment (team/member/task/run ids) is validated by `state/paths.ts` (`assertSafeSegment`) before it reaches the filesystem, with defense-in-depth at the tool schema layer. Symlinked targets and ancestors are refused on both read and write paths (`assertNoSymlinkTraversal`, O_NOFOLLOW opens).

- **Mailbox authenticity.** See [Messaging plane](#messaging-plane). Mailbox lines are forgeable by design assumption; only directive *priority* is protected by the in-process authentication registry. Plain team messages remain unauthenticated — they carry no privilege.

- **Hardened `oct-*` agent presets.** Every member role maps to an OCTeam agent preset (`agents/*.ts`, nine presets: `oct-oracle`, `oct-librarian`, `oct-explore`, `oct-metis`, `oct-momus`, `oct-multimodal-looker`, `oct-junior`, `oct-deep`, `oct-ultrabrain`); read-only roles carry explicit `deny` permissions on `edit`/`bash`/`webfetch` plus the structured write-tool family (`AFT_WRITE_TOOLS_DENY` in `agents/types.ts`: `aft_edit`, `aft_write`, `aft_apply_patch`, `aft_ast_replace`, `aft_refactor`, `aft_import`, `aft_move`, `aft_delete`, `aft_bash`, `lsp_rename`), and there is no path to a bare host agent like `build`. Tools are named explicitly rather than left to the `"*": "deny"` baseline because the host SDK may ignore the wildcard key — the same reason the member team tools are listed one by one. The matching read tiers (`AFT_READ_TOOLS_PERMISSION`, `AFT_DIAGNOSTICS_PERMISSION`) are live grants: the host injects the `aft_*`/`lsp_*` tools into member sessions and enforces the maps (allows surface a tool, denies hide it), and `lsp_rename` is classified as a write tool because it applies workspace edits. The agent is validated against the `OCTEAM_AGENTS` allowlist at every entry point (`team_create`, `team_add_member`, `team_fix_member`) and on disk reload (`isValidTeamState`), failing safe to `oct-oracle` (read-only) at dispatch. The config hook (`agents/index.ts`) force-overrides the security-critical fields (mode, prompt, description) of user-defined `oct-*` entries and merges permissions monotonically — user config can only *tighten* presets, never loosen them.

- **Project-scope isolation warning.** `.octeam/` in the project directory is writable by write-capable members. OCTeam surfaces this threat model with a one-time startup warning (`warnIfProjectScopeLacksIsolation`) and treats the directory as trusted-cooperative; the robust exclusion of `.octeam/` from member write paths belongs to the host permission layer.

## Engineering conventions

- **Never swallow errors silently.** Best-effort catch blocks log via `logSwallowed` so failures stay observable (`core/log.ts`).
- **Fail closed on recovery.** Startup reconciliation and stale-resource reaping prefer refusing state over accepting unverified state (missing sentinel → warning + less-secure fallback; unreadable sentinel → refuse master privilege).
- **Lock, re-read, merge, write.** Mutating shared state means taking the cross-process lock, re-reading disk, merging, and writing atomically — never blind overwrites.
- **Strict output contracts.** Member-facing prompts specify exact XML decision blocks; parsing is strict and misparses are counted, retried, and eventually failed per policy rather than guessed at.
