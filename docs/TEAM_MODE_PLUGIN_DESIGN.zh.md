# OCTeam — OpenCode 多 Agent 编排 Plugin

## 概述

一个为 OpenCode 实现确定性多 Agent 编排的 plugin。允许用户创建 agent 团队，使 agent 之间能够通信、协作，并以 **parallel**（并行）、**pipeline**（流水线）或 **loop**（循环）模式执行任务——这些协调模式是参考实现（`oh-my-openagent` 的 team mode，仿照 Claude Code Agent Teams 设计）所不提供的。

### 设计原则

**完全作为 OpenCode plugin 构建——对 OpenCode 核心零改动。** plugin 利用公开的 Plugin API（`@opencode-ai/plugin`）和 SDK（`@opencode-ai/sdk`）来编排 agent session。每个 agent 是一个常规的 OpenCode session，通过 `parentID` 关联回 leader。

### 与 `oh-my-openagent` Team Mode 的差异

| 方面 | `oh-my-openagent`（参考实现） | OCTeam（本设计） |
|---|---|---|
| 协调模型 | 委派 + 认领（pull-based tasklist） | 确定性 push-based 调度 |
| 编排模式 | 无（通过 leader prompt 涌现） | `team_pipeline`、`team_loop`、`team_parallel` |
| 通信 | 文件 mailbox + Transform hook 注入 | **相同**（从参考实现采纳） |
| 持久化 | 文件系统 JSON + 文件锁 | **相同**（从参考实现采纳） |
| 资源边界 | 5 种 bound 类型 | **相同**（从参考实现采纳） |
| 关闭协议 | 协作式（request/approve/reject） | **相同**（从参考实现采纳） |
| Worktree 隔离 | 每 member 一个 git worktree | **相同**（从参考实现采纳） |

OCTeam 采纳了参考实现的全部健壮性基础设施，并在此之上增加了**确定性编排语义**。

### 开发阶段

本插件分两个阶段开发：

- **Phase 1（Session Navigator）**：在 sidebar 中显示当前 session 的所有 child session（subagent/background task），点击切换查看。这是 Team sidebar 的前置基础设施。独立设计文档见 [Session Navigator 设计](./SESSION_NAVIGATOR_DESIGN.zh.md)。
- **Phase 2（Team 编排）**：在 Phase 1 基础上增加 team 编排功能（parallel/pipeline/loop + slash commands + mailbox + persistence）。即本文档的主体内容。

---

## 1. 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Plugin（两个 Module）                                          │
│                                                                 │
│  ┌─── server module ────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │  │
│  │  │ Tool Handler│  │ Event Handler│  │ Transform Hook │  │  │
│  │  │ (12 tools)  │  │ (session.    │  │ (messages.     │  │  │
│  │  │             │  │  idle)       │  │  transform)    │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │  │
│  │         │                │                  │           │  │
│  │         └────────┬───────┴──────────────────┘           │  │
│  │                  ▼                                       │  │
│  │  ┌──────────────────────────────────────────────────┐   │  │
│  │  │     Team Orchestrator（带锁状态机）              │   │  │
│  │  │  ┌─────────────┐  ┌───────────┐  ┌────────────┐  │   │  │
│  │  │  │ File State  │  │ Per-Team  │  │ Mailbox    │  │   │  │
│  │  │  │ Store       │  │ Mutex     │  │ Manager    │  │   │  │
│  │  │  │ (JSON+lock) │  │           │  │ (3-layer)  │  │   │  │
│  │  │  └─────────────┘  └───────────┘  └────────────┘  │   │  │
│  │  └──────────────────────┬───────────────────────────┘   │  │
│  │                         │                               │  │
│  │                  ┌──────▼──────┐                        │  │
│  │                  │ SDK Client  │                        │  │
│  │                  └──────┬──────┘                        │  │
│  └─────────────────────────┼───────────────────────────────┘  │
│                            │                                   │
│  ┌─── tui module ─────┐    │                                  │
│  │  sidebar_content   │    │                                  │
│  │  command.register  │    │                                  │
│  │  ui.dialog.replace │    │                                  │
│  └────────────────────┘    │                                  │
└────────────────────────────┼──────────────────────────────────┘
                             │ HTTP → OpenCode Server
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  OpenCode Server                                              │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Session A│  │ Session B│  │ Session C│  │ Session D│     │
│  │ (master) │  │ (coder)  │  │ (tester) │  │ (decider)│     │
│  │ parentID │  │ parentID │  │ parentID │  │ parentID │     │
│  │ = null   │  │ = A.id   │  │ = A.id   │  │ = A.id   │     │
│  │ cwd      │  │ cwd      │  │ cwd      │  │ cwd      │     │
│  │ = shared │  │ = shared │  │ = shared │  │ = shared │     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
│                                                               │
│  + 每 member 的文件 mailbox 位于 ~/.octeam/teams/{name}/     │
└───────────────────────────────────────────────────────────────┘
```

### 关键设计决策

1. **双 plugin module**：OpenCode 强制 `server` 和 `tui` hook 在单个 `PluginModule` 中互斥。OCTeam 导出两个 module：`server`（tools、events、transform hooks）和 `tui`（sidebar、commands、dialogs）。通过 `package.json` 中的 `"oc-plugin": ["server", "tui"]` 声明。

2. **闭包式 context**：`server()` 函数将 SDK `client`、config 和存储目录捕获到 `PluginContext` 对象中。所有 tool handler、event handler 和 transform hook 共享此 context。

3. **Poll-and-resume 执行**：OpenCode 的 session loop 在 LLM 发出 stop signal 时退出。plugin 检测 `session.idle` 事件，当 agent 有待处理工作（下一 pipeline stage、新 round、或未读消息）时通过 `promptAsync` 恢复 agent。此机制已被参考实现验证。

4. **三层通信**：消息流经 (1) 基于文件的持久化 mailbox、(2) 通过 `promptAsync` 的 best-effort 实时投递、(3) 通过 `experimental.chat.messages.transform` hook 的自动内容注入。这防止了消息丢失和重复投递。

5. **基于文件的持久化**：所有 team 状态（spec、runtime state、mailbox、tasks）以文件形式存储在 `~/.octeam/teams/{name}/` 下。文件锁（`flock` + 原子 rename）保护并发修改。这能在 plugin 崩溃和 OpenCode 重启后存活。

6. **Per-team mutex**：所有 event handler 中的状态修改通过 per-team async mutex 串行化。这防止了多个 agent 同时 idle 时的 race condition。

7. **Leader 固定为 master**：leader 固定为当前用户直接交互的 session（即调用 `team_create` 的 `context.sessionID`），名称固定为 `"master"`。master 在执行意义上不是 team member——它通过 tool 发起编排，并通过 idle 时的 `promptAsync` 注入接收结果。master 的交互式 session 永远不会被阻塞。对于 `team_loop`，decider 必须是一个 member（不能是 `"master"`）。

   **Master 作为 synthetic pseudo-member（B1 修复）**：为消除“结果投递死路”（leader 忙时排队的 team 结果无法送达），`resolveTeamMember(sessionID)` 在 `sessionID` 等于某 team 的 `leadSessionId` 时，返回一个 synthetic master 记录（`{ name: "master", isMaster: true, teamName, teamRunId, sessionId }`，**不持久化、不计入 `members[]`、不参与编排 dispatch**）。这样 Transform hook 与 event handler 都能像普通 recipient 一样 drain master 的 mailbox，把排队结果投递给用户 session。

8. **Git worktree 隔离（可选）**：默认情况下，所有 member 与 leader 工作在同一个目录下。只有用户在 member 配置中显式设置 `worktree: true` 时，才为该 member 创建独立的 git worktree。建议在多个 `modify` agent 可能写入相同文件时启用。

---

## 2. 数据模型

### TeamSpec（不可变，声明式）

存储为 `config.json`。在创建时定义，运行期间不可修改。

```ts
type TeamSpec = {
    version: 1
    name: string                        // /^[a-z0-9-]+$/, unique within scope
    description?: string
    createdAt: number                   // epoch ms
    teamAllowedPaths?: string[]         // restrict file access for members
    members: TeamMemberSpec[]           // 1-8 members
}

type TeamMemberSpec = {
    name: string                        // unique within team
    role: string                        // role description for system prompt
    model?: string                      // model identifier, e.g. "claude-sonnet"
    agent?: string                      // OpenCode agent type, default "build"
    worktree?: boolean                  // create isolated git worktree, default false (opt-in)
}
```

### RuntimeState（可变，持久化）

存储为 `state.json`。在文件锁下通过原子更新（写临时文件 + rename）修改。

```ts
type RuntimeState = {
    version: 1
    teamRunId: string                   // UUID, unique per run
    teamName: string
    status: TeamStatus
    leadSessionId: string               // always context.sessionID, leader name is always "master"
    members: RuntimeMember[]
    activeTask?: ActiveTask             // only one active orchestration at a time
    bounds: Bounds                      // resource limits (see Section 8)
    createdAt: number
    startedAt?: number                  // when first task started
}

type TeamStatus =
    | "creating"                        // sessions being spawned
    | "active"                          // ready for tasks
    | "orchestrating"                   // a parallel/pipeline/loop is running
    | "shutdown_requested"              // cooperative shutdown in progress
    | "deleting"
    | "deleted"
    | "failed"                          // unrecoverable error
    | "orphaned"                        // plugin restarted, sessions may be stale

type RuntimeMember = {
    name: string
    sessionId?: string                  // set after session.create succeeds
    model?: string
    agent?: string
    status: MemberStatus
    worktreePath?: string               // absolute path to git worktree
    pendingMessageCount: number         // unread messages in mailbox
    turnCount: number                   // M4: incremented per promptAsync dispatch; checked vs bounds.maxMemberTurns
    lastTurnMarker?: string             // for Transform hook injection dedup
    error?: string                      // if status === "errored"
    isMaster?: boolean                  // B1: set ONLY on the synthetic master record from resolveTeamMember; never persisted
}

type MemberStatus =
    | "pending"                         // session not yet created
    | "running"                         // actively processing a prompt
    | "idle"                            // finished, awaiting work
    | "errored"                         // LLM/tool failure
    | "completed"                       // finished all assigned work
    | "shutdown_approved"               // cooperative shutdown approved
```

### ActiveTask

每个 team 同一时间只能运行一个编排（parallel/pipeline/loop）。在已有活跃编排时调用新的编排 tool 会返回错误。

```ts
type ActiveTask = {
    type: "parallel" | "pipeline" | "loop"
    mode?: "isolated" | "collaborative" | "discussion"   // parallel only
    startedAt: number
    wallClockTimeoutMs: number          // hard timeout, default 300000 (5 min)
    tokenBudget?: number                // optional cost cap
    tokensUsed: number                  // running total; sourced by summing AssistantMessage
                                        //   info.tokens (input+output+reasoning) from session.messages
                                        //   — NOT from session.status (M5: status has no token data)

    // result collection (serializable — NOT a Map)
    responses: Record<string, string>   // memberName → last assistant text output

    // parallel mode
    task?: string                       // isolated: uniform task
    tasks?: Record<string, string>      // collaborative: per-member tasks
    topic?: string                      // discussion: debate topic
    maxRounds?: number                  // discussion/loop: round limit
    currentRound?: number

    // pipeline / loop: ordered stages
    stages: Stage[]
    currentStageIndex: number

    // loop-specific
    deciderMember?: string              // member name of decider (NOT "leader")
    decisionHistory: DecisionRecord[]   // structured decisions per round
}

type Stage = {
    member: string                      // member name (validated unique within stages)
    task: string                        // task description
    action?: "modify" | "read_only"     // loop mode only
    completed: boolean
}

type DecisionRecord = {
    round: number
    decision: "continue" | "done"
    rationale: string
    nextActions: string[]               // concrete directives for next round
    timestamp: number
}
```

### Message（文件 mailbox 条目）

以每行一个 JSON 对象的形式存储在 `mailbox/{recipient}.jsonl` 中。

```ts
type Message = {
    version: 1
    id: string                          // UUID
    from: string                        // sender member name, or "orchestrator"
    to: string                          // recipient member name, or "*" for broadcast
    kind: "message" | "announcement"
    body: string                        // max 32KB
    summary?: string                    // one-line summary for status display
    timestamp: number
    correlationId?: string              // UUID for request-response pairing
    deliveryStatus: "pending" | "delivered" | "processed"
}
```

**注意**：不存在全局 `read` 布尔值。每个接收者有自己的 mailbox 文件。广播消息在发送时复制到每个接收者的文件中。这消除了多读者 read-flag bug。

### Task（共享任务列表，用于协作模式）

以独立 JSON 文件存储在 `tasks/` 中。认领使用 per-task 文件锁。

```ts
type Task = {
    version: 1
    id: string                          // UUID
    subject: string
    description: string
    status: "pending" | "claimed" | "in_progress" | "completed" | "deleted"
    owner?: string                      // member name who claimed
    blocks: string[]                    // task IDs this blocks
    blockedBy: string[]                 // task IDs that must complete first
    createdAt: number
    updatedAt: number
    claimedAt?: number
}
```

---

## 3. 持久化

### 文件布局

```
~/.octeam/teams/{teamName}/                 （或 <project>/.octeam/teams/{teamName}/）
├── config.json                             TeamSpec（不可变）
├── state.json                              RuntimeState（可变，文件锁保护）
├── mailbox/
│   ├── {memberName}.jsonl                  每个接收者的消息队列（仅追加）
│   ├── {memberName}.processed.jsonl        已投递消息（审计用）
│   └── {memberName}.reserved/              投递中的预约（临时）
├── tasks/
│   ├── {taskId}.json                       单个任务
│   └── claims/
│       └── {taskId}.lock                   per-task 认领锁文件
├── worktrees/                               仅在 worktree: true 时创建
│   └── {memberName}/                       用于隔离工作的 git worktree
└── runs/
    └── {teamRunId}/                        每次运行的产物（日志、输出）
```

### 并发原语

1. **文件锁**（`withLock`）：使用 `fs.open(path, 'wx')` 实现独占创建，结合 stale 检测 TTL（默认 30s）。所有 `state.json` 写入都经过 `withLock`。

2. **原子写入**（`atomicWrite`）：先写入临时文件（`{path}.tmp.{pid}`），然后 `fs.rename` 到目标路径。防止崩溃时的部分读取。

3. **Mailbox reservation 协议**：投递消息时，plugin 将消息从 `mailbox/{member}.jsonl` 原子移动到 `mailbox/{member}.reserved/{messageId}`（预约中），然后提交到 `processed.jsonl`（已投递）或释放回 inbox（失败）。防止 live 和 poll 路径之间的重复投递。

4. **Task 认领锁**：`team_task_update` 设置 `status: "claimed"` 时通过 `fs.open(lockPath, 'wx')` 获取 `tasks/claims/{taskId}.lock`。stale 锁在 TTL 后被清除。

### 崩溃恢复

plugin 启动时，server hook 扫描 `~/.octeam/teams/` 并：
1. 对每个 `status: "creating"` 的 team → 转为 `"orphaned"`。
2. 对每个 `status: "orchestrating"` 的 team → 转为 `"orphaned"`，清除 stale mailbox 预约。
3. 对每个 `status: "active"` 的 team → 通过 `client.session.status()` 检查 member session 是否仍存在。将 stale member 标记为 `"errored"`。

Orphaned team 可通过 `team_delete({ force: true })` 恢复或手动重新关联。

---

## 4. Tools

### 4.0 Slash Commands（用户交互入口）

用户通过 slash 命令管理 team 和激活工作流。Slash command 不绕过 master agent——**master session 接收 slash command 指令后，自行调用对应的 tool**。Tool 逻辑保持不变（见 4.1–4.10），slash command 是 TUI 层的用户便捷入口。

| 命令 | 作用 | master 接收后的行为 |
|---|---|---|
| `/create-team` | 打开创建 team 对话框，配置 member/role/model | master agent 调用 `team_create` tool |
| `/clear-team` | 清空 `.octeam/teams/` 目录（强制删除所有 team） | master agent 调用 `team_delete({ force: true })` 逐个清理 |
| `/team-status` | 显示当前 team 状态（member 列表、编排进度、token 使用） | master agent 调用 `team_status` tool，结果注入 sidebar/dialog |
| `/stop-team` | 停止接受新任务，解散当前 team（协作关闭） | master agent 调用 `team_shutdown_request` 对所有 member 发起关闭 |
| `/team-parallel [task]` | 以 parallel 模式执行 | master agent 调用 `team_parallel({ task })` |
| `/team-pipeline [task]` | 以 pipeline 模式执行 | master agent 调用 `team_pipeline({ stages, task })` |
| `/team-loop [task]` | 以 loop 模式执行 | master agent 调用 `team_loop({ stages, decider, initial_task })` |

**工作流命令的 UX**：用户在 prompt 中输入 `/team-parallel <任务描述>`。slash command handler 提取任务文本，通过 `promptAsync` 向 master session 发送指令（如 `"请使用 team_parallel tool 执行以下任务：<任务描述>"`）。master agent 接收后调用对应 tool。pipeline/loop 的 member 顺序由 team 创建时的声明顺序决定。

**注意**：slash command 的参数传递机制（`onSelect` 如何读取 prompt 文本中的 inline 参数）需在 Phase 2.0 验证。如不支持 inline 参数，则改为：command 触发后通过 dialog 收集 task 再发送给 master。

> Slash command 注册在 TUI module 中通过 `api.command.register({ slash: { name: "..." }, onSelect: ... })` 完成。所有 tool（4.1–4.10）保持不变，agent 可直接调用，也可经 slash command 触发。

所有 tool 通过 `@opencode-ai/plugin/tool` 的 `tool()` 函数注册。调用 session 通过 `execute(args, context)` 签名中的 `context.sessionID` 识别——无需手动 caller-ID 传递。

### 4.1 `team_create`

创建一个包含 leader 和 sub-agent member 的 team。

```
team_create({
    name: "auth-team",
    description: "JWT authentication implementation team",
    members: [
        { name: "coder",     role: "responsible for writing code",             model: "claude-haiku" },
        { name: "tester",    role: "responsible for testing and verification",  model: "gpt-4o" },
        { name: "optimizer", role: "responsible for code review",               model: "claude-sonnet" },
    ],
    bounds?: {                          // optional, all have defaults
        maxWallClockMinutes: 30,
        maxMessagesPerRun: 100,
        maxMemberTurns: 50,
    }
})
```

**实现**：
1. 校验 member 名称唯一且匹配 `/^[a-z0-9-]+$/`。
2. 将调用者的 `context.sessionID` 记录为 `leadSessionId`（leader 名称固定为 `"master"`）。
3. 对每个 member：
   a. 如果 `member.worktree === true`，创建 git worktree：`git worktree add worktrees/{memberName} -b team/{teamName}/{memberName}`。否则使用 leader 的当前目录。
   b. 创建 child session：`client.session.create({ body: { parentID: leadSessionId, title: "{teamName}/{memberName}" }, query: { directory: worktreePath ?? ctx.directory } })`。
   c. 通过 `promptAsync` 发送包含 member 角色 + team context 的初始 prompt。
4. 写入 `config.json` + 初始 `state.json`（status: `"active"`）。
5. 返回包含 member session ID 的 team 摘要。

**API 调用形态**（已修正）：
```ts
const result = await client.session.create({
    body: { parentID: leadSessionId, title: `${teamName}/${member.name}` },
    query: { directory: member.worktreePath ?? ctx.directory },
})
const sessionId = result.data.id    // NOT result.id
```

**注意**：`session.create` 不接受 `agent` 参数。agent 类型在 `promptAsync` 时通过 `body.agent` 字段设置。

### 4.2 `team_parallel`

并行执行任务。支持三种模式。

#### 模式 A：Isolated（隔离）——相同任务，无通信

```
team_parallel({
    team_id: "auth-team",
    mode: "isolated",
    task: "Review this code for bugs and suggest fixes",
    timeout_ms: 300000
})
```

所有 member 接收相同任务。它们独立工作。当全部 idle 时，leader 接收结果摘要。

#### 模式 B：Collaborative（协作）——不同任务，允许通信

```
team_parallel({
    team_id: "auth-team",
    mode: "collaborative",
    tasks: {
        coder:     "Implement OAuth2 login flow",
        tester:    "Write comprehensive test suite",
        optimizer: "Review architecture and suggest improvements"
    }
})
```

每个 member 接收自己的任务。member 可以自由调用 `team_send_message` 和 `team_task_*` 进行协调。当全部 idle 时，leader 接收摘要。

#### 模式 C：Discussion（讨论）——多轮结构化辩论

```
team_parallel({
    team_id: "auth-team",
    mode: "discussion",
    topic: "What approach should we use for database migration?",
    max_rounds: 3,
    timeout_ms: 300000
})
```

**讨论协议**使用 **barrier 原语**（见第 7.1 节）：
```
Round 0: Plugin 通过 promptAsync 向所有 member 发送 topic → 全部运行
Round 1: 所有 member 独立响应 → 全部 idle → barrier 达到
         Plugin 收集所有响应 → 向所有 member 广播摘要
Round 2: 所有 member 回应他人观点 → barrier
         Plugin 收集 → 广播
Round 3（最终）：所有 member 发表最终声明 → barrier
         Plugin 总结 → 将结果注入 leader session（如果 idle）
```

**轮次结束条件**：barrier 达到（所有参与 member idle）或 timeout。

**退出条件**：达到 `max_rounds`，或 timeout，或所有 member 达成一致（通过结构化输出检测）。

**初始 dispatch**（三种模式共用）：tool handler 写入 `activeTask` 后**立即**发出首批 prompt——isolated 向所有 member 发送同一 `task`；collaborative 按 `tasks` 映射分别发送；discussion 向所有 member 发送 `topic`（round 0）。此后由 barrier 收集并推进。

### 4.3 `team_pipeline`

线性链式执行：Member A → Member B → Member C → Leader。

```
team_pipeline({
    team_id: "auth-team",
    stages: [
        { member: "coder",     task: "Implement JWT authentication middleware" },
        { member: "tester",    task: "Write unit tests and integration tests" },
        { member: "optimizer", task: "Review code quality and performance" },
    ],
    timeout_ms: 600000
})
```

**流程**：
```
Stage 0: coder 接收原始任务 → idle → 输出被捕获
Stage 1: tester 接收："[coder 的输出（截断至 8KB）] + [你的任务]" → idle → 输出被捕获
Stage 2: optimizer 接收："[tester 的输出（截断）] + [你的任务]" → idle → 输出被捕获
         → Leader（如果 idle）接收所有 stage 输出的摘要
```

**实现说明**：
- Stage N 的输出作为 context 前置到 Stage N+1 的任务中。
- **输出截断**：每个 stage 捕获的输出在传递给下一个 stage 前被截断至 8KB（可配置）。这防止 context-window 爆炸。
- Plugin 跟踪 `currentStageIndex`，仅在**预期的** member idle 时推进（身份校验）。
- **Stage 唯一性校验**：单次 pipeline 运行中 `stages` 必须有唯一的 `member` 值。重复的 member 会在 `responses` 中互相覆盖。
- **初始 dispatch**：tool handler 写入 `activeTask`（`currentStageIndex=0`）后，**立即**对 `stages[0].member` 调用 `promptAsync` 发出首个任务，启动流水线。此后由 event handler 的身份校验逐 stage 推进。

### 4.4 `team_loop`

循环纠错模式：编写 → 审查 → 决策 → 重复。

```
team_loop({
    team_id: "auth-team",
    stages: [
        { member: "coder",      task: "Implement JWT auth",          action: "modify"    },
        { member: "bugfinder",  task: "Find bugs, report only",     action: "read_only" },
        { member: "optimizer",  task: "Suggest improvements only",   action: "read_only" },
    ],
    decider: "optimizer",               // a MEMBER name, NOT "master"
    max_rounds: 5,
    initial_task: "Implement secure JWT authentication middleware",
    timeout_ms: 900000
})
```

**关键修正**：`decider` 必须是**member 名称**（不能是 `"master"`）。decider 是 loop 中的最后一个 stage——在所有 stage 完成后，decider 接收所有输出并产生结构化决策。如果 `decider` 不在 `stages` 中，则自动追加为最终的 read-only stage。

**Loop 协议**（每轮）：
```
Stage 0: coder(modify)     → 接收任务/决策 → 编写代码 → idle → 输出: code_vN
Stage 1: bugfinder(ro)     → 接收 coder 输出 → idle → 输出: bug report
Stage 2: optimizer(ro)     → 接收 coder 输出 + bug report → idle → 输出: 改进建议
Stage 3: decider           → 接收所有输出 → 产生结构化决策 → idle
         → 决策被解析 → 如果 "continue"，下一轮；如果 "done"，loop 结束
         → 结果注入 leader session（如果 idle）
```

**结构化决策协议**：decider 的输出必须包含可解析的 JSON 块：

```
Based on the review, here is my decision:

<decision>
{
    "decision": "continue",
    "rationale": "Security vulnerability in token validation remains",
    "nextActions": [
        "Fix the buffer overflow in base64 decode",
        "Add input length validation before decoding"
    ]
}
</decision>
```

plugin 提取 `<decision>...</decision>` 块并解析 JSON。如果解析失败，决策默认为 `"continue"`，并在 decider 的下一个 prompt 中注入警告。连续三次解析失败将强制终止 loop，原因为 `reason: "decision_parse_failure"`。

**退出条件**（满足任一即可）：
1. Decider 产生 `decision: "done"`。
2. 所有 `read_only` stage 报告无问题（通过关键词匹配检测："no issues"、"no bugs found"、"no improvements"、"all clear"）。
3. 达到 `max_rounds`。
4. 超过 wall-clock timeout。
5. Token 预算耗尽。
6. 连续三次决策解析失败。

**初始 dispatch**：tool handler 写入 `activeTask`（`currentRound=1`、`currentStageIndex=0`）后，**立即**对 `stages[0].member` 发送 `initial_task`，启动首轮。若 `decider` 不在 `stages` 中，先自动追加为最终 read_only stage 再 dispatch。

### 4.5 `team_send_message`

向 member 的 mailbox 发送消息。

```
team_send_message({
    team_id: "auth-team",
    to: "tester",                       // member name, or "*" for broadcast
    body: "API endpoint changed to /v2/auth",
    summary?: "API endpoint update",    // optional one-line summary
    correlationId?: "uuid"              // optional for request-response pairing
})
```

**实现**：
1. 通过 `context.sessionID` 识别发送者 → 解析为 member 名称。
2. 校验：广播（`to: "*"`）仅限 master（leader）。Member 只能发送点对点消息。
3. 将 message JSON 追加到 `mailbox/{recipient}.jsonl`（广播时为所有 member 的文件）。
4. 强制背压：如果接收者的未读 mailbox 超过 `messageUnreadMaxBytes`（默认 1MB）则拒绝。
5. **实时投递**（best-effort）：如果接收者 session 当前 idle，调用 `promptAsync` 发送 **wake hint**（不是消息内容）：`"You have N new team messages. They will be injected on your next turn."` 实际消息内容由 Transform hook（Layer 3）注入，而不是由这个 `promptAsync` 调用注入。

**注意**：不存在 `team_read` tool。消息由 Transform hook 在每轮自动注入到 member 的 context 中。这消除了多读者 read-flag bug。

### 4.6 `team_task_create` / `team_task_list` / `team_task_update` / `team_task_get`

用于协作协调的共享任务列表（与 parallel/pipeline/loop 互补）。

```
team_task_create({
    team_id: "auth-team",
    subject: "Write integration tests for /auth endpoint",
    description: "Cover login, logout, token refresh, and invalid credentials",
    blockedBy?: ["task-uuid-1"]         // wait for these tasks first
})

team_task_list({
    team_id: "auth-team",
    status?: "pending" | "claimed" | "completed",
    owner?: "tester"
})

team_task_update({
    team_id: "auth-team",
    task_id: "task-uuid",
    status: "claimed"                   // acquires file lock atomically
    // or: "in_progress" | "completed" | "deleted"
})

team_task_get({ team_id: "auth-team", task_id: "task-uuid" })
```

**认领语义**：`status: "claimed"` 原子获取 `tasks/claims/{taskId}.lock`。如果另一个 member 已认领，返回 `TaskAlreadyClaimedError`。这实现了协作模式下的 pull-based 任务分配。

### 4.7 `team_shutdown_request`

发起对某个 member 的协作关闭。

```
team_shutdown_request({
    team_id: "auth-team",
    member: "coder"                     // target member name
})
```

**仅限 master**。向 member 的 mailbox 发送 `shutdown_request` 消息。member 看到请求（通过 Transform hook 注入）后可以批准或拒绝。

### 4.8 `team_approve_shutdown` / `team_reject_shutdown`

```
team_approve_shutdown({
    team_id: "auth-team",
    member: "coder"                     // self-approve or leader approves
})

team_reject_shutdown({
    team_id: "auth-team",
    member: "coder",
    reason: "I have unfinished work on the OAuth flow"
})
```

批准后：member 状态 → `"shutdown_approved"`。Worktree 被清理。如果所有 member 都已批准/关闭，team 转为 `"deleted"`。

### 4.9 `team_status` / `team_list`

```
team_status({ team_id: "auth-team" })
// Returns: {
//   status: "orchestrating",
//   activeTask: { type: "loop", round: 2, maxRounds: 5 },
//   members: [
//     { name: "coder", status: "running", model: "claude-haiku", unreadMessages: 0 },
//     { name: "tester", status: "idle", model: "gpt-4o", unreadMessages: 2 },
//     ...
//   ],
//   bounds: { ... },
//   tokensUsed: 45200
// }

team_list({ scope?: "user" | "project" | "all" })
// Returns: [{ name: "auth-team", status: "active", members: 3 }, ...]
```

### 4.10 `team_delete`

```
team_delete({
    team_id: "auth-team",
    force?: false                       // if true, skip cooperative shutdown
})
```

**非 force（默认）**：要求所有 member 为 `shutdown_approved` 或 `completed`。如果有 member 仍为 `running`，返回错误并建议使用 `team_shutdown_request`。

**Force**：立即将 team 转为 `"deleting"`，取消所有 pending worktree，删除状态文件。Session 不被删除（历史记录保留在 OpenCode 的 DB 中）。这是崩溃恢复路径。

**关于中断的说明**：OpenCode 不支持对运行中的 agent 进行实时中断。因此，`force: true` 无法真正停止正在进行的 LLM 调用——agent 会完成当前 turn，但 plugin 将不再向其 dispatch 新的 prompt。这在 tool 的描述中诚实记录。

---

## 5. 通信——三层模型

agent 与 orchestrator 之间的消息流经三层，每层有不同职责：

### Layer 1：文件 Mailbox（持久化真相源）

每次 `team_send_message` 调用将一个 `Message` JSON 对象写入接收者的 mailbox 文件（`mailbox/{memberName}.jsonl`）。这是仅追加的，能在崩溃中存活。广播消息在发送时复制到每个接收者的文件中。

### Layer 2：实时投递（best-effort 即时推送）

写入文件 mailbox 后，plugin 尝试实时投递：如果接收者 session 当前 idle，调用 `promptAsync` 发送 **wake hint**（不是消息内容）：

```
[Team Orchestrator] You have 2 new team messages. They will be injected on your next turn.
```

这唤醒 idle session 使其处理下一个 turn，在此期间 Layer 3 注入实际内容。

### Layer 3：Transform Hook 注入（自动内容投递）

`experimental.chat.messages.transform` hook 在**每次 chat turn**为每个 session 运行。对于 team member session，它：

1. 将 session ID 解析为 team member。
2. 轮询 member 的 mailbox 文件获取未读消息。
3. 如果有未读消息，构建注入块并将其作为 synthetic user message 插入到 `output.messages` 中**最后一条 user message 之前**：

```ts
"experimental.chat.messages.transform": async (input, output) => {
    const sessionID = input.sessionID ?? input.session?.id
    const member = await resolveTeamMember(sessionID)
    if (!member) return  // not a team member (NB: resolveTeamMember ALSO resolves the
                         //   master session as a synthetic member, so master's queued
                         //   team results are injected through this same path — B1 fix)

    const unread = await pollMailbox(member.teamRunId, member.name)
    if (unread.length === 0) return

    const injection = formatMailboxInjection(unread)
    const syntheticMsg = {
        role: "user",
        parts: [{ type: "text", text: injection, synthetic: true }],
    }

    // Insert before the last user message
    const lastUserIdx = output.messages.findLastIndex(m => m.info?.role === "user")
    if (lastUserIdx >= 0) {
        output.messages.splice(lastUserIdx, 0, syntheticMsg)
    } else {
        output.messages.push(syntheticMsg)
    }

    // Mark messages as delivered (move to processed)
    await ackMessages(member.teamRunId, member.name, unread)
}
```

### Reservation 协议（防止重复投递）

由于 Layer 2（实时）和 Layer 3（transform）都可能尝试投递，reservation 协议防止重复：

1. 当 Layer 2 触发唤醒时，消息被原子地从 `mailbox/{member}.jsonl` 移动到 `mailbox/{member}.reserved/{messageId}`。
2. Layer 3（Transform hook）拾取已预约的消息并注入。
3. 注入成功后，消息提交到 `mailbox/{member}.processed.jsonl`。
4. 如果 session 在注入前出错，预约被释放回 inbox（stale TTL: 30s）。

### Idle Wake-Hint

在 `session.idle` 事件时，如果 member 有未读消息，plugin 通过 `promptAsync` 发送 wake hint。这对每个 member 限制为每 30 秒最多一次，以防止唤醒循环。

---

## 6. 事件处理——带锁状态机

plugin 通过 `Hooks.event` hook 订阅事件。这是一个**单一 handler**，接收所有事件类型——必须在内部通过 `event.type` 过滤。

### 核心 Handler

```ts
event: async ({ event }) => {
    // Only process idle events
    if (event.type !== "session.idle") return

    const sessionID = event.properties.sessionID
    const member = await resolveTeamMember(sessionID)
    if (!member) return  // not a team member

    const team = await loadTeamState(member.teamName)

    // --- Acquire per-team mutex (prevents concurrent state corruption) ---
    await team.mutex.runExclusive(async () => {
        // --- Step 1: Update member status ---
        member.status = "idle"

        // --- Master special case (B1 fix): master is resolved as a synthetic member.
        //     Deliver any queued team results via promptAsync, then return.
        //     Master NEVER participates in orchestration dispatch. ---
        if (member.isMaster) {
            await deliverQueuedResultsToMaster(team, sessionID)
            return
        }

        // --- Step 2: Identity validation (prevent stray idle from advancing stages) ---
        if (team.activeTask) {
            const expectedMember = getExpectedMember(team.activeTask)
            if (expectedMember && member.name !== expectedMember) {
                // This idle is from an unexpected member — record but do NOT advance
                return
            }
        }

        // --- Step 3: Capture this member's output ---
        const msgs = await client.session.messages({
            path: { id: sessionID },
        })
        const lastAssistant = msgs.data?.findLast(
            m => m.info?.role === "assistant"
        )
        if (lastAssistant) {
            const text = extractTextFromParts(lastAssistant.parts)
            team.activeTask.responses[member.name] = truncateOutput(text)
        }

        await saveTeamState(team)

        // --- Step 4: Check for unread messages first ---
        const unread = await countUnreadMessages(member.teamRunId, member.name)
        if (unread > 0) {
            // Transform hook will inject on next turn; just send wake hint
            await sendWakeHint(client, sessionID, unread)
            return
        }

        // --- Step 5: Dispatch based on active task type ---
        if (!team.activeTask) return

        switch (team.activeTask.type) {
            case "parallel":
                await handleParallelIdle(team, member)
                break
            case "pipeline":
                await handlePipelineIdle(team, member)
                break
            case "loop":
                await handleLoopIdle(team, member)
                break
        }

        // --- Step 6: Check termination conditions ---
        await checkTermination(team)
    })
}
```

### getExpectedMember（M3：按模式区分）

Step 2 的身份校验依赖 `getExpectedMember`。**关键**：parallel 模式下所有 member 并发运行，必须返回 `null`（接受所有 member 的 idle）；pipeline/loop 仅当前 stage 的 member 可推进状态机。若错误地为 parallel 返回单个 member 名，其余 member 的 idle 会被丢弃，并行将退化为串行——这是设计中需明确规避的 footgun。

```ts
function getExpectedMember(task: ActiveTask): string | null {
    // parallel (isolated/collaborative/discussion): all members run concurrently
    //   → accept EVERY member's idle event
    if (task.type === "parallel") return null
    // pipeline / loop: only the current stage's member may advance the state machine
    return task.stages[task.currentStageIndex]?.member ?? null
}
```

### Barrier 原语（三种模式共用）

所有三种编排模式共享一个共同内部原语：**运行 agent → 等待所有预期 member 达到 idle → 收集输出 → 推进**。

```ts
/**
 * Wait for all members in `memberNames` to reach idle, then call `onBarrier`.
 * Returns when the barrier is reached or timeout/budget exceeded.
 */
async function waitForBarrier(
    team: Team,
    memberNames: string[],
    onBarrier: () => Promise<void>,
): Promise<void> {
    // The event handler (Section 6) sets member.status = "idle" on each idle event.
    // This function is re-entered on each idle to check if all members are idle.
    const allIdle = memberNames.every(name => {
        const m = team.members.find(m => m.name === name)
        return m?.status === "idle"
    })
    if (allIdle) {
        await onBarrier()
    }
    // If not all idle, the function returns; the next idle event will re-check.
    // Termination is enforced by checkTermination() which runs on every idle.
}
```

### Pipeline Handler（已修正）

```ts
async function handlePipelineIdle(team: Team, member: RuntimeMember) {
    const task = team.activeTask!
    const stages = task.stages

    // Validate: this idle is from the CURRENT stage's member
    const currentStage = stages[task.currentStageIndex]
    if (currentStage.member !== member.name) return  // stray idle, ignore

    // Mark current stage completed
    currentStage.completed = true

    // Advance to next stage
    const nextIndex = stages.findIndex(s => !s.completed)
    if (nextIndex === -1) {
        // All stages complete → deliver summary to leader (if idle)
        await deliverSummaryToLeader(team, "pipeline_complete")
        team.activeTask = undefined
        team.status = "active"
        return
    }

    task.currentStageIndex = nextIndex
    const nextStage = stages[nextIndex]
    const nextMember = team.members.find(m => m.name === nextStage.member)!

    // Build prompt with previous stage's output (truncated)
    const prevResult = nextIndex > 0
        ? task.responses[stages[nextIndex - 1].member]
        : null

    const fullTask = prevResult
        ? `[Output from ${stages[nextIndex - 1].member}]\n${truncateOutput(prevResult)}\n\n[Your task]\n${nextStage.task}`
        : nextStage.task

    // Correct API shape
    await client.session.promptAsync({
        path: { id: nextMember.sessionId! },
        body: {
            parts: [{ type: "text", text: fullTask, synthetic: true }],
            agent: nextMember.agent ?? "build",
        },
        query: { directory: nextMember.worktreePath ?? team.directory },
    })
    nextMember.status = "running"
}
```

### Loop Handler（已修正——decider 是一个 stage）

```ts
async function handleLoopIdle(team: Team, member: RuntimeMember) {
    const task = team.activeTask!
    const stages = task.stages

    // Validate: this idle is from the CURRENT stage's member
    const currentStage = stages[task.currentStageIndex]
    if (currentStage.member !== member.name) return  // stray idle

    currentStage.completed = true
    task.currentStageIndex++

    if (task.currentStageIndex < stages.length) {
        // Next stage in current round
        await advanceToStage(team, stages[task.currentStageIndex])
        return
    }

    // --- All stages complete (including decider) ---
    // The decider was the LAST stage; its output is in responses[deciderMember]
    const decision = parseDecision(task.responses[task.deciderMember!])

    if (decision.decision === "done") {
        await deliverSummaryToLeader(team, "loop_complete:decider_done")
        task.decisionHistory.push(decision)
        team.activeTask = undefined
        team.status = "active"
        return
    }

    // Check exit conditions
    if (task.currentRound! >= task.maxRounds!) {
        await deliverSummaryToLeader(team, "loop_complete:max_rounds")
        team.activeTask = undefined
        team.status = "active"
        return
    }

    if (allReadOnlyStagesReportNoIssues(task)) {
        await deliverSummaryToLeader(team, "loop_complete:no_issues")
        team.activeTask = undefined
        team.status = "active"
        return
    }

    // --- Continue to next round ---
    task.decisionHistory.push(decision)
    task.currentRound!++
    task.currentStageIndex = 0
    task.stages.forEach(s => s.completed = false)

    // Start new round with first stage
    await advanceToStage(team, stages[0])
}

function parseDecision(rawText: string): DecisionRecord {
    // Extract <decision>{...}</decision> JSON block
    const match = rawText.match(/<decision>\s*(\{[\s\S]*?\})\s*<\/decision>/)
    if (!match) {
        return {
            round: 0,
            decision: "continue",
            rationale: "Decision parse failed; defaulting to continue",
            nextActions: [],
            timestamp: Date.now(),
        }
    }
    try {
        const parsed = JSON.parse(match[1])
        return {
            round: 0,
            decision: parsed.decision === "done" ? "done" : "continue",
            rationale: parsed.rationale ?? "No rationale provided",
            nextActions: parsed.nextActions ?? [],
            timestamp: Date.now(),
        }
    } catch {
        return { /* same default as above */ }
    }
}
```

### 错误与取消路径

```ts
async function checkTermination(team: Team) {
    const task = team.activeTask
    if (!task) return

    // Wall-clock timeout
    if (Date.now() - task.startedAt > task.wallClockTimeoutMs) {
        await deliverSummaryToLeader(team, "timeout")
        team.activeTask = undefined
        team.status = "active"
        return
    }

    // Token budget
    if (task.tokenBudget && task.tokensUsed > task.tokenBudget) {
        await deliverSummaryToLeader(team, "budget_exceeded")
        team.activeTask = undefined
        team.status = "active"
        return
    }

    // Member error
    const errored = team.members.find(m => m.status === "errored")
    if (errored) {
        await deliverSummaryToLeader(team, `member_error:${errored.name}:${errored.error}`)
        team.activeTask = undefined
        team.status = "active"
        return
    }
}
```

---

## 7. 编排模式

### 7.1 Barrier 原语

所有三种模式都构建在相同的 barrier 原语上：**向 N 个 member dispatch prompt → 等待全部 N 个达到 idle → 收集输出 → 推进到下一阶段**。

| 模式 | Barrier 使用方式 |
|---|---|
| Parallel（isolated） | 一个 barrier：所有 member 工作 → 全部 idle → 收集 |
| Parallel（collaborative） | 一个 barrier + 工作期间自由通信 |
| Parallel（discussion） | N 个 barrier（每轮一个）：全部响应 → 广播 → 重复 |
| Pipeline | N 个 barrier（每个 stage 一个），但每个 barrier 是单 member 的 |
| Loop | 每轮 N 个 barrier × max_rounds，decider 为最终 barrier |

### 7.2 摘要投递给 Leader

Leader session 是**被动客户端**。结果仅在 leader idle 时投递（以避免打断用户的交互式工作流）：

```ts
async function deliverSummaryToLeader(team: Team, reason: string) {
    const summary = buildSummary(team.activeTask!, reason)

    // Check if leader is idle (M5: session.status takes NO path.id; returns a map of
    //   ALL sessions' status — index by sessionID ourselves)
    const status = await client.session.status()
    const leaderStatus = status.data?.[team.leadSessionId]

    if (leaderStatus?.type === "idle") {
        // Leader is idle → inject result
        await client.session.promptAsync({
            path: { id: team.leadSessionId },
            body: {
                parts: [{
                    type: "text",
                    text: `<team_result team="${team.teamName}">\n${summary}\n</team_result>`,
                    synthetic: true,
                }],
            },
        })
    } else {
        // Leader is busy → queue to master's mailbox. Delivered later via:
        //   (1) event handler on master idle → deliverQueuedResultsToMaster (proactive), and/or
        //   (2) Transform hook on master's next turn.
        //   The reservation protocol prevents double-delivery between the two.
        await writeMailboxMessage(team.teamRunId, "master", {
            from: "orchestrator",
            to: "master",
            kind: "announcement",
            body: summary,
            summary: `Task complete: ${reason}`,
        })
    }
}

// B1 fix: drain master's mailbox and deliver queued team results when master goes idle.
// Called from the event handler's master special-case branch.
async function deliverQueuedResultsToMaster(team: Team, masterSessionId: string) {
    const queued = await pollMailbox(team.teamRunId, "master")   // reserves messages
    if (queued.length === 0) return
    const text = queued.map(m => m.body).join("\n\n")
    await client.session.promptAsync({
        path: { id: masterSessionId },
        body: { parts: [{ type: "text", text, synthetic: true }] },
    })
    await ackMessages(team.teamRunId, "master", queued)   // commit to processed
}
```

---

## 8. 资源边界与安全

### 8.1 Bounds

每个 team 有带默认值的强制资源边界：

```ts
type Bounds = {
    maxMembers: number                 // default 8, hard cap
    maxParallelMembers: number         // default 4, concurrent spawning limit
    maxMessagesPerRun: number          // default 100, total messages per orchestration
    maxWallClockMinutes: number        // default 30, hard wall-clock limit
    maxMemberTurns: number             // default 50, turns per member per orchestration
    messagePayloadMaxBytes: number     // default 32768 (32KB)
    messageUnreadMaxBytes: number      // default 1048576 (1MB), backpressure limit
}
```

这些在 dispatch 时检查。超过任何边界将以结构化原因终止活跃任务。

- **`maxMemberTurns` 强制**：每次对某 member 调用 `promptAsync` 前递增 `member.turnCount` 并检查；若达到上限，该 member 不再被 dispatch，编排以 `member_turn_limit:{member}` 终止。
- **`maxMessagesPerRun` 强制**：`team_send_message` 在写入前检查当前 run 的消息总数，超限拒绝。
- **`maxParallelMembers` 强制**：`team_create` 并发 spawn session 时分批，单批并发数不超过该值。
- **`tokenBudget` 强制（M5 已验证）**：`tokensUsed` 由累加各 member session 中 `AssistantMessage` 的 `info.tokens`（input+output+reasoning）得出——只能走 `session.messages`，**不能走 `session.status`**（status 无 token 数据）。推荐订阅 `message.updated` 事件增量累加，避免每轮全量扫描。需明确 `cache.read`/`cache.write` token 是否计入预算（缓存读通常按折计费）。

### 8.2 Agent 资格

任何 agent 类型都有资格成为 team member。plugin 不对 agent 类型做任何限制——用户可以根据需要自由组合不同类型的 agent（包括只读 agent 如 `oracle`、`explore`、`librarian` 等）。

> **注意**：只读 agent（如 `oracle`）在 loop 模式的 `modify` stage 中无法写入代码，但可以用作 `read_only` stage 或 `decider`。用户需自行确保分配给每个 member 的任务与其 agent 类型匹配。

### 8.3 Git Worktree 隔离（可选）

默认情况下，所有 member 与 leader（master）工作在同一个目录下。只有用户在 member 配置中显式设置 `worktree: true` 时，才为该 member 创建独立的 git worktree：

```bash
# 仅在 worktree: true 时执行
git worktree add worktrees/{memberName} -b team/{teamName}/{memberName}
```

建议在以下场景启用 worktree 隔离：
- `team_parallel` collaborative 模式中多个 `modify` agent 可能写入相同文件
- `team_loop` 中 `modify` agent 需要独立的代码分支

Worktree 在 `team_delete` 或 member 关闭批准时清理。对于 `read_only` stage，无需启用 worktree（只读访问不会产生写入冲突）。

---

## 9. API 参考（正确的 SDK 调用形态）

所有 API 调用已针对 OpenCode 1.17.7 + `@opencode-ai/sdk` 1.4.7 类型定义验证。

### session.create

```ts
const result = await client.session.create({
    body: {
        parentID: leadSessionId,       // links child to leader
        title: "auth-team/coder",      // display title
    },
    query: {
        directory: "/path/to/worktree", // working directory for the session
    },
})
const sessionId = result.data.id        // response is { data: { id: string } }
```

**注意**：`session.create` 不接受 `agent` 或 `model`。这些在 `promptAsync` 时设置。

### session.promptAsync

```ts
await client.session.promptAsync({
    path: { id: sessionId },            // path envelope, NOT flat { sessionID }
    body: {
        parts: [{
            type: "text",
            text: promptText,
            synthetic: true,            // marks as system-injected, not user-typed
        }],
        agent: "build",                 // optional: agent type for this turn
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },  // optional
    },
    query: {
        directory: "/path/to/worktree", // optional: override working directory
    },
})
```

### session.messages

```ts
const result = await client.session.messages({
    path: { id: sessionId },
})
// result.data is Array<{ info: { role: "user" | "assistant", ... }, parts: [...] }>
// Access role via m.info.role, NOT m.role

const lastAssistant = result.data?.findLast(m => m.info?.role === "assistant")
const text = lastAssistant?.parts
    ?.filter(p => p.type === "text")
    .map(p => p.text)
    .join("\n")
```

**Token usage（M5 已验证，v1.4.7）**：每条 `AssistantMessage` 的 `info` 携带 token/cost 字段，这是唯一可靠的预算数据源（`session.status` / `session.get` 都没有）：

```ts
// 仅 v1 字段路径（默认 @opencode-ai/sdk 导出）
for (const m of result.data ?? []) {
    if (m.info?.role !== "assistant") continue
    m.info.cost              // number
    m.info.tokens.input      // number
    m.info.tokens.output     // number
    m.info.tokens.reasoning  // number
    m.info.tokens.cache.read // number
    m.info.tokens.cache.write// number
    // 注意：v1 无 tokens.total，总数 = input + output + reasoning（v2 才有 tokens.total?）
}
```

聚合计算：`tokensUsed = Σ (input + output + reasoning)` over assistant messages；`costUsed = Σ info.cost`。更高效的做法是订阅 `message.updated` 事件增量累加，避免每轮全量扫描。

### session.status

```ts
// 注意（M5 已验证）：session.status 不接受 path.id，返回所有 session 的状态 map，
//   且 SessionStatus 只有 { type: "idle" | "busy" | "retry" }，不含任何 token/cost。
const result = await client.session.status()
// result.data is { [sessionID: string]: { type: "idle" | "busy" } | { type: "retry", ... } }
const myStatus = result.data?.[sessionId]   // 自行按 sessionID 取
```

### Hooks.event

```ts
// SINGLE handler for ALL events — filter by event.type inside
event: async ({ event }) => {
    if (event.type !== "session.idle") return

    // session.idle payload has NO "status" field
    // (that's session.status, a DIFFERENT event)
    const sessionID = event.properties.sessionID
    // ... handle idle
}
```

### experimental.chat.messages.transform

```ts
"experimental.chat.messages.transform": async (input, output) => {
    // input.sessionID or input.session?.id — the session being prompted
    // output.messages — Array<{ info: { role }, parts: [...] }>
    // Mutate output.messages to inject/modify content before LLM sees it

    const syntheticMsg = {
        info: { role: "user" },
        parts: [{ type: "text", text: "injected content", synthetic: true }],
    }
    output.messages.splice(lastUserIdx, 0, syntheticMsg)
}
```

### TUI Plugin API

**已验证（M1/M6）**：`tui(api)` 的 `api` 类型为 `TuiPluginApi`，**直接提供** `api.client`（完整 `OpencodeClient`）、`api.state`（同步状态快照读取）、`api.event`（实时事件订阅）、`api.kv`（持久化键值）。**tui 模块无需 import `@opencode-ai/sdk`、无需构造 client、无需发现 server URL**。

```ts
tui: (api) => {
    // Command 注册
    api.command.register({
        title: "Create Agent Team",
        value: "team.create",
        category: "Team",
        slash: { name: "team-create" },
        onSelect: () => api.ui.dialog.replace(() => <CreateTeamDialog />),
        //           ^^^^.dialog.replace, NOT api.dialog.replace
    })

    // Sidebar slot 注册（正确形态：api.slots.register 传入 TuiSlotPlugin 对象，
    //   slot 名作为 slots 的 key——NOT api.sidebar.register(name, fn)）
    api.slots.register({
        order: 145,
        slots: {
            sidebar_content: (ctx, value) => <TeamSidebar ctx={ctx} value={value} />,
        },
    })

    // 数据获取三类能力：
    api.state.session.status(sessionID)              // 同步快照读取（首选，零 RPC）
    api.event.on("session.status", (e) => { /* 实时刷新 */ })  // 返回 unsubscribe
    await api.client.session.list({ /* ... */ })     // SDK 未缓存的查询才用 api.client
}
```

### TUI 切换 session（M6 已验证）

两种正确形态，优先用 Option A：

```ts
// Option A（推荐：进程内、同步、免 HTTP）——route.navigate 到内置 "session" 路由
api.route.navigate("session", { sessionID })
// 读当前 session：api.route.current

// Option B（HTTP，走 SDK client）——注意 sessionID 是顶层参数，不是 { body: { sessionID } }
await api.client.tui.selectSession({ sessionID })
// 返回 RequestResult，200 body 为 boolean
```

> ❌ **错误形态**（已从设计中剔除）：`client.tui.selectSession({ body: { sessionID } })`——`body` 不在 `selectSession` 参数类型中，TypeScript 会报 excess-property 错误。
>
> 可选：订阅 `api.event.on("tui.session.select", ...)`（`EventTuiSessionSelect`）响应外部发起的 session 切换，用于高亮当前 active session。

---

## 10. TUI 集成

### Plugin Module 拆分

TUI 是与 server 分离的**独立 plugin module**：

```ts
// src/server.ts — server module
export default {
    server(ctx) {
        const pluginCtx = createPluginContext(ctx)
        return {
            tool: createTools(pluginCtx),
            event: createEventHandler(pluginCtx),
            "experimental.chat.messages.transform": createTransformHook(pluginCtx),
        }
    },
} satisfies PluginModule

// src/tui.ts — tui module (MUTUALLY EXCLUSIVE with server in same module)
export default {
    tui(api) {
        api.command.register(/* ... */)
        api.slots.register({ slots: { sidebar_content: (ctx, value) => /* ... */ } })
    },
} satisfies TuiPluginModule
```

`package.json`：
```json
{
    "oc-plugin": ["server", "tui"]
}
```

### Session Navigator（Phase 1 前置）

Session navigator（sidebar 中显示 child session + 点击切换）是本插件的 Phase 1 功能，独立设计文档见 [Session Navigator 设计](./SESSION_NAVIGATOR_DESIGN.zh.md)。Team sidebar 在其基础上叠加 team 专属信息。

### Slash Commands

用户通过 slash 命令管理 team 和激活工作流（见 Section 4.0）。Slash command 在 TUI module 中通过 `api.command.register` 注册，触发后向 master session 发送 `promptAsync` 指令，master agent 自行调用对应 tool。

```ts
tui(api) {
    // Slash commands
    api.command.register({
        title: "Create Team",
        value: "team.create",
        category: "Team",
        slash: { name: "create-team" },
        onSelect: () => api.ui.dialog.replace(() => <CreateTeamDialog api={api} />),
    })

    api.command.register({
        title: "Team Parallel",
        value: "team.parallel",
        category: "Team",
        slash: { name: "team-parallel" },
        onSelect: () => dispatchToMaster(api, "team-parallel"),
    })

    // ... /clear-team, /team-status, /stop-team, /team-pipeline, /team-loop

    // Sidebar slot (Phase 1 navigator + Phase 2 team info)
    api.slots.register({
        order: 145,
        slots: {
            sidebar_content: (ctx, value) => <TeamSidebar api={api} ctx={ctx} />,
        },
    })
}
```

**`dispatchToMaster` 机制**：从当前 prompt 文本中提取 slash command 后的任务描述，通过 `api.client.session.promptAsync` 向 master session 发送指令，master agent 接收后调用对应 tool：

```ts
async function dispatchToMaster(api: TuiPluginApi, command: string) {
    // 1. 从 prompt buffer 提取任务文本（具体机制待 Phase 2.0 验证）
    const taskText = extractTaskFromPrompt(api, command)
    const masterSessionId = api.route.current?.params?.sessionID!

    // 2. 向 master session 发送指令
    await api.client.session.promptAsync({
        path: { id: masterSessionId },
        body: {
            parts: [{
                type: "text",
                text: `[System] User invoked /${command}. Please use the ${command.replace('-', '_')} tool` +
                      (taskText ? ` with the following task: ${taskText}` : ""),
                synthetic: true,
            }],
        },
    })
}
```

### Team Sidebar

当当前 session 是一个 team 的 master 时，sidebar 在 Phase 1 navigator 的基础上额外显示 team 信息（member 列表、编排状态、任务列表）。Team member 本质上也是当前 session 的 child session（通过 `parentID` 关联），因此点击交互复用 Phase 1 的 `api.route.navigate` 机制。

> **数据源区分**：team/member/task/mailbox 等 plugin 私有 RuntimeState 走文件读取（配合 fs.watch 或轮询）；child session 类信息（状态/消息/列表）走 `api.state` / `api.client.session.*`。两者不要混浆。

```
┌─ Sessions Sidebar ────────────────┐
│                                   │
│  ── auth-team ───────────────────│
│  ▶ master   (sonnet)   orchestrator│  ← 点击切回 leader
│  ● coder    (haiku)    writing    │  ← 点击查看 coder 执行
│  ○ tester   (gpt-4o)   idle       │  ← 点击查看 tester 执行
│  ○ optimizer(sonnet)   2 unread   │  ← 点击查看 optimizer 执行
│  ─────────────────────────────── │
│  Mode: loop  Round 2/5           │
│  Tokens: 45.2k / 100k            │
│  ─────────────────────────────── │
│  Tasks: 2 pending, 1 claimed     │
└───────────────────────────────────┘
```

当前正在主窗口查看的 session 在 sidebar 中以 `▶` 前缀标记。

---

## 11. 目录结构

```
octeam/
  src/
    server.ts                      # Server plugin module 入口
    tui.ts                         # TUI plugin module 入口
    context.ts                     # PluginContext：捕获 client、config、storageDir
    types.ts                       # 所有类型定义
    state/
      store.ts                     # 基于文件的 RuntimeState CRUD + 原子写入
      locks.ts                     # withLock + atomicWrite + stale 清除
      paths.ts                     # team 产物的文件路径解析
    mailbox/
      send.ts                      # 将消息写入接收者的 .jsonl
      poll.ts                      # 轮询 member 的未读消息
      inject.ts                    # 为 Transform hook 格式化 mailbox 内容
      reservation.ts               # 原子 reserve/commit/release 协议
      ack.ts                       # 将消息标记为已处理
    tasks/
      crud.ts                      # Task create/list/update/get
      claim.ts                     # 带文件锁的原子认领
    orchestration/
      barrier.ts                   # 共享 barrier 原语
      parallel.ts                  # team_parallel（3 种模式）
      pipeline.ts                  # team_pipeline
      loop.ts                      # team_loop + 结构化决策解析
      summary.ts                   # 结果收集 + leader 投递
      termination.ts               # Timeout/budget/error/no-issues 检查
    tools/
      team-create.ts
      team-parallel.ts
      team-pipeline.ts
      team-loop.ts
      team-send-message.ts
      team-task.ts                 # task_create/list/update/get
      team-shutdown.ts             # shutdown_request/approve/reject
      team-status.ts               # status/list
      team-delete.ts
    hooks/
      event-handler.ts             # session.idle → 带锁状态机
      transform-hook.ts            # messages.transform → mailbox 注入
      wake-hint.ts                 # promptAsync wake hint（限流）
    tui/
      sidebar.tsx                  # Sidebar slot 组件
      dialog-create.tsx            # Create Team 对话框
    utils.ts                       # 辅助函数：resolveTeamMember、extractText、truncateOutput
  package.json                     # 声明 "oc-plugin": ["server", "tui"]
  tsconfig.json
```

---

## 12. 开发路线图

本插件分两个阶段开发。Phase 1（Session Navigator）的路线图见 [独立设计文档](./SESSION_NAVIGATOR_DESIGN.zh.md)。

### Phase 2：Team 编排

| Phase | 内容 | 可验证结果 | 前置条件 |
|---|---|---|---|
| **2.0** | 脚手架扩展：在 Phase 1 TUI module 基础上增加 server module、`PluginContext`、文件 state store + locks。`package.json` 升级为 `"oc-plugin": ["server", "tui"]` | server module 加载成功，tool/event/transform hook 注册，状态持久化到磁盘 | Phase 1 完成 |
| **2.1** | Slash commands：`/create-team`、`/clear-team`、`/team-status`、`/stop-team` + `dispatchToMaster` 机制 | 4 个管理命令可用，master session 接收指令后调用对应 tool | Phase 2.0 |
| **2.2** | `team_create` + `team_delete` + `team_list` + worktree 管理 | `/create-team` 能创建 member session + worktree，`/clear-team` 能清理 | Phase 2.1 |
| **2.3** | `team_send_message` + 文件 mailbox + Transform hook 注入 + wake-hint | 广播 + 点对点消息，消息通过 Transform hook 自动注入 | Phase 2.2 |
| **2.4** | `team_task_*`（create/list/update/get）+ 原子认领 | Task 创建成功，通过文件锁认领，依赖图被遵守 | Phase 2.2 |
| **2.5** | Slash command 工作流：`/team-parallel`、`/team-pipeline`、`/team-loop` + barrier 原语 + 带锁 event handler + 身份校验 | 3 种编排模式可用，master agent 接收 slash 指令后调用 tool | Phase 2.3 |
| **2.6** | `team_parallel` 模式 B（collaborative）+ 模式 C（discussion） | 不同任务 + 自由通信；多轮辩论带广播 | Phase 2.5 |
| **2.7** | 协作关闭（`/stop-team`）+ 错误/取消/timeout/budget 路径 | 优雅的 member 关闭，timeout 终止任务，budget 强制执行 | Phase 2.5 |
| **2.8** | 崩溃恢复 + orphan 检测 + reservation stale 清除 | Plugin 重启后恢复 team，stale reservation 被清除 | Phase 2.7 |
| **2.9** | Team sidebar 增强（在 Phase 1 navigator 基础上显示 team 信息） | Sidebar 显示 member/编排/任务状态，点击切换复用 Phase 1 | Phase 2.3, Phase 1 |

---

## 13. 约束与限制

### 无需修改 OpenCode 即可实现的能力

| 能力 | 机制 |
|---|---|
| Agent context 保留 | Session 持久化在 OpenCode 的 DB 中；`promptAsync` 恢复时保留完整历史 |
| Agent 间通信 | 文件 mailbox + Transform hook 注入 + 实时投递（三层） |
| 并发 agent 执行 | 每个 agent 有独立 session，独立 Runner |
| 确定性编排 | Plugin 通过 pipeline/loop/parallel 顺序 dispatch prompt |
| Agent 唤醒 | Plugin 检测 `session.idle` → `promptAsync` wake hint |
| 文件隔离（可选） | member 可选启用独立 git worktree，防止写入冲突 |
| 状态持久化 | 文件系统 JSON + 文件锁；在 plugin/OpenCode 重启后存活 |
| 调用者识别 | SDK 在每个 tool 的 `execute(args, context)` 中传递 `context.sessionID` |

### 不修改 OpenCode 则无法实现的能力

| 限制 | 原因 | 缓解措施 |
|---|---|---|
| 对运行中 agent 的实时中断 | OpenCode 没有 cancel-current-turn API | Agent 完成当前 turn；plugin 停止 dispatch 新 prompt。`force` delete 诚实记录了这一点。 |
| 真正的"始终在线" agent | `runLoop` 在 LLM stop signal 时退出 | Poll-and-resume：plugin 在 idle 时重新 prompt。延迟：每次 resume 约 100ms。 |
| Agent 间共享内存 | 每个 agent 是隔离的 session | 仅通过文件 mailbox 通信 |
| 自定义事件类型 | Plugin 只能订阅已有事件 | 使用 `session.idle` + Transform hook 处理所有协调 |
| `server` 和 `tui` 在一个 module 中 | `PluginModule.tui?: never` 由类型强制 | 拆分为两个 module |

### 关键权衡：Poll-and-Resume vs. 始终在线

本设计使用 **poll-and-resume** 模式（已被参考实现 `oh-my-openagent` 验证）：
- Agent 完成工作 → idle → plugin 检查待处理工作 → 通过 `promptAsync` 恢复。
- 从 agent 角度看，功能上等同于"始终在线"（完整 session context 保留）。
- 延迟：每次 resume 一次 `promptAsync` 调用（约 100ms）——在 agent 交互时间尺度上可忽略。
- Wake hint 是**提醒**（"你有消息"），不是内容本身。内容由 Transform hook 在下一个 turn 投递，确保正确的顺序和去重。

---

## 14. 关键依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| `@opencode-ai/sdk` | ^1.4.0 | SDK client：`session.create`、`promptAsync`、`messages`、`status` |
| `@opencode-ai/plugin` | ^1.4.0 | Plugin 类型：`PluginModule`、`TuiPluginModule`、`tool()`、hooks |
| `zod` | ^3.x | Tool 参数校验（必须可表示为 JSON Schema——不允许 `.transform()`/`.preprocess()`） |
| `@opentui/solid` | 可选 | TUI sidebar/dialog 渲染（SolidJS 组件） |

### zod 约束

Tool 参数 schema 必须可表示为 JSON Schema。这意味着：
- ❌ `z.string().transform(s => s.trim())` —— 不可表示为 JSON Schema，会导致 plugin 加载失败
- ❌ `z.preprocess(input => ..., z.string())` —— 同上
- ✅ `z.string().min(1).max(32768)` —— 可以
- ✅ `z.enum(["parallel", "pipeline", "loop"])` —— 可以
- ✅ `z.object({ ... })`（仅含 JSON Schema 兼容字段）—— 可以

---

## 15. 参考实现

本设计基于以下源码级研究：

1. **`oh-my-openagent`** v4.9.2（`code-yeongyu/oh-my-openagent`，原 `oh-my-opencode`）—— team mode 架构的参考：文件 mailbox、Transform hook 注入、idle wake-hint、协作关闭、worktree 隔离、资源边界、agent 资格。

2. **`aft`** plugin（本地安装）—— `PluginContext` 闭包模式、tool 工厂组织、SQLite 持久化的参考（OCTeam 使用文件代替，但模式类似）。

3. **`magic-context`** plugin（本地安装）—— `experimental.chat.messages.transform` hook 使用、session 级状态管理、advisory locking 的参考。

4. **`OCBuddy`** plugin（本地安装）—— TUI plugin module 结构、`api.ui.dialog.replace`、`api.command.register`、`api.slots.register`（sidebar slot）、`api.state`/`api.event`/`api.kv` 数据获取模式的参考。

5. **OpenCode 1.17.7** 源码 + SDK 1.4.7 类型定义——用于 API 调用形态验证。
