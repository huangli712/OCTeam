# Orchestration Scenarios — Authoring Brief

> Internal authoring guide for the scenario catalog. Not a scenario itself.
> Mode `01-team-parallel` is the **gold template** — mirror its structure exactly.

## Context

OCTeam ships 9 orchestration primitives (`team_parallel`, `team_consensus`, `team_pipeline`, `team_loop`, `team_delegate`, `team_route`, `team_arbitrate`, `team_recurse`, `team_tollgate`). We are building a scenario catalog under `scenarios/`: each mode gets one directory containing a README (3 sub-scenarios: math / computational-physics / coding) plus 3 TypeScript check scripts.

All scenarios must be **completable within 30 minutes** end-to-end (per-member subtask ≤ 8 min, ≤ 4 members).

## Read first (your structural template)

Read these 4 files and mirror their structure, depth, and formatting exactly:

- `scenarios/01-team-parallel/README.md`
- `scenarios/01-team-parallel/check-math-montecarlo-pi.ts`
- `scenarios/01-team-parallel/check-physics-harmonic-integrator.ts`
- `scenarios/01-team-parallel/check-coding-twosum.ts`

## Deliverables per mode (4 files)

```
scenarios/0N-team-<mode>/
├── README.md
├── check-math-<topic>.ts
├── check-physics-<topic>.ts
└── check-coding-<topic>.ts
```

## README structure (mirror template)

1. **Title + mode intro** — one-line mode description, 源码 link to `src/tools/workflow-*.ts`, 控时 design summary.
2. **场景一览 table** — columns: #, 方向, 场景, 成员数, Role, key param, 预计总时长.
3. **Per scenario (×3)**, each with sections:
   - **N.1 场景描述** — 背景, 目标, 成功标准（可机器评判）.
   - **N.2 Team 配置** — full `team_create` JSON (name, description, members[] with name/role/prompt).
   - **N.3 Master 启动调用** — full `team_<mode>` JSON call with args; add a 参数选择 bullet list explaining non-obvious choices.
   - **N.4 执行流程（时序）** — ASCII timeline (T+0m, T+Nm, ...).
   - **N.5 评判脚本** — link to the check file + 加载/提取/断言 bullet list.
4. **验收清单** — checkbox list (typecheck, roles valid, schema match, ≤30min, markers aligned).

## team_create JSON conventions

- `name`: kebab-case, context-appropriate.
- Each member has `name` (kebab-case), `role`, `prompt`.
- The member's `prompt` MUST end with the output-format marker instruction, e.g. *"Your output MUST end with a line exactly formatted: `<!-- KEY: <value> -->`"*. The check script parses this marker.
- 3 members per scenario (controls wall-clock).

## Check script conventions

- **Usage**: `bun check-*.ts <run_dir>`; exit codes `0`=PASS, `1`=FAIL (assertion), `2`=usage/IO error.
- **Imports**: only `node:fs/promises` and `node:path` — no external deps.
- Member outputs live at `<run_dir>/<member>.md`.
- Each script: load → extract via regex → assert vs ground truth → log + `process.exit`.
- Mirror `check-math-montecarlo-pi.ts` skeleton: `loadX(runDir, member)` helper, `fail(msg): never` helper, `async main()`.

## Hard constraints

- **Code + comments: English. README prose: Chinese.** (project rule — `~/.config/opencode/AGENTS.md`)
- `role` MUST be one of: `mathematician`, `physicist`, `simulator`, `chemmatist`→`chemist`, `analyst`, `visualizer`, `coder`, `debugger`, `optimizer`, `tester`, `reviewer`, `architect`, `explorer`, `writer`, `researcher`, `author`, `fantast`, `almighty`. Unknown roles silently fall back to `reviewer` (read-only) — pick deliberately.
- member `name`: `^[a-z0-9-]+$`; never `"master"` or `"orchestrator"` (reserved).
- Total scenario wall-clock ≤ 30 min; per-member subtask ≤ 8 min; members ≤ 4.
- Respect each mode's special-member rules:
  - `team_loop`: `decider` is a member, not master; cannot also be a stage member (it's auto-appended read-only).
  - `team_route`: `router` is a member, not master, and cannot be a branch target.
  - `team_arbitrate`: `arbiter` is a member, not master, not a debater; ≥2 unique debaters.
  - `team_recurse`: `decomposer` is a member, not master.
  - `team_tollgate`: each stage's `verifier` ≠ `member`.
  - `team_consensus`/`team_pipeline`: stage members must be unique.
- `team_consensus` has NO signoff gate (the all-agree mechanism is the gate).

## Verify before reporting done

1. `cd /home/yun/Working/devel/OCTeam && bunx tsc -p scenarios/tsconfig.json` — MUST exit 0 with no output.
2. All 4 files created at the correct paths under `scenarios/0N-team-<mode>/`.
3. Every `role` in every `team_create` JSON is in the allowed set above.
4. Every `team_<mode>` call's args match the schema given in your task prompt.
5. Each member prompt ends with the exact marker instruction the check script parses.
