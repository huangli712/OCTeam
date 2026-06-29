# 综合场景：OCTeam 功能增强 / 修订

> 给 OCTeam 增加新功能或强化现有功能的端到端工作流：**调研 → 讨论 → 计划 → 实现 → 审计**，5 个独立团队 × 4 种编排原语串联。master 作集成枢纽，团队间彼此隔离、数据手递手。
>
> **自用模板**：操作对象是 OCTeam 自身（`src/` + `docs/`）。不含评判脚本，最终是否成功**由你自行判断**。

## 工作流总览

| 阶段 | 团队 | 编排原语 | 输入 | 产出（交接 marker） |
|------|------|---------|------|---------------------|
| ① 调研 | **research-team** | `team_parallel` | OCTeam `src/`+docs（内部）+ GitHub/web（外部） | `<!-- CANDIDATE: <id>:<short> -->` ×≥8 |
| ② 讨论 | **discussion-team** | `team_consensus` | 8+ 候选作 topic | `<!-- SELECTED: <id> -->` + 理由 |
| ③ 计划 | **plan-team** | `team_loop` | 选中的功能 | 实施方案，编写→审计→loop 至 decider 通过（`<!-- PLAN-APPROVED -->`） |
| ④ 实现 | **implement-team** | `team_pipeline` | 通过的方案 | coder→tester→reviewer 顺序产出功能代码+测试 |
| ⑤ 审计 | **audit-team** | `team_parallel` | 实现后的功能 | 多维并行审计（`<!-- AUDIT: <dim>: pass\|fail -->`） |

用到 4 种编排：**parallel / consensus / loop / pipeline**（parallel 在调研与审计各用一次）。

```
OCTeam src/ + docs + GitHub/web
        │
        ▼
research-team (parallel)  ──≥8 candidates──► master
                                                │
discussion-team (consensus) ◄──candidates──────┘
        │
        └──SELECTED feature──► master
                                 │
plan-team (loop)               ◄──selected──────┘
        │  编写→审计→...→通过
        └──approved plan──► master
                              │
implement-team (pipeline)    ◄──plan──────────┘
        │  coder→tester→reviewer
        └──feature+tests──► master
                              │
audit-team (parallel)        ◄──feature───────┘
        │
        └──audit verdicts──► master ──► 你判断
```

## 如何使用

1. **对象**：本场景增强 OCTeam 自身（`src/` 为画布）。无需占位符。
2. **依次跑 5 个团队**（§1–§5）。每个团队走完整生命周期：`team_create` → `team_activate` → `team_<mode>` → 收产出 → `team_deactivate`。
3. **交接**：每个团队的 marker 产出由 master 汇总，作为下一个团队的输入（candidates → topic；selected → plan 任务；approved plan → pipeline 首阶段；feature → audit 对象）。
4. **判断**：你读取 audit-team 的多维结论与各团队输出，自行裁定成败。本场景**不设评判脚本**。

## team 切换铁律

> 同一时刻**仅一个团队** active。`team_activate` 在已有 active 团队时会拒绝——**必须先 `team_deactivate` 再 `team_activate` 下一个**。每个团队段的 master 步骤都已显式写出 deactivate。

---

## §1 research-team（`team_parallel`）— 调研

### 1.1 阶段说明

6 名研究员**并行**调研，每人一个维度（维度烤进成员 prompt，parallel 跑 isolated）。覆盖：OCTeam 内部现状、GitHub 同类框架、Web 生态、用户痛点、MCP/插件生态、多智能体协作研究。每人至少提 2 个候选 → 合计 ≥8。

### 1.2 Team 配置

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

**Role 选择**：alice `explorer`（内部代码扫描，只读深挖），其余 `researcher`/`analyst`（外部调研 + 综合）。6 人对称，差异来自维度 prompt。

### 1.3 Master 启动调用

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

**参数选择**：
- `mode: isolated` + 维度烤进 prompt——6 路并行各扫一个维度，互不重叠。
- 不设 `signoff_policy`——parallel 默认无 signoff，跑完即汇总。

### 1.4 生命周期步骤（master）

```
team_create(fd-research)
team_activate(fd-research)
team_parallel(...)            # §1.3
# 等待 6 名研究员产出 → team_results 取汇总
team_deactivate(fd-research)
```

### 1.5 产出与交接

- master 从 6 份输出抓取所有 `<!-- CANDIDATE: <id>:<short> -->`，汇总成**候选清单**（id + short + 描述，应 ≥8 条）。
- 这张清单作为 §2 `team_consensus` 的 `topic`。

---

## §2 discussion-team（`team_consensus`）— 讨论

### 2.1 阶段说明

5 名 debater（2 reviewer + 2 architect + 1 analyst）多轮辩论候选清单：综合**必要性 / 可行性 / 复杂度**，投票收敛选出 **1 个**要实现的功能。

### 2.2 Team 配置

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

**Role 选择**：erin/tom `reviewer`（风险视角），frank/uma `architect`（设计视角），grace `analyst`（成本/价值视角），三视角交叉。

### 2.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "fd-discussion",
    "topic": "<把 §1.5 候选清单原文粘进来：每条 CANDIDATE id/short/描述>",
    "max_rounds": 4,
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `topic` = 候选清单（master 手递手填入）。
- `max_rounds: 4`——给足辩论空间收敛到唯一选择。

### 2.4 生命周期步骤（master）

```
team_create(fd-discussion)
team_activate(fd-discussion)   # （此时 fd-research 已 deactivate）
team_consensus(...)            # topic = §1.5 候选清单
# 等待共识 → team_results 取汇总
team_deactivate(fd-discussion)
```

### 2.5 产出与交接

- master 抓取 `<!-- SELECTED: <id> -->`（共识后各成员应收敛到同一 id）+ 理由。
- 选中的功能作为 §3 plan-team 的编写对象。

---

## §3 plan-team（`team_loop`）— 计划

### 3.1 阶段说明

为选中的功能编写**实施方案**。每轮按 **编写（writer）→ 审计（reviewer）** 串行，decider 裁决「方案通过 / 回炉」。通过后产出可交付实现的完整方案。

> ⚠️ **decider 不能兼任 stage 成员**（team_loop 规则：decider 是 auto-appended 只读，不能出现在 stages 里）。jack 留作 decider，不进 stages。

### 3.2 Team 配置

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
      "role": "reviewer",
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

**Role 选择**：henry `writer`（编写方案，modify），iris `reviewer`（审计，read_only），jack `reviewer`（decider，auto-appended 只读裁决）。

### 3.3 Master 启动调用

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "fd-plan",
    "initial_task": "Write an implementation plan for the selected OCTeam feature: <SELECTED id + §2.5 理由 + 原候选描述>. Each round: Henry drafts/refines the plan, Iris audits it. Jack decides approve/rework. On approval, emit <!-- PLAN-APPROVED --> with the final plan.",
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

**参数选择**：
- `stages` 顺序：henry(modify，编写) → iris(read_only，审计)，每轮一遍；decider jack 每轮裁决。
- `max_rounds: 4`——4 轮内未通过则交回你处理。

### 3.4 生命周期步骤（master）

```
team_create(fd-plan)
team_activate(fd-plan)        # （此时 fd-discussion 已 deactivate）
team_loop(...)                # initial_task + stages 如上
# 等待 decider 裁决 approved / 达 max_rounds → team_results 取 PLAN-APPROVED + 方案
team_deactivate(fd-plan)
```

### 3.5 产出与交接

- master 抓取 `<!-- PLAN-APPROVED -->` + 完整实施方案。
- 这份方案作为 §4 implement-team pipeline 首阶段（coder）的输入。

---

## §4 implement-team（`team_pipeline`）— 实现

### 4.1 阶段说明

按方案**线性流水线**实现：**coder 实现 → tester 写+跑测试 → reviewer 评审**。前 stage 的产出拼进下 stage 的 task，顺序加工。

### 4.2 Team 配置

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

**Role 选择**：kate `coder`（实现）、leo `tester`（写+跑测试）、mona `reviewer`（评审）。pipeline 各 stage 顺序加工、无 action 字段。

### 4.3 Master 启动调用

```json
{
  "tool": "team_pipeline",
  "args": {
    "team_id": "fd-implement",
    "stages": [
      {
        "member": "kate",
        "task": "Implement the approved plan for the selected OCTeam feature. Plan: <把 §3.5 的 PLAN-APPROVED 方案粘进来>. Make the specified code changes under src/, minimal and convention-following. Output a summary of changed files + key diffs."
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

**参数选择**：
- pipeline 把每个 stage 的产出**前缀拼进**下一个 stage 的 task——leo 能看到 kate 的改动摘要，mona 能看到 kate 的代码 + leo 的测试结果。
- 首阶段 task 内嵌 §3.5 的方案。
- 不设 `signoff_policy`——pipeline 默认 none，三阶段跑完直接交付。

### 4.4 生命周期步骤（master）

```
team_create(fd-implement)
team_activate(fd-implement)   # （此时 fd-plan 已 deactivate）
team_pipeline(...)            # stages 如上，首阶段 task 含 §3.5 方案
# 等待三阶段顺序完成 → team_results 取汇总（code + tests + review）
team_deactivate(fd-implement)
```

### 4.5 产出与交接

- master 抓取 kate 的改动摘要 + leo 的测试结果 + mona 的评审结论。
- 实现后的功能（代码 + 测试）作为 §5 audit-team 的审计对象。

---

## §5 audit-team（`team_parallel`）— 审计

### 5.1 阶段说明

4 名审计员**并行**深审新功能，每人一个维度，独立于 §4 pipeline 内联的 reviewer：**正确性 / 回归 / 测试完备性 / 设计契合**。

### 5.2 Team 配置

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

**Role 选择**：nina/omar/pat `reviewer`（正确性/回归/测试 三视角，只读深审），quinn `architect`（设计契合视角）。4 人对称，差异来自维度 prompt。

### 5.3 Master 启动调用

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "fd-audit",
    "mode": "isolated",
    "task": "Audit the newly implemented OCTeam feature (see §4 output: changed files + tests + review) strictly within YOUR ASSIGNED DIMENSION (see your role brief). Emit the <!-- AUDIT: <dim>: pass|fail --> marker exactly as your brief specifies, followed by your findings.",
    "timeout_ms": 1500000
  }
}
```

**参数选择**：
- `mode: isolated` + 维度烤进 prompt——4 路并行各审一个维度。
- audit-team 看到的是 §4 的实现产出（master 在 task 里给出 changed files 摘要）。

### 5.4 生命周期步骤（master）

```
team_create(fd-audit)
team_activate(fd-audit)       # （此时 fd-implement 已 deactivate）
team_parallel(...)            # §5.3，task 含 §4 实现摘要
# 等待 4 名审计员产出 → team_results 取汇总
team_deactivate(fd-audit)
```

### 5.5 产出与交接

- master 抓取所有 `<!-- AUDIT: <dim>: pass|fail -->` + findings。
- **你读取这 4 维审计结论 + 各团队输出，自行裁定整次功能增强的成败。** 场景到此结束。

---

## 端到端时序（master 视角）

```
T+0    team_create(fd-research) → team_activate → team_parallel
         6 研究员并行调研（内部+外部）
T+~15  收 ≥8 candidates → team_deactivate(fd-research)
T+~15  team_create(fd-discussion) → team_activate → team_consensus(topic=candidates)
         5 debater 辩论投票选 1（≤4 轮）
T+~30  收 SELECTED → team_deactivate(fd-discussion)
T+~30  team_create(fd-plan) → team_activate → team_loop
         每轮 henry 编写 → iris 审计，jack 裁决
T+~45  收 PLAN-APPROVED → team_deactivate(fd-plan)
T+~45  team_create(fd-implement) → team_activate → team_pipeline
         kate 实现 → leo 测试 → mona 评审
T+~70  收 feature+tests → team_deactivate(fd-implement)
T+~70  team_create(fd-audit) → team_activate → team_parallel
         4 审计员并行深审（正确性/回归/测试/设计）
T+~85  收 audit verdicts → team_deactivate(fd-audit)
T+~85  你读取全部输出，裁定结果
```

（时长仅为量级估计；功能复杂度越高越久。本场景不设硬性 timeout 上限。）

---

## 快速启动 Prompt（复制即用）

> 整段粘贴给 master 会话。master 会依次跑 5 个团队，每步按 README 的 JSON 配置执行，团队间数据由 master 手递手。

```text
按 scenarios/composite/feature-dev/README.md 跑一次 OCTeam 功能增强工作流。

执行 5 个团队，每个走「team_create → team_activate → team_<mode> → team_results → team_deactivate」完整生命周期。同一时刻只允许一个 active 团队——切换前必须先 deactivate。

1. research-team (team_parallel，§1)：按 §1.2 team_create，§1.3 team_parallel。6 名研究员并行调研（内部 src/docs + GitHub/web 外部）。完成后 deactivate。汇总所有 <!-- CANDIDATE: <id>:<short> --> marker 成候选清单（应 ≥8 条）。

2. discussion-team (team_consensus，§2)：按 §2.2 team_create，§2.3 team_consensus（topic = 上一步候选清单，max_rounds=4）。5 名 debater 综合必要性/可行性/复杂度投票选 1。完成后 deactivate。抓取 <!-- SELECTED: <id> --> + 理由。

3. plan-team (team_loop，§3)：按 §3.2 team_create，§3.3 team_loop（initial_task 含 SELECTED 功能）。每轮 henry 编写 → iris 审计，jack 裁决。完成后 deactivate。抓取 <!-- PLAN-APPROVED --> + 完整方案。

4. implement-team (team_pipeline，§4)：按 §4.2 team_create，§4.3 team_pipeline（首阶段 task 内嵌 §3.5 方案）。kate 实现 → leo 写+跑测试 → mona 评审。完成后 deactivate。汇总改动摘要 + 测试结果 + 评审结论。

5. audit-team (team_parallel，§5)：按 §5.2 team_create，§5.3 team_parallel（task 含 §4 实现摘要）。4 名审计员并行深审（正确性/回归/测试完备/设计契合）。完成后 deactivate。汇总所有 <!-- AUDIT: <dim>: pass|fail --> marker。

全部完成后，把每个团队的产出（candidates / selected / plan / implementation / audit verdicts）整理给我，由我裁定结果。不跑评判脚本。

注意：
- 成员名必须取自 32 字预设池（alice/bob/carol/dave/erin/frank/grace/henry/iris/jack/kate/leo/mona/nina/omar/pat/quinn/ruby/sam/tom/uma...），角色必须用 explorer/researcher/analyst/reviewer/architect/writer/coder/tester 等预设值。
- 切换团队前一定先 team_deactivate 当前团队，否则 team_activate 会被拒绝。
- plan-team 的 decider（jack）不能出现在 stages 里。
- pipeline 模式无 action 字段；各 stage 顺序加工，前 stage 产出自动拼进下 stage task。
```

---

## 相关文档

- [`scenarios/README.md`](../../README.md) — 场景目录总览（单原语 9 模式 + 本综合场景）
- [`scenarios/composite/code-review/README.md`](../code-review/README.md) — 姊妹综合场景：多团队代码评审（同样 4 编排，可对照）
- [`scenarios/_AUTHORING.md`](../../_AUTHORING.md) — 单原语场景编写规范（本综合场景为变体：多团队多编排、无评判脚本）
- [`src/tools/workflow-basic.ts`](../../../src/tools/workflow-basic.ts) — parallel / consensus / pipeline / loop 源码
- [`src/tools/workflow-advanced.ts`](../../../src/tools/workflow-advanced.ts) — delegate / route / arbitrate / tollgate / recurse 源码
- [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) — OCTeam 架构与模块边界（plan/audit 团队需参照）
