# team_route 编排场景设计

> **模式**：`team_route` — 内容路由：router 成员分析输入，选择匹配的分支成员处理；选中分支并行执行后汇总。无默认路由，未匹配输入直接失败整个 run。
> **源码**：[`src/tools/workflow-advanced.ts:240-341`](../../../src/tools/workflow-advanced.ts)
> **控时设计**：路由模式天然节能 —— 每个 run 实际只有 **router + 1 个匹配分支** 被调度执行（其余分支仅作为分类候选项存在，不会被 dispatch）。因此即便 team 配置 4-5 个成员，活跃成员 ≤ 2，总时长 ≈ router 分类（~1 min）+ 匹配分支求解（~5-8 min）≈ 10 min（远低于 30 min 上限）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role（router / branch） | key param | 预计总时长 |
|---|------|------|--------|------------------------|-----------|-----------|
| 1 | 数学 | 单题分类器（微积分/代数/数论/组合） | 5 | `mathematician` / `mathematician` | `input` 携带题目，routes 无 `task` | ~8 min |
| 2 | 计算物理 | PDE 类型路由（抛物/椭圆/双曲） | 4 | `physicist` / `simulator` | `input` 携带 PDE，routes 无 `task` | ~8 min |
| 3 | 编程 | GitHub issue 分流（bug/feature/docs/refactor） | 5 | `analyst` / `coder` | `input` 携带 issue 正文，routes 无 `task` | ~8 min |

---

## 场景 1: 单题分类器（数学微积分路由）

### 1.1 场景描述

**背景**：给定一道具体的数学题，正确的学科分类决定了它该被送给哪位专家。这里用一道需要乘积法则的求导题，验证 router 能从四个相近的数学子领域中精确选出 `calculus`，并触发对应的微积分专家给出正确答案。

**目标**：router 成员读入题目 `f(x) = x³·sin(x)` 的求导请求，路由到 `calculus` 分支；其余三个分支（algebra / number-theory / combinatorics）**不应**被触发。匹配分支输出经乘积法则化简后的导数。

**成功标准（可机器评判）**：
- router 输出含 `<route>{"branch":"calculus",...}</route>`
- 仅 `bob.md` 存在 `<!-- ANSWER: ... -->` 标注（其余分支未被 dispatch，无输出文件）
- `ANSWER` 经归一化后包含两项 `3x^2*sin(x)` 与 `x^3*cos(x)`（顺序无关，容忍 `*`/`**`/空格差异）

### 1.2 Team 配置

```json
{
  "name": "math-classifier",
  "description": "Math problem router: classifies a single problem into calculus/algebra/number-theory/combinatorics",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematics problem classifier. Given a concrete math problem, identify which single sub-domain it belongs to and route it to the matching branch. The sub-domains are: calculus (derivatives, integrals, limits, differential calculus), algebra (equations, polynomials, symbolic manipulation, solving for unknowns), number-theory (integers, primes, divisibility, modular arithmetic), combinatorics (counting, permutations, combinations, graphs). A derivative or integral problem is calculus, not algebra. Pick exactly one branch. Your output MUST end with a line exactly formatted: <route>{\"branch\": \"<name>\", \"rationale\": \"<one sentence why>\"}</route>"
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are a calculus specialist (derivatives, integrals, limits, series). When given a problem, first decide if it genuinely belongs to calculus. If it does, solve it step by step and put the final simplified closed-form result in the marker. If it does NOT belong to calculus, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ANSWER: <simplified_result> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are an algebra specialist (equations, polynomials, symbolic manipulation, solving for unknowns). When given a problem, first decide if it genuinely belongs to algebra. If it does, solve it step by step and put the final simplified result in the marker. If it does NOT belong to algebra, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ANSWER: <simplified_result> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "You are a number-theory specialist (integers, primes, divisibility, modular arithmetic, Diophantine equations). When given a problem, first decide if it genuinely belongs to number theory. If it does, solve it step by step and put the final result in the marker. If it does NOT belong to number theory, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ANSWER: <result> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "You are a combinatorics specialist (counting, permutations, combinations, graphs, generating functions). When given a problem, first decide if it genuinely belongs to combinatorics. If it does, solve it step by step and put the final result in the marker. If it does NOT belong to combinatorics, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- ANSWER: <result> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    }
  ]
}
```

**Role 选择理由**：`mathematician` 用 `build` agent，能读题、推导、必要时写符号计算代码验证——router 与四个分支都用它，保证分类与求解质量。

### 1.3 Master 启动调用

```json
{
  "tool": "team_route",
  "args": {
    "team_id": "math-classifier",
    "router": "alice",
    "input": "Compute the derivative of f(x) = x^3 · sin(x) and simplify.",
    "routes": [
      { "name": "calculus", "member": "bob", "description": "derivatives, integrals, limits, differential calculus" },
      { "name": "algebra", "member": "carol", "description": "equations, polynomials, symbolic manipulation" },
      { "name": "number-theory", "member": "dave", "description": "integers, primes, divisibility, modular arithmetic" },
      { "name": "combinatorics", "member": "erin", "description": "counting, permutations, combinations, graphs" }
    ],
    "timeout_ms": 600000
  }
}
```

**参数选择**：
- `router: "alice"` — router 必须是成员名，非 master，且不能是分支 target（schema 硬约束，见 `workflow-advanced.ts:298-300`）。
- `input` 携带题目正文 — routes 全部省略 `task`，故匹配分支成员**直接收到 `input`**（schema 文档化的惯用模式，见 `workflow-advanced.ts:63` 的 `b.task ?? task.task` 回退）；避免把题目重复塞进每个 route。
- 不设 `signoff_policy` — 默认 `none`，分支求解完即交付，无需额外评审门。
- `timeout_ms: 600000`（10 min）— router 分类 ~1 min + bob 求导 ~3 min，余量充足。

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_route (input = 求导题)
T+0m    Phase A: 仅 dispatch alice（其余 4 成员等待）
T+0~1m  router 读题 → 分类 → 输出 <route>{"branch":"calculus",...}</route>
T+1m    Phase B: 仅 dispatch bob（algebra/nt/combo 三分支不被触发）
T+1~6m  bob 应用乘积法则 → 化简 → ANSWER 标记
T+6m    target barrier 收敛 → 汇总交付 master
T+6m    运行: bun check-math-problem-router.ts <run_dir>
```

### 1.5 评判脚本

[`check-math-problem-router.ts`](./check-math-problem-router.ts)

- **加载**：`<run_dir>/alice.md` 与 `<run_dir>/bob.md`
- **提取**：
  - router 决策：正则 `<route>([\s\S]*?)</route>` → `JSON.parse` → 取 `branch`（或 `branches[0]`）
  - 分支答案：正则 `<!--\s*ANSWER:\s*([\s\S]*?)\s*-->`
- **断言**：
  1. router 选中的 branch === `calculus`
  2. `bob` 未输出 `DOMAIN_MATCH: false`（即认领了该题）
  3. `bob` 输出了 `ANSWER` 标记
  4. 答案归一化（去空白、`**`→`^`、去 `*`、小写）后同时包含 `3x^2sin(x)` 与 `x^3cos(x)`（顺序无关）

---

## 场景 2: PDE 类型路由（计算物理）

### 2.1 场景描述

**背景**：偏微分方程按主部系数矩阵的特征值符号分为抛物型（热传导/扩散，时间一阶、空间二阶）、椭圆型（稳态，Laplace/Poisson）、双曲型（波动，时间二阶）。方程类型决定数值方法的选择——抛物型用 Crank-Nicolson 等隐式格式保证稳定性，椭圆型用多重网格/Gauss-Seidel，双曲型用显式迎风。正确分类是数值求解的第一步。

**目标**：router 成员读入一个带 Dirichlet 边界条件、形如 `u_t = u_xx + u_yy` 的初值问题，正确识别为 `parabolic`（热方程）并路由；匹配分支给出合适的数值方法名。

**成功标准（可机器评判）**：
- router 输出含 `<route>{"branch":"parabolic",...}</route>`
- `bob.md` 含 `<!-- METHOD: <name> -->`，且 `<name>` ∈ {`crank-nicolson`, `implicit`, `ftcs`}（大小写不敏感）
- `bob` 未输出 `DOMAIN_MATCH: false`

### 2.2 Team 配置

```json
{
  "name": "pde-classifier",
  "description": "PDE type router: classifies a PDE problem as parabolic/elliptic/hyperbolic",
  "members": [
    {
      "name": "alice",
      "role": "physicist",
      "prompt": "You are a partial differential equation (PDE) classifier. Given a PDE problem with its boundary/initial conditions, classify it by type and route to the matching branch. Types: parabolic (first-order in time, second-order in space, diffusion/heat, e.g. u_t = u_xx or u_t = u_xx + u_yy), elliptic (steady-state, no time derivative, Laplace/Poisson, e.g. u_xx + u_yy = 0 or = f(x,y)), hyperbolic (second-order in time, wave propagation, e.g. u_tt = u_xx). The presence of u_t with second spatial derivatives is the signature of parabolic. Pick exactly one branch. Your output MUST end with a line exactly formatted: <route>{\"branch\": \"<name>\", \"rationale\": \"<one sentence why>\"}</route>"
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are a numerical PDE simulator specializing in parabolic equations (heat/diffusion, u_t = L*u). When given a PDE problem, first decide if it is genuinely parabolic. If it is, name the most appropriate numerical method (e.g. Crank-Nicolson, backward/implicit Euler, FTCS) and state the key stability constraint in one line. If it is NOT parabolic, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- METHOD: <method_name> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are a numerical PDE simulator specializing in elliptic equations (steady-state, Laplace/Poisson, L*u = f with no time derivative). When given a PDE problem, first decide if it is genuinely elliptic. If it is, name the most appropriate numerical method (e.g. Gauss-Seidel, SOR, multigrid, finite-element) in one line. If it is NOT elliptic, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- METHOD: <method_name> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "dave",
      "role": "simulator",
      "prompt": "You are a numerical PDE simulator specializing in hyperbolic equations (wave propagation, u_tt = c^2*L*u, advection). When given a PDE problem, first decide if it is genuinely hyperbolic. If it is, name the most appropriate numerical method (e.g. Lax-Wendroff, upwind, leapfrog) and the CFL constraint in one line. If it is NOT hyperbolic, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- METHOD: <method_name> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    }
  ]
}
```

**Role 选择理由**：router 用 `physicist`（侧重物理方程判读），分支用 `simulator`（专为 PDE/MC/HPC 数值模拟设计，能给出方法名与稳定性约束）。

### 2.3 Master 启动调用

```json
{
  "tool": "team_route",
  "args": {
    "team_id": "pde-classifier",
    "router": "alice",
    "input": "Solve u_t = u_xx + u_yy on a square domain with Dirichlet BC u=0 on the boundary, initial condition u(x,y,0)=sin(pi*x)sin(pi*y).",
    "routes": [
      { "name": "parabolic", "member": "bob", "description": "heat/diffusion, first-order in time, e.g. u_t = u_xx + u_yy" },
      { "name": "elliptic", "member": "carol", "description": "steady-state Laplace/Poisson, no time derivative" },
      { "name": "hyperbolic", "member": "dave", "description": "wave propagation, second-order in time" }
    ],
    "timeout_ms": 600000
  }
}
```

**参数选择**：
- `router: "alice"` — 成员名，非 master，不在 routes 中（schema 约束）。
- `input` 直接嵌入完整 PDE 初边值问题 — 三个 route 均省略 `task`，匹配分支（`bob`）直接收到这段输入；分支成员的系统 prompt 已编码领域判定与 `METHOD` 标记约定。
- routes 的 `description` 给 router 提供分类线索（schema 鼓励的可选项）。

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_route (input = 热方程初边值问题)
T+0m    Phase A: 仅 dispatch alice
T+0~1m  router 识别 u_t + 二阶空间项 → 抛物型 → <route>{"branch":"parabolic",...}</route>
T+1m    Phase B: 仅 dispatch bob（elliptic/hyperbolic 不触发）
T+1~7m  bob 选 Crank-Nicolson/隐式 → 说明稳定性 → METHOD 标记
T+7m    target barrier 收敛 → 汇总交付 master
T+7m    运行: bun check-physics-pde-router.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-pde-router.ts`](./check-physics-pde-router.ts)

- **加载**：`<run_dir>/alice.md` 与 `<run_dir>/bob.md`
- **提取**：
  - router 决策：正则 `<route>([\s\S]*?)</route>` → `JSON.parse` → 取 `branch`
  - 分支方法：正则 `<!--\s*METHOD:\s*(.*?)\s*-->`
- **断言**：
  1. router 选中的 branch === `parabolic`
  2. `bob` 未输出 `DOMAIN_MATCH: false`
  3. `METHOD` 值（小写、去空白）∈ {`crank-nicolson`, `implicit`, `ftcs`}

---

## 场景 3: GitHub issue 分流（编程）

### 3.1 场景描述

**背景**：开源项目的 issue 队列每天涌入大量报告，人工分流成本高。一个能读懂 issue 正文并自动归类（bug / feature / docs / refactor）的路由器是自动化 triage 的核心。本场景用一条真实的 bug 报告（负数 id 未做参数校验）验证 router 能从四个类别中选出 `bug`，并触发修复策略生成。

**目标**：router 读入 issue 正文，正确路由到 `bug` 分支；匹配分支给出最小修复策略（指出在哪个函数加什么防护）。

**成功标准（可机器评判）**：
- router 输出含 `<route>{"branch":"bug",...}</route>`
- `bob.md` 含 `<!-- FIX_STRATEGY: <text> -->`，且 `<text>`（小写）提及 `guard` / `throw` / `rangeerror` 中至少一个
- `bob` 未输出 `DOMAIN_MATCH: false`

### 3.2 Team 配置

```json
{
  "name": "issue-triage",
  "description": "GitHub issue router: classifies an issue as bug/feature/docs/refactor",
  "members": [
    {
      "name": "alice",
      "role": "analyst",
      "prompt": "You are a GitHub issue triage classifier. Given an issue report body, classify it into exactly one category and route to the matching branch. Categories: bug (the code does something wrong: incorrect result, crash, wrong return value, exception that should be thrown but is not, or vice versa), feature (a request for new functionality that does not yet exist), docs (documentation, examples, or readability improvement with no code-behavior change), refactor (code quality/structure change with no behavior change). A report that the code returns a value when it should throw is a bug. Pick exactly one branch. Your output MUST end with a line exactly formatted: <route>{\"branch\": \"<name>\", \"rationale\": \"<one sentence why>\"}</route>"
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are a bug-fix coder. When given an issue, first decide if it genuinely reports a bug (broken or incorrect behavior). If it does, propose a minimal fix strategy: name the file/function to change and describe the concrete edit in one or two sentences (e.g. 'add a guard at the top of getUser that throws RangeError for negative ids'). If the issue is NOT a bug, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- FIX_STRATEGY: <file/function + change description> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are a feature-implementing coder. When given an issue, first decide if it genuinely requests a new feature. If it does, sketch the implementation plan (new function/module, API surface) in one or two sentences. If the issue is NOT a feature request, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- FIX_STRATEGY: <implementation plan> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "dave",
      "role": "coder",
      "prompt": "You are a documentation coder. When given an issue, first decide if it genuinely is a documentation/docs request. If it does, describe the doc change needed in one or two sentences. If the issue is NOT a docs request, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- FIX_STRATEGY: <doc change description> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    },
    {
      "name": "erin",
      "role": "coder",
      "prompt": "You are a refactoring coder. When given an issue, first decide if it genuinely is a refactor request (behavior-preserving structural improvement). If it does, describe the refactor in one or two sentences. If the issue is NOT a refactor request, reply exactly 'NOT MY DOMAIN'. Your output MUST end with a line exactly formatted: <!-- FIX_STRATEGY: <refactor description> --> when it is your domain, or <!-- DOMAIN_MATCH: false --> when it is not."
    }
  ]
}
```

**Role 选择理由**：router 用 `analyst`（侧重读 issue、分类判读），四个分支用 `coder`（侧重定位文件/函数、给出修复策略）。

### 3.3 Master 启动调用

```json
{
  "tool": "team_route",
  "args": {
    "team_id": "issue-triage",
    "router": "alice",
    "input": "When I call getUser(-1) the function returns a user instead of throwing. Expected: throw RangeError for negative ids.",
    "routes": [
      { "name": "bug", "member": "bob", "description": "incorrect behavior, crash, wrong result, missing exception" },
      { "name": "feature", "member": "carol", "description": "request for new functionality" },
      { "name": "docs", "member": "dave", "description": "documentation or readability improvement" },
      { "name": "refactor", "member": "erin", "description": "behavior-preserving structural change" }
    ],
    "timeout_ms": 600000
  }
}
```

**参数选择**：
- `router: "alice"` — 成员名，非 master，不在 routes 中。
- `input` 是真实 issue 正文 — 四个 route 均省略 `task`，匹配分支（`bob`）直接收到正文；分类线索写在 route `description` 里。
- `description` 明确区分四类（尤其「missing exception」线索帮助 router 把「应抛未抛」判为 bug 而非 feature）。

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_route (input = bug 报告正文)
T+0m    Phase A: 仅 dispatch alice
T+0~1m  router 判读「应抛未抛」→ bug → <route>{"branch":"bug",...}</route>
T+1m    Phase B: 仅 dispatch bob（feature/docs/refactor 不触发）
T+1~6m  bob 定位 getUser → 建议加负数 id 防护抛 RangeError → FIX_STRATEGY 标记
T+6m    target barrier 收敛 → 汇总交付 master
T+6m    运行: bun check-coding-issue-router.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-issue-router.ts`](./check-coding-issue-router.ts)

- **加载**：`<run_dir>/alice.md` 与 `<run_dir>/bob.md`
- **提取**：
  - router 决策：正则 `<route>([\s\S]*?)</route>` → `JSON.parse` → 取 `branch`
  - 分支策略：正则 `<!--\s*FIX_STRATEGY:\s*([\s\S]*?)\s*-->`
- **断言**：
  1. router 选中的 branch === `bug`
  2. `bob` 未输出 `DOMAIN_MATCH: false`
  3. `FIX_STRATEGY` 文本（小写）匹配 `guard|throw|rangeerror` 中至少一个关键词

---

## 验收清单

- [ ] 3 个 check 脚本通过 `bunx tsc -p docs/orchestration-scenarios/tsconfig.json`（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `physicist` / `simulator` / `analyst` / `coder` 均为预设）
- [ ] 每个 master 调用参数符合 `team_route` schema：`router` 非 master、非分支 target；routes 的 `name`/`member` 唯一；`input` ≤ 32768 字符
- [ ] 路由模式实际调度成员 = router + 1 匹配分支（≤ 2 活跃），每场景总时长 ≤ 10 min（远低于 30 min 上限）
- [ ] router 成员 prompt 以 `<route>` 格式指令结尾；分支成员 prompt 以 `DOMAIN_MATCH`/`ANSWER`/`METHOD`/`FIX_STRATEGY` 标记指令结尾；评判脚本正则与之严格对齐


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成完整闭环。route 模式评判读 **router** 成员的 `<route>` 决策 + 被选中分支成员的产出。

### 场景 1: 数学题分类路由（数学）

```text
执行 docs/orchestration-scenarios/06-team-route/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（1 router + 4 分支成员）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_route JSON 启动编排（input 是一道具体数学题）
4. team_results 轮询至 master 收到汇总（router 先决策，命中分支再执行）
5. 定位 <run_dir>（含 router 与各分支成员 .md）
6. 运行：bun docs/orchestration-scenarios/06-team-route/check-math-problem-router.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：router 选 calculus 分支；bob 的 ANSWER 含 3x²·sin(x)+x³·cos(x)（或等价导数表达式）。
```

### 场景 2: PDE 类型路由（物理）

```text
执行 docs/orchestration-scenarios/06-team-route/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_route JSON 启动编排（input 是一个具体 PDE）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/06-team-route/check-physics-pde-router.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：router 选 parabolic 分支（热扩散方程 u_t=u_xx+u_yy）；METHOD ∈ {crank-nicolson, implicit, ftcs}。
```

### 场景 3: GitHub issue 分流（编程）

```text
执行 docs/orchestration-scenarios/06-team-route/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_route JSON 启动编排（input 是一段 issue 正文）
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/06-team-route/check-coding-issue-router.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：router 选 bug 分支；FIX_STRATEGY 含 guard / throw / RangeError 之一（针对负 id 的修复思路）。
```
