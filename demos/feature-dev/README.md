# Comprehensive Scenario: OCTeam Feature Enhancement / Revision

> An end-to-end workflow for adding new features to OCTeam or strengthening existing ones: **Research → Discussion → Plan → Implementation → Audit**, 5 independent teams × 4 orchestration primitives chained together. Master acts as the integration hub, teams are isolated from each other with hand-to-hand data passing.
>
> **Self-use template**: operates on OCTeam itself (`src/` + `docs/`). No check scripts included; whether the final result succeeds is **for you to judge**.

## Workflow Overview

| Phase | Team | Orchestration Primitive | Input | Output (handoff marker) |
|------|------|---------|------|---------------------|
| ① Research | **research-team** | `team_parallel` | OCTeam `src/`+docs (internal) + GitHub/web (external) | `<!-- CANDIDATE: <id>:<short> -->` ×≥8 |
| ② Discussion | **discussion-team** | `team_consensus` | 8+ candidates as topic | `<!-- SELECTED: <id> -->` + rationale |
| ③ Plan | **plan-team** | `team_loop` | Selected feature | Implementation plan, write→audit→loop until decider approves (`<!-- PLAN-APPROVED -->`) |
| ④ Implementation | **implement-team** | `team_pipeline` | Approved plan | coder→tester→reviewer sequential output of feature code+tests |
| ⑤ Audit | **audit-team** | `team_parallel` | Implemented feature | Multi-dimensional parallel audit (`<!-- AUDIT: <dim>: pass\|fail -->`) + peer-quorum vote (for reference) |

Uses 4 orchestration primitives: **parallel / consensus / loop / pipeline** (parallel is used once each for research and audit).

```
OCTeam src/ + docs + GitHub/web
        │
        ▼
research-team (parallel)  ──≥8 candidates──► master
                                                │
discussion-team (consensus) ◄──candidates───────┘
        │
        └──SELECTED feature────────────────► master
                                                │
plan-team (loop)             ◄────selected──────┘
        │  Write→Audit→...→Approved
        └──approved plan───────────────────► master
                                                │
implement-team (pipeline)    ◄──plan────────────┘
        │  coder→tester→reviewer
        └──feature+tests───────────────────► master
                                                │
audit-team (parallel)        ◄──feature─────────┘
        │
        └──audit verdicts + vote──► master ──► you judge
```

## How to Use

1. **Target**: this scenario enhances OCTeam itself (`src/` is the canvas). No placeholders.
2. **Run 5 teams in sequence** (§1–§5). Each team goes through its full lifecycle: `team_create` → `team_activate` → `team_<mode>` → collect output → `team_deactivate`.
3. **Handoff**: each team's marker output is summarized by master and passed as the next team's input (candidates → topic; selected → plan task; approved plan → pipeline first stage; feature → audit target).
4. **Judge**: you read the audit-team's multi-dimensional conclusions and all team outputs, and decide success or failure yourself. This scenario **has no check scripts**.

## Team Switching Iron Rule

> Only **one team** active at a time. `team_activate` will be rejected if another team is already active — **you must `team_deactivate` before `team_activate` the next**. Each team section's master steps explicitly include deactivate.

---

## §1 research-team (`team_parallel`) — Research

### 1.1 Phase Description

6 researchers **research in parallel**, each with one dimension (dimension baked into member prompt, parallel runs isolated). Coverage: OCTeam internals current state, GitHub similar frameworks, Web ecosystem, user pain points, MCP/plugin ecosystem, multi-agent collaboration research. Each member proposes at least 2 candidates → total ≥8.

### 1.2 Team Configuration

```json
{
  "name": "fd-research",
  "description": "Feature discovery team: 6 researchers scan OCTeam internals + external ecosystem in parallel, each a dedicated dimension",
  "members": [
    {
      "name": "alice",
      "role": "explorer",
      "prompt": "You research OCTeam INTERNALS. Read src/ and docs/ to enumerate EXISTING features and capabilities of OCTeam, then identify GAPS / missing capabilities / rough edges worth strengthening. For each candidate feature you propose, emit a line exactly formatted: <!-- CANDIDATE: <stable-kebab-id>:<short-name> --> followed by: what it is, why it matters (cite the internal evidence you found), rough feasibility. Propose at least 2 candidates."
    },
    {
      "name": "bob",
      "role": "researcher",
      "prompt": "You research GITHUB for similar multi-agent orchestration / team frameworks (e.g. AutoGen, CrewAI, LangGraph, ChatDev, MetaGPT, OpenSwarm). Identify features they have that OCTeam lacks. For each candidate feature you propose for OCTeam, emit: <!-- CANDIDATE: <stable-kebab-id>:<short-name> --> followed by: what it is, which competitor has it (cite repo), why OCTeam would benefit, rough feasibility. Propose at least 2 candidates."
    },
    {
      "name": "carol",
      "role": "researcher",
      "prompt": "You research the BROADER WEB ecosystem of agent frameworks (not just team-orchestration) for table-stakes features and emerging patterns OCTeam should consider. For each candidate feature, emit: <!-- CANDIDATE: <stable-kebab-id>:<short-name> --> followed by: what it is, the ecosystem trend/evidence, why OCTeam would benefit, rough feasibility. Propose at least 2 candidates."
    },
    {
      "name": "dave",
      "role": "analyst",
      "prompt": "You synthesize USER PAIN POINTS and common feature-request patterns in multi-agent orchestration (friction in tooling, observability, state management, debugging). For each candidate feature that would relieve a real pain point, emit: <!-- CANDIDATE: <stable-kebab-id>:<short-name> --> followed by: what it is, the pain point it addresses, why it matters, rough feasibility. Propose at least 2 candidates."
    },
    {
      "name": "ruby",
      "role": "researcher",
      "prompt": "You research the MCP / PLUGIN ECOSYSTEM and extensibility trends — how comparable tools expose extension points, integrations, and plugin marketplaces. For each candidate feature (e.g. new extension surface, integration, plugin mechanism), emit: <!-- CANDIDATE: <stable-kebab-id>:<short-name> --> followed by: what it is, the ecosystem evidence, why OCTeam would benefit, rough feasibility. Propose at least 2 candidates."
    },
    {
      "name": "sam",
      "role": "researcher",
      "prompt": "You research MULTI-AGENT COLLABORATION patterns from academic and OSS work (role assignment, consensus, verification, planning). Identify techniques OCTeam could adopt as features. For each candidate feature, emit: <!-- CANDIDATE: <stable-kebab-id>:<short-name> --> followed by: what it is, the source technique/paper/project, why OCTeam would benefit, rough feasibility. Propose at least 2 candidates."
    }
  ]
}
```

**Role selection**: alice `explorer` (internal code scanning, read-only deep dive), the rest `researcher`/`analyst` (external research + synthesis). 6 symmetric members, differences come from dimension prompts.

### 1.3 Master Launch Call

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "fd-research",
    "mode": "isolated",
    "task": "Research YOUR ASSIGNED DIMENSION (see your role brief) to identify features OCTeam should ADD or STRENGTHEN. Propose at least 2 candidates. For each, emit the <!-- CANDIDATE: <id>:<short> --> marker exactly as your brief specifies, followed by what / why (your dimension's evidence) / rough feasibility. Report every candidate you find.",
    "timeout_ms": 1500000
  }
}
```

**Parameter selection**:
- `mode: isolated` + dimension baked into prompts — 6 parallel lanes each scan one dimension, with no overlap.
- No `signoff_policy` set — parallel defaults to no signoff, results are collected when done.

### 1.4 Lifecycle Steps (master)

```
team_create(fd-research)
team_activate(fd-research)
team_parallel(...)            # §1.3
# Wait for 6 researchers' output → team_results for the summary
team_deactivate(fd-research)
```

### 1.5 Output and Handoff

- Master extracts all `<!-- CANDIDATE: <id>:<short> -->` from the 6 outputs, compiles a **candidate list** (id + short + description, should be ≥8 items).
- This list serves as §2 `team_consensus`'s `topic`.

---

## §2 discussion-team (`team_consensus`) — Discussion

### 2.1 Phase Description

5 debaters (2 reviewer + 2 architect + 1 analyst) debate the candidate list across multiple rounds: weighing **necessity / feasibility / complexity**, voting to converge on **1** feature to implement.

### 2.2 Team Configuration

```json
{
  "name": "fd-discussion",
  "description": "Feature selection team: 5 debaters (2 reviewers + 2 architects + 1 analyst) weigh candidates on necessity/feasibility/complexity and converge on 1",
  "members": [
    {
      "name": "erin",
      "role": "reviewer",
      "prompt": "You debate which candidate feature OCTeam should implement. For each candidate argue from CORRECTNESS/RISK angle: is it well-defined? what could go wrong? Weigh necessity, feasibility, complexity. Reach agreement with your teammates to select exactly ONE. In your FINAL message, emit exactly one line: <!-- SELECTED: <candidate-id> --> followed by a short rationale (why this one, why not the others)."
    },
    {
      "name": "frank",
      "role": "architect",
      "prompt": "You debate which candidate feature OCTeam should implement. For each candidate argue from ARCHITECTURE/DESIGN angle: does it fit OCTeam's model? what's the design impact? Weigh necessity, feasibility, complexity. Reach agreement with your teammates to select exactly ONE. In your FINAL message, emit exactly one line: <!-- SELECTED: <candidate-id> --> followed by a short rationale."
    },
    {
      "name": "grace",
      "role": "analyst",
      "prompt": "You debate which candidate feature OCTeam should implement. For each candidate argue from COST/VALUE angle: complexity vs payoff, effort estimate, user impact. Weigh necessity, feasibility, complexity. Reach agreement with your teammates to select exactly ONE. In your FINAL message, emit exactly one line: <!-- SELECTED: <candidate-id> --> followed by a short rationale."
    },
    {
      "name": "tom",
      "role": "reviewer",
      "prompt": "You debate which candidate feature OCTeam should implement. For each candidate argue from CORRECTNESS/RISK angle: is it well-defined? what could go wrong? Weigh necessity, feasibility, complexity. Reach agreement with your teammates to select exactly ONE. In your FINAL message, emit exactly one line: <!-- SELECTED: <candidate-id> --> followed by a short rationale."
    },
    {
      "name": "uma",
      "role": "architect",
      "prompt": "You debate which candidate feature OCTeam should implement. For each candidate argue from ARCHITECTURE/DESIGN angle: does it fit OCTeam's model? what's the design impact? Weigh necessity, feasibility, complexity. Reach agreement with your teammates to select exactly ONE. In your FINAL message, emit exactly one line: <!-- SELECTED: <candidate-id> --> followed by a short rationale."
    }
  ]
}
```

**Role selection**: erin/tom `reviewer` (risk perspective), frank/uma `architect` (design perspective), grace `analyst` (cost/value perspective), three perspectives intersect.

### 2.3 Master Launch Call

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "fd-discussion",
    "topic": "<Paste the §1.5 candidate list verbatim: each CANDIDATE id/short/description>",
    "max_rounds": 4,
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- `topic` = candidate list (master pastes it in by hand).
- `max_rounds: 4` — gives sufficient debate space to converge to a single choice.

### 2.4 Lifecycle Steps (master)

```
team_create(fd-discussion)
team_activate(fd-discussion)   # (fd-research already deactivated at this point)
team_consensus(...)            # topic = §1.5 candidate list
# Wait for consensus → team_results for the summary
# If max_rounds exhausted without reaching consensus (consensus_max_rounds) → abort workflow, do not continue after deactivate
team_deactivate(fd-discussion)
```

### 2.5 Output and Handoff

- Master extracts `<!-- SELECTED: <id> -->` (members should converge to the same id after consensus) + rationale.
- The selected feature serves as §3 plan-team's writing target.
- **If consensus is not reached (consensus_max_rounds), abort the workflow** — do not enter §3 after deactivate, report the discussion record to you.

---

## §3 plan-team (`team_loop`) — Plan

### 3.1 Phase Description

Write an **implementation plan** for the selected feature. Each round runs **Write (writer) → Audit (reviewer)** serially; the decider rules "plan approved / rework". When approved, produce a complete plan deliverable for implementation.

> ⚠️ **decider cannot double as a stage member** (team_loop rule: decider is auto-appended read-only, cannot appear in stages). jack is reserved as decider, not in stages.

### 3.2 Team Configuration

```json
{
  "name": "fd-plan",
  "description": "Feature plan team: writer drafts the implementation plan, reviewer audits it, decider approves; loop until approved",
  "members": [
    {
      "name": "henry",
      "role": "writer",
      "prompt": "You are the WRITER (stage 1) in the plan loop. Each round, draft or refine the implementation plan for the selected feature in OCTeam. The plan must cover: goal & scope, affected files/modules (under src/), step-by-step changes, new tests, risks & mitigations, rollback notes. If Iris's previous-round audit raised gaps, address them. Make the plan concrete enough to hand to a coder."
    },
    {
      "name": "iris",
      "role": "auditor",
      "prompt": "You are the AUDITOR (stage 2) in the plan loop. Each round, audit Henry's plan for: completeness (all affected code paths?), correctness (will it actually work?), testability (are tests specified?), risk (what can break?), and fit with OCTeam's architecture. Emit a short audit verdict listing gaps Jack should send back. Do not modify the plan."
    },
    {
      "name": "jack",
      "role": "reviewer",
      "prompt": "You are the DECIDER in the plan loop. After each round (Henry drafts -> Iris audits), decide whether the plan is APPROVED (complete, correct, testable, low-risk) or needs another round. Emit <decision>{\"done\": true}</decision> when approved (then the team emits <!-- PLAN-APPROVED --> with the final plan), or <decision>{\"done\": false, \"reason\": \"...\"}</decision> naming the gaps to address. Do not lower the bar."
    }
  ]
}
```

**Role selection**: henry `writer` (write plan, modify), iris `auditor` (audit, read_only, backed by oct-momus), jack `reviewer` (decider, auto-appended read-only ruling).

### 3.3 Master Launch Call

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "fd-plan",
    "initial_task": "Write an implementation plan for the selected OCTeam feature: <SELECTED id + §2.5 rationale + original candidate description>. Each round: Henry drafts/refines the plan, Iris audits it. Jack decides approve/rework. On approval, emit <!-- PLAN-APPROVED --> with the final plan.",
    "stages": [
      {
        "member": "henry",
        "task": "Draft or refine the implementation plan for the selected feature (goal, affected src/ files, step-by-step changes, new tests, risks, rollback). Address any gaps Iris raised last round.",
        "action": "modify"
      },
      {
        "member": "iris",
        "task": "Audit Henry's plan for completeness / correctness / testability / risk / architectural fit. Emit a short verdict listing any gaps Jack should send back.",
        "action": "read_only"
      }
    ],
    "decider": "jack",
    "max_rounds": 4,
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- `stages` order: henry(modify, write) → iris(read_only, audit), one pass per round; decider jack rules each round.
- `max_rounds: 4` — if not approved within 4 rounds, **abort the workflow**, do not enter §4.

### 3.4 Lifecycle Steps (master)

```
team_create(fd-plan)
team_activate(fd-plan)        # (fd-discussion already deactivated at this point)
team_loop(...)                # initial_task + stages as above
# Wait for decider to rule approved → team_results for PLAN-APPROVED + plan
# If max_rounds exhausted without approval (loop_complete:max_rounds) → abort workflow, do not continue after deactivate
team_deactivate(fd-plan)
```

### 3.5 Output and Handoff

- Master extracts `<!-- PLAN-APPROVED -->` + complete implementation plan.
- This plan serves as §4 implement-team pipeline's first stage (coder) input.
- **If max_rounds exhausted without approval (loop_complete:max_rounds), abort the workflow** — do not enter §4 after deactivate, report the plan draft and audit records to you.

---

## §4 implement-team (`team_pipeline`) — Implementation

### 4.1 Phase Description

Implement according to the plan via a **linear pipeline**: **coder implements → tester writes+runs tests → reviewer reviews**. The preceding stage's output is spliced into the next stage's task, processed in order.

### 4.2 Team Configuration

```json
{
  "name": "fd-implement",
  "description": "Feature implementation pipeline: coder implements -> tester writes+runs tests -> reviewer reviews",
  "members": [
    {
      "name": "kate",
      "role": "coder",
      "prompt": "You are the CODER (stage 1) in the implementation pipeline. Implement the approved plan in OCTeam's src/: make the code changes the plan specifies, minimal and following existing conventions. Output a summary of what you changed (files + key diffs) for the next stage."
    },
    {
      "name": "leo",
      "role": "tester",
      "prompt": "You are the TESTER (stage 2) in the implementation pipeline. Given Kate's implementation, WRITE tests for the new feature (happy path + edge cases) in the appropriate test dir, then RUN the full OCTeam test suite. Output: which tests you added, the suite result (pass/fail counts), and any failures you observed."
    },
    {
      "name": "mona",
      "role": "reviewer",
      "prompt": "You are the REVIEWER (stage 3) in the implementation pipeline. Given Kate's code and Leo's test results, review the implementation against the approved plan: is it complete? does it follow conventions? are the tests adequate? Output a review verdict (accept / request-changes) with specific notes."
    }
  ]
}
```

**Role selection**: kate `coder` (implementation), leo `tester` (write+run tests), mona `reviewer` (review). Pipeline stages are processed in order, no action field.

### 4.3 Master Launch Call

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "fd-implement",
    "stages": [
      {
        "member": "kate",
        "task": "Implement the approved plan for the selected OCTeam feature. Plan: <Paste the §3.5 PLAN-APPROVED plan>. Make the specified code changes under src/, minimal and convention-following. Output a summary of changed files + key diffs."
      },
      {
        "member": "leo",
        "task": "Write tests for the new feature Kate implemented (happy path + edge cases) in the appropriate test dir, then run the full OCTeam test suite. Output the tests you added + suite result (pass/fail counts) + any failures."
      },
      {
        "member": "mona",
        "task": "Review Kate's implementation and Leo's test results against the approved plan. Output a review verdict (accept / request-changes) with specific notes on completeness, conventions, and test adequacy."
      }
    ],
    "timeout_ms": 2400000
  }
}
```

**Parameter selection**:
- Pipeline **prefix-splices** each stage's output into the next stage's task — leo can see kate's change summary, mona can see kate's code + leo's test results.
- The first stage's task embeds §3.5's plan.
- No `signoff_policy` set — pipeline defaults to none, three stages deliver directly when done.

### 4.4 Lifecycle Steps (master)

```
aft_safety(checkpoint, "pre-implement")   # Snapshot current code, for easy rollback later
team_create(fd-implement)
team_activate(fd-implement)   # (fd-plan already deactivated at this point)
team_pipeline(...)            # stages as above, first stage task includes §3.5 plan
# Wait for three stages to complete in order → team_results for the summary (code + tests + review)
team_deactivate(fd-implement)
```

> **Why checkpoint before implement**: kate will directly modify `src/` code. Use `aft_safety` (`op: "checkpoint"`, `name: "pre-implement"`) to snapshot the current file state; after audit, if rollback is needed, use `aft_safety restore "pre-implement"` to restore.

### 4.5 Output and Handoff

- Master extracts kate's change summary + leo's test results + mona's review conclusion.
- The implemented feature (code + tests) serves as §5 audit-team's audit target.

---

## §5 audit-team (`team_parallel`) — Audit

### 5.1 Phase Description

4 auditors **audit in parallel** the new feature, each with one dimension, independent from §4 pipeline's inline reviewer: **correctness / regression / test completeness / design fit**. After parallel audit completes, the 4 members conduct a **peer-quorum vote** based on all audit summaries (≥50% approve passes), with the vote result provided for your reference.

### 5.2 Team Configuration

```json
{
  "name": "fd-audit",
  "description": "Feature audit team: 4 reviewers audit the new feature in parallel across correctness/regression/test-completeness/design-fit",
  "members": [
    {
      "name": "nina",
      "role": "reviewer",
      "prompt": "You audit the new feature for CORRECTNESS against the approved plan: does it do what the plan specified? are there logic bugs? For your dimension, emit exactly one line: <!-- AUDIT: correctness: pass --> or <!-- AUDIT: correctness: fail --> followed by a short list of findings."
    },
    {
      "name": "omar",
      "role": "reviewer",
      "prompt": "You audit the new feature for REGRESSIONS: run OCTeam's existing test suite and check whether the new feature broke anything pre-existing. For your dimension, emit exactly one line: <!-- AUDIT: regression: pass --> or <!-- AUDIT: regression: fail --> followed by a short list of findings (any failing pre-existing tests)."
    },
    {
      "name": "pat",
      "role": "reviewer",
      "prompt": "You audit the new feature for TEST COMPLETENESS: are the new tests thorough? do they cover edge cases, error paths, and the plan's specified behaviors? For your dimension, emit exactly one line: <!-- AUDIT: test-completeness: pass --> or <!-- AUDIT: test-completeness: fail --> followed by a short list of gaps."
    },
    {
      "name": "quinn",
      "role": "architect",
      "prompt": "You audit the new feature for DESIGN FIT: does it align with OCTeam's architecture, conventions, and module boundaries (see src/ + docs/ARCHITECTURE.md)? For your dimension, emit exactly one line: <!-- AUDIT: design-fit: pass --> or <!-- AUDIT: design-fit: fail --> followed by a short list of concerns."
    }
  ]
}
```

**Role selection**: nina/omar/pat `reviewer` (correctness/regression/test three perspectives, read-only deep review), quinn `architect` (design fit perspective). 4 symmetric members, differences come from dimension prompts.

### 5.3 Master Launch Call

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "fd-audit",
    "mode": "isolated",
    "task": "Audit the newly implemented OCTeam feature (see §4 output: changed files + tests + review) strictly within YOUR ASSIGNED DIMENSION (see your role brief). Emit the <!-- AUDIT: <dim>: pass|fail --> marker exactly as your brief specifies, followed by your findings.",
    "signoff_policy": "peer-quorum",
    "signoff_quorum": 0.5,
    "timeout_ms": 1500000
  }
}
```

**Parameter selection**:
- `mode: isolated` + dimension baked into prompts — 4 parallel lanes each audit one dimension.
- audit-team sees §4's implementation output (master gives the changed files summary in the task).
- `signoff_policy: peer-quorum` + `signoff_quorum: 0.5` — after 4 lanes complete audit, buildSummary aggregates all audit conclusions and sends them to each member, who each cast `<signoff>{"approved": true|false}</signoff>`. ≥2/4 approve passes. The vote result is **for your reference**, the final decision is still yours.

### 5.4 Lifecycle Steps (master)

```
team_create(fd-audit)
team_activate(fd-audit)       # (fd-implement already deactivated at this point)
team_parallel(...)            # §5.3, task includes §4 implementation summary
# Wait for 4 auditors' output → team_results for the summary
team_deactivate(fd-audit)
```

### 5.5 Output and Handoff

- Master extracts all `<!-- AUDIT: <dim>: pass|fail -->` + findings.
- Master extracts the peer-quorum vote result (signoff_quorum_reached / signoff_quorum_not_reached).
- **The audit report and vote result are for reference only; you read the 4-dimensional audit conclusions + vote result + all team outputs, and decide the success or failure of the entire feature enhancement yourself.** If rollback is needed, use `aft_safety restore "pre-implement"` to restore to the pre-implementation code. The scenario ends here.

---

## End-to-End Timeline (master perspective)

```
T+0    team_create(fd-research) → team_activate → team_parallel
         6 researchers research in parallel (internal+external)
T+~15  Collect ≥8 candidates → team_deactivate(fd-research)
T+~15  team_create(fd-discussion) → team_activate → team_consensus(topic=candidates)
         5 debaters debate and vote to select 1 (≤4 rounds)
T+~30  Collect SELECTED → team_deactivate(fd-discussion)
         ⚠️ If consensus not reached → abort workflow, do not continue
T+~30  team_create(fd-plan) → team_activate → team_loop
         Each round: henry writes → iris audits, jack rules
T+~45  Collect PLAN-APPROVED → team_deactivate(fd-plan)
         ⚠️ If max_rounds exhausted without approval → abort workflow, do not continue
T+~45  aft_safety(checkpoint, "pre-implement")   # Snapshot code for rollback
       team_create(fd-implement) → team_activate → team_pipeline
         kate implements → leo tests → mona reviews
T+~70  Collect feature+tests → team_deactivate(fd-implement)
T+~70  team_create(fd-audit) → team_activate → team_parallel
         4 auditors audit in parallel (correctness/regression/test/design) → peer-quorum vote
T+~85  Collect audit verdicts + vote result → team_deactivate(fd-audit)
T+~85  You read all output, decide the outcome
```

(Durations are order-of-magnitude estimates only; higher feature complexity increases time. This scenario has no hard timeout cap.)

---

## Quick-Start Prompt (Copy and Use)

> Paste the entire block to the master session. Master will run 5 teams in sequence, executing each step per the README's JSON configuration, with data hand-carried between teams by master.

```text
按 demos/composite/feature-dev/README.md 跑一次 OCTeam 功能增强工作流。

执行 5 个团队，每个走「team_create → team_activate → team_<mode> → team_results → team_deactivate」完整生命周期。同一时刻只允许一个 active 团队——切换前必须先 deactivate。

1. research-team (team_parallel，§1)：按 §1.2 team_create，§1.3 team_parallel。6 名研究员并行调研（内部 src/docs + GitHub/web 外部）。完成后 deactivate。汇总所有 <!-- CANDIDATE: <id>:<short> --> marker 成候选清单（应 ≥8 条）。

2. discussion-team (team_consensus，§2)：按 §2.2 team_create，§2.3 team_consensus（topic = 上一步候选清单，max_rounds=4）。5 名 debater 综合必要性/可行性/复杂度投票选 1。完成后 deactivate。抓取 <!-- SELECTED: <id> --> + 理由。**若未达成共识（consensus_max_rounds），deactivate 后中断流程，不继续。**

3. plan-team (team_loop，§3)：按 §3.2 team_create，§3.3 team_loop（initial_task 含 SELECTED 功能）。每轮 henry 编写 → iris 审计，jack 裁决。完成后 deactivate。抓取 <!-- PLAN-APPROVED --> + 完整方案。**若 max_rounds 用尽仍未通过（loop_complete:max_rounds），deactivate 后中断流程，不继续。**

4. implement-team (team_pipeline，§4)：**先 aft_safety(checkpoint, "pre-implement") 快照当前代码（便于最后回退）**，再按 §4.2 team_create，§4.3 team_pipeline（首阶段 task 内嵌 §3.5 方案）。kate 实现 → leo 写+跑测试 → mona 评审。完成后 deactivate。汇总改动摘要 + 测试结果 + 评审结论。

5. audit-team (team_parallel，§5)：按 §5.2 team_create，§5.3 team_parallel（task 含 §4 实现摘要，signoff_policy=peer-quorum，signoff_quorum=0.5）。4 名审计员并行深审后全员投票。完成后 deactivate。汇总所有 <!-- AUDIT: <dim>: pass|fail --> marker + 投票结果（参考）。

全部完成后，把每个团队的产出（candidates / selected / plan / implementation / audit verdicts）整理给我，由我裁定结果。不跑评判脚本。

注意：
- 成员名必须取自 32 字预设池（alice/bob/carol/dave/erin/frank/grace/henry/iris/jack/kate/leo/mona/nina/omar/pat/quinn/ruby/sam/tom/uma...），角色必须用 explorer/researcher/analyst/reviewer/architect/writer/coder/tester 等预设值。
- 切换团队前一定先 team_deactivate 当前团队，否则 team_activate 会被拒绝。
- plan-team 的 decider（jack）不能出现在 stages 里。
- pipeline 模式无 action 字段；各 stage 顺序加工，前 stage 产出自动拼进下 stage task。
- 当 team 在运行中时，轮询 team_progress/team_results 的间隔为 30 秒，不要更频繁。
- **discussion-team 未达成共识或 plan-team 方案未通过时，立即中断流程**，deactivate 当前团队后不继续后续阶段。
- implement-team 启动前一定先 `aft_safety(checkpoint)` 快照代码，审计后可按需 `restore` 回退。
```

---

## Related Documents

- [`demos/README.md`](../README.md) — scenario directory overview (single-primitive 9 modes + this comprehensive scenario)
- [`demos/code-review/README.md`](../code-review/README.md) — sister comprehensive scenario: multi-team code review (also 4 primitives, for comparison)
- parallel / consensus / pipeline / loop source: [`src/tools/parallel.ts`](../../src/tools/parallel.ts) / [`consensus.ts`](../../src/tools/consensus.ts) / [`pipeline.ts`](../../src/tools/pipeline.ts) / [`loop.ts`](../../src/tools/loop.ts)
- delegate / route / arbitrate / tollgate / recurse source: [`src/tools/delegate.ts`](../../src/tools/delegate.ts) / [`router.ts`](../../src/tools/router.ts) / [`arbitrate.ts`](../../src/tools/arbitrate.ts) / [`tollgate.ts`](../../src/tools/tollgate.ts) / [`recurse.ts`](../../src/tools/recurse.ts)
- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — OCTeam architecture and module boundaries (plan/audit teams should reference)
