# OCTeam — OpenCode 多 Agent 编排 Plugin

## 概述

一个为 OpenCode 实现确定性多 Agent 编排的 plugin。允许用户创建 agent 团队，使 agent 之间能够通信、协作，并以 **parallel**（并行）、**pipeline**（流水线）、**loop**（循环）或 **delegate**（委派认领）模式执行任务——这些协调模式是参考实现（`oh-my-openagent` 的 team mode，仿照 Claude Code Agent Teams 设计）所不提供的。

### 设计原则

**完全作为 OpenCode plugin 构建——对 OpenCode 核心零改动。** plugin 利用公开的 Plugin API（`@opencode-ai/plugin`）和 SDK（`@opencode-ai/sdk`）来编排 agent session。每个 agent 是一个常规的 OpenCode session，通过 `parentID` 关联回 leader。

### 与 `oh-my-openagent` Team Mode 的差异

| 方面 | `oh-my-openagent`（参考实现） | OCTeam（本设计） |
|---|---|---|
| 协调模型 | 委派 + 认领（pull-based tasklist） | 确定性 push-based 调度 |
| 编排模式 | 无（通过 leader prompt 涌现） | `team_parallel`、`team_pipeline`、`team_loop`、`team_delegate` |
| 通信 | 文件 mailbox + Transform hook 注入 | **相同**（从参考实现采纳） |
| 持久化 | 文件系统 JSON + 文件锁 | **相同**（从参考实现采纳） |
| 资源边界 | 5 种 bound 类型 | **相同**（从参考实现采纳） |
| 关闭协议 | 协作式（request/approve/reject） | **相同**（从参考实现采纳） |
| Worktree 隔离 | 每 member 一个 git worktree | **相同**（从参考实现采纳） |

OCTeam 采纳了参考实现的全部健壮性基础设施，并在此之上增加了**确定性编排语义**。

### 开发阶段

本插件分两个阶段开发：

- **Phase 1（Session Navigator）**：在 sidebar 中显示当前 session 的所有 child session（subagent/background task），点击切换查看。这是 Team sidebar 的前置基础设施。独立设计文档见 [Session Navigator 设计](./SESSION_NAVIGATOR_DESIGN.zh.md)。
- **Phase 2（Team 编排）**：在 Phase 1 基础上增加 team 编排功能（parallel/pipeline/loop/delegate + slash commands + mailbox + persistence）。即本文档的主体内容。

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
│  │  │ (15 tools)  │  │ (session.    │  │ (messages.     │  │  │
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
    | "live"                           // config written, no sessions spawned yet
    | "busy"                           // sessions spawned, workflow running
    | "idle"                           // sessions spawned, idle (workflow completed)
    | "failed"                         // agent error or task incomplete (e.g. loop max rounds reached without done)
    | "dead"                           // marked for deletion, about to be cleaned up
    | "disabled"                       // team disabled, cannot be used (e.g. by /team_shutdown_request)

type RuntimeMember = {
    name: string
    sessionId?: string                  // set after session.create succeeds
    model?: string
    agent?: string
    status: MemberStatus
    initialized: boolean                // B3: true after role-setup prompt completes (member idled once).
                                        //   Event handler IGNORES idles until initialized, preventing
                                        //   role-setup idle from being captured as a task result.
    worktreePath?: string               // absolute path to git worktree
    pendingMessageCount: number         // unread messages in mailbox
    turnCount: number                   // M4: incremented per promptAsync dispatch; checked vs bounds.maxMemberTurns
    lastTurnMarker?: string             // for Transform hook injection dedup
    lastNotifiedAt?: number             // delegate: epoch ms of last "tasks available" re-prompt;
                                        //   used to rate-limit re-prompts (avoid claim-race busy-loop)
    retryingSince?: number              // B2: epoch ms when session entered "retry"; escalated to errored after TTL
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

### Team（运行时对象，非持久化）

`RuntimeState` 是**持久化数据**（`state.json`）。handler 操作的是 `Team`——一个**进程级缓存的运行时对象**，包裹 `RuntimeState` 并附加非持久化的运行时句柄（mutex、解析后的工作目录）。

```ts
type Team = RuntimeState & {
    mutex: AsyncMutex                    // per-teamName singleton; serializes event-handler state mutations
    directory: string                   // resolved project/team working directory
}
```

**关键：mutex 必须是 per-teamName 进程级单例**。否则若每次 `loadTeamState` 返回新对象、新 mutex，则并发 idle 会获取不同的 mutex → 串行化失效 → 状态损坏。

```ts
// 进程级注册表：teamName → Team（含其单例 mutex）
const teamRegistry = new Map<string, Team>()

async function loadTeamState(teamName: string): Promise<Team> {
    let team = teamRegistry.get(teamName)
    if (!team) {
        // First load: create Team with a fresh mutex, read state.json into it
        const state = await readStateFile(teamName)        // parse state.json
        team = { ...state, mutex: new AsyncMutex(), directory: resolveTeamDir(teamName) }
        teamRegistry.set(teamName, team)
    } else {
        // Subsequent loads: refresh persisted fields, KEEP the same mutex
        const state = await readStateFile(teamName)
        Object.assign(team, state)                          // mutex/directory preserved
    }
    return team
}
```

`saveTeamState(team)` 将 `team` 的持久化字段（即 `RuntimeState` 部分）经 `withLock` + `atomicWrite` 写回 `state.json`。`mutex`/`directory` 不写入磁盘。plugin 重启后 `teamRegistry` 为空，首次访问各 team 时重建（单实例，安全）。

### sessionID → member 索引（#6 修复——避免热路径扫盘）

`resolveTeamMember(sessionID)` 被 **Transform hook 在每个 session 的每次 chat turn 调用**（包括与 team 无关的用户 session）+ 每个 `session.idle` 调用。若每次都扫描所有 `state.json` 文件判断「是不是 member」，会对**全部 OpenCode 使用**施加 I/O 开销。

用进程级内存索引 O(1) 解析：

```ts
// sessionID → { teamName, memberName } | { teamName, isMaster: true }
const sessionIndex = new Map<string, { teamName: string; memberName: string; isMaster?: boolean }>()

// Built at ensureMembersReady (member sessions) and team_create (leadSessionId → master).
// Invalidated at team_delete. Rebuilt from disk on plugin restart (scan once, not per-turn).
async function resolveTeamMember(sessionID: string): Promise<RuntimeMember & { teamName: string; teamRunId: string } | null> {
    const hit = sessionIndex.get(sessionID)
    if (!hit) return null              // O(1) reject for non-member sessions (the common case)
    const team = await loadTeamState(hit.teamName)
    if (hit.isMaster) {
        // B1: synthetic master pseudo-member (not persisted, not in members[])
        return { name: "master", isMaster: true, status: "idle", initialized: true,
                 pendingMessageCount: 0, turnCount: 0,
                 teamName: team.teamName, teamRunId: team.teamRunId } as any
    }
    const member = team.members.find(m => m.name === hit.memberName)
    return member ? { ...member, teamName: team.teamName, teamRunId: team.teamRunId } : null
}
```

> **多 team 共享 leader 的已知限制**：若同一 session 是多个 team 的 leader，`sessionIndex` 只能映射到一个（最后写入者）。设计上建议一个交互 session 同一时间只 active 一个 team；`team_create` 在 leader 已有 active team 时应警告。

### ActiveTask

每个 team 同一时间只能运行一个编排（parallel/pipeline/loop/delegate）。在已有活跃编排时调用新的编排 tool 会返回错误。

```ts
type ActiveTask = {
    type: "parallel" | "pipeline" | "loop" | "delegate"
    mode?: "isolated" | "collaborative" | "discussion"   // parallel only
    startedAt: number
    wallClockTimeoutMs: number          // hard timeout, default 300000 (5 min)
    tokenBudget?: number                // optional cost cap
    tokensUsed: number                  // running total = sum of tokensByMember (recomputed, never +=)
    tokensByMember: Record<string, number>  // memberName → Σ(input+output+reasoning) over that
                                        //   member's assistant messages. Recomputed per idle to AVOID
                                        //   double-counting (each idle re-reads full message history).
                                        //   Source: session.messages info.tokens — NOT session.status (M5).

    // result collection (serializable — NOT a Map)
    responses: Record<string, string>   // memberName → last assistant text output (NOT used for delegate)

    // parallel mode
    task?: string                       // isolated: uniform task
    tasks?: Record<string, string>      // collaborative: per-member tasks
    topic?: string                      // discussion: debate topic
    maxRounds?: number                  // discussion/loop: round limit
    currentRound?: number

    // delegate mode: uses shared tasklist (team_task_*), no extra fields needed

    // pipeline / loop: ordered stages
    stages: Stage[]
    currentStageIndex: number

    // loop-specific
    deciderMember?: string              // member name of decider (NOT "leader")
    decisionHistory: DecisionRecord[]   // structured decisions per round
    decisionParseFailures: number       // consecutive <decision> parse failures; loop aborts at 3

    // discussion-specific (parallel mode === "discussion")
    consensusReached?: boolean          // set when all members emit <consensus>{"agreed":true}</consensus>
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

4. **Task 认领锁 + stale-claim reaper**：`team_task_update` 设置 `status: "claimed"` 时通过 `fs.open(lockPath, 'wx')` 获取 `tasks/claims/{taskId}.lock`。

   **关键一致性（Oracle 发现）**：锁文件与 `Task.status` 是两份独立状态。若 member 认领后崩溃，锁在 TTL（30s）后过期，但 `Task.status` 仍是 `"claimed"` → 任务进入「锁可用但状态为 claimed」的 limbo，`handleDelegateIdle` 的 `claimable` 过滤（`status === "pending"`）会跳过它，造成假死锁。**reaper 必须同时复位两者**：sweep timer 周期性扫描 claimed 任务，若其锁文件已过期（或不存在）且 `claimedAt` 超过 TTL，则将 `Task.status` 从 `"claimed"` 复位为 `"pending"`，使其可被重新认领。

   ```ts
   // Run by the sweep timer (Section 6). Reconciles claim-lock TTL with Task.status.
   async function reapStaleClaims(team: Team): Promise<void> {
       for (const task of await listAllTasks(team.teamRunId)) {
           if (task.status !== "claimed") continue
           const lockAlive = await lockFresh(claimLockPath(team.teamRunId, task.id))  // exists & within TTL
           if (!lockAlive && Date.now() - (task.claimedAt ?? 0) > CLAIM_TTL_MS) {
               await updateTask(team.teamRunId, task.id, { status: "pending", owner: undefined })
           }
       }
   }
   ```

### 崩溃恢复

plugin 启动时，server hook 扫描 `~/.octeam/teams/` 并：
1. 对每个 `status: "live"` 的 team → 无需处理（无 session）。
2. 对每个 `status: "busy"` 的 team → 通过 `client.session.status()` 检查 member session 是否仍存在。若 session 失效，清除 stale mailbox 预约，将 team 转为 `"failed"`。若 session 存活，转为 `"idle"`（中断的 workflow 已无法恢复）。
3. 对每个 `status: "idle"` 的 team → 同上检查 session 存活性。将 stale member 标记为 `"errored"`。
4. 对每个 `status: "failed"` 或 `status: "disabled"` 的 team → 无需处理（终态，等待用户决定是否 `team_delete` 或重新拉起）。

失效的 team 可通过 `team_delete({ force: true })` 清理，或下次 workflow 调用时由 `ensureMembersReady` 重新拉起 session。

---

## 4. Tools

### 4.0 Slash Commands（用户交互入口）

用户通过 slash 命令管理 team 和激活工作流。Slash command 不绕过 master agent——**master session 接收 slash command 指令后，自行调用对应的 tool**。Tool 逻辑保持不变（见 4.1–4.10），slash command 是 TUI 层的用户便捷入口。

| 命令 | 作用 | master 接收后的行为 |
|---|---|---|
| `/team_create` | 打开创建 team 对话框，配置 member/role/model | master agent 调用 `team_create` tool |
| `/team_delete` | 清空 `.octeam/teams/` 目录（强制删除所有 team） | master agent 调用 `team_delete({ force: true })` 逐个清理 |
| `/team_status` | 显示当前 team 状态（member 列表、编排进度、token 使用） | master agent 调用 `team_status` tool，结果注入 sidebar/dialog |
| `/team_shutdown_request` | 停止接受新任务，解散当前 team（协作关闭） | master agent 调用 `team_shutdown_request` 对所有 member 发起关闭，team 转为 `"disabled"` |
| `/team_parallel [task]` | 以 parallel 模式执行 | master agent 调用 `team_parallel({ task })` |
| `/team_pipeline [task]` | 以 pipeline 模式执行 | master agent 调用 `team_pipeline({ stages, task })` |
| `/team_loop [task]` | 以 loop 模式执行 | master agent 调用 `team_loop({ stages, decider, initial_task })` |
| `/team_delegate [tasks]` | 以 delegate 模式执行（member 自主认领任务） | master agent 调用 `team_delegate({ tasks })` |

**工作流命令的 UX**：用户在 prompt 中输入 `/team_parallel <任务描述>`。slash command handler 提取任务文本，通过 `promptAsync` 向 master session 发送指令（如 `"请使用 team_parallel tool 执行以下任务：<任务描述>"`）。master agent 接收后调用对应 tool。pipeline/loop 的 member 顺序由 team 创建时的声明顺序决定。

**注意**：slash command 的参数传递机制（`onSelect` 如何读取 prompt 文本中的 inline 参数）需在 Phase 2.0 验证。如不支持 inline 参数，则改为：command 触发后通过 dialog 收集 task 再发送给 master。

> Slash command 注册在 TUI module 中通过 `api.command.register({ slash: { name: "..." }, onSelect: ... })` 完成。所有 tool（4.1–4.10）保持不变，agent 可直接调用，也可经 slash command 触发。

所有 tool 通过 `@opencode-ai/plugin/tool` 的 `tool()` 函数注册。调用 session 通过 `execute(args, context)` 签名中的 `context.sessionID` 识别——无需手动 caller-ID 传递。

### 4.1 `team_create`

创建（定义）一个 team。**不 spawn member sessions**——仅写入配置文件。Session 在 workflow tool（`team_parallel`/`team_pipeline`/`team_loop`）首次执行时按需拉起（见 `ensureMembersReady`）。

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
3. 写入 `config.json`（TeamSpec）+ 初始 `state.json`（status: `"live"`，所有 member 的 `sessionId: undefined`、`status: "pending"`）。
4. **不创建 session、不发送 prompt、不创建 worktree**。这些延迟到 workflow tool 执行时。
5. 返回 team 摘要（不含 session ID，因为尚未创建）。

**Session 按需拉起（`ensureMembersReady`，含 role-setup barrier — B3 修复）**：

`team_parallel`/`team_pipeline`/`team_loop`/`team_delegate` 的 tool handler 在写入 `activeTask` 前，先 `await ensureMembersReady(team)`，然后设置 `team.status = "busy"`，再写入 `activeTask` 并发出首批 prompt。

**关键（B3）**：`ensureMembersReady` 必须**等待所有 member 完成 role-setup（即各自 idle 一次）后才返回**。否则存在竞态：member 的 role-setup idle 会在 `activeTask` 写入后、首个任务 dispatch 前到达，被 event handler 当作 stage 结果捕获并错误推进 pipeline。通过 `initialized` 标志 + readiness barrier 消除此竞态：

```ts
async function ensureMembersReady(team: Team): Promise<void> {
    const toSpawn = team.members.filter(m => !m.sessionId)
    if (toSpawn.length === 0) return    // team reused; all sessions live & initialized

    // Spawn in batches of maxParallelMembers (concurrent session.create + role-setup)
    for (const batch of chunk(toSpawn, team.bounds.maxParallelMembers)) {
        await Promise.all(batch.map(async member => {
            // 1. Worktree (if configured)
            if (member.worktree) {
                member.worktreePath = await createWorktree(team.teamName, member.name)
            }
            // 2. Create child session
            const result = await client.session.create({
                body: { parentID: team.leadSessionId, title: `${team.teamName}/${member.name}` },
                query: { directory: member.worktreePath ?? team.directory },
            })
            member.sessionId = result.data.id
            member.status = "running"        // running role-setup, NOT yet idle
            member.initialized = false
            // 3. Send role-setup prompt (members will idle when done)
            await client.session.promptAsync({
                path: { id: member.sessionId },
                body: {
                    parts: [{ type: "text", text: buildRolePrompt(member, team), synthetic: true }],
                    agent: member.agent ?? "build",
                },
            })
            member.turnCount = 1
        }))
        await saveTeamState(team)
    }

    // 4. ROLE-SETUP BARRIER: wait until every spawned member has idled once.
    //    The event handler sets member.initialized = true on the FIRST idle of an
    //    uninitialized member, then returns WITHOUT capturing output or advancing.
    await waitUntil(
        () => toSpawn.every(m => team.members.find(x => x.name === m.name)?.initialized),
        { timeoutMs: 120_000, pollMs: 250 },
    )
    // If timeout: mark non-idle members errored, throw — tool handler reports failure.
}
```

> `waitUntil(predicate, opts)` 轮询 `predicate`（每 `pollMs`），在为真时 resolve，超时则 reject。`chunk(arr, n)` 将数组分批。两者为小工具函数。

**优势**：
- 创建 team 零开销（无 session、无 LLM 调用）
- Team 可创建后多次使用（多个 workflow 复用同一组 session）
- 首次 workflow 调用时统一 spawn，避免创建即浪费

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

**初始 dispatch**（三种模式共用）：tool handler 先调用 `ensureMembersReady(team)` 拉起尚未创建的 member sessions，然后写入 `activeTask` 并**立即**发出首批 prompt——isolated 向所有 member 发送同一 `task`；collaborative 按 `tasks` 映射分别发送；discussion 向所有 member 发送 `topic`（round 0）。此后由 barrier 收集并推进。

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
- **初始 dispatch**：tool handler 先调用 `ensureMembersReady(team)`，然后写入 `activeTask`（`currentStageIndex=0`）后，**立即**对 `stages[0].member` 调用 `promptAsync` 发出首个任务，启动流水线。此后由 event handler 的身份校验逐 stage 推进。

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

**初始 dispatch**：tool handler 先调用 `ensureMembersReady(team)`，然后写入 `activeTask`（`currentRound=1`、`currentStageIndex=0`）后，**立即**对 `stages[0].member` 发送 `initial_task`，启动首轮。若 `decider` 不在 `stages` 中，先自动追加为最终 read_only stage 再 dispatch。

### 4.5 `team_delegate`

委派模式（pull-based 自组织）：leader 发布一组任务到共享 tasklist，idle 的 member 自主认领、执行、交付结果，循环直到所有任务完成。

```
team_delegate({
    team_id: "auth-team",
    tasks: [
        { ref: "task-1", subject: "Implement JWT login",  description: "...", blockedBy: [] },
        { ref: "task-2", subject: "Write unit tests",     description: "...", blockedBy: ["task-1"] },
        { ref: "task-3", subject: "Add rate limiting",    description: "...", blockedBy: [] },
        { ref: "task-4", subject: "Security review",      description: "...", blockedBy: ["task-1", "task-3"] },
    ],
    timeout_ms: 600000
})
```

**位置引用 → UUID 映射（#4 修复）**：输入用 `ref`（人可读的临时标识）声明依赖，`Task.id` 是生成的 UUID。`team_delegate` handler 必须先创建所有 task、捕获返回的 UUID、建立 `ref → uuid` 映射，再重写 `blockedBy`：

```ts
// 1. Create all tasks first, building ref → uuid map
const refToUuid = new Map<string, string>()
for (const t of input.tasks) {
    const created = await createTask(team.teamRunId, { subject: t.subject, description: t.description })
    if (t.ref) refToUuid.set(t.ref, created.id)
}
// 2. Resolve blockedBy refs → uuids (unknown refs are an input error)
for (const t of input.tasks) {
    const uuid = refToUuid.get(t.ref)!
    const blockedBy = (t.blockedBy ?? []).map(r => {
        const dep = refToUuid.get(r)
        if (!dep) throw new ToolError(`team_delegate: unknown blockedBy ref "${r}"`)
        return dep
    })
    await updateTask(team.teamRunId, uuid, { blockedBy })
}
```

**与 parallel/pipeline/loop 的核心差异**：

| 方面 | parallel/pipeline/loop | delegate |
|---|---|---|
| 任务分配 | 编排器 push 到指定 member | member pull 自主认领 |
| 执行顺序 | 确定性（固定 stage/round） | 非确定（取决于 member 空闲 + 任务依赖） |
| Barrier | 需要同步等待 | 无 barrier，各自独立 |
| 任务依赖 | 无 | 支持（`blockedBy`） |

**流程**：
```
1. tool handler 调用 ensureMembersReady(team) 拉起 sessions
2. 创建所有 task 到共享 tasklist（内部调用 team_task_create）
3. 设置 team.status = "busy"，写入 activeTask（type: "delegate"）
4. 向每个 member 发送初始 prompt：
   "你是 team X 的成员。请用 team_task_list 查看可用任务，
    用 team_task_update 认领任务，执行后用 team_send_message
    向 master 报告结果，然后检查是否有更多任务。"
5. member idle 时 → event handler 检查：
   a. 所有 task 已完成 → 交付摘要给 leader，status = "idle"
   b. 有可认领 task → re-prompt member 检查 tasklist（受 lastNotifiedAt 限流）
   c. 无可认领 task 且所有 member idle → 死锁，status = "failed"
```

**re-prompt 限流（#10 修复，避免认领竞争 busy-loop）**：多个 idle member 竞争少量可认领 task 时，输家会反复被 re-prompt、认领失败、再被 re-prompt——每次空烧一个 LLM turn。用 `member.lastNotifiedAt` 限流：同一 member 在 `NOTIFY_COOLDOWN_MS`（默认 10s）内不重复 re-prompt；且仅在可认领数 > 当前 running member 数时才值得再叫醒额外 member。

**任务依赖处理**：task 的 `blockedBy` 中引用的 task 全部 `completed` 后才可被认领。这允许构建复杂工作流（如 "写测试" 依赖 "写功能"，"安全审查" 依赖 "写功能"+"加速率限制"）。

**动态任务**：执行期间 leader 可通过 `team_task_create` 追加新任务。idle member 会在下一次检查时发现并认领。

**退出条件**：
1. 所有 task 状态为 `completed` 或 `deleted`。
2. 死锁：无可认领 task（剩余 task 全被阻塞或已认领）且所有 member idle。
3. 超过 wall-clock timeout。
4. Token 预算耗尽。
5. Member 出错。

**Delegate Handler**（Section 6 event handler 的 `case "delegate"`）：

```ts
async function handleDelegateIdle(team: Team, member: RuntimeMember) {
    const tasks = await listAllTasks(team.teamRunId)
    const incomplete = tasks.filter(t => t.status !== "completed" && t.status !== "deleted")

    // All done?
    if (incomplete.length === 0) {
        await deliverSummaryToLeader(team, "delegate_complete")
        team.activeTask = undefined
        team.status = "idle"
        return
    }

    // Check claimable tasks (pending + all blockers completed)
    const claimable = incomplete.filter(t =>
        t.status === "pending" &&
        t.blockedBy.every(id => tasks.find(x => x.id === id)?.status === "completed")
    )

    // Deadlock: no claimable tasks and all members idle
    if (claimable.length === 0) {
        const allIdle = team.members.every(m => m.status === "idle" || !m.sessionId)
        if (allIdle) {
            await deliverSummaryToLeader(team, "delegate_deadlock")
            team.activeTask = undefined
            team.status = "failed"
            return
        }
        return  // some members still running, wait
    }

    // Re-prompt this member to check tasklist — RATE-LIMITED (#10) to avoid claim-race busy-loop.
    const now = Date.now()
    if (member.lastNotifiedAt && now - member.lastNotifiedAt < NOTIFY_COOLDOWN_MS) {
        return  // recently notified; let the claim race settle before re-prompting
    }
    // Only wake if there are more claimable tasks than members already working on them.
    const running = team.members.filter(m => m.status === "running" && !m.isMaster).length
    if (claimable.length <= running) {
        return  // enough members already heading for the available tasks
    }
    member.lastNotifiedAt = now
    await client.session.promptAsync({
        path: { id: member.sessionId! },
        body: {
            parts: [{
                type: "text",
                text: `[Team Orchestrator] You have completed your task. ${claimable.length} task(s) available. Use team_task_list to check, team_task_update to claim, execute, then team_send_message to report to master. Repeat until no tasks remain.`,
                synthetic: true,
            }],
        },
    })
    member.status = "running"
    member.turnCount++
}
```

### 4.6 `team_send_message`

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

### 4.7 `team_task_create` / `team_task_list` / `team_task_update` / `team_task_get`

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

**认领语义**：`status: "claimed"` 原子获取 `tasks/claims/{taskId}.lock` **并校验 `Task.status === "pending"`**（双重检查：锁可用 + 状态一致）。如果另一个 member 已认领（锁被占用或状态非 pending），返回 `TaskAlreadyClaimedError`。这实现了协作模式下的 pull-based 任务分配。崩溃遗留的 stale claim 由 sweep timer 的 `reapStaleClaims` 复位（见 §3 并发原语）。

### 4.8 `team_shutdown_request`

发起对某个 member 的协作关闭。

```
team_shutdown_request({
    team_id: "auth-team",
    member: "coder"                     // target member name
})
```

**仅限 master**。向 member 的 mailbox 发送 `shutdown_request` 消息。member 看到请求（通过 Transform hook 注入）后可以批准或拒绝。

### 4.9 `team_approve_shutdown` / `team_reject_shutdown`

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

批准后：member 状态 → `"shutdown_approved"`。Worktree 被清理。如果所有 member 都已批准/关闭，team 转为 `"dead"`。

### 4.10 `team_status` / `team_list`

```
team_status({ team_id: "auth-team" })
// Returns: {
//   status: "busy",
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
// Returns: [{ name: "auth-team", status: "idle", members: 3 }, ...]
```

### 4.11 `team_delete`

```
team_delete({
    team_id: "auth-team",
    force?: false                       // if true, skip cooperative shutdown
})
```

**非 force（默认）**：要求所有 member 为 `shutdown_approved` 或 `completed`。如果有 member 仍为 `running`，返回错误并建议使用 `team_shutdown_request`。

**Force**：立即将 team 转为 `"dead"`，取消所有 pending worktree，删除状态文件。Session 不被删除（历史记录保留在 OpenCode 的 DB 中）。这是崩溃恢复路径。

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

// Shared formatter for injected mailbox content (Transform hook + master drain path),
// so the user/member sees a consistent format regardless of delivery route.
function formatMailboxInjection(msgs: Message[]): string {
    return msgs.map(m =>
        `<team_message from="${m.from}"${m.correlationId ? ` correlationId="${m.correlationId}"` : ""}>\n`
        + `${m.body}\n</team_message>`,
    ).join("\n\n")
}
```

### Reservation 协议（防止重复投递）

master 的 mailbox 被**两条路径** drain：(1) event handler 在 master idle 时的 `deliverQueuedResultsToMaster`，(2) Transform hook 在 master 下一 turn。member 的 mailbox 只被 Transform hook drain（单一 drainer，无竞争）。为防止 master 的双路径重复投递，**`pollMailbox` 必须是原子 read-and-reserve**，而非单纯读取。

**核心：`pollMailbox` 原子预约**。在文件锁下，将 inbox 中的消息移动到 `reserved/`，返回被移动的消息。两个 drainer 调用同一函数；先到者拿走消息并 reserve，后到者看到空 inbox → 不重复投递。

```ts
// Atomic read-and-reserve under file lock. Returns the messages THIS caller reserved.
async function pollMailbox(teamRunId: string, recipient: string): Promise<Message[]> {
    return withLock(mailboxLockPath(teamRunId, recipient), async () => {
        const inbox = await readJsonl(inboxPath(teamRunId, recipient))   // {recipient}.jsonl
        if (inbox.length === 0) return []
        // Move each message to reserved/{messageId} (atomic rename), stamp reservedAt.
        for (const msg of inbox) {
            await atomicWrite(
                reservedPath(teamRunId, recipient, msg.id),
                JSON.stringify({ ...msg, deliveryStatus: "delivered", reservedAt: Date.now() }),
            )
        }
        await truncateFile(inboxPath(teamRunId, recipient))   // clear inbox in same lock
        return inbox
    })
}

// Commit reserved → processed (delivery confirmed). Removes the reserved files.
async function ackMessages(teamRunId: string, recipient: string, msgs: Message[]): Promise<void> {
    for (const msg of msgs) {
        await appendJsonl(processedPath(teamRunId, recipient), { ...msg, deliveryStatus: "processed" })
        await rm(reservedPath(teamRunId, recipient, msg.id))
    }
}

// Reaper (run by the sweep timer): release reserved messages older than TTL back to inbox.
// Covers the crash-between-reserve-and-ack case.
async function releaseStaleReservations(teamRunId: string, recipient: string): Promise<void> {
    return withLock(mailboxLockPath(teamRunId, recipient), async () => {
        for (const r of await listReserved(teamRunId, recipient)) {
            if (Date.now() - r.reservedAt > RESERVATION_TTL_MS) {   // default 30000
                await appendJsonl(inboxPath(teamRunId, recipient), { ...r, deliveryStatus: "pending" })
                await rm(reservedPath(teamRunId, recipient, r.id))
            }
        }
    })
}
```

**流程**：
1. drainer 调用 `pollMailbox` → 原子地把 inbox 消息移入 `reserved/` 并返回。
2. drainer 投递（Transform 注入 / master promptAsync）。
3. 成功后调用 `ackMessages` → `reserved/` → `processed.jsonl`。
4. 若投递前崩溃 → 消息滞留 `reserved/` → sweep timer 的 `releaseStaleReservations`（TTL 30s）将其放回 inbox 重新投递。

**`countUnreadMessages` 只数 inbox**（不含 reserved），因此已预约的消息不会触发重复 wake-hint。

### Idle Wake-Hint

在 `session.idle` 事件时，如果 member 有未读消息，plugin 通过 `promptAsync` 发送 wake hint。这对每个 member 限制为每 30 秒最多一次，以防止唤醒循环。

---

## 6. 事件处理——带锁状态机

plugin 通过 `Hooks.event` hook 订阅事件。这是一个**单一 handler**，接收所有事件类型——必须在内部通过 `event.type` 过滤。除 `session.idle` 外，还处理 `session.status`（B2：捕获 retry/error）。另有一个独立的 **sweep timer**（B1）兜底丢失的 idle 事件。

### 核心 Handler

```ts
event: async ({ event }) => {
    // B2: session.status carries retry/error signals that session.idle does NOT.
    if (event.type === "session.status") {
        await handleStatusEvent(event)
        return
    }
    if (event.type !== "session.idle") return

    const sessionID = event.properties.sessionID
    const member = await resolveTeamMember(sessionID)
    if (!member) return  // not a team member

    const team = await loadTeamState(member.teamName)

    // --- Acquire per-team mutex (prevents concurrent state corruption) ---
    await team.mutex.runExclusive(async () => {
        await processIdle(team, member, sessionID)
    })
}

async function processIdle(team: Team, member: RuntimeMember, sessionID: string) {
    // --- Step 0: Master special case (B1 fix): master is a synthetic member.
    //     Deliver any queued team results, then return. Master NEVER dispatches. ---
    if (member.isMaster) {
        await deliverQueuedResultsToMaster(team, sessionID)
        return
    }

    // --- Step 1: Update member status ---
    member.status = "idle"
    member.retryingSince = undefined        // B2: idle clears any retry tracking

    // --- Step 1.5: Role-setup barrier (B3): the FIRST idle of an uninitialized member
    //     marks it ready and returns WITHOUT capturing output or advancing. This
    //     prevents the role-setup response from being mistaken for a task result. ---
    if (!member.initialized) {
        member.initialized = true
        await saveTeamState(team)
        return
    }

    // --- Step 2: Token accounting (B2/#2): recompute this member's token tally from
    //     full message history (recompute, never +=, to avoid double-counting). ---
    const msgs = await client.session.messages({ path: { id: sessionID } })
    if (team.activeTask) {
        team.activeTask.tokensByMember[member.name] = sumMemberTokens(msgs.data)
        team.activeTask.tokensUsed = Object.values(team.activeTask.tokensByMember)
            .reduce((a, b) => a + b, 0)
    }

    // --- Step 3: Identity validation (prevent stray idle from advancing stages) ---
    if (team.activeTask) {
        const expectedMember = getExpectedMember(team.activeTask)
        if (expectedMember && member.name !== expectedMember) {
            await saveTeamState(team)   // persist token tally; do NOT advance
            return
        }
    }

    // --- Step 4: Capture this member's output (NULL-GUARDED + mode-aware).
    //     delegate does NOT use responses[] (per-task results go to master via
    //     team_send_message; capturing here would overwrite — see #3). ---
    if (team.activeTask && team.activeTask.type !== "delegate") {
        const lastAssistant = msgs.data?.findLast(m => m.info?.role === "assistant")
        if (lastAssistant) {
            const text = extractTextFromParts(lastAssistant.parts)
            team.activeTask.responses[member.name] = truncateOutput(text)
        }
    }

    await saveTeamState(team)

    // --- Step 5: Check for unread messages first ---
    const unread = await countUnreadMessages(member.teamRunId, member.name)
    if (unread > 0) {
        // Transform hook will inject on next turn; just send wake hint
        await sendWakeHint(client, sessionID, unread)
        return
    }

    // --- Step 6: Dispatch based on active task type ---
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
        case "delegate":
            await handleDelegateIdle(team, member)
            break
    }

    // --- Step 7: Check termination conditions ---
    await checkTermination(team)
}
```

### B2：session.status 处理（retry/error 升级）

`session.idle` 不携带错误信号；retry 中的 member 永不 idle。订阅 `session.status` 捕获这两类状态，避免 barrier 无限等待（旧设计中 `checkTermination` 的 member-error 分支是死代码）。

```ts
async function handleStatusEvent(event: { properties: { sessionID: string } }) {
    const sessionID = event.properties.sessionID
    const member = await resolveTeamMember(sessionID)
    if (!member || member.isMaster) return

    const team = await loadTeamState(member.teamName)
    await team.mutex.runExclusive(async () => {
        const status = (await client.session.status()).data?.[sessionID]
        if (status?.type === "retry") {
            // Track first retry; escalate to errored after sustained retry TTL (default 60s)
            member.retryingSince ??= Date.now()
            if (Date.now() - member.retryingSince > RETRY_ESCALATION_MS) {
                member.status = "errored"
                member.error = `sustained retry > ${RETRY_ESCALATION_MS}ms: ${status.message ?? "unknown"}`
                await saveTeamState(team)
                await checkTermination(team)   // member-error branch now fires
            }
        } else if (status?.type === "idle") {
            member.retryingSince = undefined
        }
    })
}
```

### B1：Sweep Timer（丢失 idle 事件兜底）

barrier 模式被单个丢失的 `session.idle` 永久卡住。sweep timer 周期性轮询 `session.status()`——若某 member 在 OpenCode 中已 `idle` 但 plugin 状态仍 `running`（事件丢失），补触发 `processIdle`。这是确定性模式可靠性的关键兜底。

```ts
// Started in server() init; one interval for the whole plugin.
function startSweepTimer() {
    setInterval(async () => {
        const statusMap = (await client.session.status()).data ?? {}
        for (const team of teamRegistry.values()) {
            if (!team.activeTask) continue
            await team.mutex.runExclusive(async () => {
                // 1. Reclaim stale resources (crash recovery for in-flight orchestration)
                await releaseStaleReservations(team.teamRunId, "master")   // mailbox reservations
                for (const m of team.members) {
                    await releaseStaleReservations(team.teamRunId, m.name)
                }
                if (team.activeTask.type === "delegate") {
                    await reapStaleClaims(team)   // claim-lock TTL vs Task.status reconciliation
                }
                // 2. Wall-clock / budget / error checks run even if no idle arrives
                await checkTermination(team)
                if (!team.activeTask) return
                // 3. Missed-idle reconciliation
                for (const member of team.members) {
                    if (!member.sessionId || member.status !== "running") continue
                    if (statusMap[member.sessionId]?.type === "idle") {
                        // Missed idle event — reconcile by re-entering the idle path
                        await processIdle(team, member, member.sessionId)
                    }
                }
            })
        }
    }, SWEEP_INTERVAL_MS)   // default 15000
}
```

> sweep timer 承担三项兜底：(1) 释放 stale mailbox 预约 + 复位 stale claim（崩溃恢复）；(2) 定期调用 `checkTermination`，使 wall-clock timeout / budget / member-error 即使在完全没有 idle 事件到达时也能触发；(3) 补触发丢失的 idle。不再依赖 idle 作为唯一驱动。

### getExpectedMember（M3：按模式区分）

Step 2 的身份校验依赖 `getExpectedMember`。**关键**：parallel 模式下所有 member 并发运行，必须返回 `null`（接受所有 member 的 idle）；pipeline/loop 仅当前 stage 的 member 可推进状态机。若错误地为 parallel 返回单个 member 名，其余 member 的 idle 会被丢弃，并行将退化为串行——这是设计中需明确规避的 footgun。

```ts
function getExpectedMember(task: ActiveTask): string | null {
    // parallel (isolated/collaborative/discussion): all members run concurrently
    //   → accept EVERY member's idle event
    if (task.type === "parallel") return null
    if (task.type === "delegate") return null   // all members run independently
    // pipeline / loop: only the current stage's member may advance the state machine
    return task.stages[task.currentStageIndex]?.member ?? null
}
```

### Barrier 原语（仅 parallel 模式使用）

**重要澄清**：barrier 不是所有模式共用的。pipeline/loop **不使用** `waitForBarrier`——它们通过 event handler 的身份校验（`getExpectedMember` 返回当前 stage 的 member）逐 stage 内联推进，每个 stage 本质是单 member 的隐式 barrier。**只有 parallel（isolated/collaborative/discussion）真正使用 `waitForBarrier`**，因为它需要等待 N 个并发 member 全部 idle。delegate 无 barrier。

`waitForBarrier` 是一个**幂等检查**（非阻塞）：在每次 idle 时由 `handleParallelIdle` 调用，检查所有参与 member 是否都已 idle；是则触发 `onBarrier` 推进，否则返回等待下一个 idle 再检查。

```ts
/**
 * Idempotent barrier check (NOT blocking). Called from handleParallelIdle on each
 * idle. If all participating members are idle, fires onBarrier exactly once for this
 * phase. The mutex (Section 6) guarantees onBarrier's status flips are atomic, so a
 * later idle in the same phase re-checks and sees members already "running" → no
 * double-fire.
 */
async function waitForBarrier(
    team: Team,
    memberNames: string[],
    onBarrier: () => Promise<void>,
): Promise<void> {
    const allIdle = memberNames.every(name => {
        const m = team.members.find(m => m.name === name)
        return m?.status === "idle"
    })
    if (allIdle) {
        await onBarrier()
    }
    // If not all idle, return; the next idle event re-checks.
    // Termination is enforced by checkTermination() + the sweep timer (Section 6).
}
```

### Parallel Handler（B1/#5 修复——此前未定义）

`handleParallelIdle` 覆盖 isolated/collaborative/discussion 三个子模式。它用 `waitForBarrier` 等待所有参与 member idle，再按子模式推进。

```ts
async function handleParallelIdle(team: Team, member: RuntimeMember) {
    const task = team.activeTask!
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await waitForBarrier(team, participants, async () => {
        // All participants idle → barrier reached for this phase.
        switch (task.mode) {
            case "isolated":
            case "collaborative":
                // Single barrier: collect all outputs → deliver to leader → done.
                await deliverSummaryToLeader(team, `parallel_${task.mode}_complete`)
                team.activeTask = undefined
                team.status = "idle"
                return

            case "discussion": {
                // Detect consensus from this round's outputs (structured protocol below).
                task.consensusReached = allMembersAgree(task.responses)
                if (task.consensusReached) {
                    await deliverSummaryToLeader(team, "discussion_consensus")
                    team.activeTask = undefined
                    team.status = "idle"
                    return
                }
                if (task.currentRound! >= task.maxRounds!) {
                    await deliverSummaryToLeader(team, "discussion_max_rounds")
                    team.activeTask = undefined
                    team.status = task.consensusReached ? "idle" : "failed"
                    return
                }
                // Next round: broadcast prior-round summary to all, reset to running.
                task.currentRound!++
                const summary = buildRoundSummary(task.responses)
                for (const m of team.members.filter(x => !x.isMaster)) {
                    await client.session.promptAsync({
                        path: { id: m.sessionId! },
                        body: { parts: [{
                            type: "text",
                            text: `[Discussion Round ${task.currentRound}] Others said:\n${summary}\n\n`
                                + `Respond, then emit <consensus>{"agreed": true|false}</consensus>.`,
                            synthetic: true,
                        }] },
                    })
                    m.status = "running"
                    m.turnCount++
                }
                return
            }
        }
    })
}

// Discussion consensus: every participant must emit <consensus>{"agreed":true}</consensus>
// in its latest output. Mirrors loop's <decision> structured-output protocol.
function allMembersAgree(responses: Record<string, string>): boolean {
    const texts = Object.values(responses)
    if (texts.length === 0) return false
    return texts.every(t => {
        const m = t.match(/<consensus>\s*(\{[\s\S]*?\})\s*<\/consensus>/)
        if (!m) return false
        try { return JSON.parse(m[1]).agreed === true } catch { return false }
    })
}
```

> **discussion 结构化共识协议**：每个 member 每轮输出末尾必须包含 `<consensus>{"agreed": true|false}</consensus>` 块（与 loop 的 `<decision>` 对称）。`allMembersAgree` 要求**全部** member 都 `agreed: true` 才算达成一致。round 0 的初始 prompt 与每轮 re-prompt 都需指示 member 输出此块。

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
        team.status = "idle"
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

    // Track consecutive parse failures (exit condition 6: abort at 3)
    if (decision.parseFailed) {
        task.decisionParseFailures++
        if (task.decisionParseFailures >= 3) {
            await deliverSummaryToLeader(team, "loop_complete:decision_parse_failure")
            team.activeTask = undefined
            team.status = "failed"
            return
        }
    } else {
        task.decisionParseFailures = 0   // reset on a successful parse
    }

    if (decision.decision === "done") {
        await deliverSummaryToLeader(team, "loop_complete:decider_done")
        task.decisionHistory.push(decision)
        team.activeTask = undefined
        team.status = "idle"
        return
    }

    // Check exit conditions
    if (task.currentRound! >= task.maxRounds!) {
        await deliverSummaryToLeader(team, "loop_complete:max_rounds")
        team.activeTask = undefined
        team.status = "failed"       // max rounds reached without decider done
        return
    }

    if (allReadOnlyStagesReportNoIssues(task)) {
        await deliverSummaryToLeader(team, "loop_complete:no_issues")
        team.activeTask = undefined
        team.status = "idle"
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

// parseFailed flags a missing/invalid <decision> block so handleLoopIdle can count
// consecutive failures (exit condition 6). On failure we default to "continue".
function parseDecision(rawText: string): DecisionRecord & { parseFailed?: boolean } {
    const fail = (): DecisionRecord & { parseFailed: boolean } => ({
        round: 0,
        decision: "continue",
        rationale: "Decision parse failed; defaulting to continue",
        nextActions: [],
        timestamp: Date.now(),
        parseFailed: true,
    })
    // Extract <decision>{...}</decision> JSON block
    const match = rawText?.match(/<decision>\s*(\{[\s\S]*?\})\s*<\/decision>/)
    if (!match) return fail()
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
        return fail()
    }
}

// advanceToStage: dispatch the given stage's task to its member, prefixing the prior
// stage's (or decider's) output. Sets member.status = "running". Shared by loop rounds.
async function advanceToStage(team: Team, stage: Stage): Promise<void> {
    const task = team.activeTask!
    const member = team.members.find(m => m.name === stage.member)!
    const prevIdx = task.currentStageIndex - 1
    const prev = prevIdx >= 0 ? task.responses[task.stages[prevIdx].member] : null
    const text = prev
        ? `[Prior output]\n${truncateOutput(prev)}\n\n[Your task]\n${stage.task}`
        : stage.task
    await client.session.promptAsync({
        path: { id: member.sessionId! },
        body: {
            parts: [{ type: "text", text, synthetic: true }],
            agent: member.agent ?? "build",
        },
        query: { directory: member.worktreePath ?? team.directory },
    })
    member.status = "running"
    member.turnCount++
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
        team.status = "failed"
        return
    }

    // Token budget
    if (task.tokenBudget && task.tokensUsed > task.tokenBudget) {
        await deliverSummaryToLeader(team, "budget_exceeded")
        team.activeTask = undefined
        team.status = "failed"
        return
    }

    // Member error
    const errored = team.members.find(m => m.status === "errored")
    if (errored) {
        await deliverSummaryToLeader(team, `member_error:${errored.name}:${errored.error}`)
        team.activeTask = undefined
        team.status = "failed"
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
| Delegate | 无 barrier（member 各自独立认领 + 执行） |

### 7.2 摘要投递给 Leader

Leader session 是**被动客户端**。结果仅在 leader idle 时投递（以避免打断用户的交互式工作流）：

```ts
async function deliverSummaryToLeader(team: Team, reason: string) {
    const summary = await buildSummary(team, team.activeTask!, reason)

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
// Uses formatMailboxInjection — the SAME formatter as the Transform hook (Layer 3) — so
// the user sees a consistent format regardless of which drain path delivered the result.
async function deliverQueuedResultsToMaster(team: Team, masterSessionId: string) {
    const queued = await pollMailbox(team.teamRunId, "master")   // atomic read-and-reserve
    if (queued.length === 0) return
    await client.session.promptAsync({
        path: { id: masterSessionId },
        body: { parts: [{ type: "text", text: formatMailboxInjection(queued), synthetic: true }] },
    })
    await ackMessages(team.teamRunId, "master", queued)   // commit reserved → processed
}

// Mode-aware summary. delegate aggregates from the TASK LIST (per-task results were
// delivered to master via team_send_message; responses[] is NOT used for delegate — #3).
// loop uses decisionHistory (structured) rather than the overwritten responses[].
async function buildSummary(team: Team, task: ActiveTask, reason: string): Promise<string> {
    const head = `mode=${task.type} reason=${reason} tokens=${task.tokensUsed}`
    switch (task.type) {
        case "delegate": {
            const tasks = await listAllTasks(team.teamRunId)
            const lines = tasks.map(t => `- [${t.status}] ${t.subject}${t.owner ? ` (@${t.owner})` : ""}`)
            return `${head}\n${lines.join("\n")}`
        }
        case "loop": {
            const last = task.decisionHistory.at(-1)
            const rounds = task.decisionHistory.map(d => `  round ${d.round}: ${d.decision} — ${d.rationale}`)
            return `${head} rounds=${task.currentRound}\nfinal: ${last?.decision ?? "n/a"}\n${rounds.join("\n")}`
        }
        default: // parallel / pipeline: concatenate each member's captured output
            return `${head}\n` + Object.entries(task.responses)
                .map(([name, out]) => `### ${name}\n${truncateOutput(out)}`).join("\n\n")
    }
}

// One-line-per-member digest of the current round's outputs, for discussion broadcasts.
function buildRoundSummary(responses: Record<string, string>): string {
    return Object.entries(responses)
        .map(([name, out]) => `- ${name}: ${truncateOutput(out, 500)}`).join("\n")
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

聚合计算：`tokensUsed = Σ (input + output + reasoning)` over assistant messages；`costUsed = Σ info.cost`。event handler Step 2 每次 idle 用 `sumMemberTokens` 重算该 member 的 token 量（重算而非 `+=`，避免重复计数——见 §6）：

```ts
// Sum a single session's assistant-message tokens. Recomputed per idle from full
// history (idempotent). cache.read/write are NOT counted toward the budget here
// (cached reads are typically discounted; adjust if your provider bills them fully).
function sumMemberTokens(messages: Array<{ info?: any }> | undefined): number {
    let total = 0
    for (const m of messages ?? []) {
        if (m.info?.role !== "assistant") continue
        const t = m.info.tokens
        total += (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0)
    }
    return total
}
```

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
        value: "team_create",
        category: "Team",
        slash: { name: "team_create" },
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
        value: "team_create",
        category: "Team",
        slash: { name: "team_create" },
        onSelect: () => api.ui.dialog.replace(() => <CreateTeamDialog api={api} />),
    })

    api.command.register({
        title: "Team Parallel",
        value: "team_parallel",
        category: "Team",
        slash: { name: "team_parallel" },
        onSelect: () => dispatchToMaster(api, "team_parallel"),
    })

    // ... /team_clear, /team_status, /team_stop, /team_pipeline, /team_loop

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
                text: `[System] User invoked /${command}. Please use the ${command} tool` +
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
      barrier.ts                   # waitForBarrier（仅 parallel 使用）
      parallel.ts                  # team_parallel（3 种模式）+ handleParallelIdle + 共识检测
      pipeline.ts                  # team_pipeline
      loop.ts                      # team_loop + 结构化决策解析
      delegate.ts                  # team_delegate + handleDelegateIdle + ref→uuid 映射
      summary.ts                   # 结果收集 + leader 投递（buildSummary）
      termination.ts               # Timeout/budget/error/no-issues 检查
    tools/
      team_create.ts
      team_parallel.ts
      team_pipeline.ts
      team_loop.ts
      team_delegate.ts
      team_send_message.ts
      team_task.ts                 # task_create/list/update/get
      team_shutdown.ts             # shutdown_request/approve/reject
      team_status.ts               # status/list
      team_delete.ts
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
| **2.1** | Slash commands：`/team_create`、`/team_delete`、`/team_status`、`/team_shutdown_request` + `dispatchToMaster` 机制 | 4 个管理命令可用，master session 接收指令后调用对应 tool | Phase 2.0 |
| **2.2** | `team_create` + `team_delete` + `team_list` + worktree 管理 | `/team_create` 能创建 member session + worktree，`/team_delete` 能清理 | Phase 2.1 |
| **2.3** | `team_send_message` + 文件 mailbox + Transform hook 注入 + wake-hint | 广播 + 点对点消息，消息通过 Transform hook 自动注入 | Phase 2.2 |
| **2.4** | `team_task_*`（create/list/update/get）+ 原子认领 | Task 创建成功，通过文件锁认领，依赖图被遵守 | Phase 2.2 |
| **2.5** | Slash command 工作流：`/team_parallel`、`/team_pipeline`、`/team_loop` + barrier 原语 + 带锁 event handler + 身份校验 | 3 种编排模式可用，master agent 接收 slash 指令后调用 tool | Phase 2.3 |
| **2.6** | `team_parallel` 模式 B（collaborative）+ 模式 C（discussion） | 不同任务 + 自由通信；多轮辩论带广播 | Phase 2.5 |
| **2.7** | 协作关闭（`/team_shutdown_request`）+ 错误/取消/timeout/budget 路径 | 优雅的 member 关闭，timeout 终止任务，budget 强制执行 | Phase 2.5 |
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
| 确定性编排 | Plugin 通过 parallel/pipeline/loop/delegate 顺序 dispatch prompt |
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
