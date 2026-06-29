# 综合场景：OCTeam 多团队代码评审

> 5 阶段代码评审链（**审计 → 确认缺陷 → 制定修复方案 → 修复 → 修复部分复审**），由 4 个独立团队 × 4 种编排原语串联完成。master 作集成枢纽，团队间彼此隔离、数据手递手。
>
> **自用模板**：不绑定特定靶子，不含评判脚本。把 `<TARGET>` 替换为你要评审的代码（文件 / 模块 / 目录），按文末 quick-start prompt 跑通；发现的真假与修复的正确性**由你自行判断**。

## 工作流总览

| 阶段 | 团队 | 编排原语 | 输入 | 产出（交接 marker） |
|------|------|---------|------|---------------------|
| ① 审计 + ② 发现缺陷 | **audit-team** | `team_parallel` | `<TARGET>` 源码 | `<!-- FINDING: <id>:<dim>:<severity> -->` |
| ③ 制定修复方案（含确认） | **plan-team** | `team_consensus` | audit 汇总的 findings | `<!-- CONFIRMED: <id>:<strategy> -->` |
| ④ 修复 | **fix-team** | `team_delegate` | 每个 CONFIRMED 发现一条 task | `<!-- FIXED: <id> -->` + 补丁 |
| ⑤ 修复部分复审（审计 + 可选测试） | **verify-team** | `team_loop` | 补丁后的工作副本 | `<!-- VERDICT: <id>: pass\|fail -->` |

用到 4 种编排：**parallel / consensus / delegate / loop**。loop 的 decider 是成员（非 master），裁决「通过 / 继续修」。

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
            verify-team (loop)      ◄──patched──────┘
                 │
                 └──verdicts──► master ──► 你判断
```

## 如何使用

1. **确定 `<TARGET>`**：你要评审的代码路径（单文件 / 目录 / 模块名）。
2. **依次跑 4 个团队**（§1–§4）。每个团队走完整生命周期：`team_create` → `team_activate` → `team_<mode>` → 收产出 → `team_deactivate`。
3. **交接**：每个团队的 marker 产出由 master 汇总，作为下一个团队的输入（findings → topic；confirmed → tasks；fixed+patches → 复审对象）。
4. **判断**：你读取 verify-team 的 verdict 与各团队输出，自行裁定结果。本场景**不设回归门 / 不跑评判脚本**。

## team 切换铁律

> 同一时刻**仅一个团队** active。`team_activate` 在已有 active 团队时会拒绝——**必须先 `team_deactivate` 再 `team_activate` 下一个**。每个团队段的 master 步骤都已显式写出 deactivate。

---

## §1 audit-team（`team_parallel`）— 审计 + 发现缺陷

### 1.1 阶段说明

4 个 reviewer **并行**审计 `<TARGET>`，每人一个专属维度（维度烤进成员 prompt，parallel 跑 isolated）。覆盖：正确性/逻辑、并发/竞态、安全/输入校验、错误处理/资源清理。

### 1.2 Team 配置

```json
{
  "name": "cr-audit",
  "description": "Code review audit team: 4 reviewers scan <TARGET> in parallel, each a dedicated dimension",
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
    }
  ]
}
```

**Role 选择**：`reviewer` 为只读角色（审计不应改码），4 人对称，差异来自维度 prompt。

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
- `mode: isolated` + 维度烤进成员 prompt——4 路并行各自扫一个维度，互不重叠。
- 不设 `signoff_policy`——parallel 默认无 signoff，跑完即汇总。

### 1.4 生命周期步骤（master）

```
team_create(cr-audit)         # 用 §1.2 JSON
team_activate(cr-audit)       # 激活（确认当前无其它 active 团队）
team_parallel(...)            # 用 §1.3 JSON
# 等待 4 名 reviewer 产出 → team_results 取汇总
team_deactivate(cr-audit)     # 释放，为下一个团队让路
```

### 1.5 产出与交接

- master 从 4 份成员输出抓取所有 `<!-- FINDING: <id>:<dim>:<severity> -->`，**汇总成一张 findings 清单**（id + dim + severity + 描述）。
- 这张清单作为 §2 `team_consensus` 的 `topic` 喂给 plan-team。

---

## §2 plan-team（`team_consensus`）— 确认缺陷 + 制定修复方案

### 2.1 阶段说明

3 名 debater 多轮辩论 audit 的 findings：哪些是真问题、严重度如何、用什么修复策略。达成共识后，输出被确认的缺陷表 + 每条的修复策略。

### 2.2 Team 配置

```json
{
  "name": "cr-plan",
  "description": "Code review plan team: 3 debaters triage audit findings, agree on real issues + fix strategies",
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
    }
  ]
}
```

**Role 选择**：erin/frank 用 `reviewer`（只读深审），grace 用 `architect`（带设计视角权衡修复策略）。

### 2.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "cr-plan",
    "topic": "<把 §1.5 的 findings 清单原文粘进来：每条 FINDING id/dim/severity/描述>",
    "max_rounds": 3,
    "timeout_ms": 1200000
  }
}
```

**参数选择**：
- `topic` = audit findings 清单（master 手递手填入）。
- `max_rounds: 3`——给足辩论空间，3 轮内一般能收敛。
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

## §4 verify-team（`team_loop`）— 修复部分复审（审计 + 可选测试）

### 4.1 阶段说明

修复有没有真解决问题、有没有引入新问题？用纠正循环：coder 兜底返工 ↔ reviewer 复审每条修复，decider 裁决「全通过 / 继续修」。最多 3 轮。测试可选——若 `<TARGET>` 自带测试套件，复审时顺手跑；否则纯复审。**不设回归门，最终由你判断。**

### 4.2 Team 配置

```json
{
  "name": "cr-verify",
  "description": "Code review verify team: coder/reviewer loop re-auditing the fixes; decider judges done",
  "members": [
    {
      "name": "kate",
      "role": "coder",
      "prompt": "You are a coder in the verify loop. Each round, ensure every confirmed finding's fix is actually applied to <TARGET>. If the previous round flagged any fix as incomplete or regression-causing, REWORK that fix minimally now. For any finding you re-touched this round, emit <!-- REWORKED: <finding-id> -->. Otherwise confirm the fix is in place."
    },
    {
      "name": "leo",
      "role": "tester",
      "prompt": "You are a tester/re-reviewer in the verify loop. Each round, re-audit EACH confirmed finding's fix in <TARGET>: is the original issue actually resolved? did the fix introduce a new issue? For each finding emit exactly one line: <!-- VERDICT: <finding-id>: pass --> if resolved with no new issue, or <!-- VERDICT: <finding-id>: fail --> with a one-line reason if not. OPTIONALLY, if <TARGET> has a runnable test suite, run it and emit <!-- TESTS: <passed>/<total> --> for extra confidence — this is NOT a gate."
    },
    {
      "name": "mona",
      "role": "reviewer",
      "prompt": "You are the DECIDER in the verify loop. After each round (kate's rework + leo's re-audit), decide: are ALL confirmed findings' fixes verified (leo's VERDICT all pass, no regressions)? Emit <decision>{\"done\": true}</decision> when all pass, or <decision>{\"done\": false, \"reason\": \"...\"}</decision> naming the failing finding ids to send kate back. Preserve invariants; do not lower the bar."
    }
  ]
}
```

**Role 选择**：kate `coder`（返工）、leo `tester`（复审 + 可选测试）、mona `reviewer`（decider，只读裁决）。

### 4.3 Master 启动调用

```json
{
  "tool": "team_loop",
  "args": {
    "team_id": "cr-verify",
    "initial_task": "Verify the fixes applied to <TARGET> for these confirmed findings: <把 §2.5 的 CONFIRMED id 列表粘进来>. Kate ensures each fix is applied (rework any flagged incomplete); Leo re-audits each fix and emits a VERDICT (optionally runs <TARGET>'s tests if present). Mona decides whether ALL fixes are verified.",
    "stages": [
      {
        "member": "kate",
        "task": "Ensure every confirmed finding's fix is applied to <TARGET>. If Leo's previous round flagged any fix incomplete or regression-causing, refine that fix minimally now. Emit <!-- REWORKED: <id> --> for anything re-touched.",
        "action": "modify"
      },
      {
        "member": "leo",
        "task": "Re-audit each confirmed finding's fix in <TARGET>. Emit one <!-- VERDICT: <id>: pass --> (resolved, no new issue) or <!-- VERDICT: <id>: fail --> (with one-line reason) per finding. Optionally run <TARGET>'s test suite and emit <!-- TESTS: <passed>/<total> --> if present.",
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
- `stages`：kate(modify) → leo(read_only)，每轮跑一遍；decider mona 每轮裁决。
- `max_rounds: 3`——3 轮内修不干净就交回你处理（避免死循环）。
- 测试可选（leo prompt 已说明「NOT a gate」）——呼应「不设回归门、由你判断」。

### 4.4 生命周期步骤（master）

```
team_create(cr-verify)
team_activate(cr-verify)      # （此时 cr-fix 已 deactivate）
team_loop(...)                # initial_task + stages 如上
# 等待 decider 裁决 done / 达 max_rounds → team_results 取汇总
team_deactivate(cr-verify)
```

### 4.5 产出与交接

- master 抓取所有 `<!-- VERDICT: <id>: pass|fail -->`（+ 可选 `<!-- TESTS: n/total -->`）。
- **你读取这些 verdict 与各团队输出，自行裁定整次评审的成败。** 场景到此结束。

---

## 端到端时序（master 视角）

```
T+0   team_create(cr-audit) → team_activate → team_parallel
        4 reviewer 并行审计 <TARGET>
T+~10  收 findings → team_deactivate(cr-audit)
T+~10  team_create(cr-plan) → team_activate → team_consensus(topic=findings)
        3 debater 辩论确认 + 定策略
T+~20  收 confirmed → team_deactivate(cr-plan)
T+~20  team_create(cr-fix) → team_activate → team_delegate(tasks=per-confirmed)
        3 coder 自取自修 <TARGET>
T+~35  收 fixed+patches → team_deactivate(cr-fix)
T+~35  team_create(cr-verify) → team_activate → team_loop
        kate↔leo 循环，mona 裁决
T+~50  收 verdicts → team_deactivate(cr-verify)
T+~50  你读取全部输出，裁定结果
```

（时长仅为量级估计；`<TARGET>` 越大越久。本场景不设硬性 timeout 上限。）

---

## 快速启动 Prompt（复制即用）

> 把 `<TARGET>` 替换为你要评审的代码路径，整段粘贴给 master 会话。master 会依次跑 4 个团队，每步按 README 的 JSON 配置执行，团队间数据由 master 手递手。

```text
按 scenarios/composite/01-code-review/README.md 跑一次多团队代码评审，目标代码 = <TARGET>。

执行 4 个团队，每个走「team_create → team_activate → team_<mode> → team_results → team_deactivate」完整生命周期。同一时刻只允许一个 active 团队——切换前必须先 deactivate。

1. audit-team (team_parallel，§1)：按 §1.2 team_create，§1.3 team_parallel。4 名 reviewer 并行审计 <TARGET>。完成后 deactivate。汇总所有 <!-- FINDING: ... --> marker 成 findings 清单。

2. plan-team (team_consensus，§2)：按 §2.2 team_create，§2.3 team_consensus（topic = 上一步 findings 清单）。3 名 debater 辩论确认。完成后 deactivate。汇总所有 <!-- CONFIRMED: <id>:<strategy> --> marker 成确认缺陷表。

3. fix-team (team_delegate，§3)：按 §3.2 team_create，§3.3 team_delegate（tasks = 把确认缺陷表每条展开成一个 fix task，含 strategy）。3 名 coder 自取自修。完成后 deactivate。汇总所有 <!-- FIXED: <id> --> + 补丁。

4. verify-team (team_loop，§4)：按 §4.2 team_create，§4.3 team_loop（initial_task 含 CONFIRMED id 列表）。kate↔leo 循环，mona 裁决。完成后 deactivate。汇总所有 <!-- VERDICT: <id>: pass|fail -->。

全部完成后，把每个团队的产出（findings / confirmed / fixed+patches / verdicts）整理给我，由我裁定结果。不跑评判脚本、不设回归门。

注意：
- 成员名必须取自 32 字预设池（alice/bob/carol/dave/erin/frank/grace/henry/iris/jack/kate/leo/mona...），角色必须用 reviewer/architect/coder/tester 等预设值。
- 切换团队前一定先 team_deactivate 当前团队，否则 team_activate 会被拒绝。
- fix-team 的 coder 会改 <TARGET> 源码——我已自行处理好 worktree/分支，你直接改即可。
```

---

## 相关文档

- [`../../README.md`](../../README.md) — 场景目录总览（单原语 9 模式 + 本综合场景）
- [`../../_AUTHORING.md`](../../_AUTHORING.md) — 单原语场景编写规范（本综合场景为变体：多团队多编排、无评判脚本）
- [`../../01-team-parallel/README.md`](../../01-team-parallel/README.md) — parallel 原语参考
- [`../../05-team-delegate/README.md`](../../05-team-delegate/README.md) — delegate 原语参考（自取流程）
- [`../../../src/tools/workflow-basic.ts`](../../../src/tools/workflow-basic.ts) — parallel / consensus / pipeline / loop 源码
- [`../../../src/tools/workflow-advanced.ts`](../../../src/tools/workflow-advanced.ts) — delegate / route / arbitrate / tollgate / recurse 源码
