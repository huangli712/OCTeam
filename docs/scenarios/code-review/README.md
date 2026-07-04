# 综合场景：OCTeam 多团队代码评审

3 阶段代码评审链（**审计 → 确认缺陷 → 修复**），由 3 个独立团队 × 3 种编排原语串联完成。audit 一次性审计；triage 与 fix 按 **5 条一组**循环（每组先 triage 辩论、再 fix 逐个修复），直至 findings 处理完。master 作集成枢纽，团队间彼此隔离、数据手递手。

**自用模板**：不绑定特定靶子，不含评判脚本。把 `<TARGET>` 替换为你要评审的代码（文件 / 模块 / 目录），按文末 quick-start prompt 跑通；发现的真假与修复的正确性**由你自行判断**。

## 工作流总览

| 阶段 | 团队 | 编排原语 | 输入 | 产出（交接 marker） |
|------|------|---------|------|---------------------|
| ① 审计（一次） | **audit-team** | `team_parallel` | `<TARGET>` 源码 | `<!-- FINDING: <id>:<dim>:<severity> -->` |
| ② 确认缺陷（每组一次，≤5 条） | **triage-team** | `team_arbitrate` | 当前组的 findings | `<!-- CONFIRMED: <id> -->` |
| ③ 修复（逐个门控，本组 CONFIRMED 串行） | **fix-team** | `team_tollgate` | 本组每个 CONFIRMED 一条流水线 | `<!-- FIXED: <id> -->` + 补丁 |

②③ 按 5 条一组循环 G=⌈N/5⌉ 次（末组可不足 5）。audit 去重合并后**不按 severity 裁剪**，high/medium/low 全保留。

用到 3 种编排：**parallel / consensus / tollgate**。tollgate 的每道 stage 有独立 verifier（两道门用不同 verifier），FAIL 回退 producer，INVALID 升级到 arbiter，最终由 signoff decider 签字。

```
<TARGET> ──► audit-team (parallel)  ──findings──► master
                                                     │ 去重合并 + 分组（每组 5，末组可不足 5）
                                                     ▼
                           ┌─── loop G 组 ────────────────────────┐
                           │                                      │
                           │  triage-team (arbitrate)             │
                           │    ◄── 当前组 findings (≤5) ──       │
                           │    └── confirmed (本组) ──► master   │
                           │                                      │
                           │  fix-team (tollgate)                 │
                           │    ◄── confirmed (本组) ──           │
                           │    └── fixed+patches ──► master      │
                           └──────────────────────────────────────┘
                                                     │ 全部组完成
                                                     ▼
                                              master ──► 你判断
```

## 如何使用

1. **确定 `<TARGET>`**：你要评审的代码路径（单文件 / 目录 / 模块名）。
2. **依次跑 3 个团队**（§1–§3）。每个团队走完整生命周期：`team_create` → `team_activate` → `team_<mode>` → 收产出 → `team_deactivate`。
3. **交接**：audit 的 findings 由 master 去重合并后**分 5 条一组**（不裁剪 severity）；每组 findings → 当前组 arbitrate 的 topic；本组 confirmed → 当前组逐个 tollgate run 的 task。组间 triage→fix 交替循环。
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
    "reducer_member": "pat",
    "timeout_ms": 1800000
  }
}
```

**参数选择**：
- `mode: isolated` + 维度烤进成员 prompt——8 路并行各自扫一个维度，互不重叠。
- `reduce_policy: merge` + `reducer_member: pat`——8 路产出**合并**成一份（保留全部维度发现，不摘要/挑选），让 triage-team 拿到完整 findings 清单。reducer 必须是 team 成员之一（工具从 `team.members.find()` 查找）；选 pat 是因 maintainability 维度天然贴合"汇总全局发现"的视角，且 reduce 阶段 prompt 固定为机械合并（不与其审计维度 prompt 冲突）。
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
- **去重合并（不按严重度裁剪）**：按 id 去重，同 id 的多维发现合并为一条；**保留全部等级**（high / medium / low 均保留），不丢弃任何低等级发现。severity 仅作为 triage debater 的上下文信息，不用于过滤。
- 去重后若 **0 条 findings**（没有任何维度的任何发现），master 如实汇报并**中断流程**。
- **分组（每组 5 条）**：把去重后的清单按合并顺序切成若干组，每组 5 条，最后一组可能不足 5 条。组数 G = ⌈总条数 / 5⌉。
- 这些组**严格串行**进入 §2 → §3 的循环：每组先 triage 讨论，再 fix 修复；**必须等本组 triage→fix 全部跑完，才进入下一组**——组间**不并行**多组，不交叉。组内顺序与组间顺序均按合并顺序，**不按 severity 重排**。

---

## §2 triage-team（`team_arbitrate`）— 确认缺陷（真假辩论）

### 2.1 阶段说明

> triage-team 在 §1.5 分组循环中**每组运行一次** `team_arbitrate`：每次只辩论当前组的 findings（≤5 条），不混组、不跨组累积。

6 名 debater（2 reviewer + 2 architect + 1 coder + 1 explorer）多轮辩论**当前组的 findings**：**哪些是真问题、哪些是误报**。**本阶段不讨论修复策略**——修复方案交给 §3 fix-team 的 coder 自行决定。辩论结束后，1 名 `almighty` 仲裁（sam）权衡各方立场下达**有约束力裁决**——**只确认 debater 达成共识的发现**（仍有分歧的默认丢弃）。

### 2.2 Team 配置

```json
{
  "name": "cr-triage",
  "description": "Code review triage team: 6 debaters (2 reviewers + 2 architects + 1 coder + 1 explorer) + 1 almighty arbiter triage audit findings via arbitrate — debate real-vs-false-positive, arbiter confirms only consensus findings; NOT fix strategies",
  "members": [
    {
      "name": "erin",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues (not false positives). For each finding argue ONLY: is it a genuine issue? does the code actually exhibit the described problem? Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues (not false positives). For each finding argue ONLY: is it a genuine issue? does the code actually exhibit the described problem? Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "grace",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL. Weigh whether the described problem genuinely violates design invariants or contracts. Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "quinn",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL. Weigh whether the described problem genuinely violates design invariants, contracts, or long-term correctness. Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "mona",
      "role": "coder",
      "prompt": "You are a CODER debating which audit findings are REAL. Approach each finding SKEPTICALLY from an implementer's perspective: by default suspect it is a false positive — ask whether real-world code paths actually trigger the described behavior, whether existing guards or context already cover it, whether the described impact is genuinely reachable. Only concede a finding is real if presented with concrete evidence (a triggering call path, a missing guard, a demonstrated failure). Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "ruby",
      "role": "explorer",
      "prompt": "You are an EXPLORER debating which audit findings are REAL. Approach each finding SKEPTICALLY from a codebase-traversal perspective: by default suspect it is a false positive — trace whether the flagged code is actually reachable in real execution, whether callers or upstream already validate the input, whether the described race or error window can actually open. Only concede a finding is real if presented with concrete evidence (a live call path reaching the code, an unguarded entry point, a demonstrated trigger). Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "sam",
      "role": "almighty",
      "prompt": "You are the ARBITER (almighty). Six debaters (2 reviewers, 2 architects, 1 coder, 1 explorer) debated which audit findings are REAL, actionable issues. Weigh all positions impartially across the rounds. Apply this BINDING rule: confirm a finding ONLY IF the debaters reached consensus that it is real — i.e. no substantive dissent remained, or any initial skepticism was withdrawn when confronted with concrete evidence (a triggering call path, a missing guard, a demonstrated failure). Findings with unresolved disagreement are rejected as unconfirmed. Do NOT discuss fix strategies — that is delegated to the fix team. In your FINAL ruling, emit one line per confirmed finding exactly formatted: <!-- CONFIRMED: <finding-id> --> (rejected findings are simply omitted), then emit exactly one line formatted: <ruling>{\"decision\":\"<comma-separated confirmed ids, or none>\",\"rationale\":\"<which findings reached consensus and which did not, and why>\"}</ruling>."
    }
  ]
}
```

**Role 选择**：erin/frank 用 `reviewer`（只读深审），grace/quinn 用 `architect`（架构视角判断是否真违反不变量/契约）。mona 用 `coder`（实现者视角，默认质疑可触发性）、ruby 用 `explorer`（代码库可达性视角，默认质疑路径可达），两人倾向唱反调——除非被具体证据（触发调用链、缺失防护、可演示失败）说服，否则倾向于判为误报。sam 用 `almighty`（仲裁，非辩手、非 master）——辩论结束后权衡 6 方立场，按「只确认共识发现」的约束力规则下达裁决。辩论焦点统一收敛到"真假"，策略留给后续。

### 2.3 Master 启动调用

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "cr-triage",
    "task": "<把当前组的 findings（≤5 条）原文粘进来：每条 FINDING id/dim/severity/描述>",
    "arbiter": "sam",
    "debaters": ["erin", "frank", "grace", "quinn", "mona", "ruby"],
    "max_rounds": 6,
    "timeout_ms": 2400000
  }
}
```

**参数选择**：
- `task` = **当前组**的 findings（master 从 §1.5 分组中取出本组 ≤5 条手递手填入）；arbitrate 的 `task` 即争议主题。
- `arbiter: "sam"`（role=`almighty`）——非 debater、非 master；权衡 6 名 debater 立场后下达有约束力裁决。
- `debaters`——6 名辩手（erin/frank/grace/quinn/mona/ruby），≥2 且唯一，均不得为 arbiter。
- `max_rounds: 6`——给足辩论空间，应对大量 findings 时有回旋余量。
- 不设 `signoff_policy`——arbiter 的裁决本身即为终点（等价 `none` 门）。

### 2.4 生命周期步骤（master）

triage-team 在循环中每组复用，定义一次、按组激活（同组的 fix-team 紧随其后，见 §3.4）：

```
team_create(cr-triage)         # 循环外定义一次
# （cr-audit 已 deactivate；cr-fix 可先定义或待第一次 §3.4 再建）

for each group g in 1..G:        # §1.5 分组循环
    team_activate(cr-triage)     # 激活（确认当前无其它 active 团队）
    team_arbitrate(...)          # task = 第 g 组 findings（≤5 条），arbiter=sam
    # 等待 arbiter 裁决 → team_results 取本组 confirmed
    team_deactivate(cr-triage)   # 为同组的 fix-team 让路
    # → 接 §3.4：activate(cr-fix) 跑本组 confirmed 的 tollgate
```

### 2.5 产出与交接（当前组）

- master 从**本组** arbiter 裁决输出抓取所有 `<!-- CONFIRMED: <id> -->`，去重成**本组确认缺陷表**。
- 对每个 CONFIRMED id，从 §1.5 维护的 id → 描述映射查出缺陷描述，组装 §3 每次 tollgate run 的 task。
- 本组确认缺陷表立即交给 §3 fix-team（在 deactivate triage-team 后 activate fix-team）；**不等其他组**，组内串行修复完才进入下一组的 triage。

---

## §3 fix-team（`team_tollgate`）— 修复（逐个门控，TDD 顺序）

### 3.1 阶段说明

> fix-team 在 §1.5 分组循环中**每组**（triage 完成后）激活一次：对本组 CONFIRMED 的每条 finding 逐个跑 tollgate run，跑完 deactivate，进入下一组。

5 名成员采用 TDD 门控流水线，**逐个**修复**本组** confirmed finding。master 为本组每条 CONFIRMED **串行启动一次独立的 tollgate run**（本组 N 条 → N 次 run，复用同一 fix-team）。每次 run 走两道门：

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

fix-team 在循环中每组复用，定义一次、按组激活（紧跟同组 triage 之后）：

```
team_create(cr-fix)            # 循环外定义一次
for each group g in 1..G:       # §1.5 分组循环（triage 已为该组跑完）
    team_activate(cr-fix)        # （此时 cr-triage 已 deactivate）
    for each CONFIRMED in group g:   # 逐个串行，本组 N 条 → N 次 run
        team_tollgate(...)        # 用 §3.3 JSON，替换 <id> 和 <一句缺陷描述>
        # 等待 signoff → team_results 取该 run 产出
    team_deactivate(cr-fix)      # 为下一组的 triage 让路
```

### 3.5 产出与交接（当前组）

- master 抓取**本组**每个 run 的 `<!-- FIXED: <id> -->` + 对应补丁。
- 本组修复完后回到 §2 处理下一组，直至 G 组全部完成。
- **全部组处理完毕后，你读取所有补丁与 FIXED marker，自行裁定整次评审的成败。** 场景到此结束。

---

## 端到端时序（master 视角）

```
T+0   team_create(cr-audit) → team_activate → team_parallel
        8 reviewer 并行审计 <TARGET>
T+~12  收 findings → 去重合并（不裁剪）→ 分组（每组 5 条，末组可不足 5）
        → team_deactivate(cr-audit)
        若去重后 0 条 → 中断，如实汇报
        组数 G = ⌈总条数 / 5⌉

team_create(cr-triage)   # 循环外定义一次
team_create(cr-fix)      # 循环外定义一次

for g in 1..G:                          # 分组循环：每组 triage → fix
    team_activate(cr-triage)              # （另一团队已 deactivate）
    team_arbitrate(task = 第 g 组 findings，arbiter=sam，≤6 轮)
        6 debater 辩论本组真假 → arbiter(sam) 只确认共识发现
    team_deactivate(cr-triage)

    team_activate(cr-fix)                 # （cr-triage 已 deactivate）
    for each CONFIRMED in group g（逐个串行）:
        team_tollgate (henry→iris 写测试门, jack→kate 修复门, leo 签字)
    team_deactivate(cr-fix)

收全部 fixed+patches → 你读取全部输出，裁定结果
```

（时长仅为量级估计；`<TARGET>` 越大、组数 G 越多、每组 CONFIRMED 越多越久。N = 全部 CONFIRMED 总条数。）

---

## 快速启动 Prompt（复制即用）

> 把 `<TARGET>` 替换为你要评审的代码路径，整段粘贴给 master 会话。master 会依次跑 3 个团队，每步按 README 的 JSON 配置执行，团队间数据由 master 手递手。

```text
按 docs/scenarios/code-review/README.md 跑一次多团队代码评审，目标代码 = <TARGET>。

执行 3 个团队，每个走「team_create → team_activate → team_<mode> → team_results → team_deactivate」完整生命周期。同一时刻只允许一个 active 团队——切换前必须先 deactivate。

1. audit-team (team_parallel，§1)：按 §1.2 team_create，§1.3 team_parallel。8 名 reviewer 并行审计 <TARGET>。完成后 deactivate。汇总所有 <!-- FINDING: ... --> marker 成 findings 清单，同时维护 id→描述映射。**只去重合并，不按 severity 裁剪**（high/medium/low 全保留）。去重后若 0 条则中断流程。然后**分组：每组 5 条，末组可不足 5 条**，组数 G = ⌈总条数/5⌉。

2. triage-team (team_arbitrate，§2) + fix-team (team_tollgate，§3) 交替循环 G 组：
   循环前：team_create(cr-triage)、team_create(cr-fix) 各一次。
   for g in 1..G:
     - activate cr-triage → team_arbitrate（task = 第 g 组 findings（≤5 条），arbiter=sam，max_rounds=6）。6 名 debater 辩论本组哪些是真问题、哪些是误报——不讨论修复策略；arbiter 只确认达成共识的发现。deactivate cr-triage。汇总本组 <!-- CONFIRMED: <id> -->。
     - activate cr-fix → 对本组每个 CONFIRMED finding 串行启动一次 team_tollgate run（替换 <id> 和缺陷描述）。每次 run 两道门：henry 写 failing test → iris 验证；jack 修复 → kate 验证；leo 仲裁签字。max_gate_retries=2，signoff_policy=decider，signoff_decider=leo。本组跑完 deactivate cr-fix。

3. 全部 G 组处理完毕后，把每个团队的产出（findings / confirmed / fixed+patches）整理给我，由我裁定结果。不跑评判脚本、不设回归门。

注意：
- 成员名必须取自 32 字预设池（alice/bob/carol/dave/erin/frank/grace/henry/iris/jack/kate/leo/mona/nina/omar/pat/quinn/ruby/sam...），角色必须用 reviewer/architect/coder/tester 等预设值。
- 切换团队前一定先 team_deactivate 当前团队，否则 team_activate 会被拒绝。
- **不按 severity 裁剪**：去重后 high/medium/low 全保留，每组 5 条（末组可不足 5），组与组之间 triage→fix 交替循环。
- **组间严格串行不并行**：一组 triage→fix 全部跑完才进入下一组。严禁同时跑多组的 triage、或多组的 fix、或一组的 triage 与另一组的 fix 交叉。
- fix-team 逐个串行跑 tollgate：每个 CONFIRMED 一次独立 run，复用同一 fix-team。不要批量塞进单次 run。
- 当 team 在运行中时，轮询 team_progress/team_results 的间隔为 30 秒，不要更频繁。
```

---

## 相关文档

- [`docs/scenarios/README.md`](../../README.md) — 场景目录总览（单原语 9 模式 + 本综合场景）
- [`docs/scenarios/01-team-parallel/README.md`](../../01-team-parallel/README.md) — parallel 原语参考
- [`docs/scenarios/07-team-arbitrate/README.md`](../../07-team-arbitrate/README.md) — arbitrate 原语参考
- [`docs/scenarios/09-team-tollgate/README.md`](../../09-team-tollgate/README.md) — tollgate 原语参考
- parallel / arbitrate / tollgate 源码：[`src/orchestration/parallel.ts`](../../../../src/orchestration/parallel.ts) / [`arbitrate.ts`](../../../../src/orchestration/arbitrate.ts) / [`tollgate.ts`](../../../../src/orchestration/tollgate.ts)
