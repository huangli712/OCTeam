# OCTeam 编排场景目录

> 9 种编排原语的真实应用场景设计集。每个场景 **端到端 ≤ 30 分钟** 可完成，含 team 配置、master 调用、执行流程时序、可运行的 TypeScript 评判脚本。
>
> 场景方向覆盖：**数学 / 计算物理 / 编程**。

## 快速参考

| # | 模式 | 一句话 | 最佳适用场景 | 目录 |
|---|------|--------|-------------|------|
| 01 | `team_parallel` | 所有成员并行执行 | 批量独立任务、多方法对比 | [`01-team-parallel/`](./01-team-parallel/) |
| 02 | `team_consensus` | 多轮辩论达共识 | 无绝对答案的选型决策 | [`02-team-consensus/`](./02-team-consensus/) |
| 03 | `team_pipeline` | 线性流水线 | 顺序加工链 | [`03-team-pipeline/`](./03-team-pipeline/) |
| 04 | `team_loop` | 纠正循环 | 实现-评审-修复迭代 | [`04-team-loop/`](./04-team-loop/) |
| 05 | `team_delegate` | 任务自取 | 异构专家自分配 | [`05-team-delegate/`](./05-team-delegate/) |
| 06 | `team_route` | 内容路由 | 输入分流到对应专家 | [`06-team-route/`](./06-team-route/) |
| 07 | `team_arbitrate` | 辩论 + 仲裁 | 两派对立争议的裁决 | [`07-team-arbitrate/`](./07-team-arbitrate/) |
| 08 | `team_recurse` | 递归分解 | 复杂任务分层拆解 | [`08-team-recurse/`](./08-team-recurse/) |
| 09 | `team_tollgate` | 验证门流水线 | 逐关质量把关 | [`09-team-tollgate/`](./09-team-tollgate/) |

## 场景矩阵（模式 × 方向）

| 模式 | 数学 | 计算物理 | 编程 |
|------|------|---------|------|
| parallel | Monte Carlo π 三方法 | 谐振子积分器能量漂移 | 两数和多解法 |
| consensus | 小规模排序选型 | 热传导时间格式 | 字符串匹配算法 |
| pipeline | 高斯定积分全流程 | 单摆小角度仿真 | Fibonacci TDD 线 |
| loop | 二分法边界 bug | 弹簧能量漂移 | 区间合并 off-by-one |
| delegate | 数论题集（5 道） | ODE 套件（3 个） | CLI 计算器（DAG） |
| route | 数学题分类 | PDE 类型路由 | GitHub issue 分流 |
| arbitrate | 矩阵求逆法之争 | 刚性 ODE 格式之争 | 缓存淘汰策略之争 |
| recurse | 错排数 D_n 推导 | 阻尼摆建模 | Markdown→HTML 转换器 |
| tollgate | 快速幂实现+验证 | Verlet 求解器+验证 | 字符串反转+验证 |

## 每个场景包含

每个模式目录下有 4 个文件：

- **`README.md`** — 完整设计（3 个子场景：数学 / 计算物理 / 编程），每个子场景含：
  - 场景描述（背景、目标、可机器评判的成功标准）
  - `team_create` 完整 JSON 配置
  - master 的 `team_*` 启动调用 JSON + 参数选择说明
  - 执行流程时序图
  - 评判脚本说明
- **`check-math-*.ts`** — 数学场景评判脚本（`bun` 可运行）
- **`check-physics-*.ts`** — 计算物理场景评判脚本
- **`check-coding-*.ts`** — 编程场景评判脚本

## 如何运行一个场景

1. **创建团队**：按场景 README 中的 `team_create` JSON 调用 `team_create` 工具
2. **激活团队**：调用 `team_activate`（默认不自动激活）
3. **启动编排**：按 README 中的 master 调用 JSON 调用对应的 `team_*` 工具
4. **等待完成**：成员并行/顺序执行，OCTeam 汇总输出到 master 会话
5. **评判结果**：

   ```bash
   bun docs/orchestration-scenarios/0N-team-<mode>/check-<theme>-<topic>.ts <run_dir>
   ```

   - `<run_dir>` 是该次 run 的输出目录（含各成员的 `<member>.md` 输出）
   - 退出码：`0` = PASS，`1` = FAIL（断言失败），`2` = 用法/IO 错误

## 统一控时设计

所有场景遵循：

| 维度 | 上限 |
|------|------|
| 端到端总时长 | ≤ 30 min |
| 每成员子任务 | ≤ 8 min |
| 成员数 | ≤ 4 |
| 顺序阶段/轮数 | ≤ 3 |
| 递归深度 | ≤ 2 |

详见 [`_AUTHORING.md`](./_AUTHORING.md)（内部编写规范）。

## 相关文档

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — 9 种编排原语的官方定义与状态持久化模型
- [`src/tools/workflow-basic.ts`](../src/tools/workflow-basic.ts) — parallel / consensus / pipeline / loop 工具源码
- [`src/tools/workflow-advanced.ts`](../src/tools/workflow-advanced.ts) — delegate / route / arbitrate / tollgate / recurse 工具源码
- [`src/core/role-presets.ts`](../src/core/role-presets.ts) — 18 种角色预设及其 agent 映射


## 快捷启动：复制即用的 Prompt

每个场景 README 末尾都有「**快速启动 Prompt（复制即用）**」章节，提供该场景 3 个子场景（数学 / 计算物理 / 编程）的一键闭环 prompt。把对应 prompt 粘贴给 master 会话，AI 会自动完成「创建团队 → 激活 → 启动编排 → 等待汇总 → 运行评判脚本」，并按退出码报告 PASS / FAIL——**无需手动拼装 JSON**。

例如启动 `01-team-parallel` 的 Monte Carlo π 场景：打开 [`01-team-parallel/README.md`](./01-team-parallel/README.md) 的「快速启动 Prompt → 场景 1」，复制其中 ```text``` 代码块粘贴给 AI 即可。


## 挑战级场景（增补）

每个模式在 3 个基线场景（≤4 成员、≤30 min）之外，另有 **1 个挑战级场景**（6-10 成员、规模放大、时间放宽至 35-90 min），用于压测各原语在大规模/高难度下的扩展性。挑战级场景在每个模式 README 中标注「（挑战级）」，配套 check 脚本与快速启动 prompt 与基线场景一致。

| 模式 | 挑战场景 | 成员 | 规模放大点 | 时长 |
|------|---------|-----|-----------|------|
| parallel | 8 种排序 × 10⁶ × 3 数据集基准 | 8 coder | 数据 10³→10⁶、算法 3→8 | ~40min |
| consensus | 60 位 RSA 模数分解算法选型 | 6 mathematician | 方法 3→6、轮数 3→5 | ~35min |
| pipeline | Lennard-Jones 分子动力学完整链 | 8 simulator | 3→8 阶段、真实 MD 流程 | ~60min |
| loop | Lock-free queue 四类并发 bug 修复 | 7 (4coder+2tester+decider) | 单 bug→4 类、10³→10⁷ 压测 | ~60min |
| delegate | 100 道程序化数论题 | 8 mathematician | **5→100 题** | ~90min |
| route | 多面性工单九路分流 | 9 (router+8分支) | 单选→多路并发分支 | ~45min |
| arbitrate | 复杂边界 PDE 五方法之争 | 6 (5debater+arbiter) | 2→5 派、1→3 轮 | ~40min |
| recurse | Vandermonde 恒等式多层证明 | 6 mathematician | depth 2→4、3 路证法 | ~50min |
| tollgate | 二维热传导求解器 V&V 认证 | 6 | 1→3 门、含网格收敛+守恒律 | ~60min |
