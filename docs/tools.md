# OCTeam Tool Reference

This document is the complete reference for OCTeam's 42 tools: purpose, caller permission, parameters, side effects, and common error returns. Parameters are extracted from each tool's schema definition in `src/tools/`. For the architecture behind these tools, see [arch.md](./arch.md); for mode-selection guidance, see [modes.md](./modes.md) and [workflow.md](./workflow.md) (companion documents).

Permission labels:

- **master-only** — only the team's leader ("master") session may call the tool. Most tools enforce this either through a direct check (`team.leadSessionId !== context.sessionID || !isIndexedMasterOf(...)`) or by resolving the caller via `resolveCallerInTeam(...)` and requiring `caller.isMaster`.
- **master+member** — any member of the team (or the master) may call; membership is enforced via `resolveCallerInTeam(...)`. Tools marked *read-only* pass `{ requireActive: false }` so an inactive team can still be inspected.
- **member-only** — only non-master members may call (`team_done`).

## Shared conventions for the orchestration tools

These apply to every tool under "Orchestration modes" and "Workflow":

- All tools under "Orchestration modes" and "Workflow" except `team_planner` are master-only and go through the same startup gate: `resolveCallerInTeam(...)` + `if (!caller?.isMaster) return "Error: <tool> is master-only"`, plus the shared startup errors `Error: team "<id>" not found`, `Error: team "<id>" could not be loaded (state file unreadable)`, and `Error: team already has an active orchestration`. `team_planner` is master-only via its own indexed-member check instead (see its section). Individual sections below list only tool-specific errors.
- Shared bound fields appear in many parameter tables: `timeout_ms` (wall-clock timeout in ms, clamped by `team.bounds.maxWallClockMinutes`; default 600000 = 10 min, or 900000 = 15 min where noted), `token_budget` (run fails if exceeded), `max_retries` (provider re-dispatch grace windows, 0-5, default 0), `signoff_policy`/`signoff_decider`/`signoff_quorum` (post-completion review gate: none | decider | peer-quorum, quorum default 0.5), and `human_approval`/`approval_timeout_ms` (pause at mid-run boundaries for `team_approve`/`team_reject`; default no pause — and when a pause is created without an explicit `approval_timeout_ms`, a default of 600000 ms = 10 minutes applies).

## Contents

- [Lifecycle](#lifecycle): team_create, team_activate, team_deactivate, team_add_member, team_remove_member, team_rename, team_delete, team_list, team_details, team_fix_member
- [Messaging and shared tasks](#messaging-and-shared-tasks): team_send_message, team_task_create, team_task_list, team_task_update, team_task_get
- [Orchestration modes](#orchestration-modes): team_parallel, team_consensus, team_pipeline, team_loop, team_delegate, team_route, team_arbitrate, team_recurse, team_tollgate, team_arena, team_quorum
- [Workflow](#workflow): team_workflow, team_planner
- [Run control](#run-control): team_cancel, team_fix_workflow, team_done, team_intervene, team_resume, team_approve, team_reject
- [Query](#query): team_query, team_metrics, team_progress, team_results, team_result_get, team_run_dir, team_root_dir

## Lifecycle

### team_create

- Purpose: define an agent team with preset roles, writing config and state to disk; member sessions spawn lazily on the first workflow call.
- Permission: master-only (the calling session becomes the team's master). No `resolveCallerInTeam` — the team does not exist yet; instead the handler blocks member sessions from escalating to master: `if (isIndexedMember(context.sessionID)) return "Error: a team member session cannot create a team"`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| name | string, 1-64, `^[a-z0-9-]+$` | yes | — | team name; lowercase letters, digits, hyphens only |
| description | string, max 2048 | no | — | optional human-readable team description |
| members | array, 1-12 items | yes | — | initial member specs |
| members[].name | string, 1-32, `^[a-z0-9-]+$` | no | auto-picked from the preset name pool | member name; must be a preset pool name (not "master"/"orchestrator") |
| members[].role | string, 1-64, `^[a-zA-Z]+$` | yes | — | single English word; preset roles (coder, debugger, optimizer, tester, solver, reviewer, architect, explorer, writer, mathematician, physicist, simulator, chemist, analyst, visualizer, researcher, author, fantast, planner, auditor, looker, arbiter, evaluator, verifier, reducer, almighty); unknown collapses to "reviewer" (read-only) |
| members[].prompt | string, 1-8192 | yes | — | member instructions |
| members[].model | string | no | per-agent default → default model → leader session model (each step best-effort; lookups that fail are skipped) | explicit model override (e.g. `providerID/modelID`) |
| members[].agent | string | no | derived from role | hardened `oct-*` agent override; must pass the `OCTEAM_AGENTS` allowlist |
| members[].worktree | boolean | no | — | run the member in an isolated git worktree |
| bounds | object | no | see rows | resource bounds; partial override merged onto defaults |
| bounds.maxMembers | int 1-50 | no | 12 | member count cap |
| bounds.maxParallelMembers | int 1-50 | no | 4 | max concurrently running members |
| bounds.maxMessagesPerRun | int 1-100000 | no | 100 | per-run message quota |
| bounds.maxWallClockMinutes | int 1-10080 | no | 30 | run wall-clock cap in minutes |
| bounds.maxMemberTurns | int 1-10000 | no | 50 | max turns per member |
| bounds.maxTasks | int 1-10000 | no | 200 | shared-task-list cap |

- Behavior: refuses indexed member sessions (no master escalation); validates every member's `agent` against the `oct-*` allowlist and explicit names against the pool; atomically claims the team directory with `mkdir` (non-recursive, EEXIST = collision) after walking the ancestor chain with `assertNoSymlinkTraversal`; cross-validates `bounds.maxMembers >= initial member count` (rolls the directory back on violation); writes `config.json` (`writeTeamSpec`), initial `state.json` (`status: "live"`, `activatedAt: undefined`, members `pending`), and a `master.sentinel` pinning the creator's session id, created with O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW at mode 0644 and then chmod'd to 0444 (a failed chmod is logged at debug level and does not abort creation, so the sentinel is not guaranteed read-only on disk). Member sessions are NOT spawned here; teams are never auto-activated.
- Errors: `Error: a team member session cannot create a team`; `Error: agent "<agent>" is not a hardened oct-* agent. Members must run as one of: <OCTEAM_AGENTS list>. Omit 'agent' to derive it from the role.`; `Error: "<name>" is a reserved name and cannot be a member name`; `Error: name "<name>" is not a preset pool name. Choose one of: <pool list>`; `Error: duplicate member name "<name>"`; `Error: team name "<name>" already exists in this <scope> scope`; `Error: bounds.maxMembers (N) is less than the number of initial members (M). Set maxMembers to at least M.`; throws `team_create: failed to create master.sentinel securely: ...` (aborts team creation).

### team_activate

- Purpose: make a team the session's active (available) team; at most one team is active per session.
- Permission: master-only — direct check `if (target.leadSessionId !== context.sessionID || !isIndexedMasterOf(context.sessionID, target.directory))`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to activate |

- Behavior: serializes per session via an in-process session mutex; re-scans all sibling teams inside the mutex and fails closed if any sibling state load rejects (note: a sibling whose state was already flagged unreadable in the process-local cache is served from that cache instead of rejecting, bypassing the refusal); acquires ordered locks over `[target, activeSibling]` (sorted by directory to avoid deadlock); on approval sets `activatedAt = Date.now()`, updates the in-memory active-team pointer, and persists. On persist failure, restores in-memory state and returns an error. Auto-switching from an already-active sibling is disabled.
- Errors: `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: team_activate is master-only (only the team's leader session can activate it)`; `Error: cannot verify sibling team states (unreadable: N). Refusing to activate to prevent concurrent activation. Check .octeam/ permissions and retry.`; `Cannot activate: team "<outgoing>" is currently active. Call team_deactivate("<outgoing>") first — auto-switching is disabled.`; `Error: failed to persist activation for team "<id>" (state file write failed)`.

### team_deactivate

- Purpose: deactivate the session's active team; after this no team is available in the session.
- Permission: master-only — direct check `if (team.leadSessionId !== context.sessionID || !isIndexedMasterOf(context.sessionID, team.directory))`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to deactivate |

- Behavior: refuses while the team is busy with an active orchestration; takes the team lifecycle lock + team mutex and revalidates inside the mutex (a concurrent orchestration start may have flipped status; also refuses during `spawning`); idempotent — an already-inactive team returns the already-inactive message; on proceed clears `activatedAt`, clears the active-team pointer, and persists with in-memory rollback on persist failure.
- Errors: `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: team_deactivate is master-only (only the team's leader session can deactivate it)`; `Error: team "<id>" is busy with an active orchestration. Wait for it to finish before deactivating.`; `Error: failed to persist deactivation for team "<id>" (state file write failed)`.

### team_add_member

- Purpose: add a member to an existing team; allowed only while the team is in `live` status (before any session has spawned).
- Permission: master-only — direct check `if (team.leadSessionId !== context.sessionID || !isIndexedMasterOf(context.sessionID, team.directory))`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to add the member to |
| name | string, 1-32, `^[a-z0-9-]+$` | no | auto-picked from the preset pool | member name; preset pool name, no duplicates |
| role | string, 1-64, `^[a-zA-Z]+$` | yes | — | preset role (unknown → "reviewer") |
| prompt | string, 1-8192 | yes | — | member instructions |
| model | string | no | — | explicit model override; stored verbatim (no fallback resolution here, unlike team_create) |
| agent | string | no | derived from role | hardened `oct-*` agent override |
| worktree | boolean | no | — | run the member in an isolated git worktree |

- Behavior: pre-lock validation of explicit `name` (reserved + pool) and `agent` (`oct-*` allowlist); takes the team lifecycle lock + team mutex and reloads state from disk inside the lock; rejects non-`live` status, `spawning`, `members.length >= bounds.maxMembers`, duplicate names, and pool exhaustion; re-reads `config.json` inside the mutex, pushes the new `MemberSpec` (writes `config.json`), pushes the new member state (`pending`, `initialized: false`) and persists `state.json`; on state-write failure performs a compensating spec rewrite so config and state stay consistent.
- Errors: `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: team_add_member is master-only (only the team's leader can add members)`; `Error: "<name>" is a reserved name and cannot be a member name`; `Error: name "<name>" is not a preset pool name. Choose one of: <pool list>`; `Error: agent "<agent>" is not a hardened oct-* agent. ...`; `Error: name "<name>" already exists in team "<id>"`; `Error: no available names left in the pool (all taken by existing members)`; `Error: team "<id>" could not be reloaded (state file unreadable)`; `Error: team "<id>" status is "<status>", not "live". Members can only be added before sessions are spawned (workflow calls).`; `Error: team already has N members (maximum)`; `Error: cannot read config for team "<id>"`; `Error: team "<id>" changed while adding member`.

### team_remove_member

- Purpose: remove a member from an existing team; live-status only, master-only, at least one member must remain.
- Permission: master-only — direct check `team.leadSessionId !== context.sessionID || !isIndexedMasterOf(...)`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to remove the member from |
| member_name | string, min 1 | yes | — | member to remove |

- Behavior: team lifecycle lock + team mutex with a locked state reload before validating; requires `live` status and not spawning, member existence, and more than one member remaining; removes the member from both spec (`config.json`) and state (`state.json`) with rollback and a compensating spec rewrite on save failure (a failed compensating write is logged, so config and state can stay inconsistent); only after both writes succeed, deletes the member's inbox file (`mailbox/<name>.jsonl` — the processed log and `<name>.reserved/` directory are left in place).
- Errors: `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: team_remove_member is master-only (only the team's leader can remove members)`; `Error: team "<id>" could not be reloaded (state file unreadable)`; `Error: team "<id>" status is "<status>", not "live". Members can only be removed before sessions are spawned (workflow calls).`; `Error: cannot read config for team "<id>"`; `Error: member "<name>" not found in team "<id>"`; `Error: team "<id>" has only N member(s). Cannot remove the last member.`.

### team_rename

- Purpose: rename an existing live team; renames the on-disk team directory and updates all stored references and indexes.
- Permission: master-only — direct check `team.leadSessionId !== context.sessionID || !isIndexedMasterOf(...)`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | current team name |
| new_name | string, 1-64, `^[a-z0-9-]+$` | yes | — | new team name; no collision with another team visible to the rename's scope scan (user-scope storage is flat, so the collision check effectively covers every team in scope) |

- Behavior: no-op rename returns an informational message (not an error); takes the namespace lock (shared with team_delete) + lifecycle lock + team mutex, revalidates live/not-spawning inside, and atomically claims the new directory via `mkdir` (EEXIST = collision, TOCTOU-safe); refuses to rename when `config.json` is unreadable or missing (would lose the spec); `fs.rename`s the directory, writes spec (new name) and state to the new location, then rekeys the registry, reindexes the master index, updates the active-team pointer if active, and unlinks the stale lifecycle lock in the new directory; on persistence failure rolls the directory back and restores the spec name.
- Errors: `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: team_rename is master-only (only the team's leader can rename it)`; `Error: team "<id>" status is "<status>", not "live". Teams can only be renamed before sessions are spawned.`; `Error: a team named "<new>" already exists under this session`; `Error: team "<id>" config is unreadable — refusing to rename (<cause>)`; `Error: team "<id>" config is missing — refusing to rename`.

### team_delete

- Purpose: delete a team; without force it refuses during an active orchestration or when member worktrees are dirty, with force it removes on-disk state immediately.
- Permission: master-only — direct check `team.leadSessionId !== context.sessionID || !isIndexedMasterOf(...)`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to delete |
| force | boolean | no | false (handler fallback) | skip safety checks: delete even while busy or with dirty worktrees; running agents are best-effort aborted, sessions stay in OpenCode history |

- Behavior: without force, refuses when busy and when any member worktree has uncommitted changes; namespace lock + lifecycle lock + team mutex, revalidates busy (non-force) and spawning inside; sets `team.deleted = true` first so racing event handlers cannot resurrect the directory; force-deleting a busy team aborts running members (`abortAndResetMembers`), clears the active task, sets status idle (intentionally not persisted since storage is removed); destroys every member's worktree (collecting per-member warnings), then quarantines the team directory and deletes the quarantined storage; unindexes all member sessions and the master index, clears wake hints, and invalidates the in-memory team.
- Errors: `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: team_delete is master-only (only the team's leader session can delete it)`; `Error: team "<id>" is busy with an active orchestration. Wait for it to finish, or re-run with force: true.`; `Error: member(s) <list> have uncommitted changes in their worktrees. Commit or stash them first, or re-run with force: true.`; `Error: team "<id>" is initializing (session/worktree creation in progress). Retry in a few seconds.`; `Error: failed to quarantine team "<id>": <msg>. No worktrees or branches were modified; the team remains tombstoned and can be retried.`; `Error: team "<id>" was quarantined but cleanup failed: <msg>. The canonical team directory is gone; manual quarantine cleanup may be required.`.

### team_list

- Purpose: list all teams in the current scope with status, member count, description, creation time, and active flag.
- Permission: no caller-resolution gate — any session may call. Project scope lists all teams in scope; user scope filters to teams the caller masters (`isIndexedMasterOf`).

Parameters: none.

- Behavior: enumerates team names in scope and returns "No teams found." when empty (also after the user-scope ownership filter); per team reads `config.json` (description, fallback "-") and `state.json` (status, member count, createdAt, active) with each read isolated so one corrupt team cannot hide the others; a team whose state load rejects is still listed with status `error: state unreadable` (a team whose cached in-process state was already flagged unreadable is served from that cache, showing stale status/member data instead of the error marker); renders a Markdown table `Name | Description | Created | Members | Status | Active` with descriptions truncated to 47 chars + "…" when longer than 50 and pipes escaped.
- Errors: none returned as errors; empty result is `No teams found.`, per-team read failures surface as `error: state unreadable` in the Status column.

### team_details

- Purpose: show a team's current status: orchestration progress, member states, and token usage.
- Permission: master+member (read-only) — `const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, { requireActive: false })`; null caller rejected, no master requirement.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to inspect |

- Behavior: read-only, no locks or writes; header shows team name, status, active flag; if an orchestration is active shows type/mode, current round vs max rounds, tokens used, and any pending human-approval request; mode-specific extras: parallel shows reduce + signoff policy, delegate shows a shared-tasklist summary (done / in progress / claimed / pending), loop shows decider + last decision + parse failures, consensus shows reached / not reached; per member shows status, model, unread mailbox count (fetched best-effort via `Promise.allSettled`; zero counts are omitted), and turn count (zero omitted).
- Errors: `Error: caller is not a member of this team`; `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`.

### team_fix_member

- Purpose: modify a team member's name, role, system prompt, and/or agent; only allowed when the team is not busy and the target member is not running.
- Permission: master-only — caller resolved via `resolveCallerInTeam(..., { requireActive: false })` then `if (!caller.isMaster) return "Error: team_fix_member is master-only ..."`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team containing the member |
| member_name | string, min 1 | yes | — | current member name |
| new_name | string, 1-32, `^[a-z0-9-]+$` | no | undefined (no change) | new member name; must be a preset pool name |
| new_role | string, 1-64, `^[a-zA-Z]+$` | no | undefined (no change) | new role; normalized, unknown → "reviewer" (read-only); re-derives the agent unless new_agent is also given |
| new_prompt | string, 1-8192 | no | undefined (no change) | new system-prompt text |
| new_agent | string, min 1 | no | undefined (no change) | hardened agent override; enum (`OCTEAM_AGENTS`): oct-deep, oct-explore, oct-junior, oct-librarian, oct-metis, oct-momus, oct-multimodal-looker, oct-oracle, oct-ultrabrain; re-resolves the model from the agent registry |

At least one of `new_name` / `new_role` / `new_prompt` / `new_agent` must be provided (handler-level check).

- Behavior:
  - Rename (`new_name`): updates the member name in state + spec; re-indexes the session binding; migrates member references inside `activeTask` and `lastInterruptedTask` for every orchestration type (tokens/baselines, responses, signoff records, workflow step actor/verifier/ensemble/reducer, router, arbiter, decider, candidates, scoreboard, quorum participants/ballots); transactionally re-owners claimed/in_progress shared tasks with rollback on failure.
  - Mailbox-directory migration side effect on rename: `fs.rename`s the member's inbox, processed-message log, and reserved directory to the new name — preserving deduplication state and preventing delivery to a future member reusing the old name; ENOENT tolerated, other failures become warnings.
  - Role (`new_role`): writes the normalized role to the spec and re-derives the agent (unless `new_agent` overrides); a role or prompt change deletes the old session after persistence and marks the member uninitialized so the next dispatch re-creates it with the new configuration.
  - Agent (`new_agent`): sets the agent in state + spec and re-resolves the bound model from the agent registry (pre-fetched outside the mutex); model stays unchanged when the registry is unavailable or the agent has no bound model.
  - Worktree teardown on rename (after persistence): destroys the member's old worktree — skipped with a warning if it has uncommitted changes; the member's worktree/session fields are cleared unless the teardown throws (a cleanup that reports failure by return value still clears the fields and reports the destroy as done).
  - Concurrency: lifecycle lock + team mutex with a locked state reload; validations (not busy/spawning, member exists, not running, no name collision) run after the reload; `config.json` written before `state.json`, with full rollback (name, index, mailbox dir, agent/model/role/prompt, compensating spec rewrite) on save failure.
- Errors: `Error: provide at least one of new_name, new_role, new_prompt, or new_agent`; `Error: caller is not a member of this team`; `Error: team_fix_member is master-only (only the team's leader session can modify members)`; `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: agent "<agent>" is not a hardened oct-* agent. ...`; `Error: name "<name>" is not a preset pool name. ...`; `Error: team "<id>" could not be reloaded (state file unreadable)`; `Error: team "<id>" is busy. Wait for the workflow to finish before modifying members.`; `Error: name "<name>" already exists in this team`; `Error: member "<name>" not found in team "<id>"`; `Error: member "<name>" is currently running. Wait for it to finish before modifying.`; `Error: cannot modify member — team config (config.json) is unreadable`; `Error: cannot modify member — team config is absent or member missing from spec`.

## Messaging and shared tasks

### team_send_message

- Purpose: send a message to a teammate's mailbox (point-to-point), or broadcast to all members (`to: "*"`, master-only); the recipient sees it injected automatically on its next turn.
- Permission: master+member — `const sender = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)`; point-to-point allowed for any member; broadcast master-only (`if (args.to === "*" && !sender.isMaster) return "Error: broadcast (to: \"*\") is master-only"`). In isolated parallel runs, member-to-member lateral sends are forbidden (member↔master stays allowed in both directions).

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to send within |
| to | string, min 1 | yes | — | recipient member name, or `"*"` for broadcast (master-only) |
| body | string, 1-32768 | yes | — | message content; also checked at runtime against the team's `messagePayloadMaxBytes` UTF-8 byte cap |
| summary | string, max 200 | no | — | short summary of the message |
| correlation_id | string, max 128, `^[A-Za-z0-9_-]+$` | no | — | correlation identifier |

- Behavior: layered delivery — writes to the recipient's mailbox file, sends a best-effort wake hint if the recipient is idle (never carries content), and the transform hook injects actual content on the recipient's next turn; broadcast resolves to all non-master members; single recipients validated against the roster (or "master"); per-run quota accounting (`messagesSent += recipients.length` under the team mutex against `bounds.maxMessagesPerRun`; partial-delivery failures refund only undelivered recipients, debited against the run that is active when the failure is handled — a run switch between charge and refund can mis-attribute the refund); per-mailbox unread-byte backpressure (`bounds.messageUnreadMaxBytes`) enforced inside the mailbox lock.
- Errors: `Error: caller is not a member of this team`; `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: message body exceeds payload limit (N bytes).`; `Error: broadcast (to: "*") is master-only`; `Error: unknown recipient "<name>"`; `Error: isolated mode forbids member-to-member messaging. You may message "master" only.`; `Error: per-run message limit reached (N). Message not sent.`; `Error: recipient "<name>" mailbox is full (backpressure). Try later.`.

### team_task_create

- Purpose: create a task in the shared team task list, optionally declaring `blocked_by` dependencies on other task IDs.
- Permission: master+member — any member or master of the team via `resolveCallerInTeam(...)`. Disabled entirely in recurse mode (subtasks are generated by the orchestrator) and in parallel isolated mode.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team whose shared task list to append to |
| subject | string, 1-500 | yes | — | task subject line |
| description | string, 1-8192 | yes | — | full task description |
| blocked_by | string[] | no | — | task IDs this task depends on; max 32 entries, each must match the task UUID pattern and reference an existing non-deleted task |

- Behavior: runs under both the cross-process claim mutex and the in-process team mutex (a recurse decomposition cannot race mid-create); `blocked_by` validated inside the mutex (TOCTOU-safe): each entry must pass the canonical UUID pattern and match an existing non-deleted task; enforces the live-task cap `bounds.maxTasks` (non-deleted count); writes a new task file via `createTask`, tagged with the active run's `runId` when a run is active.
- Errors: `Error: caller is not a member of this team`; `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: team has been deleted`; `Error: team_task_create is disabled in recurse mode. Subtasks are created automatically by the orchestrator from the decomposer's <decompose> block.`; `Error: team_task_create is disabled in parallel isolated mode. Isolated members cannot share a task list.`; `Error: blocked_by cannot exceed 32 entries (got N)`; `Error: blocked_by entry "<id>" is not a valid task ID.`; `Error: blocked_by entry "<id>" does not match an existing task.`; `Error: team task limit reached (N). Complete or delete tasks before creating more.`; `Error: failed to create task (internal error)`.

### team_task_list

- Purpose: list tasks in the shared team task list with optional status/owner filters.
- Permission: master+member — membership via `resolveCallerInTeam(...)`; shared-list access rejected in parallel isolated mode (fail-closed if team state cannot be read).

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team whose task list to read |
| status | enum: `pending`, `claimed`, `in_progress`, `completed`, `deleted` | no | — | filter by exact task status |
| owner | string (trimmed, min 1) | no | — | filter by owning member name |
| limit | int 1-200 | no | 100 (runtime `args.limit ?? 100`) | max tasks returned |

- Behavior: reads all task files and applies status/owner filters; output lines `- [status] <id> <subject> @owner (blocked by N)` (suffixes only when present); result capped by `limit` and then by a hard 64 KiB byte cap on the response (byte truncation may retain fewer lines than the limit, but the truncation marker still shows the pre-byte-cap kept count); `[...showing N of M tasks; use limit to show more]` marker when truncated; returns `No tasks.` when empty.
- Errors: `Error: caller is not a member of this team`; `Error: team "<id>" not found`; `Error: shared task access is disabled in parallel isolated mode. Isolated members cannot share a task list.`; `Error: cannot verify team state for isolated-mode check. Underlying error: ...`.

### team_task_update

- Purpose: update a task's status; `status: "claimed"` atomically acquires the persistent claim lock and makes the caller the owner; all other status changes require the caller to be the task owner or master.
- Permission: master+member with ownership rules. Claim is open to any member of a cooperative run (caller becomes owner). Non-claim updates pass `caller.isMaster ? {} : { expectedOwner: caller.name }` to `updateTask`, so a member may only update a task it owns while master bypasses the owner check; `expectedOwner` is verified inside the update lock (TOCTOU-safe). `claimTask` flips the status with `{ expectedStatus: "pending" }` as a compare-and-swap inside the lock.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team owning the shared task list |
| task_id | string (task UUID pattern) | yes | — | task to update |
| status | enum: `claimed`, `in_progress`, `completed`, `deleted` | yes | — | new task status |

- Behavior (status transitions and who may perform each):
  - `claimed` (any member or master): only from `pending`. Runs under claim mutex + team mutex with an isolated-mode guard (fail-closed on unreadable state). Acquires a persistent per-task claim lock file (`fs.open 'wx'`, stale locks reaped after TTL), then flips the task to `claimed` with `owner = caller.name` and `claimedAt` via the pending CAS. Fails if another member holds the lock or the task is not pending, if the caller already holds another task in the claimed/in_progress window (one active task per member), or if any `blocked_by` blocker is not completed/deleted (a missing/corrupt blocker file also blocks).
  - `in_progress` (owner member or master): only from `claimed` (the transition matrix requires an owner patch otherwise, which this tool never sends).
  - `completed` (owner member or master): from any non-deleted status (a pending task can be completed directly; a deleted task admits no further status change). In recurse mode, member-initiated completion is rejected — the orchestrator is the single writer of terminal status and finalizes the task (including the result) when the member goes idle.
  - `deleted` (owner member or master): from any non-deleted status; a completed task may still be deleted; a deleted task admits no further status change.
  - Side effect: transitions out of the claim window remove the persistent claim lock file. Non-claim paths are rejected in parallel isolated mode before any shared-task mutation.
- Errors: `Error: caller is not a member of this team`; `Error: team "<id>" not found`; `Error: cannot verify team state for isolated-mode check. Task claim rejected. Underlying error: ...`; `Error: team_task_claim is disabled in parallel isolated mode. Isolated members cannot share a task list.`; `Error: task <id> already claimed or not claimable.`; `Error: Task <id> is blocked by <blocker> (currently "<status>"); wait for the blocker to complete before claiming`; `Error: Member <name> already holds task <id> in <status> state; complete it before claiming another`; `Error: shared task access is disabled in parallel isolated mode. Isolated members cannot share a task list.`; `Error: task <id> not found`; `Error: cannot verify team state for recurse single-writer check. Task completion rejected to avoid bypassing orchestrator ownership. Underlying error: ...`; `Error: in recurse mode, task completion is owned by the orchestrator. Do NOT call team_task_update(status="completed") — the orchestrator finalizes your task automatically when you go idle, including writing your output as the result. Just solve the task and go idle.`; `Error: only the task owner (@<owner>) or master can update task <id>.`.

### team_task_get

- Purpose: get full details of a single task by ID.
- Permission: master+member — membership via `resolveCallerInTeam(...)`; shared-list reads rejected in parallel isolated mode (fail-closed); team must not be deleted.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team owning the task |
| task_id | string (task UUID pattern) | yes | — | task to fetch |

- Behavior: loads team state to verify it exists and is not deleted, then reads the task file; returns a formatted block: task ID, subject, status with owner, depth (recurse subtasks only), description, blocked-by ID list, and result when present; read-only, no locks or state mutation.
- Errors: `Error: caller is not a member of this team`; `Error: team "<id>" not found`; `Error: shared task access is disabled in parallel isolated mode. Isolated members cannot share a task list.`; `Error: cannot verify team state for isolated-mode check. Underlying error: ...`; `Error: team has been deleted`; `Error: team "<id>" state could not be read`; `Error: task <id> not found`; `Error: task <id> could not be read: <err>`.

## Orchestration modes

### team_parallel

- Purpose: run a task across all members in parallel — isolated (same task, no comms) or cooperative (per-member tasks, free comms).
- Permission: master-only — via the shared `startOrchestration` gate (see [Shared conventions](#shared-conventions-for-the-orchestration-tools)); error text `Error: team_parallel is master-only`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| mode | enum: `isolated` \| `cooperative` | yes | — | parallel mode |
| task | string, max 8192 | yes if mode=isolated | — | isolated: the single task sent to all members |
| tasks | record<string, string max 8192> | yes if mode=cooperative | — | cooperative: `{ memberName: task }` |
| reduce_policy | enum: `summarize` \| `select` \| `merge` \| `rubric` | no | `summarize` | how to combine member outputs |
| reduce_rubric | string, max 8192 | required if rubric | — | scoring rubric when reduce_policy=rubric |
| reduce_select | string, max 8192 | no | — | selection criteria when reduce_policy=select |
| reducer_member | string | required unless summarize | — | member performing the real reduce |
| signoff fields | see conventions | no | none | post-completion review gate |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |
| max_errored_members | int >= 0 | no | 0 | tolerate up to N terminally-errored members and still deliver survivors' work |
| require_done_ack | boolean | no | false | replace the all-idle barrier with an all-acked barrier (`team_done`); re-prompts members that idle without acking |

- Behavior: starts a `type: "parallel"` active task and dispatches to every non-master member with the isolated task or the per-member cooperative map (unassigned members get a "No task assigned" placeholder); `summarize` concatenates with a header summary; `select`/`merge`/`rubric` dispatch a named `reducer_member` to perform an autonomous reduce; barrier is all-idle by default, all-acked with `require_done_ack`.
- Errors: `Error: isolated mode does not support \`tasks\` — use cooperative mode for per-member tasks`; `Error: isolated mode requires \`task\``; `Error: cooperative mode requires \`tasks\``; `Error: cooperative mode \`tasks\` must contain at least one member assignment`; `Error: reduce_policy 'rubric' requires reduce_rubric`; `Error: reduce_policy '<p>' requires reducer_member`; plus the shared startup errors.

### team_consensus

- Purpose: multi-round structured debate across all members until consensus (all emit `<consensus>{"agreed": true}</consensus>`).
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| topic | string, 1-4096 | yes | — | the debate topic |
| max_rounds | int 1-20 | no | 3 | round limit; run fails if hit without consensus |
| human_approval / approval_timeout_ms | see conventions | no | false / — | HITL pause at mid-run boundaries |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |

- Behavior: requires at least 2 non-master members; dispatches round prompts to all participants; ends when every participant emits `agreed: true`, or fails when `max_rounds` is hit without consensus; deliberately has no signoff fields — the all-members-agree mechanism is itself the completion gate.
- Errors: `Error: team_consensus requires at least 2 non-master members`; plus the shared startup errors.

### team_pipeline

- Purpose: linear pipeline where each stage's output is prefixed onto the next stage's task; final output summarized to the leader.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| stages | array, min 1 | yes | — | ordered pipeline stages |
| stages[].member | string, min 1 | yes | — | stage actor (unique across stages) |
| stages[].task | string, 1-8192 | yes | — | stage task text |
| signoff fields | see conventions | no | none | post-completion review gate |
| human_approval / approval_timeout_ms | see conventions | no | false / — | HITL pause |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |

- Behavior: starts a `type: "pipeline"` active task and dispatches stage 1 on startup; each completed stage's output is prefixed onto the next stage's task; the final stage's output is summarized to the leader, with an optional signoff gate afterwards.
- Errors: `Error: pipeline stages must have unique member names`; `Error: unknown member "<name>" in stages`; plus the shared startup errors.

### team_loop

- Purpose: corrective loop (code → review → decide → repeat) where a member decider emits a `<decision>` block each round.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| stages | array, min 1 | yes | — | loop work stages |
| stages[].member | string, min 1 | yes | — | stage actor (unique across stages) |
| stages[].task | string, 1-8192 | yes | — | stage task text |
| stages[].action | enum: `modify` \| `read_only` | no | `read_only` | whether the stage modifies code or only reviews |
| decider | string, min 1 | yes | — | decider member name (not "master"); appended as a final read-only stage if absent from stages |
| max_rounds | int 1-50 | yes | — | round cap |
| initial_task | string, 1-8192 | yes | — | task dispatched to the first stage in round 1 |
| max_decision_parse_failures | int 1-20 | no | 3 | consecutive decision parse failures before the run fails |
| human_approval / approval_timeout_ms | see conventions | no | false / — | HITL pause |
| timeout_ms / token_budget / max_retries | see conventions | no | 900000 / — / 0 | run bounds (loop uses the 15-min default timeout) |

- Behavior: starts a `type: "loop"` active task; if the decider is not listed in stages it is appended as a final `read_only` stage with the decision-format contract; the decider must emit `<decision>{"decision":"done"|"continue","rationale":...,"nextActions":[...]}</decision>`; loops until done, max_rounds, no-issues, timeout, or the parse-failure cap; a decider explicitly listed in stages must be the LAST stage and must not have `action: "modify"`.
- Errors: `Error: decider must be a member name, not "master"`; `Error: loop stages must have unique member names`; `Error: unknown member "<name>" in stages`; `Error: decider "<name>" appears in stage N but must be the LAST stage...`; `Error: decider "<name>" stage must be action "read_only"...`; plus the shared startup errors.

### team_delegate

- Purpose: publish tasks to the shared tasklist; idle members self-claim, execute, and report to the master, with blockedBy dependencies via human-readable refs.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| tasks | array, 1-200 | yes | — | tasks to publish |
| tasks[].ref | string, max 256 | no | — | human-readable id for blockedBy references (uniqueness is enforced for non-empty refs; empty strings are accepted and ignored) |
| tasks[].subject | string, 1-500 | yes | — | task subject |
| tasks[].description | string, 1-8192 | yes | — | task description |
| tasks[].blocked_by | string[] (max 256 each), max 50 | no | — | refs this task is blocked by (must be declared refs, acyclic) |
| signoff fields | see conventions | no | none | post-completion review gate |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |
| max_errored_members | int >= 0 | no | 0 | tolerate N terminally-errored members and still deliver survivors' work |

- Behavior: starts a `type: "delegate"` active task; preallocates task ids, resolves refs to UUIDs, and creates all tasks via `createTask` before committing the active task, enforcing `bounds.maxTasks`; members are prompted to self-claim via `team_task_list` / `team_task_update` and report via `team_send_message`; on startup failure the created tasks are rolled back (deleted).
- Errors: `Error: duplicate ref "<ref>" — each ref must be unique`; `Error: unknown blockedBy ref "<ref>"`; `Error: blocked_by cycle detected: A -> B -> A`; `Error: team task limit reached (N). ... cannot add M more.`; plus the shared startup errors.

### team_route

- Purpose: content-based routing — a router member inspects the input and selects which branch(es) handle it; branches run in parallel; no default route.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| router | string, min 1 | yes | — | router member name (not "master", not a branch member) |
| input | string, 1-32768 | yes | — | content to be routed; also delivered to branches without a per-branch task |
| routes | array, min 1 | yes | — | branch definitions |
| routes[].name | string, 1-64 | yes | — | branch label the router selects by (unique) |
| routes[].member | string, 1-64 | yes | — | branch target member (unique across branches) |
| routes[].task | string, 1-8192 | no | — | per-branch task; if omitted the branch member receives `input` |
| routes[].description | string, max 1024 | no | — | hint shown to the router |
| max_route_parse_failures | int 1-20 | no | 2 | consecutive router decision parse failures before the run fails |
| signoff fields | see conventions | no | none | post-completion review gate |
| human_approval / approval_timeout_ms | see conventions | no | false / — | HITL pause |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |

- Behavior: starts a `type: "route"` active task; phase A dispatches only the router with a prompt built by `buildRouterPrompt` (`src/orchestration/modes/route.ts`); selected branches are dispatched in parallel and their outputs summarized to the leader; unmatched input fails the run (no default route).
- Errors: `Error: router must be a member name, not "master"`; `Error: route branch names must be unique`; `Error: route branch members must be unique`; `Error: router must not also be a branch target`; `Error: unknown member "<name>" in router/routes`; plus the shared startup errors.

### team_arbitrate

- Purpose: authoritative ruling — debaters argue a dispute over up to max_rounds, then a single arbiter issues a binding ruling.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| task | string, 1-8192 | yes | — | the dispute / subject under arbitration |
| arbiter | string, min 1 | yes | — | arbiter member name (not "master", not a debater) |
| debaters | string[] (1-64 each), 2-12 | yes | — | debater member names (unique, none may be the arbiter) |
| max_rounds | int 1-20 | no | 1 | debate round limit before the ruling |
| hitl_phase | enum: `pre` \| `post` \| `both` | no | `pre` | HITL pause point(s) when human_approval is true (pre = after debate, before arbiter; post = after ruling, before delivery) |
| max_ruling_parse_failures | int 1-20 | no | 2 | consecutive arbiter ruling parse failures before the run fails |
| signoff fields | see conventions | no | none | post-completion review gate |
| human_approval / approval_timeout_ms | see conventions | no | false / — | HITL pause |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |

- Behavior: starts a `type: "arbitrate"` active task; round 1 dispatches only the debaters with `buildDebatePrompt` (`src/orchestration/modes/arbitrate.ts`); after up to `max_rounds` debate rounds the arbiter weighs all positions and issues a binding ruling; when `human_approval` is true the run pauses per `hitl_phase`.
- Errors: `Error: arbiter must be a member name, not "master"`; `Error: debaters must have unique names`; `Error: arbiter must not also be a debater`; `Error: <label> "<name>" is not a member of team "<team>"`; plus the shared startup errors.

### team_recurse

- Purpose: hierarchical recursive decomposition — a root task decomposes into subtasks (up to max_depth), and results aggregate back up until the root is solved.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| task | string, 1-8192 | yes | — | the root task / goal to recursively decompose and solve |
| decomposer | string, min 1 | yes | — | member first dispatched with the root task (not "master"); decomposition is open to all members |
| max_depth | int 1-8 | no | 3 | recursion depth upper bound; tasks at this depth cannot decompose further |
| max_subtasks | int 1-20 | no | 5 | per-decomposition subtask upper bound |
| max_aggregation_dispatches | int 1-20 | no | 3 | max aggregation re-dispatches before declaring the run stalled |
| signoff fields | see conventions | no | none | post-completion review gate |
| human_approval / approval_timeout_ms | see conventions | no | false / — | HITL pause |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |
| max_errored_members | int >= 0 | no | 0 | failure isolation for independent subtask execution |

- Behavior: starts a `type: "recurse"` active task; seeds a root task (depth 0, subject truncated to 480 chars) in the shared tasklist via `createTask`, enforcing `bounds.maxTasks`; dispatches only the decomposer with the recursive contract (`buildRecursePrompt`, `src/orchestration/modes/recurse.ts`) while other members pull claimable tasks; uses the shared task list and blockedBy DAG for layered aggregation; on startup failure the root task is rolled back (deleted).
- Errors: `Error: decomposer must be a member name, not "master"`; `Error: team task limit reached (N)...`; plus the shared startup errors.

### team_tollgate

- Purpose: verdict-gated pipeline — a three-valued verification gate (PASS/FAIL/INVALID) sits between stages; a downstream stage starts only on PASS.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| stages | array, min 1 | yes | — | gated stages |
| stages[].member | string, min 1 | yes | — | producer member name (unique across stages; never also a verifier anywhere) |
| stages[].task | string, 1-8192 | yes | — | producer's task |
| stages[].verifier | string, min 1 | yes | — | verifier member name (must differ from member) |
| stages[].criteria | string, 1-8192 | yes | — | verification criteria (tolerance / conservation law / reference description) |
| stages[].reference | string, max 8192 | no | — | golden reference location for a Compare-style numerical verdict |
| escalate_to | string | no | escalate to leader | INVALID escalation target member; must not be any stage producer |
| max_gate_retries | int 0-20 | no | 0 | gate FAIL retry cap (distinct from provider max_retries); first FAIL fails by default |
| max_invalid_cycles | int 0-20 | no | 3 | cap on INVALID/escalate ping-pong per gate; beyond it fails with `tollgate_invalid:exhausted` |
| signoff fields | see conventions | no | none | post-completion review gate |
| human_approval / approval_timeout_ms | see conventions | no | false / — | HITL pause |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |

- Behavior: starts a `type: "tollgate"` active task and dispatches the stage-0 producer via `advanceToGatedStage` (`src/orchestration/modes/tollgate.ts`); FAIL returns the producer with a diff (up to `max_gate_retries`, then the run fails); INVALID isolates the stage and escalates the verifier side — the producer is not penalized; enforces role separation: each gate's verifier differs from its producer, no member is producer in one gate and verifier in another, and no producer appears in multiple stages (shared response slots would overwrite artifacts).
- Errors: `Error: stage verifier "<v>" must not equal its producer "<m>"`; `Error: escalate_to "<name>" must not equal stage producer...`; `Error: member "<name>" appears as both producer and verifier across different gates...`; `Error: producer "<name>" appears in multiple stages...`; `Error: unknown member "<name>" in stages/escalate_to`; plus the shared startup errors.

### team_arena

- Purpose: competitive arena — N candidates implement competing solutions in isolated worktrees; an evaluator scores every candidate and a deterministic winner is delivered directly.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| task | string, 1-8192 | yes | — | shared implement task every candidate works on |
| evaluator | string, min 1 | yes | — | evaluator member name (not "master", not a candidate) |
| candidates | string[] (1-64 each), max 12 | no | all non-master members except the evaluator | candidate member names (unique, >= 2) |
| eval_command | string, max 8192 | one of eval_command/eval_criteria | — | objective command the evaluator runs against each candidate worktree |
| eval_criteria | string, max 8192 | one of eval_command/eval_criteria | — | scoring criteria for the evaluator |
| winner_metric | string, max 64 | no | `"score"` | metric the winner is selected on |
| score_direction | enum: `max` \| `min` | no | `"max"` | whether the winner is the max or min of the winner metric |
| max_eval_retries | int 0-5 | no | 1 | evaluator re-dispatch cap on scoreboard parse/selection failure |
| max_errored_members | int >= 0 | no | 0 | candidate failure isolation during implement |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |

- Behavior: starts an `type: "arena"` active task (implement phase); every candidate must have an isolated git worktree (`worktree: true` at member creation) — startup fails listing members missing one; the shared task is dispatched to every candidate in its own worktree; the evaluator waits for the evaluate phase, runs the same objective evaluation over each surviving candidate (errored candidates stay in the task for audit but are excluded from scoring), and emits a structured scoreboard; the deterministic winner (on `winner_metric` with `score_direction`) is delivered directly — no signoff gate.
- Errors: `Error: unknown evaluator "<name>"`; `Error: evaluator "<name>" must be a non-master member`; `Error: candidates must have unique names`; `Error: evaluator "<name>" must not also be a candidate`; `Error: team_arena requires at least 2 candidates`; `Error: team_arena requires at least one of eval_command or eval_criteria`; `team_arena requires every candidate to have an isolated worktree (create with worktree:true): ...`; plus the shared startup errors.

### team_quorum

- Purpose: replicated k-of-n voting — N members independently answer the same fixed-schema question; strict majority wins; no debate, no early exit.
- Permission: master-only — shared `startOrchestration` gate.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| task | string, 1-8192 | yes | — | the voting question; sent verbatim to all participants |
| vote_key | string, 1-64, `^[A-Za-z0-9_]+$` | yes | — | ballot field name; members emit `<vote>{"<vote_key>": "<value>"}</vote>` |
| vote_options | string[] (1-256 each), max 20 | no | any non-empty string | whitelist of legal values; values outside count as abstain (invalid ballot) |
| members | string[] (1-256 each), max 50 | yes (schema has no `.optional()`; describe says "default = all non-master members" and validate falls back to that) | all non-master members | subset of members who ballot; length >= 2 |
| max_errored_members | int >= 0 | no | N - 1 (participants minus 1) | tolerate N runtime-errored members and still tally; must be < participant count; invalid ballots always abstain |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run bounds |

- Behavior: single-round orchestration: dispatch the ballot prompt to all participants → wait-all barrier → tally → deliver verdict; all participants run to completion; the option with strict majority (`k > valid_ballots/2`) wins; malformed ballots and runtime errors abstain (excluded from the denominator); deliberately has no signoff fields (quorum IS the verdict) and no human_approval fields (single-round, no pause point).
- Errors: `Error: team_quorum requires at least 2 participants`; `Error: duplicate participant "<name>" in members`; `Error: unknown member "<name>" in members`; `Error: vote_options must not be empty...`; `Error: vote_options must not contain blank values`; `Error: max_errored_members (N) must be less than participant count (M)`; plus the shared startup errors.

## Workflow

### team_workflow

- Purpose: deterministic, declaratively-composed workflow of `task`, `gate`, `fanout`, and `join` steps; the engine (not the master LLM) drives transitions, retries, INVALID handling, and verdict-gated jumps.
- Permission: master-only — explicit check in the tool: `const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id); if (!caller?.isMaster) return "Error: team_workflow is master-only"` (plus the shared `startOrchestration` gate).

Top-level parameters:

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| steps | array, 1-256 | one of steps/workflow_file | — | ordered workflow steps; fanout must be immediately followed by a join marker; capped at 256 total steps after matrix/foreach expansion |
| workflow_file | string, min 1 | one of steps/workflow_file | — | relative path to a JSON workflow file under the workspace (schema version 1); mutually exclusive with steps |
| vars | record<string, string> | no | — | template variables for workflow_file strings, referenced as `${name}` |
| dry_run | boolean | no | — | validate and render the 1-based step ledger without starting orchestration |
| signoff fields | see conventions | no | none | post-completion review gate |
| human_approval / approval_timeout_ms | see conventions | no | false / — | HITL pause |
| timeout_ms / token_budget / max_retries | see conventions | no | 600000 / — / 0 | run-level bounds |

Step fields (`kind`: enum `task` | `gate` | `fanout` | `join`, required; branch steps only allow `task` | `gate`):

| field | type | applies to | required | default | description |
|------|------|-----------|----------|---------|-------------|
| id | string, 1-64 | all | no | — | stable step identifier; gates may reference task steps by id |
| member | string, min 1 | task | yes | — | actor member name |
| fallback_member | string, min 1 | task | no | — | fallback actor when member has no live session |
| task | string, 1-8192 | task | yes | — | task text |
| verifier | string, min 1 | gate | yes (single) | — | verifier member name (must differ from the target task member) |
| fallback_verifier | string, min 1 | gate | no | — | fallback verifier; must differ from every target task member |
| verifiers | string[], min 2 | gate | no | — | ensemble verifiers; mutually exclusive with verifier/fallback_verifier; requires ensemble_policy |
| ensemble_policy | enum: `majority` \| `quorum` \| `unanimous` | gate | with verifiers | — | verdict aggregation (majority > 50%; quorum = ensemble_quorum fraction; unanimous = all) |
| ensemble_quorum | number, > 0 and <= 1 | gate | when quorum policy | — | quorum fraction |
| criteria | string, 1-8192 | gate | yes | — | verification criteria |
| target_step | step ref (int >= 1 or string) | gate | no (implicit target: nearest preceding task or join) | — | single target step (1-based number or id; may reference a task or a join; branch-local in branches) |
| targets | step refs[], min 1 | gate | no (see target_step) | — | multiple prior task/join steps verified together |
| inputs | step refs[], min 1 | task | no | implicit upstream selection | explicit upstream task/join steps to include |
| expose_output | boolean | task | no | true | when false, suppress this output from implicit downstream context |
| retry_on | object: one of `empty` (must be true) / `output_contains` / `output_not_contains` / `regex` (string) | task | no | — | auto-retry condition (exactly one key); requires max_task_retries |
| max_task_retries | int 0-5 | task | with retry_on | 0 | auto-retry attempts |
| on_fail | enum: `retry` \| `fail` \| `skip` | gate | no | `fail` | FAIL control; retry re-dispatches the target up to max_retries (required when on_fail=retry); skip advances |
| max_retries | int 0-5 | gate | yes when on_fail=retry | — | FAIL retry cap when on_fail=retry |
| on_invalid | enum: `fail` \| `retry_verifier` \| `escalate` | gate | no | `fail` | INVALID control; escalate pauses for human approval |
| max_invalid_retries | int 0-5 | gate | when retry_verifier | 0 | retry_verifier cap |
| on_malformed | enum: `fail` \| `retry_verifier` \| `skip` \| `escalate` | gate | no | inherits `on_invalid` when unset (falling back to `fail`) | parse-failure control |
| max_malformed_retries | int 0-5 | gate | when retry_verifier | 0 | malformed-retry cap |
| on_pass_goto / on_fail_goto / on_invalid_goto | step ref | gate | no | — | jump targets after PASS / at FAIL terminal / at INVALID terminal (branch-local in branches) |
| where | object: one of `score_gte` (0-10) / `score_lt` (0-10) / `confidence_gte` (0-1) / `has_issue_severity` (`low`\|`medium`\|`high`\|`critical`) | gate | no | — | threshold condition gating the gotos (exactly one key) |
| approval_before / approval_after | boolean | task/gate | no | — | pause for team_approve before dispatch / after completion; disallowed inside fanout branches |
| max_output_bytes | int >= 1 | task | no | — | cap the captured output snapshot (head+tail preserved) |
| timeout_ms | int >= 1000 | task/gate | no | — | per-step wall-clock deadline from dispatch |
| on_timeout | enum: `fail` \| `retry` \| `skip` | task/gate | no | `fail` | timeout control (branch steps may only use `fail`: `retry`/`skip` and `max_timeout_retries` are rejected inside fanout branches) |
| max_timeout_retries | int 0-5 | task/gate | when on_timeout=retry | — | timeout retry cap |
| max_jumps | int 0-10 | gate | no | 3 | per-gate verdict-driven jump cap; exceeding terminates as `workflow_failed:jump_limit` |
| loop | object: `max_iterations` (int 1-20, required), `on_exhaust` (`fail`\|`continue`) | gate | no | — | loop control for on_fail_goto; requires on_fail_goto; incompatible with on_fail retry/skip |
| join_policy | enum: `all` \| `quorum` \| `any_success` \| `required_branches` \| `reduce` \| `select` | fanout | no | max_errored tolerance | join semantics; reduce/select dispatch reducer_member after all branches finish |
| quorum | number 0-1 | fanout | when join_policy=quorum | — | survivor fraction required |
| required_branches | string[], min 1 | fanout | when required_branches policy | — | branch ids that must succeed |
| reducer_member | string, min 1 | fanout | for reduce/select | — | member aggregating (reduce) or choosing (select) branch outputs |
| use_survivors | boolean | fanout | no | — | continue with surviving branch outputs instead of failing on branch errors |
| matrix | record<string, string[]>, keys `^[A-Za-z0-9_]+$` | fanout | no | — | cartesian-product expansion substituting `${name}` in branch text; exclusive with branches/foreach; requires a template `steps` array (only expressible via `workflow_file` — the inline `steps` schema does not expose it) |
| foreach | string[], min 1 (enforced at expansion, not by the schema) | fanout | no | — | single-dimension list; one branch per value substituting `${as}`; exclusive with branches/matrix; requires a template `steps` array (workflow_file only, as with matrix) |
| as | string, `^[A-Za-z0-9_]+$` | fanout | no | `item` | foreach variable name |
| branches | array of `{ id: string (1-64), steps: array (min 1) of branch step (kind task\|gate) }` | fanout | one of branches/matrix/foreach | — | explicit fanout branches with stable ids and branch-local task/gate steps |
| max_errored | int >= 0 | fanout | no | 0 | max errored branches tolerated (must leave one survivor) |

- Behavior: starts a `type: "workflow"` active task; the engine (`src/orchestration/workflow/engine.ts`: `dispatchTaskStep`, `advanceWorkflowStep`, `maybePauseBeforeWorkflowStep`) drives step transitions, keeping intermediate results out of the leader's context; steps are lowered from the authoring format in `src/tools/workflow/lower.ts`; `workflow_file` is loaded by `src/orchestration/workflow/loader.ts` (version 1 schema, 1 MiB file cap, workspace path containment, `${name}` templating); matrix/foreach fanouts expand before validation; gates verify prior task outputs (PASS/FAIL/INVALID verdicts) with per-gate retry, jump, and loop controls bounded by `max_jumps` and `loop.max_iterations`; total expanded steps capped at 256; `dry_run` validates and renders the 1-based step ledger without starting orchestration.
- Errors: `Error: team_workflow is master-only`; `Error: team_workflow must set exactly one of steps or workflow_file`; `Error: workflow expands to N steps, exceeding the 256 limit`; `Error: duplicate step id "<id>" at steps N and M`; `Error: join step N has no matching fanout step`; `Error: join step N has join-policy fields...`; `Error: workflow_file must be relative to the workspace` / `... must point to a .json file` / `... must stay inside the workspace`; `Error: failed to load team state for dry-run: ...`; plus the shared startup errors. Deeper authoring-format rules and troubleshooting live in [workflow.md](./workflow.md).

### team_planner

- Purpose: master-only human-in-the-loop planner that authors a team + team_workflow via an `oct-metis` child session, with propose/revise/write ops.
- Permission: master-only — `if (isIndexedMember(context.sessionID)) return "Error: team_planner is master-only; a team member session cannot run it"` (rejects indexed member sessions before any planner session opens or loader is written).

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| op | enum: `propose` \| `revise` \| `write` | yes | — | planner operation |
| team_id | string, min 1 (safe lowercase slug `^[a-z0-9-]+$`, max 64) | yes | — | slug; the generated team.name must equal it |
| goal | string | propose/revise | — | the objective the team+workflow must accomplish |
| constraints | string | no (propose) | — | extra constraints for the planner |
| previous_team | object or JSON string | revise | — | prior team JSON to revise |
| previous_workflow | object or JSON string | revise | — | prior workflow JSON to revise |
| feedback | string, max 32768 | revise | — | what to change about the previous plan |
| team | object or JSON string | write | — | team JSON to validate and persist |
| workflow | object or JSON string | write | — | workflow JSON to validate and persist |
| dry_run | boolean | no (write) | false | validate + preview target paths without writing |
| overwrite | boolean | no (write) | false (no-overwrite) | replace both loaders if they already exist |

- Behavior: `propose`/`revise` open one `oct-metis` child session (`runPlannerSession`), prompt with goal/feedback plus a formatting contract, poll (300 s timeout, 2 s interval), extract JSON strictly from a `<team_planner>...</team_planner>` tag, re-prompt the same session with the exact error up to 2 correction rounds, and return a preview — nothing is written; `write` runs deterministic validation only (never calls a model): team name must match team_id, 1-12 members with preset-pool names, lowercase-letter roles, required prompts (<= 8192 chars), valid bounds, and a version-1 workflow whose members/verifiers are declared and verifiers differ from producers; persists `team.<id>.json` + `workflow.<id>.json` under the workspace via atomic writes under a `planner.lock`, with backup and rollback on overwrite; reads no existing team lifecycle state.
- Errors: `Error: team_planner is master-only; a team member session cannot run it`; `Error: team_id "<id>" must be a safe lowercase slug...`; `Error: op=propose requires 'goal'`; `Error: op=revise requires 'goal'/'feedback'/'previous_team'/'previous_workflow'`; `Error: team is required` / `Error: workflow is required` (write); `Error: refusing to overwrite existing loader(s)... pass overwrite: true to replace both`; `Error: team.name must match team_id "<id>"`; `Error: team.members must have at most 12 members (got N)`; `Error: unknown team_planner op`.

## Run control

### team_cancel

- Purpose: cancel the in-flight orchestration on a busy team; aborts running member turns, clears the active task, and returns the team to idle WITHOUT deleting it (members, sessions, and worktrees are kept and reusable).
- Permission: master-only — direct check `if (team.leadSessionId !== context.sessionID || !isIndexedMasterOf(context.sessionID, team.directory))`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team whose orchestration to cancel |

- Behavior: requires status busy with an active task (no-op error otherwise); under the team mutex, `abortAndResetMembers` aborts running member turns and resets them; `finishRun(ctx, team, "cancelled", "idle", "failed")` notifies the master, clears the active task, and transitions the team to idle; the run is recorded with outcome `cancelled` and status `failed` so metrics do not count it as a success; warns if some members could not be aborted.
- Errors: `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: team_cancel is master-only (only the team's leader session can cancel it)`; `Error: team "<id>" has no active orchestration to cancel.` (a concurrent cancel that wins the mutex race returns the same text without the `Error: ` prefix).

### team_fix_workflow

- Purpose: master-only workflow repair — redispatch, skip, advance, fail, or reassign steps of a busy or interrupted `team_workflow` run without cancelling the whole team.
- Permission: master-only — `resolveCallerInTeam(..., { requireActive: false })` then `if (!caller.isMaster) return "Error: team_fix_workflow is master-only"`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team owning the workflow |
| op | enum: `redispatch` \| `skip` \| `advance` \| `fail` \| `reassign` | yes | — | repair operation |
| step | int >= 1 or string, min 1 | no | first active frontier step (redispatch/skip/reassign) | 1-based step number or stable step id; `advance` always targets the first active frontier step (step ignored) |
| reason | string, 1-200 | no | `operator_fix` (sanitized) | operator reason used by op=fail (sanitized to `[A-Za-z0-9_.:-]`, max 80 chars) |
| to_member | string, min 1 | reassign | — | target member name (must be a live team member) |

- Behavior: repair targets a busy workflow (rejected while an approval is pending) or an interrupted workflow (status failed + checkpoint of type workflow, promoted to busy with `runnerPid` reset and errored members reset to idle — note the interrupted path does not check for a stale pending approval on the checkpoint); all operations run under the team mutex with a state snapshot — an error result or thrown exception restores the in-memory/persisted state snapshot, but external side effects already performed (session aborts, re-dispatches, mailbox/event writes) are not undone; workflow invariants are re-validated around the mutation for skip/advance (before the mutation) and reassign (after), but not for `fail`; successful fixes record a `repaired` event — except `op=fail`, which finishes the run (clearing the active task) before the event would be recorded, so none is written. Per-op semantics:
  - `redispatch` — an active, non-completed frontier step: aborts the currently dispatched actor's running session (must succeed, else refused to avoid turn races), resets `dispatchedAt`, and re-dispatches the same step.
  - `skip` — an active non-marker (fanout/join) step: aborts the actor, marks `completed = true` + `skipped = true`, clears dispatch fields, advances the workflow.
  - `advance` — the first active frontier step: marks `completed = true`, clears dispatch fields, advances unconditionally.
  - `fail` — regardless of step: finishes the run with the sanitized reason (`workflowOperatorFailReason`), status failed.
  - `reassign` — an active non-marker step: requires `to_member` with a live session (not missing, not errored), not already owning the step, not active in a sibling branch, and not a duplicate ensemble verifier; updates the actor field (`member`, `verifier`, or `verifiers[0]` for ensemble gates, clearing the old verifier's ensemble result), aborts the old actor, and re-dispatches to the new member.
- Errors: `Error: team_fix_workflow is master-only`; `Error: team "<id>" not found` / `could not be loaded (state file unreadable)`; activation gate error; `Error: cannot repair the workflow while an approval is pending; approve or reject it first`; `Error: team "<name>" has no active or interrupted workflow to fix` / `Error: active task is not a workflow`; `Error: workflow has no active step to redispatch|skip|advance|reassign`; `Error: step <n> does not exist` / `Error: step <n> is not in the active workflow frontier` / `Error: step <n> is already completed`; `Error: step <n> marker steps cannot be skipped directly` / `Error: step <n> marker steps cannot be reassigned`; `Error: team_fix_workflow op='reassign' requires `to_member``; `Error: step <n> is already owned by "<member>"` / `Error: "<member>" is not a team member` / `Error: "<member>" has no live session`; `Error: "<member>" is already active in branch "<branchId>"` / `Error: "<member>" is already a verifier in this ensemble gate — reassignment would create a duplicate`; `Error: step <n> cannot be redispatched` / `Error: step <n> cannot be redispatched to "<member>"`; `Error: cannot abort previous turn for member "<name>" before redispatch. <msg>`; `Error: workflow invariant violation after fix: <violations>`; `Error: team_fix_workflow failed: <msg>`.

### team_done

- Purpose: member-side explicit completion acknowledgement for `require_done_ack` parallel runs; replaces the all-idle barrier with an all-acked barrier.
- Permission: member-only (the only such tool) — `const caller = await resolveCallerInTeam(...); if (caller.isMaster) return "Error: team_done is a member-only acknowledgement; the master does not call it"`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team with the done-ack run in progress |

- Behavior: only meaningful for `parallel` isolated/cooperative runs started with `require_done_ack: true`; a member should call it exactly once after finishing every step of its task (including required messages and self-verification); members that go idle without acking get an automatic re-prompt from `processIdle` instead of ending the orchestration; sets `member.declaredDone = true` under the team mutex, re-validating run identity inside the mutex (a stale ack from a prior run is refused); persists the flag and rolls back if persistence fails; idempotent in effect — a second call in the same run returns an "Already acknowledged." notice; the barrier fires when every participant has acked (or earlier via timeout/turn-cap).
- Errors: `Error: caller is not a member of this team`; `Error: team_done is a member-only acknowledgement; the master does not call it`; `Error: team "<id>" not found` / `could not be loaded (state file unreadable)`; `Error: no active orchestration on this team — nothing to acknowledge`; `Error: team_done does not apply to <type> orchestrations (parallel only)`; `Error: team_done does not apply to parallel/<mode> (isolated/cooperative only)`; `Error: this run did not enable require_done_ack; just stop producing tool calls and the barrier will fire normally on idle`; `Error: the active run changed before this acknowledgement was applied; re-evaluate the current run and ack again if appropriate`.

### team_intervene

- Purpose: inject a high-priority, `[DIRECTIVE]`-marked message into a member's mailbox (point-to-point or broadcast) during a running orchestration, without touching control flow.
- Permission: master-only — `resolveCallerInTeam(...)` (requireActive defaults to true) then `if (!caller.isMaster) return "Error: team_intervene is master-only"`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | target team |
| to | string, min 1 | yes | — | member name, or `"*"` to broadcast to all (non-master) members |
| body | string, 1-32768 | yes | — | directive text |
| summary | string, max 200 | no | — | optional short summary |

- Behavior: requires the team busy with an active task (no directives on idle/live/failed); recipients validated to exist and must not be "master"; enforces the team-configurable `messagePayloadMaxBytes` cap (UTF-8) beyond the schema max; binds the directive to the active `runId` (the runId-filtered transform hook rejects cross-run replay) — an active task without a runId is refused; writes the mailbox message (`kind: "directive"`, `from: "master"`) via `deliverToRecipients` under the team mutex, with backpressure enforced inside the mailbox lock; inject-only: does not re-dispatch members or alter control flow; directives are exempt from the per-run `maxMessagesPerRun` comms quota.
- Errors: `Error: team_intervene is master-only`; `Error: team "<id>" not found` / `could not be loaded (state file unreadable)`; `Error: directive body exceeds payload limit (N bytes).`; `Error: team "<id>" has no active run to intervene on.`; `Error: team_intervene cannot target "master"; directives are delivered to member mailboxes only.`; `Error: unknown recipient "<name>"`; `Error: cannot send directive — active task has no runId. Wait for the workflow to initialize and retry.`; `Error: recipient "<name>" mailbox is full (backpressure). Try later.`.

### team_resume

- Purpose: resume an interrupted (failed-after-crash) orchestration from its preserved checkpoint; re-dispatches incomplete members.
- Permission: master-only — `resolveCallerInTeam(..., { requireActive: false })` then `if (!caller.isMaster) return "Error: team_resume is master-only"`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to resume |
| timeout_ms | int >= 1000 | no | — | wall-clock timeout for the resumed run; clamped by `bounds.maxWallClockMinutes` |
| token_budget | int >= 1 | no | — | overrides the resumed task's token budget |

- Behavior: requires the team activated and status `failed` with a preserved checkpoint; three-phase locking: phase 1 (mutex) snapshots the checkpoint + sets a spawning lease + resets errored members to idle (arena candidates/evaluator exempt) + saves without committing the active task; phase 2 (outside the mutex) probes member session reachability (5 s timeout) and runs `ensureMembersReady` (spawns missing sessions); phase 3 (mutex) atomically commits activeTask + status busy + `runnerPid`, dispatches per mode, and clears the checkpoint and lease only on success (the lease itself is also cleared on the failure path so a retry can proceed). Per-mode recovery: parallel/consensus re-dispatch incomplete members (incomplete = `requireDoneAck ? !declaredDone : !responses`), and a zero-dispatch resume re-drives the barrier immediately to avoid stalling to the wall-clock timeout; pipeline/loop advance to the persisted stage; delegate reaps stale claims and resets claimed/in_progress tasks to pending — except tasks whose owner still has a live, running session (preserved to avoid duplicate work). `task.startedAt` is reset (full fresh timeout) and the optional overrides applied. On failure, active rollback: clears activeTask, restores status failed, and preserves the checkpoint for retry — note the preserved checkpoint is the same (partially re-dispatched) object Phase 3 mutated, not a pristine pre-resume copy; members dispatched during the partial resume are aborted (marked errored) and the member snapshot restored.
- Errors: `Error: caller is not a member of this team`; `Error: team_resume is master-only`; `Error: team "<id>" not found` / `could not be loaded (state file unreadable)`; activation gate error (team_activate required first); `Error: no interrupted task to resume (team must be 'failed' with a preserved checkpoint)`; `Error: team state changed during resume`; `Error: team already resumed or state changed`; `Error: resume failed (<msg>), checkpoint preserved for retry`.

### team_approve

- Purpose: approve the current human-approval pause and resume the orchestration per the approval kind.
- Permission: master-only — `resolveCallerInTeam(...)` then `if (!caller.isMaster) return "Error: team_approve is master-only"`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team with the pending approval |
| approval_id | string, min 1 | yes | — | must match the pending approvalRequest id (internal direct callers fall back to the pending id at invocation) |
| feedback | string, max 32768 | no | — | optional feedback attached to the decision record |

- Behavior: under the team mutex, validates a pending approval exists, the id matches, and the request carries the payload its kind requires; shifts `task.startedAt` forward by the paused duration so the wall-clock timeout accounts for the human delay; appends an ApprovalDecisionRecord to `task.approvalHistory`. Per-kind approval: `pipeline_stage` advances to the next stage; `tollgate_gate` starts verification (pre-verify / INVALID-retry pauses) or advances past the gate; `loop_done` approves loop completion (delivers with `loop_complete:human_approved`); `route_decision` advances routing after the decision; `arbitrate_ruling` dispatches the arbiter to rule (pre-ruling pause) or honors signoff then finishes the run (post-ruling pause); `consensus_deadlock` finishes the run as accepted at max rounds (idle, `consensus_max_rounds_accepted`); `recurse_decompose` approves the decomposition; `workflow_step` advances the workflow step. On success clears the approval fields, persists, and records an `approval_resolved` event — except for terminal decisions that finish the run (the active task is cleared first, so no event is recorded); on resolution error rolls back startedAt/approval fields/history on the task object and rethrows (a terminal decision that already finished the run cannot be un-finished — the rollback only touches the detached task).
- Errors: `Error: team_approve is master-only`; `Error: team "<id>" not found` / `could not be loaded (state file unreadable)`; `Error: team "<name>" has no pending human approval.`; `Error: approval_id "<id>" does not match pending approval "<id>".`; `Error: approval request <id> has an incomplete payload for kind "<kind>": <gap>`; `Error: unsupported approval kind.`.

### team_reject

- Purpose: reject the current human-approval pause and apply the mode-specific rejection behavior.
- Permission: master-only — same shared approval handler as team_approve; the master check error reads `Error: team_reject is master-only`.

Parameters: identical to team_approve (`team_id`, `approval_id`, optional `feedback`).

- Behavior: same validation, startedAt shift, and history bookkeeping as approve. Per-kind rejection: `pipeline_stage` finishes the run `pipeline_human_rejected` (failed); `tollgate_gate` → `tollgate_human_rejected` (failed); `loop_done` fails with `loop_complete:human_rejected_max_rounds` when the round cap is already reached, otherwise forces another round with the feedback; `route_decision` → `route_human_rejected` (failed); `arbitrate_ruling` → `arbitrate_human_rejected` (failed); `consensus_deadlock` → `consensus_human_rejected` (failed); `recurse_decompose` rejects the decomposition; `workflow_step` → `workflow_human_rejected` (failed). Clears the approval fields, persists, records an `approval_resolved` event when the task is still active (terminal rejections that finish the run record none); same rollback/rethrow on error.
- Errors: same set as team_approve, with the team_reject master-only variant.

## Query

All query tools resolve the caller with `resolveCallerInTeam(..., { requireActive: false })` — teams do not need to be active to be inspected.

### team_query

- Purpose: query detailed information about a specific team member by name.
- Permission: master+member — but non-masters are restricted to their own member info (handler check quoted from `inspect.ts`: non-master callers inspecting another member get `Error: non-master members can only inspect their own member info.`).

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team whose member to inspect |
| member_name | string, min 1 | yes | — | member to query |

- Behavior: loads team state and finds the member by exact name; role and prompt are read from the team spec, falling back to "unknown" when the spec file is absent; returns fixed lines (Name, Role, Prompt, Agent, Model, Status, Initialized, Turn count) plus conditional lines when present (Session ID, Worktree, Error, Tokens used from the active task's per-member tally); master identity comes from `caller.isMaster` (session index), not the tamperable state field.
- Errors: `Error: caller is not a member of this team`; `Error: team "<id>" not found`; `Error: team "<id>" could not be loaded (state file unreadable)`; `Error: member "<name>" not found in team "<id>"`; `Error: team "<id>" config could not be read: ...`; `Error: non-master members can only inspect their own member info.`.

### team_metrics

- Purpose: aggregate token/message/success metrics across a team's recent run records (read-only, real-time); token-only, no pricing.
- Permission: master+member (no master check).

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team whose run records to aggregate |
| limit | int 1-50 | no | 20 | max runs to aggregate, newest first |

- Behavior: re-reads run records on every call (no cache) and aggregates over the newest limit-capped slice; reports run totals (completed/failed/success %), token and message totals, per-orchestration-type count/tokens, workflow step durations (count/total/avg ms), and per-member token totals; zero-token runs are flagged `(no token data)` and counted, never summed as a measured zero; ends with a per-run list (newest first) and a `showing X of Y retained` note when the limit hides runs.
- Errors: `Error: caller is not a member of this team`; `Error: run records for team "<id>" could not be read: ...`. Non-error notice: `No run records for team "<id>" yet.`.

### team_progress

- Purpose: show a team's live progress — current member states plus the run's event timeline; `format=mermaid` renders a live team_workflow graph.
- Permission: master+member.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team to observe |
| limit | int 1-200 | no | 40 | max events, most-recent kept |
| since | int (epoch ms) | no | — | only events strictly after this timestamp (incremental polling) |
| run_id | string | no | active or latest run | a specific run (validated as a safe path segment; not required to be finished — an explicit run whose events file is absent renders as an empty timeline) |
| format | enum: `text` \| `mermaid` | no | `text` | output format |

- Behavior: resolves the run (explicit run_id → active task's runId → newest record; run_id validated as a safe path segment); text mode returns a live snapshot (team status, active task type/mode/stage or workflow frontier with per-step elapsed ms, round, tokens, awaiting-approval line with age, per-member status/turns/tokens/error) followed by the event timeline with relative timestamps (`+N.Ns`), kind/member/stage/round/bytes/reason, and detail truncated to 256 chars; malformed or oversized events.jsonl lines (per-line 1 MiB cap) are skipped and counted; the event-line bytes are capped at 256 KiB (the prepended snapshot and timeline header sit outside that budget); mermaid mode requires an in-progress team_workflow (live steps), otherwise errors.
- Errors: `Error: caller is not a member of this team`; `Error: invalid run_id "<id>"`; `Error: team "<id>" not found` / `could not be loaded (state file unreadable)`; `Error: team_progress format=mermaid requires an in-progress team_workflow (no active workflow on team "<id>")`; `Error: run records for team "<id>" could not be read: ...`; `Error: events for run "<runId>" could not be read: ...`. Non-error notice: `Timeline: (no runs yet)`.

### team_results

- Purpose: list recent orchestration run records for a team (newest first); each run is one completed/failed workflow with persisted full outputs.
- Permission: master+member.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team whose runs to list |
| limit | int 1-50 | no | 10 | max runs to return |

- Behavior: reads run records and slices to limit, newest first, under a header showing the retained total; one line per run: runId, `[type/mode] status`, reason (truncated at 200 chars plus a `...` suffix), finish time (ISO), tokens, member-output count, and arena winner when present; intended as the index — full details come from team_result_get.
- Errors: `Error: caller is not a member of this team`; `Error: run records for team "<id>" could not be read: ...`. Non-error notice: `No run records for team "<id>" yet.`.

### team_result_get

- Purpose: get one orchestration run's full record; omit run_id for the latest run (covers "I lost the summary").
- Permission: master+member.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team that owns the run |
| run_id | string | no | latest run | run id |
| member | string | no | — | return this member's full output verbatim |
| format | enum: `text` \| `mermaid` | no | `text` | output format |

- Behavior: with run_id reads that record, otherwise the newest; run_id and member are validated as safe path segments; `member=` returns that member's full output file (`runs/<runId>/<member>.md`) verbatim via fd-based safeReadFile (symlink traversal refused) — files larger than the 256 KiB read cap are refused with an error rather than truncated, and there is no `from_end` parameter; text mode default renders a header block (run id, team/type/mode/status, reason, started/finished ISO, tokens/messages, consensus reached and rounds when present), bounded per-member output previews (1 KiB display cap each, with a pointer line showing the exact `team_result_get(..., member=...)` follow-up call), a tasks list, a workflow step tree (fanout branches indented, gate verdicts with score/confidence/issues/retries/jumps, per-step duration and control tags like approval_before / max_output_bytes), and an arena preview (winner on score-direction + metric, evaluator, surviving candidates, per-candidate scoreboard with ineligible tagging); missing member output files render as `[output file missing]`, unreadable ones as `[output file unreadable: ...]`; the final response is capped at 256 KiB; mermaid mode renders the persisted workflow steps, erroring when the record has none.
- Errors: `Error: caller is not a member of this team`; `Error: invalid run_id "<id>"`; `Error: invalid member "<name>"`; `Error: run "<id>" for team "<team>" could not be read: ...`; `Error: run "<id>" not found for team "<team>"`; `Error: run records for team "<id>" could not be read: ...`; `Error: member "<name>" has no output in run <runId>`; `Error: output file for "<name>" is missing in run <runId>`; `Error: output file for "<name>" is unreadable in run <runId>: ...`; `Error: run <runId> has no persisted workflow steps`. Non-error notice: `No run records for team "<id>" yet.`.

### team_run_dir

- Purpose: return the absolute filesystem path to a run's output directory (contains `<member>.md`, `record.json`, `events.jsonl`); omit run_id for the most recent run.
- Permission: master+member (read-only).

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team that owns the run |
| run_id | string | no | latest run | run id |

- Behavior: with run_id verifies the record exists, otherwise uses the newest; run_id validated as a safe path segment; returns `run_id: <id>` and `run_dir: <absolute path>` to `<teamDirectory>/runs/<runId>/` — lets external check scripts locate a run directory without an out-of-band find.
- Errors: `Error: caller is not a member of this team`; `Error: invalid run_id "<id>"`; `Error: run "<id>" for team "<team>" could not be read: ...`; `Error: run "<id>" not found for team "<team>"`; `Error: run records for team "<id>" could not be read: ...`. Non-error notice: `No run records for team "<id>" yet.`.

### team_root_dir

- Purpose: return the absolute filesystem path to a team's root directory (contains `config.json`, `state.json`, `mailbox/`, `runs/`, `tasks/`, `worktrees/`).
- Permission: master-only — the handler resolves any member via `resolveCallerInTeam(..., { requireActive: false })` but then rejects non-masters (the control root exposes state, mailbox, tasks, and locks): `Error: team_root_dir is restricted to the team leader (master session).`.

| name | type | required | default | description |
|------|------|----------|---------|-------------|
| team_id | string, min 1 | yes | — | team whose root directory to return |

- Behavior: loads team state to verify readability, then enforces the master check; returns `team_root_dir: <absolute path>` plus a sorted entries listing; if the directory disappears between the state load and the directory read, the resolved path is still returned with a `warning: directory does not exist on disk` line (a team whose directory — and state — is already gone fails the earlier state load instead); available from team_create onwards, including mid-orchestration (unlike team_run_dir it does not depend on any record.json existing).
- Errors: `Error: caller is not a member of this team`; `Error: team could not be loaded (state file unreadable)`; `Error: team_root_dir is restricted to the team leader (master session).`; `Error: team root directory could not be read: ...`.
