# team_workflow 编排场景设计

> **模式**：`team_workflow` — 声明式、确定性步骤引擎。每个 step 可以是 `task`（一个成员产出）、`gate`（验证者对指定前导 task 给出 PASS / FAIL / INVALID 三值判定）、`fanout` 或 `join`。引擎——而非 master LLM——驱动推进、重试、分支汇合、reduce 聚合和恢复；中间结果默认只进入下游成员上下文，不进 master 上下文。
> **源码**：[`src/tools/workflow.ts`](../../../src/tools/workflow.ts) / [`src/orchestration/workflow.ts`](../../../src/orchestration/workflow.ts)
> **控时设计**：4 步链（task → gate → task → gate）、2 成员，每步 3-5 min，串行 ≈ 14-18 min（远低于 30 min 上限）。

## 与 pipeline / tollgate 的区别

| 模式 | 单位 | 控制语义 |
|------|------|---------|
| `team_pipeline` | stage | 线性传递输出，无 per-step 验证门 / 重试 |
| `team_tollgate` | gate（绑定 producer） | 固定的 producer/verifier 门控流水线 |
| `team_workflow` | step（task \| gate 任意交错） | 声明式线性步骤 + 门控重试，engine 驱动每一步 |

`team_workflow` 的价值在于：把"先做两个普通 task，再对第三步 gate，再继续普通 task"这类异构链一次性声明、可重复执行，且所有推进逻辑落在可持久化的 engine 里，而非占用 master 的上下文预算。

**已落地强化项**：内部 `currentStageIndex` 保持 0-based，所有用户可见文本（summary / progress / approval prompt / result ledger）统一 1-based；`RunRecord` 新增 `workflow.steps` 快照，`team_result_get` 可重建完整 step ledger；同一成员跑多个 task step 时，下游/gate 注入的是该 step 自身产出快照，而非成员最新响应；`gate` 支持显式 `target_step` / `targets`；`gate` FAIL retry 记录结构化 `retry` 事件；task/gate 步骤演员缺失 live session 时 run 以 `workflow_failed:no_session:*` 显式终止；`fanout` / `join` 支持 tolerance、all、quorum、any_success、required_branches 和 reduce 汇合策略；workflow step 持久化 `startedAt` / `completedAt` / `durationMs`；task step 支持 `inputs` 显式选择上游和 `expose_output=false` 抑制隐式上游；`dry_run: true` 渲染 1-based step 计划，不启动编排。

### gate 三值语义（PASS / FAIL / INVALID）

| 判定 | engine 行为 | run 结果 |
|------|------------|---------|
| PASS | 标记 gate 完成，推进下一步 | 继续 |
| FAIL + `on_fail="fail"`（默认） | 立即终止 | `workflow_failed:<verifier>` |
| FAIL + `on_fail="retry"` 且 `attempts ≤ max_retries` | 把 `target_step` 指向的 task（连同其与 gate 之间的已完成步骤）重置并重派；`retry` 事件含 display step / attempts / diff | 继续 |
| FAIL + `on_fail="retry"` 且 `attempts > max_retries` | 终止 | `workflow_failed:<verifier>` |
| INVALID 或 verdict 无法解析 | 终止，不重派 producer（producer 中立） | `workflow_invalid:<verifier>` |

### gate `target_step`：验证更早的 task

`gate` 默认验证“最近的前导 task”。若想验证更早或更具体的 task，用 `target_step`（1-based）：

```json
{
  "steps": [
    { "kind": "task", "member": "alice", "task": "draft design" },
    { "kind": "task", "member": "carol", "task": "add tests" },
    { "kind": "gate", "verifier": "bob", "target_step": 1, "criteria": "design covers the API surface", "on_fail": "retry", "max_retries": 1 }
  ]
}
```

约束：`target_step` 必须 < 当前 gate 的序号、必须指向 task 步骤、且 verifier 不能等于该 task 的成员（禁止自验证）。FAIL retry 时会重派该 `target_step`，并把它与 gate 之间的已完成步骤一并重置重跑，保证线性依赖一致。

### Phase 4 强化项（已落地）：step id、on_invalid、graph validator

**step `id`（稳定标识）**：每个 step 可声明可选 `id`。`target_step` 既接受 1-based 数字（旧），也接受字符串 id：

```json
{
  "steps": [
    { "kind": "task", "id": "design", "member": "alice", "task": "draft design" },
    { "kind": "task", "member": "carol", "task": "add tests" },
    { "kind": "gate", "verifier": "bob", "target_step": "design", "criteria": "design covers the API surface" }
  ]
}
```

id 在整条 workflow 内必须唯一（否则 `dry_run`/启动校验报 `duplicate step id`）。summary / progress / approval prompt / result ledger 在有 id 时显示 `step N (id)`，便于在多 task 链里稳定引用。内部仍用 0-based `targetStepIndex`，id 在 build 时一次性解析成索引。

**gate `on_invalid`（INVALID 策略）**：Phase 3 里 INVALID 一律 producer-neutral 终止。Phase 4 给 gate 加可选 `on_invalid`：

| `on_invalid` | 行为 | run 结果 |
|---|---|---|
| `fail`（默认） | 终止，不重派 producer | `workflow_invalid:<reason>:<verifier>` |
| `retry_verifier` | 重派**本 gate 的 verifier**（带"无法评估"提示），`max_invalid_retries` 次；耗尽后终止 | 继续到 verifier PASS/FAIL/INVALID 为止；耗尽 → `workflow_invalid` |
| `escalate` | **无视全局 `human_approval`**，强制 HITL 暂停；`team_approve` = 人工放行（gate 标记完成，推进下一步）；`team_reject` = 终止 | approve → 继续；reject → `workflow_human_rejected` |

注意：所有 `on_invalid` 策略都**不重派 producer**——INVALID 表示 verifier 无法评估，不是 producer 的错。`retry_verifier` 要求显式 `max_invalid_retries`（与 `on_fail="retry"` 要求 `max_retries` 对称），避免无限重试。`escalate` 不需要 `human_approval=true`；它是 gate 级强制暂停。

**graph validator**：启动前（含 `dry_run`）统一做线性图校验，任一失败返回 `Error: ...` 且不创建 `activeTask`：

- 首步必须是 task（gate 无前导 task 可验证）
- step `id` 全局唯一
- gate `target_step`（数字或 id）必须解析为**当前 gate 之前的 task** 步骤
- verifier ≠ 目标 task 成员（禁止自验证）
- task 步骤不得带 gate 字段，gate 步骤不得带 task 字段
- `on_fail="retry"` 必须带 `max_retries`；`on_invalid="retry_verifier"` 必须带 `max_invalid_retries`
- verifier / member 必须是团队成员

这些检查集中在新 `validateWorkflowGraph`，`team_workflow` 的 `dry_run` 和真实启动共用同一份校验，保证预演和执行一致。

### fanout / join 与数据流控制

`fanout` 必须紧跟一个 `join` marker。join 会先等待所有分支进入 terminal 状态（completed / skipped / errored），再应用策略判断是否继续。默认 join 使用 `max_errored` 容忍度；也可以声明 `join_policy` 为 `all`、`quorum`、`any_success`、`required_branches` 或 `reduce`。`join_policy="reduce"` 要求设置 `reducer_member`：所有分支成功后，engine 会先把分支产出派发给 reducer，由 reducer 输出单一 `joinedOutput`，再继续下游步骤。

task step 默认接收之前已完成且可见的上游 task/join 产出。若只想传入指定上游，使用 `inputs`（1-based step 编号或 step id）；若某个 task 的产出不应进入后续隐式上游，设置 `expose_output: false`。显式 `inputs` 仍可引用该产出，适合“默认隐藏，但允许指定消费者读取”的场景。

## 场景一览

| # | 方向 | 场景 | 成员数 | 成员角色 | step 序列 | 预计总时长 |
|---|------|------|--------|---------|-----------|-----------|
| 1 | 编程 | REST API handler 实现 + 验证 + 重构 + 再验证 | 2 | `coder` / `tester` | task → gate → task → gate | ~16 min |

> `team_workflow` 的步骤序列由使用者声明，不绑特定靶子、不含机器评判脚本——结果由使用者自判（与综合场景一致）。

---

## 场景 1: REST API handler 实现 + 验证 + 重构

### 1.1 场景描述

**背景**：实现一个处理用户注册的 REST handler：参数校验、错误返回、成功路径。先写实现，再独立验证（边界 + 错误处理），验证通过后做一次重构（提取校验函数、改善可读性），重构后再用同一 gate 验证行为不变——保证重构没引入回归。

**目标**：用一条 `team_workflow` 串起四个异构步骤——`coder` 实现 → `tester` gate 验证 → `coder` 重构 → `tester` gate 再验证——由 engine 确定性推进，master 只在结尾收到汇总。

**成功标准（人工自判）**：
- step 1（task）：`coder` 产出可加载的 handler 代码块
- step 2（gate）：`tester` 对 step 1 产出给出 `<verdict>{"result":"PASS",...}</verdict>`
- step 3（task）：`coder` 基于上游（step 1 产出）做重构，行为不变、可读性提升
- step 4（gate）：`tester` 对 step 3 重构产出再次验证行为不变，给出 `<verdict>{"result":"PASS",...}</verdict>`
- 最终 `workflow_complete`，master 收到含四步账本 + 各 task 产出的汇总

### 1.2 Team 配置

```json
{
  "name": "register-handler-flow",
  "description": "Linear workflow: implement register handler, gate-verify, then refactor — engine-driven, no master context bloat"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement and refactor TypeScript with minimal, correct code. When asked to produce code, embed the full TypeScript in a single ```typescript fenced block."
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You are a tester. You verify implementations by checking them against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case if FAIL, else empty>\"}</verdict>."
    }
  ]
}
```

**Role 选择理由**：两个 task 步骤用同一个 `coder`（alice）保证实现→重构的连续性；gate 用独立的 `tester`（bob，只读 agent）做裁判，避免自验证（schema 硬约束：gate 的 verifier 必须不同于前一个 task 的成员）。

### 1.3 Master 启动调用

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "register-handler-flow",
    "steps": [
      {
        "kind": "task",
        "member": "alice",
        "task": "Implement a TypeScript function `handleRegister(body: { email: string; password: string })` that returns `{ status: 400, error: string }` on invalid input (empty email, password < 8 chars) and `{ status: 200, user: { email } }` on success. Embed the code in a fenced ```typescript block."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Verify handleRegister rejects empty email with 400, rejects password shorter than 8 chars with 400, and returns 200 with the email on valid input. Emit PASS only if all three hold; FAIL naming the failing case.",
        "on_fail": "retry",
        "max_retries": 1
      },
      {
        "kind": "task",
        "member": "alice",
        "task": "Refactor the upstream handleRegister implementation: extract the validation into a `validate(body)` function and keep behavior identical. Embed the refactored code in a fenced ```typescript block."
      },
      {
        "kind": "gate",
        "verifier": "bob",
        "criteria": "Re-verify the REFACTORED handleRegister against the SAME three cases (empty email -> 400, password < 8 -> 400, valid input -> 200). The refactor must not change behavior. Emit PASS only if all three still hold AND a validate() function was extracted; FAIL naming any regression or missing extraction.",
        "on_fail": "retry",
        "max_retries": 1
      }
    ],
    "timeout_ms": 1200000
  }
}
```

**参数选择**：
- step 1 是 `task`（验证硬约束：首步必须是 task，gate 必须验证前导 task）
- step 2 的 `verifier: "bob"` ≠ step 1 的 `member: "alice"` —— 满足「禁止自验证」
- step 2 `on_fail: "retry"` + `max_retries: 1` —— gate FAIL 时把 alice 连同 diff 重派一次（首次实现易漏边界），第二次 FAIL 则整条 run 失败（`workflow_failed`）
- step 3 是 `task`，engine 自动注入 step 1 的产出作为上游上下文（gate 步骤的判定不计入上游）
- step 4 是 `gate`，验证 step 3 的重构产出——`verifier: "bob"` ≠ step 3 的 `member: "alice"`，同样满足「禁止自验证」；criteria 复用 step 2 的三用例 + 额外要求提取了 `validate()`，确保重构无回归
- step 4 `on_fail: "retry"` + `max_retries: 1` —— 重构也可能引入回归，给 alice 一次修正机会
> 注：step 4 默认验证“最近前导 task”（即 step 3）。如需让 step 4 复用 step 2 已确认的同一组用例但显式验证 step 1 的实现，可加 `target_step: 1`；本场景保持默认以演示最近前导语义。
- `timeout_ms: 1200000`（20 min）—— 串行四步，正常 16 min 完成，留余量

### 1.4 执行流程（时序）

```
T+0m     master 调用 team_workflow
T+0m     engine dispatch step 1 (alice, task): 实现 handleRegister
T+0~5m   alice 产出 handler 代码 → idle
T+5m     engine 推进到 step 2 (gate): dispatch bob，喂入 step 1 产出 + criteria
T+5~8m   bob 判定 → <verdict>
         PASS  -> engine 推进到 step 3
         FAIL  -> 重派 alice（带 diff），attempts++；再走一次 gate；第二次 FAIL -> workflow_failed
T+8m     engine dispatch step 3 (alice, task): 重构，注入 step 1 产出作上游
T+8~12m  alice 产出重构代码 → idle
T+12m    engine 推进到 step 4 (gate): dispatch bob，喂入 step 3 重构产出 + criteria
T+12~16m bob 再判定 → <verdict>
         PASS  -> 所有步骤完成 -> workflow_complete
         FAIL  -> 重派 alice（带 diff），attempts++；再走一次 gate；第二次 FAIL -> workflow_failed
T+16m    workflow_complete，汇总交付 master（含四步账本 + task 产出）
```

> 期间任意 task/gate 演员缺失 live session（session 未创建或成员已 errored），engine 立即终止为 `workflow_failed:no_session:<member>`，并把 `workflow.steps` 快照写入 `RunRecord`（每步 kind / member / verifier / targetStep / verdict / attempts / completed / output / outputBytes）。`team_result_get` 读取该 run 时会渲染 `### workflow steps` 分组，按 Step N 展示账本 + 各 task 产出快照。

### 1.5 可选：人工审批（HITL）

在 `team_workflow` 加 `"human_approval": true`，engine 会在每个非终步完成（task 完成、gate PASS）后、推进下一步前暂停，等待 `team_approve` / `team_reject`：

- `team_approve(team_id, approval_id)` —— 继续下一步
- `team_reject(team_id, approval_id, feedback)` —— 整条 run 失败（`workflow_human_rejected`）

挂钟在暂停期间不计入超时（与其它编排的 HITL 一致）。approval prompt 会显示 `workflow_step (step N)`（1-based）并附上当前完成步骤的 kind / actor / verdict rationale 与下一步摘要，便于 master 直接判断。

### 1.6 可选：dry_run 预演

启动前加 `dry_run: true`，`team_workflow` 只渲染 1-based step 计划，不创建 `activeTask`、不派发成员：

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "register-handler-flow",
    "dry_run": true,
    "steps": [ /* 同 1.3 */ ]
  }
}
```

输出形如：
```
Workflow dry run for "register-handler-flow" (4 step(s)):
1. [task] alice: Implement ...
2. [gate] bob verifies step 1: Verify handleRegister ...; on_fail=retry max_retries=1
3. [task] alice: Refactor ...
4. [gate] bob verifies step 3: Re-verify ...; on_fail=retry max_retries=1
```

校验失败（如 `on_fail="retry"` 缺 `max_retries`、task/gate 跨字段、`target_step` 指向 gate）也会在此阶段报错，避免半启动的 run。

### 1.7 可选：workflow_file 模板

复杂 workflow 可以放进仓库内的 JSON 文件，再用 `vars` 进行模板替换。文件必须是相对工作区路径并以 `.json` 结尾；推荐设置 `version: 1` 和 `strict_vars: true`，让变量拼写错误在启动前失败。

本目录提供了可直接预演或启动的模板：[`register-handler.workflow.json`](./register-handler.workflow.json)。启动方式：

```json
{
  "tool": "team_workflow",
  "args": {
    "team_id": "register-handler-flow",
    "workflow_file": "docs/scenarios/10-team-workflow/register-handler.workflow.json",
    "vars": {
      "handler": "handleRegister",
      "resource": "register handler"
    }
  }
}
```

先加 `dry_run: true` 可以查看变量替换后的 step ledger，确认成员、gate、join policy 和数据流都符合预期，再启动真实编排。

## 恢复与检查点粒度

`team_workflow` 的状态完全保存在 `activeTask`（`steps[]` + `currentStageIndex` 游标）中，因此复用现有的 `team_resume`：进程崩溃后，`team_resume` 会重新驱动当前步骤（若当前步演员已有产出则直接处理，否则重新派发），或若全部步骤已完成则直接交付。

**已知限制**（与所有编排一致）：检查点粒度是整条 task，恢复时从**当前步骤**重新开始，而非步骤内部的子进度。恢复覆盖分支（captured task 重放 / no captured response 重派 / all-complete 直接交付 / captured gate verdict 重放）见 `tests/resume-dispatch-branches.test.ts`。


## 快速启动 Prompt（复制即用）

> 将以下 prompt 粘贴给 master 会话，AI 会自动完成「创建团队 → 激活 → 启动编排 → 等待汇总」的完整闭环。workflow 模式无机器评判脚本（步骤序列由使用者声明、不绑特定靶子），结果由使用者自判——打开 `<run_dir>` 核对四步账本 + 各 task 产出。

### 场景 1: REST API handler 实现 + 验证 + 重构

```text
执行 docs/scenarios/10-team-workflow/README.md「场景 1」的完整闭环。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（2 名成员：alice=coder、bob=tester）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_workflow JSON 启动编排（4 步链：task(implement) → gate(verify) → task(refactor) → gate(re-verify)）
4. team_results 轮询至 master 收到汇总（engine 驱动每步推进：alice 实现 → bob gate 判定 → PASS 则 alice 重构 → bob 再 gate 判定；任一 gate FAIL 且 attempts ≤ max_retries=1 则重派对应 task，第二次 FAIL 整条 run 失败）
5. 定位 <run_dir>（含 alice 与 bob 的 .md）
6. 人工核对（无 check 脚本）：
   - alice 的 .md 含可加载的 handleRegister 实现（step 1）+ 重构后的版本（step 3，提取了 validate 函数、行为不变）
   - bob 的 .md 含两个 <verdict>{"result":"PASS",...}</verdict>（step 2 验证原实现 + step 4 再验证重构产出）
   - master 汇总含「workflow_complete」+ 四步账本（[task] alice (done) / [gate] bob verifies nearest task -> PASS / [task] alice (done) / [gate] bob verifies nearest task -> PASS）

成功标准（人工自判）：handleRegister 三路径正确（空 email→400、password<8→400、合法输入→200）；两道 gate 均 PASS；重构后行为不变且提取了 validate 函数。
```
