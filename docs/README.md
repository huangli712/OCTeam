# OCTeam Documentation

OCTeam is a persistent multi-agent team plugin for OpenCode: one leader session coordinates up to 12 member sessions through twelve orchestration primitives, with all state on disk so teams survive restarts.

**New to OCTeam? Start with the [User Guide](./guide.md)** — it takes you from install to your first running team, then covers picking a mode, watching and steering runs, and crash recovery.

## The documents

| Document | Read it when |
|---|---|
| [guide.md](./guide.md) — User Guide | You are getting started or want the task-oriented walkthrough (quickstart, steering, troubleshooting) |
| [tools.md](./tools.md) — Tool Reference | You are calling a tool and need its parameters, permissions, side effects, or error strings (all 42 tools) |
| [modes.md](./modes.md) — Orchestration Modes | You want to understand a mode's member contract, decision blocks, or termination semantics — or need help choosing between modes |
| [workflow.md](./workflow.md) — Workflow Engine | You are authoring `team_workflow` steps or `workflow_file` JSON: gates, ensembles, jumps, fanout/join, the planner, and validation-error troubleshooting |
| [arch.md](./arch.md) — Architecture | You are contributing or debugging internals: module layering, on-disk state, recovery, and the security model |

## By task

- **Run your first team** → [guide.md: Quickstart](./guide.md#quickstart-your-first-run)
- **Choose an orchestration mode** → [modes.md: Choosing a mode](./modes.md#choosing-a-mode)
- **Look up a tool parameter or error** → [tools.md](./tools.md) (grouped: Lifecycle / Messaging & tasks / Modes / Workflow / Run control / Query)
- **Write or debug a workflow** → [workflow.md](./workflow.md), especially [Troubleshooting validation errors](./workflow.md#troubleshooting-validation-errors)
- **Understand what members must emit** (`<decision>`, `<verdict>`, ...) → [modes.md: The decision-block protocol](./modes.md#the-decision-block-protocol)
- **Recover from a crash or a stuck run** → [guide.md: Crashes and restarts](./guide.md#crashes-and-restarts), [team_fix_workflow](./tools.md#team_fix_workflow)
- **See how it works under the hood** → [arch.md](./arch.md)
- **Complete real-world scenarios** → [demos/](../demos/README.md)

## Conventions used in these documents

- All tool references link to the tool's section in [tools.md](./tools.md), where full parameter tables live; mode and workflow documents do not duplicate them.
- Member-emitted decision blocks are written as `<tag>{"json": ...}</tag>`; the strict parsing rules are defined once in [modes.md](./modes.md#the-decision-block-protocol).
- Failure `reason` strings are quoted verbatim from the source (e.g. `workflow_failed:jump_limit:<verifier>`, `member_error:<name>:<error>`) so they can be grepped in run records.
