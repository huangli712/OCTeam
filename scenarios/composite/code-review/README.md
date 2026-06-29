# 综合场景：OCTeam 多团队代码评审

5 阶段代码评审链（**审计 → 确认缺陷 → 制定修复方案 → 修复 → 修复部分复审**），由 4 个独立团队 × 4 种编排原语串联完成。master 作集成枢纽，团队间彼此隔离、数据手递手。

**自用模板**：不绑定特定靶子，不含评判脚本。把 `<TARGET>` 替换为你要评审的代码（文件 / 模块 / 目录），按文末 quick-start prompt 跑通；发现的真假与修复的正确性**由你自行判断**。

## 工作流总览

| 阶段 | 团队 | 编排原语 | 输入 | 产出（交接 marker） |
|------|------|---------|------|---------------------|
| ① 审计 + ② 发现缺陷 | **audit-team** | `team_parallel` | `<TARGET>` 源码 | `<!-- FINDING: <id>:<dim>:<severity> -->` |
| ③ 制定修复方案（含确认） | **plan-team** | `team_consensus` | audit 汇总的 findings | `<!-- CONFIRMED: <id>:<strategy> -->` |
| ④ 修复 | **fix-team** | `team_delegate` | 每个 CONFIRMED 发现一条 task | `<!-- FIXED: <id> -->` + 补丁 |
| ⑤ 修复部分复审（测试 + 审计） | **verify-team** | `team_loop` | 补丁后的工作副本 | tester `<!-- TESTS: ... -->`；reviewer `<!-- VERDICT: <id>: pass\|fail -->` |

用到 4 种编排：**parallel / consensus / delegate / loop**。loop 的 decider 是成员（非 master），裁决「通过 / 继续循环」。

```
<TARGET> ──► audit-team (parallel)  ──findings──► master
                                                     │
             plan-team  (consensus) ◄──findings──────┘
                  │
                  └──confirmed──► master
                                     │
             fix-team   (delegate) ◄──confirmed──────┘
                  │
                  └──fixed+patches──► master
                                        │
             verify-team (loop)       ◄──patched──────┘
                  │
                  └──verdicts──► master ──► 你判断
```

## 如何使用

1. **确定 `<TARGET>`**：你要评审的代码路径（单文件 / 目录 / 模块名）。
2. **依次跑 4 个团队**（§1–§4）。每个团队走完整生命周期：`team_create` → `team_activate` → `team_<mode>` → 收产出 → `team_deactivate`。
3. **交接**：每个团队的 marker 产出由 master 汇总，作为下一个团队的输入（findings → topic；confirmed → tasks；fixed+patches → 复审对象）。
4. **判断**：你读取 verify-team 的 verdict 与各团队输出，自行裁定结果。本场景**不设回归门 / 不跑评判脚本**。

## team 切换铁律

同一时刻**仅一个团队** active。`team_activate` 在已有 active 团队时会拒绝——**必须先 `team_deactivate` 再 `team_activate` 下一个**。每个团队段的 master 步骤都已显式写出 deactivate。

---

## §1 audit-team（`team_parallel`）— 审计 + 发现缺陷

### 1.1 阶段说明

7 个 reviewer **并行**审计 `<TARGET>`，每人一个专属维度（维度烤进成员 prompt，parallel 跑 isolated）。覆盖：正确性/逻辑、并发/竞态、安全/输入校验、错误处理/资源清理、性能/效率、API 契约/类型安全、可维护性/代码异味。

### 1.2 Team 配置

```json
{
  "name": "cr-audit",
  "description": "Code review audit team: 7 reviewers scan <TARGET> in parallel, each a dedicated dimension",
  "members": [
    {
      "name": "alice",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in CORRECTNESS & LOGIC. Audit the code at the given <TARGET> for: off-by-one errors, wrong operators, incorrect algorithms, missed edge cases, boundary-condition bugs. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:correctness:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id (e.g. tasks-off-by-one-capacity). Report every issue — do not self-censor."
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in CONCURRENCY & RACES. Audit the code at the given <TARGET> for: mutex/lock coverage gaps, TOCTOU (time-of-check-to-time-of-use), data races, async ordering bugs, deadlock potential. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:concurrency:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in SECURITY & INPUT VALIDATION. Audit the code at the given <TARGET> for: injection, path traversal, auth/authz gaps, untrusted-input handling, unsafe deserialization, symlink/rename races on filesystem paths. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:security:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "dave",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in ERROR HANDLING & RESOURCE CLEANUP. Audit the code at the given <TARGET> for: swallowed errors, empty/over-broad catch blocks, resource leaks (unclosed handles), partial-failure cleanup gaps, unhandled promise rejections. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:errorhandling:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "nina",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in PERFORMANCE & EFFICIENCY. Audit the code at the given <TARGET> for: hot-path inefficiencies, unnecessary allocations, O(n^2) or worse complexity where O(n) suffices, redundant work, sync I/O on hot paths, missing caching where beneficial. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:performance:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "omar",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in API CONTRACTS & TYPE SAFETY. Audit the code at the given <TARGET> for: unsafe type assertions (as any / @ts-ignore), missing input validation at trust boundaries, broken invariants/contracts, schema validation gaps, public API misuse. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:apicontracts:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "pat",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in MAINTAINABILITY & CODE SMELL. Audit the code at the given <TARGET> for: duplicated logic, excessive cyclomatic complexity, magic numbers, dead code, unclear naming, overly long functions. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:maintainability:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    }
  ]
}
```

**Role 选择**：`reviewer` 为只读角色（审计不应改码），7 人对称，差异来自维度 prompt。

### 1.3 Master 启动调用

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "cr-audit",
    "mode": "isolated",
    "task": "Audit the code at <TARGET> for actionable issues strictly within YOUR ASSIGNED DIMENSION (see your role brief). For each issue, emit the <!-- FINDING: <id>:<dim>:<severity> --> marker exactly as your brief specifies, followed by a short description. Report every issue you find.",
    "timeout_ms": 1200000
  }
}
```

**参数选择**：
- `mode: isolated` + 维度烤进成员 prompt——7 路并行各自扫一个维度，互不重叠。
- 不设 `signoff_policy`——parallel 默认无 signoff，跑完即汇总。

### 1.4 生命周期步骤（master）

```
team_create(cr-audit)         # 用 §1.2 JSON
team_activate(cr-audit)       # 激活（确认当前无其它 active 团队）
team_parallel(...)            # 用 §1.3 JSON
# 等待 7 名 reviewer 产出 → team_results 取汇总
team_deactivate(cr-audit)     # 释放，为下一个团队让路
```

### 1.5 产出与交接

- master 从 7 份成员输出抓取所有 `<!-- FINDING: <id>:<dim>:<severity> -->`，**汇总成一张 findings 清单**（id + dim + severity + 描述）。
- 这张清单作为 §2 `team_consensus` 的 `topic` 喂给 plan-team。
- 如果没有发现问题，那么 master 应该如实汇报，并中断流程。

---

## §2 plan-team（`team_consensus`）— 确认缺陷 + 制定修复方案

### 2.1 阶段说明

4 名 debater（2 reviewer + 2 architect）多轮辩论 audit 的 findings：哪些是真问题、严重度如何、用什么修复策略。达成共识后，输出被确认的缺陷表 + 每条的修复策略。

### 2.2 Team 配置

```json
{
  "name": "cr-plan",
  "description": "Code review plan team: 4 debaters (2 reviewers + 2 architects) triage audit findings, agree on real issues + fix strategies",
  "members": [
    {
      "name": "erin",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues worth fixing. For each finding argue: is it a genuine issue (not a false positive)? what is the correct severity? what is the minimal, safe fix strategy? Reach agreement with your teammates. In your FINAL message, emit one line per confirmed issue exactly formatted: <!-- CONFIRMED: <finding-id>:<fix-strategy-slug> --> where strategy is a short kebab-case hint (e.g. narrow-the-catch / add-missing-lock / off-by-one-minus-one). Findings you collectively reject are simply omitted."
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues worth fixing. For each finding argue: is it a genuine issue (not a false positive)? what is the correct severity? what is the minimal, safe fix strategy? Reach agreement with your teammates. In your FINAL message, emit one line per confirmed issue exactly formatted: <!-- CONFIRMED: <finding-id>:<fix-strategy-slug> -->. Findings you collectively reject are simply omitted."
    },
    {
      "name": "grace",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL and how to fix them cleanly. Weigh design impact and invariant preservation when proposing fix strategies. Reach agreement with your teammates. In your FINAL message, emit one line per confirmed issue exactly formatted: <!-- CONFIRMED: <finding-id>:<fix-strategy-slug> -->. Findings you collectively reject are simply omitted."
    },
    {
      "name": "quinn",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL and how to fix them cleanly. Weigh design impact, invariant preservation, and long-term maintainability when proposing fix strategies. Reach agreement with your teammates. In your FINAL message, emit one line per confirmed issue exactly formatted: <!-- CONFIRMED: <finding-id>:<fix-strategy-slug> -->. Findings you collectively reject are simply omitted."
    }
  ]
}
```

**Role 选择**：erin/frank 用 `reviewer`（只读深审），grace/quinn 用 `architect`（双架构视角权衡修复策略的设计影响）。

### 2.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "cr-plan",
    "topic": "<把 §1.5 的 findings 清单原文粘进来：每条 FINDING id/dim/severity/描述>",
    "max_rounds": 6,
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `topic` = audit findings 清单（master 手递手填入）。
- `max_rounds: 6`——给足辩论空间，应对大量 findings 时有回旋余量。
- 不设 `signoff_policy`——consensus 的「全同意」机制本身就是门。

### 2.4 生命周期步骤（master）

```
team_create(cr-plan)
team_activate(cr-plan)        # （此时 cr-audit 已 deactivate）
team_consensus(...)           # topic = §1.5 findings 清单
# 等待共识 → team_results 取汇总
team_deactivate(cr-plan)
```

### 2.5 产出与交接

- master 抓取所有 `<!-- CONFIRMED: <id>:<strategy> -->`，去重成**确认缺陷表**。
- 这张表用于 §3：每条 CONFIRMED 展开成 fix-team 的一个 delegate task。

---

## §3 fix-team（`team_delegate`）— 修复

### 3.1 阶段说明

3 名 coder **自取**任务：每条确认缺陷是一个 task（含修复策略），coder 认领后在 `<TARGET>` 上打最小补丁。

### 3.2 Team 配置

```json
{
  "name": "cr-fix",
  "description": "Code review fix team: 3 coders self-claim confirmed findings and apply minimal fixes to <TARGET>",
  "members": [
    {
      "name": "henry",
      "role": "coder",
      "prompt": "You are a coder in delegate mode. Use team_task_list to find available fix tasks, claim one with team_task_update (status 'claimed'), apply the MINIMAL fix described by its strategy to <TARGET>, then report to master via team_send_message and release the task. Make the smallest change that resolves the issue without unrelated edits. For each completed task, emit a line exactly formatted: <!-- FIXED: <finding-id> --> and include the patch (diff or changed lines). Repeat until no tasks remain."
    },
    {
      "name": "iris",
      "role": "coder",
      "prompt": "You are a coder in delegate mode. Use team_task_list to find available fix tasks, claim one with team_task_update (status 'claimed'), apply the MINIMAL fix described by its strategy to <TARGET>, then report to master via team_send_message and release the task. Make the smallest change that resolves the issue without unrelated edits. For each completed task, emit a line exactly formatted: <!-- FIXED: <finding-id> --> and include the patch. Repeat until no tasks remain."
    },
    {
      "name": "jack",
      "role": "coder",
      "prompt": "You are a coder in delegate mode. Use team_task_list to find available fix tasks, claim one with team_task_update (status 'claimed'), apply the MINIMAL fix described by its strategy to <TARGET>, then report to master via team_send_message and release the task. Make the smallest change that resolves the issue without unrelated edits. For each completed task, emit a line exactly formatted: <!-- FIXED: <finding-id> --> and include the patch. Repeat until no tasks remain."
    }
  ]
}
```

**Role 选择**：`coder` 用 build agent，最小变更、专注实现。3 人对称（delegate 模式角色对称，差异来自认领的任务）。

### 3.3 Master 启动调用

`tasks` 数组每条对应一个 CONFIRMED 缺陷。下面给模板 + 样例（按实际 `CONFIRMED` 列表展开）。

```json
{
  "tool": "team_delegate",
  "args": {
    "team_id": "cr-fix",
    "tasks": [
      {
        "ref": "fix-<finding-id>",
        "subject": "Fix <finding-id>",
        "description": "Apply the fix for finding <finding-id> using strategy: <strategy-slug>. Background: <一句缺陷描述>. Make the minimal change to <TARGET> that resolves it. Emit <!-- FIXED: <finding-id> --> and include the patch. <策略展开提示，如：narrow the catch to only ENOENT / add the missing lock around the claim / change <= to < on capacity>"
      }
    ],
    "timeout_ms": 1800000,
    "max_errored_members": 0
  }
}
```

**参数选择**：
- 无 `blocked_by`——各缺陷修复相互独立（若某两个修复改同一文件需串行，可加 `blocked_by` 串起来）。
- `max_errored_members: 0`——任一修复失败即整体失败（你手动重跑该条即可）。
- 不设 `signoff_policy`——delegate 默认 none，任务完成直接交付。

### 3.4 生命周期步骤（master）

```
team_create(cr-fix)
team_activate(cr-fix)         # （此时 cr-plan 已 deactivate）
team_delegate(...)            # tasks = §2.5 确认缺陷表展开
# 等待 coder 自取自报 → team_results 取汇总
team_deactivate(cr-fix)
```

### 3.5 产出与交接

- master 抓取所有 `<!-- FIXED: <id> -->` + 对应补丁。
- 补丁后的 `<TARGET>` 工作副本作为 §4 verify-team 的复审对象。

---

## §4 verify-team（`team_loop`）— 修复部分复审（测试 + 审计）

### 4.1 阶段说明

修复有没有真解决问题、有没有引入新问题、有没有回归？用纠正循环，每轮按 **测试（tester，写+跑回归测试）→ 修复（coder）→ 审计（reviewer）** 三阶段串行，decider 裁决「全通过 / 继续循环」。最多 3 轮。**不设硬性回归门，最终由你判断。**

**decider 不能兼任 stage 成员**（team_loop 规则：decider 是 auto-appended 只读，不能出现在 stages 里）。所以「审计」stage 用独立 reviewer 成员 ruby，mona 留作 decider。

### 4.2 Team 配置

```json
{
  "name": "cr-verify",
  "description": "Code review verify team: test->fix->audit loop each round; decider judges done",
  "members": [
    {
      "name": "leo",
      "role": "tester",
      "prompt": "You are the TESTER (stage 1) in the verify loop. Each round, for each confirmed finding's fix, WRITE a focused regression test (in <TARGET>'s test directory) if one does not already cover it, then run the full test suite. Emit <!-- TESTS: <passed>/<total> --> (or <!-- TESTS: skip:no-suite --> if <TARGET> has no runnable test suite). Call out which findings' fixes are covered and whether they pass. You MAY add test files — do NOT modify the production fix code itself (that is Kate's job)."
    },
    {
      "name": "kate",
      "role": "coder",
      "prompt": "You are the CODER (stage 2) in the verify loop. Each round, if Leo's tests or Ruby's previous-round audit flagged any fix as failing or incomplete, apply the MINIMAL rework to <TARGET> to resolve it. Emit <!-- REWORKED: <finding-id> --> for each finding you re-touched this round. If nothing needs rework, confirm the fixes stand."
    },
    {
      "name": "ruby",
      "role": "reviewer",
      "prompt": "You are the AUDITOR (stage 3) in the verify loop. Each round, re-audit EACH confirmed finding's fix in <TARGET>: is the original issue actually resolved? did the fix introduce a new issue or regression? Emit exactly one line per finding: <!-- VERDICT: <finding-id>: pass --> if resolved with no new issue, or <!-- VERDICT: <finding-id>: fail --> with a one-line reason if not."
    },
    {
      "name": "mona",
      "role": "reviewer",
      "prompt": "You are the DECIDER in the verify loop. After each round (Leo's tests -> Kate's rework -> Ruby's audit), decide whether ALL confirmed findings' fixes are verified: Ruby's VERDICT all pass AND Leo's tests green (or skipped). Emit <decision>{\"done\": true}</decision> when all pass, or <decision>{\"done\": false, \"reason\": \"...\"}</decision> naming the failing finding ids to loop back. Preserve invariants; do not lower the bar."
    }
  ]
}
```

**Role 选择**：leo `tester`（写回归测试 + 跑测试，stage1 modify 测试文件）、kate `coder`（返工修复，stage2 modify 生产代码）、ruby `reviewer`（复审，stage3 只读）、mona `reviewer`（decider，auto-appended 只读裁决）。

### 4.3 Master 启动调用

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "cr-verify",
    "initial_task": "Verify the fixes applied to <TARGET> for these confirmed findings: <把 §2.5 的 CONFIRMED id 列表粘进来>. Each round runs Leo (write+run regression tests) -> Kate (rework failures) -> Ruby (re-audit each fix, VERDICT). Mona decides whether ALL fixes are verified.",
    "stages": [
      {
        "member": "leo",
        "task": "For each confirmed finding's fix, write a regression test (in <TARGET>'s test dir) if not already covered, then run the full suite. Emit <!-- TESTS: <passed>/<total> --> (or <!-- TESTS: skip:no-suite -->). Flag which findings' fixes are covered and pass. Add tests only — do not touch the fix code.",
        "action": "modify"
      },
      {
        "member": "kate",
        "task": "If Leo's tests or Ruby's previous-round audit flagged any fix as failing or incomplete, apply the MINIMAL rework to <TARGET>. Emit <!-- REWORKED: <id> --> for each re-touched finding.",
        "action": "modify"
      },
      {
        "member": "ruby",
        "task": "Re-audit each confirmed finding's fix in <TARGET>. Emit one <!-- VERDICT: <id>: pass --> (resolved, no new issue) or <!-- VERDICT: <id>: fail --> (with one-line reason) per finding.",
        "action": "read_only"
      }
    ],
    "decider": "mona",
    "max_rounds": 3,
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `stages` 顺序：leo(modify，写+跑测试) → kate(modify，返工) → ruby(read_only，复审)，每轮跑一遍；decider mona 每轮裁决。
- 测试先行：每轮 tester 先写回归测试 + 跑全套暴露回归/失败，coder 再修，reviewer 最后审计正确性。
- `max_rounds: 3`——3 轮内修不干净就交回你处理（避免死循环）。

### 4.4 生命周期步骤（master）

```
team_create(cr-verify)
team_activate(cr-verify)      # （此时 cr-fix 已 deactivate）
team_loop(...)                # initial_task + stages 如上
# 等待 decider 裁决 done / 达 max_rounds → team_results 取汇总
team_deactivate(cr-verify)
```

### 4.5 产出与交接

- master 抓取 leo 的 `<!-- TESTS: ... -->` 与 ruby 的所有 `<!-- VERDICT: <id>: pass|fail -->`（+ kate 的 `<!-- REWORKED: <id> -->` 痕迹）。
- **你读取这些测试结果与 verdict，自行裁定整次评审的成败。** 场景到此结束。

---

## 端到端时序（master 视角）

```
T+0   team_create(cr-audit) → team_activate → team_parallel
        7 reviewer 并行审计 <TARGET>
T+~12  收 findings → team_deactivate(cr-audit)
T+~12  team_create(cr-plan) → team_activate → team_consensus(topic=findings)
        4 debater（2 reviewer + 2 architect）辩论确认 + 定策略（≤5 轮）
T+~25  收 confirmed → team_deactivate(cr-plan)
T+~25  team_create(cr-fix) → team_activate → team_delegate(tasks=per-confirmed)
        3 coder 自取自修 <TARGET>
T+~40  收 fixed+patches → team_deactivate(cr-fix)
T+~40  team_create(cr-verify) → team_activate → team_loop
        每轮 leo 写+跑测试 → kate 修复 → ruby 审计，mona 裁决
T+~55  收 verdicts → team_deactivate(cr-verify)
T+~55  你读取全部输出，裁定结果
```

（时长仅为量级估计；`<TARGET>` 越大越久。本场景不设硬性 timeout 上限。）

---

## 快速启动 Prompt（复制即用）

> 把 `<TARGET>` 替换为你要评审的代码路径，整段粘贴给 master 会话。master 会依次跑 4 个团队，每步按 README 的 JSON 配置执行，团队间数据由 master 手递手。

```text
按 scenarios/composite/code-review/README.md 跑一次多团队代码评审，目标代码 = <TARGET>。

执行 4 个团队，每个走「team_create → team_activate → team_<mode> → team_results → team_deactivate」完整生命周期。同一时刻只允许一个 active 团队——切换前必须先 deactivate。

1. audit-team (team_parallel，§1)：按 §1.2 team_create，§1.3 team_parallel。7 名 reviewer 并行审计 <TARGET>。完成后 deactivate。汇总所有 <!-- FINDING: ... --> marker 成 findings 清单。

2. plan-team (team_consensus，§2)：按 §2.2 team_create，§2.3 team_consensus（topic = 上一步 findings 清单，max_rounds=5）。4 名 debater（2 reviewer + 2 architect）辩论确认。完成后 deactivate。汇总所有 <!-- CONFIRMED: <id>:<strategy> --> marker 成确认缺陷表。

3. fix-team (team_delegate，§3)：按 §3.2 team_create，§3.3 team_delegate（tasks = 把确认缺陷表每条展开成一个 fix task，含 strategy）。3 名 coder 自取自修。完成后 deactivate。汇总所有 <!-- FIXED: <id> --> + 补丁。

4. verify-team (team_loop，§4)：按 §4.2 team_create，§4.3 team_loop（initial_task 含 CONFIRMED id 列表）。每轮 leo 写+跑测试 → kate 修复 → ruby 审计，mona 裁决。完成后 deactivate。汇总 leo 的 <!-- TESTS: ... --> 与 ruby 的所有 <!-- VERDICT: <id>: pass|fail -->。

全部完成后，把每个团队的产出（findings / confirmed / fixed+patches / tests+verdicts）整理给我，由我裁定结果。不跑评判脚本、不设回归门。

注意：
- 成员名必须取自 32 字预设池（alice/bob/carol/dave/erin/frank/grace/henry/iris/jack/kate/leo/mona/nina/omar/pat/quinn/ruby...），角色必须用 reviewer/architect/coder/tester 等预设值。
- 切换团队前一定先 team_deactivate 当前团队，否则 team_activate 会被拒绝。
- 如果audit-team 没有发现P0, P1, P2级的问题，应中断流程。
```

---

## 相关文档

- [`scenarios/README.md`](../../README.md) — 场景目录总览（单原语 9 模式 + 本综合场景）
- [`scenarios/_AUTHORING.md`](../../_AUTHORING.md) — 单原语场景编写规范（本综合场景为变体：多团队多编排、无评判脚本）
- [`scenarios/01-team-parallel/README.md`](../../01-team-parallel/README.md) — parallel 原语参考
- [`scenarios/05-team-delegate/README.md`](../../05-team-delegate/README.md) — delegate 原语参考（自取流程）
- [`src/tools/workflow-basic.ts`](../../../src/tools/workflow-basic.ts) — parallel / consensus / pipeline / loop 源码
- [`src/tools/workflow-advanced.ts`](../../../src/tools/workflow-advanced.ts) — delegate / route / arbitrate / tollgate / recurse 源码
