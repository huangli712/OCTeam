# OCTeam Session Navigator — OpenCode Plugin（Phase 1）

## 概述

在 OpenCode sidebar 中显示当前 session 的所有 child session（包括 subagent 和 background task），点击任意条目即可在主窗口切换查看其执行流程。

这是 OCTeam 插件的**第一阶段**功能，完全独立于 team 编排逻辑。Phase 2（team 编排）的 team sidebar 在此基础上叠加 team 专属信息。

### 设计原则

**纯 TUI plugin**——不需要 server module，不需要 tools，不需要 event handler，不需要 transform hook。所有数据和交互能力由 OpenCode TUI API（`TuiPluginApi`）直接提供。

---

## 1. 架构

```
┌──────────────────────────────────────────┐
│  Plugin (TUI module only)                │
│                                          │
│  package.json: "oc-plugin": ["tui"]      │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  Session Navigator Sidebar         │  │
│  │                                    │  │
│  │  ┌──────────┐  ┌────────────────┐  │  │
│  │  │ Renderer │  │ Event Listener │  │  │
│  │  │ (SolidJS)│  │ (api.event.on) │  │  │
│  │  └────┬─────┘  └───────┬────────┘  │  │
│  │       │                │           │  │
│  │  ┌────▼────────────────▼────────┐  │  │
│  │  │       TuiPluginApi           │  │  │
│  │  │  • api.slots.register        │  │  │
│  │  │  • api.route.navigate        │  │  │
│  │  │  • api.route.current         │  │  │
│  │  │  • api.state.session.status  │  │  │
│  │  │  • api.event.on              │  │  │
│  │  │  • api.client.session.list   │  │  │
│  │  └─────────────────────────────┘  │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

### 关键设计决策

1. **纯 TUI module**：Phase 1 只声明 `"oc-plugin": ["tui"]`，不包含 server module。所有功能通过 `tui(api)` hook 实现。

2. **数据来自 `api.state` + `api.event`**：OpenCode host 已预同步 session 状态到 TUI 进程。优先用 `api.state.session.status(sessionID)` 同步读取（零 RPC 延迟），仅在需要 session 元数据（标题、agent 类型）时才通过 `api.client.session.list()` 查询。

3. **点击切换通过 `api.route.navigate`——复用原生 session view**：OpenCode 原生提供 session 导航（点击 chat 中的派发信息可查看子任务、左右箭头在同级间切换、底部 Up 标签回到 parent）。`api.route.navigate("session", { sessionID })` 导航到的是**同一个 session view**，因此这些原生功能自动生效。sidebar 点击是原生导航的**补充入口**，不是替代——额外价值在于：显示所有 child session（含没有可点击派发信息的 background task）、持久列表（不随 chat 滚动消失）、实时状态一览。

   > **Phase 1.0 验证项**：确认 `api.route.navigate` 到 child session 后，原生左右箭头和 Up 标签自动出现。预期是的（同一 route 同一 view），但需实际确认。

4. **实时刷新通过 `api.event` 订阅**：订阅 `session.created`、`session.status`、`session.updated` 事件，收到事件后触发 sidebar 重新渲染。`api.event.on` 返回 unsubscribe 函数，在组件销毁时调用。

5. **`package.json` 声明**：Phase 1 只声明 `["tui"]`，Phase 2 升级为 `["server", "tui"]`。

6. **已知限制——sidebar 在子 session 上不渲染**：OpenCode TUI 的 session view 组件中，sidebar 可见性由硬编码条件门控：`if (session.parentID) return false`。任何有 `parentID` 的 session（即子 session），整个 sidebar 面板（包括所有 `sidebar_content`/`sidebar_title`/`sidebar_footer` slot）都不渲染。这是 OpenCode 的设计决策，不是 plugin 可控的。导航到子 session 后，用户通过原生左右箭头（同级间切换）和底部 Up 标签（回到 parent session）导航。返回主 session 后 sidebar 自动恢复。

   > **根因验证**：从 OpenCode 1.17.7 二进制中提取的 minified TUI JS 确认，sidebar visibility computed `yU()` 的第一个条件 `if (D()?.parentID) return false` 无条件短路，优先于手动 toggle 和 auto 模式。原生 sidebar 面板（Files/LSP/MCP/Todo）同样在子 session 上消失——它们也注册在 `sidebar_content` slot 上，走同一套门控。

---

## 2. 数据模型

### SessionTreeNode（纯展示模型，不持久化）

```ts
type SessionTreeNode = {
    sessionId: string
    title: string                    // session 标题
    agentType?: string               // agent 类型，如 "build"、"explore"
    model?: string                   // 模型标识
    status: SessionStatus            // 当前状态
    isCurrent: boolean               // 是否当前在主窗口显示
    childCount: number               // 直接子 session 数量（用于显示是否有嵌套）
    createdAt?: number               // 创建时间
}

type SessionStatus = "running" | "idle" | "completed" | "errored"
```

> **注意**：此类型仅用于 sidebar 渲染，不写入磁盘。数据每次刷新时从 `api.state` / `api.client` 实时获取。

---

## 3. TUI 集成

### 3.1 Sidebar Slot 注册

```ts
// src/tui.ts
import type { TuiPluginModule } from "@opencode-ai/plugin"
import { SessionNavigatorSidebar } from "./tui/sidebar"

export default {
    tui(api) {
        api.slots.register({
            order: 145,
            slots: {
                sidebar_content: (ctx, value) =>
                    <SessionNavigatorSidebar api={api} ctx={ctx} value={value} />,
            },
        })
    },
} satisfies TuiPluginModule
```

**正确形态（M1 已验证）**：`api.slots.register({ order, slots: { slotName: Component } })`。❌ 不是 `api.sidebar.register(name, fn)`。

### 3.2 数据获取

#### 初始加载：获取当前 session 的 child session

```ts
async function loadChildren(api: TuiPluginApi, currentSessionId: string): Promise<SessionTreeNode[]> {
    // 查询所有 session，过滤出当前 session 的直接 child
    const result = await api.client.session.list()
    const allSessions = result.data ?? []
    const children = allSessions.filter(s => s.parentID === currentSessionId)

    return children.map(s => ({
        sessionId: s.id!,
        title: s.title ?? s.id!,
        agentType: s.agent,
        model: s.model,
        status: mapStatus(api.state.session.status(s.id!)),
        isCurrent: api.route.current?.params?.sessionID === s.id,
        childCount: allSessions.filter(c => c.parentID === s.id).length,
        createdAt: s.createdAt,
    }))
}
```

#### 实时刷新：事件订阅

```ts
// 在组件 setup 中订阅事件，在 cleanup 中退订
function setupLiveRefresh(api: TuiPluginApi, refresh: () => void) {
    const unsubs = [
        api.event.on("session.created", () => refresh()),
        api.event.on("session.status", () => refresh()),
        api.event.on("session.updated", () => refresh()),
    ]
    return () => unsubs.forEach(u => u())
}
```

#### 当前 session

```ts
// api.route.current 返回当前路由信息
const current = api.route.current
// 类型: { name: "session", params: { sessionID: string } } | { name: "home" } | ...
const currentSessionId = current?.name === "session" ? current.params.sessionID : undefined
```

#### 状态读取（同步，零延迟）

```ts
// api.state.session.status 返回同步缓存的 session 状态
const raw = api.state.session.status(sessionID)
// 类型: { type: "idle" } | { type: "busy" } | { type: "retry", ... } | undefined
const status: SessionStatus =
    raw?.type === "busy" ? "running" :
    raw?.type === "idle" ? "idle" :
    raw?.type === "retry" ? "running" :
    "idle"  // fallback
```

### 3.3 点击交互——复用原生 session view

点击 sidebar 条目后，通过 `api.route.navigate` 导航到目标 session。**原生 OpenCode 的 session view 功能自动生效**：
- 主窗口显示该 session 的完整对话/执行流程
- 左右箭头在同级 sibling session 间移动（OpenCode 内置）
- 底部 Up 标签回到 parent session（OpenCode 内置）

```ts
function handleSessionClick(api: TuiPluginApi, sessionId: string) {
    // 首选：进程内路由切换（M6 已验证）
    // 导航后原生 session view 自动激活（箭头、Up 标签等原生功能随之生效）
    api.route.navigate("session", { sessionID: sessionId })
}
```

**与原生派发信息点击的关系**：OpenCode 在 agent 派发子任务时，chat 中会显示可点击的派发信息。点击它也是导航到同一 session route。我们的 sidebar 点击与此**等价**——同一个 route、同一个 view、同一套原生功能。sidebar 的增量价值是持久列表 + 全量 child session + 实时状态。

**正确形态（M6 已验证）**：
- ✅ `api.route.navigate("session", { sessionID })` — 进程内，同步，免 HTTP
- ✅ `api.client.tui.selectSession({ sessionID })` — HTTP，顶层参数
- ❌ ~~`api.client.tui.selectSession({ body: { sessionID } })`~~ — body 不在参数类型中

### 3.4 可选：嵌套子 session 展开

如果 child session 自身也有 child（grandchild），可在 sidebar 中支持树形展开：

```ts
async function loadTree(api: TuiPluginApi, rootSessionId: string): Promise<SessionTreeNode[]> {
    const result = await api.client.session.list()
    const all = result.data ?? []

    function buildChildren(parentId: string): SessionTreeNode[] {
        return all
            .filter(s => s.parentID === parentId)
            .map(s => ({
                sessionId: s.id!,
                title: s.title ?? s.id!,
                // ...同上
                childCount: all.filter(c => c.parentID === s.id).length,
                // 嵌套递归（限制深度避免无限展开）
            }))
    }
    return buildChildren(rootSessionId)
}
```

> **建议**：Phase 1 先只显示直接 child（1 层）。嵌套展开作为后续优化。

---

## 4. Sidebar 显示

```
┌─ Sessions ──────────────────────┐
│                                 │
│  ▶ main     (sonnet)   running  │  ← 当前 session（点击切回）
│  ─────────────────────────────  │
│  Child Sessions                 │
│  ○ explore  (haiku)    done     │  ← 点击查看执行流程
│  ○ task-1   (sonnet)   running  │  ← 点击查看执行流程
│  ○ task-2   (haiku)    idle     │  ← 点击查看执行流程
│    (2 child sessions)           │  ← task-2 有 2 个子 session
│  ─────────────────────────────  │
│  Total: 3 children              │
│                                 │
└─────────────────────────────────┘
```

- `▶` 标记当前在主窗口显示的 session
- `○` 标记可点击切换的 session
- 状态用颜色区分：running（黄色）、idle（灰色）、done（绿色）、errored（红色）
- 有 child 的 session 可显示子 session 数量

---

## 5. API 参考（已验证 v1.4.7）

以下 API 均已通过类型定义验证。来源：`@opencode-ai/plugin` + `@opencode-ai/sdk` 1.4.7 的 `.d.ts` 文件。

### api.slots.register

```ts
api.slots.register({
    order: number,                        // sidebar 排序权重
    slots: {
        [slotName: string]: (ctx, value) => JSX,  // slot 渲染组件
    },
})
// 注册后，OpenCode 在渲染 sidebar 的对应 slot 时调用组件
```

### api.route.navigate

```ts
api.route.navigate(route: string, params: Record<string, string>): void
// 切换主窗口路由。内置路由包括 "session"、"home" 等。
// 例：api.route.navigate("session", { sessionID: "abc123" })
```

### api.route.current（只读）

```ts
type Route = { name: string, params: Record<string, string> }
const current: Route | undefined = api.route.current
// 例：{ name: "session", params: { sessionID: "abc123" } }
//     { name: "home" }
```

### api.state.session.status

```ts
type SessionStatus = 
    | { type: "idle" } 
    | { type: "busy" } 
    | { type: "retry", [key: string]: unknown }

const status: SessionStatus | undefined = api.state.session.status(sessionID: string)
// 同步读取 host 预同步的 session 状态，零 RPC 延迟
```

### api.event.on

```ts
type Unsubscribe = () => void

const unsub: Unsubscribe = api.event.on(eventType: string, handler: (event) => void)
// 订阅事件。返回 unsubscribe 函数，在组件销毁时调用。
// 相关事件类型：
//   "session.created"  — 新 session 创建
//   "session.status"   — session 状态变化
//   "session.updated"  — session 元数据更新
//   "session.removed"  — session 删除
```

### api.client.session.list

```ts
const result = await api.client.session.list({ query?: { directory?: string } })
// result.data: Session[]
// Session 类型包含: { id, title?, parentID?, agent?, model?, createdAt? }
```

---

## 6. 目录结构

```
octeam/
  src/
    tui.ts                         # TUI plugin module 入口
    tui/
      sidebar.tsx                  # SessionNavigatorSidebar 组件
      session-tree.ts              # loadTree / loadChildren 数据获取逻辑
      status-map.ts                # OpenCode 状态 → 展示状态映射
  package.json                     # "oc-plugin": ["tui"]
  tsconfig.json
```

> Phase 2 会在此结构上增加 `server.ts`、`tools/`、`orchestration/`、`mailbox/` 等目录。

---

## 7. 开发路线图

| Phase | 内容 | 验证标准 | 前置条件 |
|---|---|---|---|
| **1.0** | TUI 脚手架：`tui(api)` hook + `api.slots.register` + `package.json`（`"oc-plugin": ["tui"]`） | Plugin 加载成功，空 sidebar slot 注册成功 | 无 |
| **1.1** | Session 列表渲染：`api.client.session.list` 获取 child session，`api.state.session.status` 读取状态，渲染到 sidebar | Sidebar 显示当前 session 的所有直接 child session 及其状态 | Phase 1.0 |
| **1.2** | 实时刷新：`api.event.on` 订阅 `session.created`/`session.status`/`session.updated`/`session.removed`，自动更新列表 | 新建的 session 自动出现，完成的 session 状态自动更新，退订在组件销毁时执行 | Phase 1.1 |
| **1.3** | 点击导航：`api.route.navigate("session", { sessionID })` 切换主窗口 session。验证原生 session view 功能（左右箭头、Up 标签）自动生效 | 点击 sidebar 条目切换主窗口显示，原生箭头/Up 可用，再次点击当前条目可切回 | Phase 1.1 |
| **1.4** | 当前 session 高亮：`api.route.current` + `▶` 标记 + 颜色区分状态 | 当前查看的 session 以 `▶` 标记，不同状态用不同颜色 | Phase 1.3 |

---

## 8. 依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| `@opencode-ai/plugin` | ^1.4.0 | TUI hook 类型：`TuiPluginModule`、`TuiPluginApi` |
| `@opencode-ai/sdk` | ^1.4.0 | SDK client 类型（通过 `api.client` 间接使用，无需直接 import） |
| `@opentui/solid` | 可选 | TUI sidebar 渲染（SolidJS 组件） |

---

## 9. 与 Phase 2 的关系

Phase 2（team 编排）在 Phase 1 的基础上：
1. `package.json` 升级为 `"oc-plugin": ["server", "tui"]`，新增 `server.ts` module。
2. TUI module 注册 slash commands（`/create-team`、`/team-parallel` 等）。
3. Sidebar 在 session navigator 基础上，当当前 session 是某 team 的 master 时，额外显示 team 信息（member 列表、编排状态、任务列表）。
4. 点击交互复用 Phase 1 的 `api.route.navigate` 机制——team member 也是 child session。

详细设计见 [Team Mode Plugin 设计](./TEAM_MODE_PLUGIN_DESIGN.zh.md)。
