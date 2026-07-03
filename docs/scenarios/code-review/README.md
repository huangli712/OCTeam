# 综合场景：OCTeam 多团队代码评审

3 阶段代码评审链（**审计 → 确认缺陷 → 修复**），由 3 个独立团队 × 3 种编排原语串联完成。master 作集成枢纽，团队间彼此隔离、数据手递手。

**自用模板**：不绑定特定靶子，不含评判脚本。把 `<TARGET>` 替换为你要评审的代码（文件 / 模块 / 目录），按文末 quick-start prompt 跑通；发现的真假与修复的正确性**由你自行判断**。

## 工作流总览

| 阶段 | 团队 | 编排原语 | 输入 | 产出（交接 marker） |
|------|------|---------|------|---------------------|
| ① 审计 | **audit-team** | `team_parallel` | `<TARGET>` 源码 | `<!-- FINDING: <id>:<dim>:<severity> -->` |
| ② 确认缺陷（真假辩论） | **plan-team** | `team_consensus` | audit 汇总的 findings | `<!-- CONFIRMED: <id> -->` |
| ③ 修复（逐个门控） | **fix-team** | `team_tollgate` | 每个 CONFIRMED 一条流水线（逐个串行 run） | `<!-- FIXED: <id> -->` + 补丁 |

用到 3 种编排：**parallel / consensus / tollgate**。tollgate 的每道 stage 有独立 verifier（两道门用不同 verifier），FAIL 回退 producer，INVALID 升级到 arbiter，最终由 signoff decider 签字。

```
<TARGET> ──► audit-team (parallel)  ──findings──► master
                                                     │
             plan-team  (consensus) ◄──findings──────┘
                  │
                  └──confirmed──────────────────► master
                                                     │
             fix-team   (tollgate) ◄──confirmed──────┘
                  │  (逐个串行 run，每个 CONFIRMED 一次)
                  └──fixed+patches──────────────► master ──► 你判断
```

## 如何使用

1. **确定 `<TARGET>`**：你要评审的代码路径（单文件 / 目录 / 模块名）。
2. **依次跑 3 个团队**（§1–§3）。每个团队走完整生命周期：`team_create` → `team_activate` → `team_<mode>` → 收产出 → `team_deactivate`。
3. **交接**：每个团队的 marker 产出由 master 汇总，作为下一个团队的输入（findings → topic；confirmed → 逐个 tollgate run 的 task）。
4. **判断**：你读取 fix-team 的 FIXED marker 与补丁，自行裁定结果。本场景**不设回归门 / 不跑评判脚本**。

## team 切换

同一时刻**仅一个团队** active。`team_activate` 在已有 active 团队时会拒绝——**必须先 `team_deactivate` 再 `team_activate` 下一个**。每个团队段的 master 步骤都已显式写出 deactivate。

---

## §1 audit-team（`team_parallel`）— 审计

### 1.1 阶段说明

8 个 reviewer **并行**审计 `<TARGET>`，每人一个专属维度（维度烤进成员 prompt，parallel 跑 isolated）。覆盖：正确性/边界、逻辑/算法、并发/竞态、安全/输入校验、错误处理/资源清理、性能/效率、API 契约/类型安全、可维护性/代码异味。

### 1.2 Team 配置

```json
{
  "name": "cr-audit",
  "description": "Code review audit team: 8 reviewers scan <TARGET> in parallel, each a dedicated dimension",
  "members": [
    {
      "name": "alice",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in CORRECTNESS & BOUNDARIES. Audit the code at the given <TARGET> for: off-by-one errors, wrong operators (e.g. < vs <=, == vs ===), boundary-condition bugs, numeric/comparison errors, capacity/limit checks gone wrong. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:correctness:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id (e.g. tasks-off-by-one-capacity). Report every issue — do not self-censor."
    },
    {
      "name": "sam",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in LOGIC & ALGORITHMS. Audit the code at the given <TARGET> for: incorrect algorithms, wrong control flow, logic that does not match intent, missed edge cases (null/empty/extreme input), state-machine errors. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:logic:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
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

**Role 选择**：`reviewer` 为只读角色（审计不应改码），8 人对称，差异来自维度 prompt。

### 1.3 Master 启动调用

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "cr-audit",
    "mode": "isolated",
    "task": "Audit the code at <TARGET> for actionable issues strictly within YOUR ASSIGNED DIMENSION (see your role brief). For each issue, emit the <!-- FINDING: <id>:<dim>:<severity> --> marker exactly as your brief specifies, followed by a short description. Report every issue you find.",
    "reduce_policy": "merge",
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `mode: isolated` + 维度烤进成员 prompt——8 路并行各自扫一个维度，互不重叠。
- `reduce_policy: merge`——8 路产出**合并**成一份（保留全部维度发现，不摘要/挑选），让 plan-team 拿到完整 findings 清单。
- 不设 `signoff_policy`——parallel 默认无 signoff，跑完即汇总。

### 1.4 生命周期步骤（master）

```
team_create(cr-audit)         # 用 §1.2 JSON
team_activate(cr-audit)       # 激活（确认当前无其它 active 团队）
team_parallel(...)            # 用 §1.3 JSON
# 等待 8 名 reviewer 产出 → team_results 取汇总
team_deactivate(cr-audit)     # 释放，为下一个团队让路
```

### 1.5 产出与交接

- master 从 8 份成员输出抓取所有 `<!-- FINDING: <id>:<dim>:<severity> -->`，**汇总成一张 findings 清单**（id + dim + severity + 描述），同时维护 **id → 描述映射**（后续 §3 tollgate task 展开需要）。
- **裁剪规则（按严重度层级取最高）**：只保留存在的**最高严重度等级**的全部发现，更低等级全部丢弃：
  - 若 high / medium / low 都存在 → 只保留 high，丢弃 medium 和 low。
  - 若无 high 但 medium / low 都存在 → 只保留 medium，丢弃 low。
  - 若只有 low → 保留 low。
- 裁剪后若 **0 条 findings**（没有任何维度的任何发现），master 如实汇报并**中断流程**。
- 这张清单作为 §2 `team_consensus` 的 `topic` 喂给 plan-team。

---

## §2 plan-team（`team_consensus`）— 确认缺陷（真假辩论）

### 2.1 阶段说明

4 名 debater（2 reviewer + 2 architect）多轮辩论 audit 的 findings：**哪些是真问题、哪些是误报**。**本阶段不讨论修复策略**——修复方案交给 §3 fix-team 的 coder 自行决定。达成共识后，输出被确认为真问题的缺陷清单。

### 2.2 Team 配置

```json
{
  "name": "cr-plan",
  "description": "Code review plan team: 4 debaters (2 reviewers + 2 architects) triage audit findings — debate real-vs-false-positive only, NOT fix strategies",
  "members": [
    {
      "name": "erin",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues (not false positives). For each finding argue ONLY: is it a genuine issue? does the code actually exhibit the described problem? Reach agreement with your teammates. Do NOT discuss fix strategies — that is delegated to the fix team. In your FINAL message, emit one line per confirmed-real issue exactly formatted: <!-- CONFIRMED: <finding-id> -->. Findings you collectively reject as false positives are simply omitted."
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues (not false positives). For each finding argue ONLY: is it a genuine issue? does the code actually exhibit the described problem? Reach agreement with your teammates. Do NOT discuss fix strategies — that is delegated to the fix team. In your FINAL message, emit one line per confirmed-real issue exactly formatted: <!-- CONFIRMED: <finding-id> -->. Findings you collectively reject as false positives are simply omitted."
    },
    {
      "name": "grace",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL. Weigh whether the described problem genuinely violates design invariants or contracts. Reach agreement with your teammates. Do NOT discuss fix strategies — that is delegated to the fix team. In your FINAL message, emit one line per confirmed-real issue exactly formatted: <!-- CONFIRMED: <finding-id> -->. Findings you collectively reject as false positives are simply omitted."
    },
    {
      "name": "quinn",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL. Weigh whether the described problem genuinely violates design invariants, contracts, or long-term correctness. Reach agreement with your teammates. Do NOT discuss fix strategies — that is delegated to the fix team. In your FINAL message, emit one line per confirmed-real issue exactly formatted: <!-- CONFIRMED: <finding-id> -->. Findings you collectively reject as false positives are simply omitted."
    }
  ]
}
```

**Role 选择**：erin/frank 用 `reviewer`（只读深审），grace/quinn 用 `architect`（架构视角判断是否真违反不变量/契约）。辩论焦点统一收敛到"真假"，策略留给后续。

### 2.3 Master 启动调用

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "cr-plan",
    "topic": "<把 §1.5 的 findings 清单原文粘进来：每条 FINDING id/dim/severity/描述>",
    "max_rounds": 6,
    "timeout_ms": 2400000
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

- master 抓取所有 `<!-- CONFIRMED: <id> -->`，去重成**确认缺陷表**。
- 对每个 CONFIRMED id，从 §1.5 维护的 id → 描述映射查出缺陷描述，组装 §3 每次 tollgate run 的 task。
- 这张表用于 §3：每条 CONFIRMED 展开成**一次独立的 tollgate run**。

---

## §3 fix-team（`team_tollgate`）— 修复（逐个门控，TDD 顺序）

### 3.1 阶段说明

5 名成员采用 TDD 门控流水线，**逐个**修复 confirmed finding。master 为每条 CONFIRMED **串行启动一次独立的 tollgate run**（N 条 → N 次 run，复用同一 fix-team）。每次 run 走两道门：

```
Stage 1:  henry 写 failing test  →  iris 验证
            criteria: 测试准确复现该 bug（FAIL 必须源于此 bug，非泛泛失败）
            FAIL → 回退 henry 重写        INVALID → escalate leo

Stage 2:  jack 修复代码  →  kate 验证
            criteria: 1) failing test 转 PASS
                      2) 全量回归无新增失败
                      3) 修改最小化（无夹带重构）
                      4) 类型安全（无 as any / @ts-ignore）
            FAIL → 回退 jack 重修          INVALID → escalate leo

两道门都 PASS → leo 最终签字（signoff_policy: decider）
```

**为什么 TDD 顺序（tester 先于 coder）**：完成标准由独立的 tester 提前固化——修复前测试必须 FAIL、修复后必须 PASS。coder 无法写"能 pass 的橡皮图章测试"，测试客观定义了"修好"的标准。

**为什么两道门用不同 verifier**：iris 和 kate 分别把守测试门和修复门，避免单一验证者的盲区。

**为什么逐个串行而非批量**：tollgate 的 stages 是固定单条流水线。逐个串行让每个 bug 独立门控，互不干扰；同一 fix-team 复用，N 次 run 之间由 master 串行启动。

### 3.2 Team 配置

```json
{
  "name": "cr-fix",
  "description": "Code review fix team: 5 members, TDD tollgate (write failing test → verify → fix → verify → signoff), one run per confirmed finding",
  "members": [
    {
      "name": "henry",
      "role": "tester",
      "prompt": "You are the TESTER (Stage 1 producer) in a tollgate fix pipeline. For the confirmed finding assigned in the task, write a FOCUSED regression test (in <TARGET>'s test directory) that reproduces the bug. The test MUST fail on the current (unfixed) code for the RIGHT reason (the actual bug, not a trivial/syntax error, not a different bug). Do NOT modify production code. Emit <!-- TEST-WRITTEN: <finding-id> --> with the test file path."
    },
    {
      "name": "iris",
      "role": "reviewer",
      "prompt": "You are the Stage 1 VERIFIER in a tollgate fix pipeline. Verify that Henry's failing test accurately reproduces the confirmed finding: it FAILS on the current code for the right reason, is focused, and would turn PASS once the bug is fixed. Emit PASS / FAIL (with reason) / INVALID (if the finding description is ambiguous and no accurate test can be written)."
    },
    {
      "name": "jack",
      "role": "coder",
      "prompt": "You are the CODER (Stage 2 producer) in a tollgate fix pipeline. Apply the MINIMAL fix to <TARGET> that turns the failing test PASS. Make the smallest change that resolves the issue without unrelated edits or refactors. Emit <!-- FIXED: <finding-id> --> with the patch (diff or changed lines)."
    },
    {
      "name": "kate",
      "role": "reviewer",
      "prompt": "You are the Stage 2 VERIFIER in a tollgate fix pipeline. Verify Jack's fix: 1) Henry's failing test now PASSES. 2) Full regression suite has no new failures (or no test suite exists). 3) The fix is minimal — no unrelated refactors, no scope creep. 4) Type-safe — no 'as any', no '@ts-ignore', no suppressed errors. Emit PASS / FAIL (with reason) / INVALID (if the fix approach is fundamentally flawed, not merely an implementation slip)."
    },
    {
      "name": "leo",
      "role": "reviewer",
      "prompt": "You are the ESCALATION TARGET and SIGNOFF DECIDER for the fix tollgate. When a verifier emits INVALID (finding ambiguous or fix approach fundamentally flawed), issue a binding ruling on how to proceed. When both gates PASS, provide final signoff. Do NOT participate as a stage member or debater — you only rule on escalations and sign off."
    }
  ]
}
```

**Role 选择**：henry `tester`（写 failing test），iris/kate/leo `reviewer`（验证 + 仲裁），jack `coder`（修复）。每个 stage 的 verifier ≠ producer（iris≠henry，kate≠jack），leo 不参与任何 stage 只做仲裁签字。

### 3.3 Master 启动调用（每条 CONFIRMED 一次）

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "cr-fix",
    "stages": [
      {
        "member": "henry",
        "task": "Write a failing test that reproduces confirmed finding <id>: <一句缺陷描述>. Place it in <TARGET>'s test directory. The test MUST fail on the current (unfixed) code and would pass once the bug is fixed. Do NOT modify production code.",
        "verifier": "iris",
        "criteria": "The test accurately reproduces confirmed finding <id>: it FAILS on the current code for the right reason (the actual bug, not a trivial/syntax failure, not a different bug). The test is focused and would turn PASS once the bug is fixed."
      },
      {
        "member": "jack",
        "task": "Apply the MINIMAL fix to <TARGET> that resolves confirmed finding <id>: <一句缺陷描述>. Make the smallest change that turns Henry's failing test PASS without unrelated edits. Do NOT refactor neighboring code.",
        "verifier": "kate",
        "criteria": "1. Henry's failing test now PASSES. 2. Full regression suite has no new failures (or no test suite exists). 3. The fix is minimal — no unrelated refactors, no scope creep. 4. Type-safe — no 'as any', no '@ts-ignore', no suppressed errors."
      }
    ],
    "escalate_to": "leo",
    "max_gate_retries": 2,
    "max_invalid_cycles": 3,
    "signoff_policy": "decider",
    "signoff_decider": "leo",
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- 每个 CONFIRMED finding 替换 `<id>` 和 `<一句缺陷描述>`（从 §1.5 的 id → 描述映射查出）。
- `max_gate_retries: 2`——每道门最多回退 2 次，避免无限循环。
- `max_invalid_cycles: 3`——INVALID 最多 3 轮后强制升级失败。
- `signoff_policy: decider` + `signoff_decider: leo`——leo 最终签字放行。
- `escalate_to: leo`——两道门的 INVALID 都升级到 leo 裁决。

### 3.4 生命周期步骤（master）

```
team_create(cr-fix)
team_activate(cr-fix)         # （此时 cr-plan 已 deactivate）
for each CONFIRMED finding:   # 逐个串行，N 条 → N 次 run
    team_tollgate(...)         # 用 §3.3 JSON，替换 <id> 和 <一句缺陷描述>
    # 等待 signoff → team_results 取该 run 产出
team_deactivate(cr-fix)
```

### 3.5 产出与交接

- master 抓取每个 run 的 `<!-- FIXED: <id> -->` + 对应补丁。
- **你读取这些补丁与 FIXED marker，自行裁定整次评审的成败。** 场景到此结束。

---

## 端到端时序（master 视角）

```
T+0   team_create(cr-audit) → team_activate → team_parallel
        8 reviewer 并行审计 <TARGET>
T+~12  收 findings → 按严重度裁剪 → team_deactivate(cr-audit)
        若裁剪后 0 条 → 中断，如实汇报
T+~12  team_create(cr-plan) → team_activate → team_consensus(topic=findings)
        4 debater（2 reviewer + 2 architect）辩论真假（≤6 轮）
T+~25  收 confirmed → team_deactivate(cr-plan)
T+~25  team_create(cr-fix) → team_activate
        for each CONFIRMED finding（逐个串行）:
            team_tollgate (henry→iris 写测试门, jack→kate 修复门, leo 签字)
T+~25+N×~10  收 fixed+patches → team_deactivate(cr-fix)
T+~25+N×10   你读取全部输出，裁定结果
```

（时长仅为量级估计；`<TARGET>` 越大、CONFIRMED 越多越久。N = CONFIRMED 条数。）

---

## 快速启动 Prompt（复制即用）

> 把 `<TARGET>` 替换为你要评审的代码路径，整段粘贴给 master 会话。master 会依次跑 3 个团队，每步按 README 的 JSON 配置执行，团队间数据由 master 手递手。

```text
按 docs/scenarios/code-review/README.md 跑一次多团队代码评审，目标代码 = <TARGET>。

执行 3 个团队，每个走「team_create → team_activate → team_<mode> → team_results → team_deactivate」完整生命周期。同一时刻只允许一个 active 团队——切换前必须先 deactivate。

1. audit-team (team_parallel，§1)：按 §1.2 team_create，§1.3 team_parallel。8 名 reviewer 并行审计 <TARGET>。完成后 deactivate。汇总所有 <!-- FINDING: ... --> marker 成 findings 清单，同时维护 id→描述映射。按严重度裁剪：只保留存在的最高严重度等级的全部发现（high>medium>low），更低等级全部丢弃。裁剪后若 0 条则中断流程。

2. plan-team (team_consensus，§2)：按 §2.2 team_create，§2.3 team_consensus（topic = 上一步裁剪后的 findings 清单，max_rounds=6）。4 名 debater（2 reviewer + 2 architect）辩论哪些是真问题、哪些是误报——不讨论修复策略。完成后 deactivate。汇总所有 <!-- CONFIRMED: <id> --> marker 成确认缺陷表。

3. fix-team (team_tollgate，§3)：按 §3.2 team_create（5 人：henry tester / iris reviewer / jack coder / kate reviewer / leo reviewer），§3.3 对每个 CONFIRMED finding 串行启动一次 team_tollgate run（替换 <id> 和缺陷描述）。每次 run 两道门：henry 写 failing test → iris 验证；jack 修复 → kate 验证；leo 仲裁签字。max_gate_retries=2，signoff_policy=decider，signoff_decider=leo。全部 finding 跑完后 deactivate。汇总所有 <!-- FIXED: <id> --> + 补丁。

全部完成后，把每个团队的产出（findings / confirmed / fixed+patches）整理给我，由我裁定结果。不跑评判脚本、不设回归门。

注意：
- 成员名必须取自 32 字预设池（alice/bob/carol/dave/erin/frank/grace/henry/iris/jack/kate/leo/mona/nina/omar/pat/quinn/ruby/sam...），角色必须用 reviewer/architect/coder/tester 等预设值。
- 切换团队前一定先 team_deactivate 当前团队，否则 team_activate 会被拒绝。
- 裁剪规则：只保留最高严重度等级。若 high/medium/low 都有 → 只留 high；若 medium/low 都有 → 只留 medium；若只有 low → 留 low。裁剪后若 0 条则中断。
- fix-team 逐个串行跑 tollgate：每个 CONFIRMED 一次独立 run，复用同一 fix-team。不要批量塞进单次 run。
- 当 team 在运行中时不要频繁轮询 team_progress/team_results，等待 OCTeam 通知完成即可。
```

---

## 相关文档

- [`docs/scenarios/README.md`](../../README.md) — 场景目录总览（单原语 9 模式 + 本综合场景）
- [`docs/scenarios/01-team-parallel/README.md`](../../01-team-parallel/README.md) — parallel 原语参考
- [`docs/scenarios/02-team-consensus/README.md`](../../02-team-consensus/README.md) — consensus 原语参考
- [`docs/scenarios/09-team-tollgate/README.md`](../../09-team-tollgate/README.md) — tollgate 原语参考
- parallel / consensus / tollgate 源码：[`src/orchestration/parallel.ts`](../../../../src/orchestration/parallel.ts) / [`consensus.ts`](../../../../src/orchestration/consensus.ts) / [`tollgate.ts`](../../../../src/orchestration/tollgate.ts)
