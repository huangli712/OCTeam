# team_hierarchical 模式 Design Doc

> Status: Draft（基于 collab-explorers 团队 discussion 共识）
> Date: 2026-06-22
> 共识来源：theorist / engineer / critic 三方在第 4 轮全票通过

## 1. 背景与动机

OCTeam 现有四种工作流模式：

| Mode | 拓扑 | 控制流 |
|---|---|---|
| `parallel` | 星型 | leader 聚合 |
| `pipeline` | 链型 | 顺序传递 |
| `loop` | 闭环 | decider 驱动 |
| `delegate` | 池型 | 自认领（FCFS） |

四种模式在「拓扑 + 控制流」双维度上**两两不同**，覆盖了协作的基本形状。但存在一类真实需求未被覆盖：

> **运行时不可分解的协调任务**——需要把一个大任务递归分解成子树，每个子树有局部协调者，子结果沿树向上汇聚。

`delegate` 是扁平池型（一层），无法表达"递归分解 + 多层协调"。强行用 `delegate` 处理这类任务会导致：
- 顶层 master 成为唯一聚合点（瓶颈 + token 爆炸）
- 子任务之间的依赖无法表达
- 3 层以上递归必崩

## 2. 判据（来自 discussion 共识）

**mode = (通信拓扑, 控制流)**

> 只改策略不改拓扑/控制流的 = primitive（不是 mode）

套用到 hierarchical：
- 拓扑：**树型**（vs delegate 的池型）— 改了
- 控制流：**递归委派**（vs delegate 的自认领）— 改了

**结论**：hierarchical 在两个维度上都不同于现有四模式，是真正的 mode 新增（而非现有 mode 的参数化）。

**反向验证**：判据正确保留现有四模式（它们在拓扑和控制流上都两两不同），只淘汰了 discussion 中冗余的新提案（如 scatter-gather = parallel + reducer、map-reduce = parallel + 可配置 reducer、能力匹配 = delegate + assignment-policy）。

## 3. 核心定义

### 3.1 通信拓扑
```
master (top-level orchestrator)
  └── root member (局部 master for its subtree)
        ├── child member A (leaf)
        ├── child member B (leaf)
        └── child member C (intermediate, has its own subtree)
              ├── grandchild D
              └── grandchild E
```

- 每个非叶成员是**自己子树的局部 master**
- 父成员持有 team 工具，可递归调用 `parallel` / `delegate` / `hierarchical`
- 子成员只与父成员通信，**不跨子树通信**

### 3.2 控制流
```
master
  → dispatch root_task to root member
      → root member: decompose or self-solve
          → if decompose: dispatch subtasks to children
              → children: solve (or recurse)
              → children: report to parent
          → parent: aggregate children's results (reduce_policy)
          → parent: signoff (signoff_policy)
      → root member: report to master
  → master: done
```

## 4. API 设计

```typescript
team_hierarchical({
    team_id: string,
    root_task: string,

    // 树结构定义
    // 方式一：显式指定子树
    // 方式二："auto" 让父成员运行时自己 recruit/decompose
    hierarchy: {
        [memberName: string]: {
            children: string[] | "auto",
            // 父成员的子树协调策略
            subtree_mode: "delegate" | "parallel",  // 用哪个现有 mode 协调子树
        },
    },

    // 来自 discussion 的 reduce-policy primitive
    // 父成员聚合子结果时用
    reduce_policy: "summarize" | "select" | "merge" | "rubric",

    // 来自 discussion 的 signoff-policy primitive
    // 父成员签发子树结果时用
    signoff_policy: "auto" | "decider" | "peer-quorum",

    max_depth: number,  // 默认 3，防止无限递归
    timeout_ms?: number,
    token_budget?: number,
})
```

### 参数说明

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `team_id` | ✅ | — | 团队 ID |
| `root_task` | ✅ | — | 顶层任务描述 |
| `hierarchy` | ✅ | — | 树结构；`"auto"` 允许父成员运行时决定 |
| `reduce_policy` | ❌ | `"summarize"` | 父成员如何聚合子结果 |
| `signoff_policy` | ❌ | `"auto"` | 父成员如何签发子树结果 |
| `max_depth` | ❌ | `3` | 树最大深度，防止无限递归 |
| `timeout_ms` | ❌ | team bounds | 总超时 |
| `token_budget` | ❌ | team bounds | token 上限 |

## 5. 状态机

### Master 视角
```
dispatched → waiting_root → aggregated → done
                                ↓
                            failed (timeout / root aborts)
```

### 每个非叶成员（局部 master）视角
```
received → deciding (decompose or self-solve)
  ├── self-solve → reported
  └── decompose → dispatched_subtree → aggregating → signoff → reported
                                                     ↓
                                                 rejected (re-dispatch)
```

### 每个叶成员视角
```
received → solving → reported
```

## 6. 实施约束（不可妥协）

### 6.1 子树协调下放（critic 硬护栏）

**子树协调必须下放给父成员**。父成员即局部 master，禁止把所有 fan-in 堆回顶层 master。

**理由**：
- 若违反，顶层 master 在 3 层以上 hierarchical 中必然 token 爆炸
- 顶层 master 同时是时序瓶颈（所有子结果串行汇聚）
- 这是性能/可扩展性的生死线

**实现要求**：
- 子成员的 `team_send_message` 只能发给父成员，不能跨子树
- 父成员在自己子树内调用 `team_delegate` / `team_parallel` 时，使用自己的 session 作为 leadSessionId
- 顶层 master 只接收 root member 的最终汇报

### 6.2 max_depth 强制限制

默认 `max_depth = 3`。超过时 orchestrator 拒绝继续分解，强制当前成员自己解决（即便结果粗糙）。

**理由**：防止 member 反复递归分解而永不实际解题（"分解瘫痪"）。

## 7. 与 delegate 的边界

| 维度 | delegate | hierarchical |
|---|---|---|
| 拓扑 | 池型（一层） | 树型（多层） |
| 控制流 | 自认领（FCFS） | 递归委派（父→子） |
| 任务来源 | master 预先发布到共享列表 | 父成员运行时分解 |
| 协调者 | master（单一） | 每个非叶成员（局部 master） |
| 适合 | 任务列表已知、扁平并行 | 任务需要分解、有自然层级 |
| 子任务依赖 | 不支持 | 通过树结构表达 |

**关键区分**：delegate 假设 master 知道所有任务；hierarchical 允许父成员运行时决定如何分解。

## 8. 与 primitives 的组合

hierarchical 是 mode，可以挂载 discussion 提出的所有 primitives：

| primitive | 在 hierarchical 中的作用 |
|---|---|
| `reduce_policy` | 父成员聚合子结果（summarize/select/merge/rubric） |
| `signoff_policy` | 父成员签发子树结果（auto/decider/peer-quorum） |
| `assignment_policy` | 父成员向子成员分配任务（FCFS/bidding/capability） |

**子树内部 mode**：父成员可以选择用 `delegate` / `parallel` / `pipeline` 协调自己的子树（递归组合），不需要发明新的内部机制。

## 9. 典型用例

### 用例 1：复杂软件任务
```
root_task: "实现一个 LLM 评估框架"
  ├── 子任务 1（designer）: 设计架构
  ├── 子任务 2（frontend-lead）: 前端实现
  │     ├── UI 工程师 A
  │     └── UI 工程师 B
  └── 子任务 3（backend-lead）: 后端实现
        ├── API 工程师
        └── 评估算法工程师
```
顶层 master 无法预先知道所有子任务，需要 lead 成员运行时分解。

### 用例 2：分布式研究
```
root_task: "调研 LLM agent 协作模式"
  ├── theorist（调研经典 MAS）
  ├── engineer（调研现代框架）
  │     ├── LangGraph 子调研
  │     └── AutoGen 子调研
  └── critic（综合 + 批判）
```

### 用例 3：层级化代码评审
```
root_task: "评审这个 PR"
  ├── security-reviewer（安全视角）
  │     └── crypto-specialist（深度加密检查）
  ├── perf-reviewer（性能视角）
  └── style-reviewer（风格视角）
```

## 10. 暂不实现的相关提案

### 10.1 blackboard（共享黑板模式）
**搁置理由**：token 成本高、收敛不可预测。分类上可能通过判据（改了拓扑：池型共享内存），但构建优先级暂缓。

### 10.2 decompose 作为独立 mode
**降级为 pattern**：作为"成员可递归调用 parallel/delegate"的文档化组合 pattern，不需要 orchestrator 新原语——是涌现，不是 mode。

## 11. 开放问题（待实现时决策）

1. **父成员如何决定"自己完成 vs 分解"？**
   - 选项 A：显式 `hierarchy` 参数告诉它
   - 选项 B：父成员运行时自己判断（需要 prompt 引导）
   - 选项 C：用 `decomposition_policy: "manual" | "auto"` 切换

2. **树结构是 explicit 还是 emergent？**
   - explicit：master 在 `team_hierarchical` 调用时指定 `hierarchy`
   - emergent：root member 自己 recruit 子成员（需要团队扩容机制）

3. **子成员能否拒绝父成员的分解？**
   - 影响 signoff_policy 的设计
   - 建议初版不允许，父成员有绝对分配权

4. **部分子树失败如何处理？**
   - 父成员的 reduce_policy 是否需要 `"fail_fast"` / `"best_effort"` 选项

## 12. 实施路线图

| 阶段 | 内容 | 依赖 |
|---|---|---|
| Phase 1 | 实现 `team_hierarchical` 基础（explicit hierarchy + 固定 reduce/signoff） | 无 |
| Phase 2 | 加 `reduce_policy` 参数化（顺带让 `team_parallel` 也支持） | Phase 1 |
| Phase 3 | 加 `signoff_policy` 参数化 | Phase 1 |
| Phase 4 | 支持 `hierarchy: "auto"`（父成员运行时 recruit） | Phase 1 + 团队扩容机制 |

## 13. 引用

- Discussion 共识（collab-explorers 团队，2026-06-22）：唯一新增 mode = hierarchical；3 类 primitives = reduce/assignment/signoff policy
- 双维度判据：mode = (通信拓扑, 控制流)；只改策略 = primitive
- critic 硬护栏：子树协调必须下放，禁止顶层 fan-in
