# Security Policy

## Reporting

To report a security concern, open a GitHub issue on this repository.
(Replace this with the maintainers' preferred contact channel.)

## Scope

This policy covers the OCTeam plugin code under `src/`. It does **not** cover
the OpenCode host runtime, its SDK, or any third-party dependencies.

## Threat model

OCTeam is a single-user developer tool. Its on-disk state lives in
`<project>/.octeam/` (project scope) or `~/.octeam/` (user scope). Both
locations are trusted in the same way source code is trusted: if an attacker can
write to them, the user is already compromised at or above the filesystem level.

Teams coordinate the user's own OpenCode sessions. A team's members all run
under the same user and share the same filesystem. There is no cross-user or
multi-tenant boundary.

## Hardening

The following protections are implemented in the codebase:

### Path traversal prevention

All path segments interpolated into filesystem paths pass through
`isSafePathSegment` / `assertSafeSegment` (`src/state/paths.ts`). This
chokepoint rejects segments containing `/`, `\`, `\0`, `.`, or `..`, and
applies uniformly to both live tool arguments and values re-loaded from disk
(`config.json` / `state.json`). No path construction bypasses these guards.

### Master-only orchestration

Every workflow tool (`team_parallel`, `team_pipeline`, `team_loop`,
`team_delegate`, `team_consensus`, `team_route`, `team_arbitrate`,
`team_recurse`, `team_tollgate`) and `team_resume` verifies the caller is the
team's master via `resolveCallerInTeam` before committing any state mutation.
Non-master sessions cannot start or resume orchestrations.

### Single active orchestration

At most one orchestration can be active per team. Workflow tools check
`team.activeTask` inside the per-team mutex before committing, preventing
concurrent orchestration starts within the same process.

### ID validation

Team IDs and task IDs are validated as UUIDs. Run IDs are generated via
`crypto.randomUUID()` at commit time.

### Process-level mutex

State mutations (save, orchestration commit, idle event processing) are
serialized per team through an in-process `AsyncMutex`. Concurrent events for
the same team cannot race on state transitions.

## Known limitation: user-scope multi-process

User-scope teams under `~/.octeam/teams/<name>` should be treated as
single-process.

`saveTeamState` is write-atomic via a cross-process file lock
(`state.json.lock`), preventing torn writes on crash. However, it is **not** a
read-merge-write primitive. Each OpenCode process caches its own copy of a
team's state and writes the full snapshot under the lock without re-reading
disk. If two OpenCode processes drive the same user-scope team concurrently,
they will clobber each other's mutations.

Project-scope teams are segmented by lead session ID
(`<dir>/.octeam/<sessionId>/teams/<name>`) and are not affected by this
limitation. If concurrent multi-process drive of user-scope teams ever becomes a
requirement, `saveTeamState` must be replaced with a locked read-merge-write
pattern.
