# team_tollgate 编排场景设计

> **模式**：`team_tollgate` — 判定门控流水线。每个 stage 产出后必须经独立 verifier 三值判定（PASS / FAIL / INVALID），PASS 才放行下游；FAIL 把产出连同 diff 退回 producer（最多 `max_gate_retries` 次）；INVALID 隔离问题、升级到 verifier 侧，不惩罚 producer。
> **源码**：[`src/tools/workflow-advanced.ts:431-549`](../../../src/tools/workflow-advanced.ts)
> **控时设计**：每场景 1 个 gate、2 成员（producer + verifier），producer 3-5 min、verifier 2-3 min，串行 ≈ 6-8 min（远低于 30 min 上限）。

## 场景一览

| # | 方向 | 场景 | 成员数 | Role (producer / verifier) | gate 数 | 预计总时长 |
|---|------|------|--------|----------------------------|---------|-----------|
| 1 | 数学 | 快速模幂（二进制平方乘）实现 + 验证 | 2 | `mathematician` / `reviewer` | 1 | ~8 min |
| 2 | 计算物理 | Velocity Verlet 积分器（能量守恒）实现 + 验证 | 2 | `simulator` / `physicist` | 1 | ~8 min |
| 3 | 编程 | 字符串反转（Unicode 代理对安全）实现 + 验证 | 2 | `coder` / `tester` | 1 | ~7 min |

---

## 场景 1: 快速模幂（二进制平方乘）实现 + 验证

### 1.1 场景描述

**背景**：快速模幂 `base^exp mod mod` 是 RSA 等公钥密码学的核心原语。朴素循环 `O(exp)` 在大指数下不可行；二进制平方乘（binary exponentiation）把复杂度降到 `O(log exp)`，且全程对 `mod` 取模避免大数溢出。`exp=0` 必须返回 `1`（任意正模数的约定）。

**目标**：producer 用 TypeScript 实现迭代版 `modPow(base, exp, mod)`；verifier 跑三个已知答案的用例并放行/驳回。

**成功标准（可机器评判）**：
- producer 输出含 `<!-- IMPL: modPow -->` 标注，且嵌入可加载的 ```typescript 代码块
- 代码通过三例：`modPow(2,10,1000)=24`、`modPow(3,0,7)=1`、`modPow(7,256,13)=9`
- `exp=0` 返回 `1`
- verifier 输出含 `<!-- VERDICT: PASS -->`

### 1.2 Team 配置

```json
{
  "name": "modpow-gate",
  "description": "Fast modular exponentiation: implement (mathematician) then gate-verify (reviewer) against 3 known cases",
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are a mathematician. You implement numerical algorithms in TypeScript with rigor, using minimal code. When asked to produce an implementation, embed the full TypeScript in a single ```typescript fenced block and declare it with an IMPL marker. Your output MUST end with a line exactly formatted: <!-- IMPL: modPow -->"
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a reviewer. You verify mathematical implementations by running them against the gate's criteria. Emit a verdict: PASS if every criterion holds, FAIL otherwise (naming the failing case). Your output MUST end with a line exactly formatted: <!-- VERDICT: PASS --> (or <!-- VERDICT: FAIL -->)."
    }
  ]
}
```

**Role 选择理由**：producer 用 `mathematician`（`build` agent，可写码+做数值验证）；verifier 用 `reviewer`（只读 agent，独立裁判，避免与 producer 同 agent 的偏见）。

### 1.3 Master 启动调用

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "modpow-gate",
    "stages": [
      {
        "member": "alice",
        "task": "Implement `modPow(base, exp, mod)` computing base^exp mod mod via binary exponentiation (iterative square-and-multiply). Handle exp=0 (return 1 for any mod>0). Embed TypeScript code in a fenced block.",
        "verifier": "bob",
        "criteria": "Verify modPow(2,10,1000)=24, modPow(3,0,7)=1, modPow(7,256,13)=9. Also confirm exp=0 returns 1. If all pass emit PASS, else FAIL with the failing case."
      }
    ],
    "max_gate_retries": 1,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- 单 stage（implement → verify）— tollgate 最小有意义单元；门控即终点
- `verifier != member`（`bob` ≠ `alice`）— 满足「禁止自验证」硬约束
- `max_gate_retries: 1` — 给 producer 一次 FAIL 后修正的机会（首次实现易漏 `exp=0` 边界）
- `timeout_ms: 900000`（15 min）— 串行两跳，正常 8 min 完成，留余量

### 1.4 执行流程（时序）

```
T+0m    master 调用 team_tollgate
T+0m    OCTeam dispatch stage-0 producer (alice, mathematician)
T+0~5m  alice 写 modPow → 嵌入 ```typescript 块 + IMPL 标记 → idle
T+5m    gate 触发：dispatch verifier (bob, reviewer)，喂入 producer 输出 + criteria
T+5~8m  bob 跑三用例 → 输出 VERDICT 标记
T+8m    PASS → 流水线结束，结果交付 master
T+8m    运行: bun check-math-fast-pow.ts <run_dir>
```

（若 FAIL 且 `attempts < max_gate_retries`，producer 连同 diff 退回重做，再走一次 gate。）

### 1.5 评判脚本

[`check-math-fast-pow.ts`](./check-math-fast-pow.ts)

- **加载**：`runs/<run_id>/{alice,bob}.md`
- **提取**：
  - producer 代码：抓取 ` ```typescript ... ``` ` 代码块
  - verifier 判定：正则 `<!--\s*VERDICT:\s*(PASS|FAIL)\s*-->`
- **断言**：
  1. producer 代码可用 `new Function` 加载为 `modPow` 函数
  2. `modPow(2,10,1000)===24`、`modPow(3,0,7)===1`、`modPow(7,256,13)===9`
  3. verifier VERDICT 为 `PASS`

---

## 场景 2: Velocity Verlet 积分器（能量守恒）实现 + 验证

### 2.1 场景描述

**背景**：谐振子 `ẍ = -ω²x`（取 ω=1，初始 `x0=1, v0=0`）是能量守恒系统的标准测试题，理论能量 `E = ½(x² + v²) = 0.5` 恒定。Velocity Verlet 是**辛（symplectic）格式**，在有限步长下能量有界振荡而非系统性漂移——这是它与显式 Euler 的本质区别。

**目标**：producer 实现 Velocity Verlet，跑 1000 步（h=0.01），报告相对能量漂移；verifier 核对漂移是否满足辛格式的守恒界。

**成功标准（可机器评判）**：
- producer 输出含 `<!-- DRIFT: <数值> -->` 标注（相对漂移 `|E_end - E0|/E0`）
- 漂移 `< 1e-3`（辛格式的标志）
- verifier 输出含 `<!-- VERDICT: PASS -->`

### 2.2 Team 配置

```json
{
  "name": "verlet-energy-gate",
  "description": "Velocity Verlet on harmonic oscillator: implement (simulator) then gate-verify (physicist) energy conservation"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are a simulator. You implement numerical integrators in TypeScript and run them to report measured quantities. Embed runnable code in a ```typescript fenced block and always end with the requested numeric marker. Your output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
    },
    {
      "name": "bob",
      "role": "physicist",
      "prompt": "You are a physicist. You verify numerical results against physical conservation laws and known tolerances. Emit a verdict: PASS if the criterion holds, FAIL otherwise (with the measured value). Your output MUST end with a line exactly formatted: <!-- VERDICT: PASS --> (or <!-- VERDICT: FAIL -->)."
    }
  ]
}
```

**Role 选择理由**：producer 用 `simulator`（数值模拟专用）；verifier 用 `physicist`（懂辛格式/能量守恒，能独立复算判定）。

### 2.3 Master 启动调用

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "verlet-energy-gate",
    "stages": [
      {
        "member": "alice",
        "task": "Implement Velocity Verlet for the harmonic oscillator (omega=1, x0=1, v0=0). Run 1000 steps h=0.01. Embed the integrator code. Report the relative energy drift.",
        "verifier": "bob",
        "criteria": "Verify |E_end - E0|/E0 < 1e-3 (Verlet is symplectic). Compare the producer's reported drift to a recomputation if possible. If drift < 1e-3 emit PASS, else FAIL."
      }
    ],
    "max_gate_retries": 1,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- `max_gate_retries: 1` — 辛格式实现易在「先更新位置还是速度」上犯错（破坏辛性），给一次修正机会
- verifier 用 `physicist` 角色可独立复算漂移，而非盲信 producer 报数

### 2.4 执行流程（时序）

```
T+0m    master 调用 team_tollgate
T+0m    dispatch producer (alice, simulator)
T+0~5m  alice 写 Velocity Verlet → 跑 1000 步 → 报告 DRIFT 标记 → idle
T+5m    gate 触发：dispatch verifier (bob, physicist)
T+5~8m  bob 复算/核对漂移 < 1e-3 → 输出 VERDICT 标记
T+8m    PASS → 结果交付 master
T+8m    运行: bun check-physics-verlet.ts <run_dir>
```

### 2.5 评判脚本

[`check-physics-verlet.ts`](./check-physics-verlet.ts)

- **加载**：`runs/<run_id>/{alice,bob}.md`
- **提取**：
  - producer 漂移：正则 `<!--\s*DRIFT:\s*([\d.eE+-]+)\s*-->`
  - verifier 判定：正则 `<!--\s*VERDICT:\s*(PASS|FAIL)\s*-->`
- **断言**：
  1. 漂移值存在且 `Number.isFinite`
  2. `drift < 1e-3`（辛格式守恒界）
  3. verifier VERDICT 为 `PASS`

---

## 场景 3: 字符串反转（Unicode 代理对安全）实现 + 验证

### 3.1 场景描述

**背景**：JavaScript 字符串按 UTF-16 码元存储。emoji（如 `🚀`，U+1F680）由一对代理项（surrogate pair）表示。朴素 `s.split('').reverse().join('')` 会拆散代理对，反转后产生乱码。正确做法须按**码点（code point）**反转——如 `[...s].reverse().join('')` 或显式 `for...of`。

**目标**：producer 实现 `reverseStr(s: string): string`，正确处理 ASCII、空串与代理对；verifier 跑三个用例（含 emoji）。

**成功标准（可机器评判）**：
- producer 输出含 `<!-- IMPL: reverseStr -->` 标注，嵌入可加载代码块
- `reverseStr('abc')==='cba'`、`reverseStr('')===''`、`reverseStr('a🚀b')==='b🚀a'`（代理对保持完整）
- verifier 输出含 `<!-- VERDICT: PASS -->`

### 3.2 Team 配置

```json
{
  "name": "reverse-str-gate",
  "description": "Unicode-safe string reverse: implement (coder) then gate-verify (tester) including a surrogate-pair case"
}
```

```json
{
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are a coder. You implement functions in clean TypeScript with minimal code. Embed the full TypeScript in a single ```typescript fenced block and declare it with an IMPL marker. Your output MUST end with a line exactly formatted: <!-- IMPL: reverseStr -->"
    },
    {
      "name": "bob",
      "role": "tester",
      "prompt": "You are a tester. You verify implementations by running them against the gate's test cases, including edge cases. Emit a verdict: PASS if every case holds, FAIL otherwise (naming the failing case). Your output MUST end with a line exactly formatted: <!-- VERDICT: PASS --> (or <!-- VERDICT: FAIL -->)."
    }
  ]
}
```

**Role 选择理由**：producer 用 `coder`（专注实现）；verifier 用 `tester`（专门跑测试用例，含边界）。

### 3.3 Master 启动调用

```json
{
  "tool": "team_tollgate",
  "args": {
    "team_id": "reverse-str-gate",
    "stages": [
      {
        "member": "alice",
        "task": "Implement `reverseStr(s: string): string` that reverses a string AND correctly handles Unicode surrogate pairs (e.g. emoji). Embed TypeScript code in a fenced block.",
        "verifier": "bob",
        "criteria": "Verify reverseStr('abc')='cba', reverseStr('')='', reverseStr('a🚀b')='b🚀a' (surrogate pair stays intact). Run these 3 cases. If all pass emit PASS, else FAIL."
      }
    ],
    "max_gate_retries": 1,
    "timeout_ms": 900000
  }
}
```

**参数选择**：
- 代理对边界是典型陷阱（朴素 split 即错），`max_gate_retries: 1` 给一次补救
- verifier 用 `tester` 角色，三个用例（含空串、emoji）直接编码在 `criteria` 里

### 3.4 执行流程（时序）

```
T+0m    master 调用 team_tollgate
T+0m    dispatch producer (alice)
T+0~4m  alice 写 reverseStr → 嵌入代码 + IMPL 标记 → idle
T+4m    gate 触发：dispatch verifier (bob, tester)
T+4~7m  bob 跑三用例（含 emoji） → 输出 VERDICT 标记
T+7m    PASS → 结果交付 master
T+7m    运行: bun check-coding-reverse-str.ts <run_dir>
```

### 3.5 评判脚本

[`check-coding-reverse-str.ts`](./check-coding-reverse-str.ts)

- **加载**：`runs/<run_id>/{alice,bob}.md`
- **提取**：
  - producer 代码：抓取 ` ```typescript ... ``` ` 代码块
  - verifier 判定：正则 `<!--\s*VERDICT:\s*(PASS|FAIL)\s*-->`
- **断言**：
  1. producer 代码可用 `new Function` 加载为 `reverseStr` 函数
  2. `reverseStr('abc')==='cba'`、`reverseStr('')===''`、`reverseStr('a🚀b')==='b🚀a'`
  3. verifier VERDICT 为 `PASS`

---

## 验收清单

- [ ] 3 个 check 脚本 `tsc -p docs/orchestration-scenarios/tsconfig.json` 通过（无类型错误）
- [ ] 每个 team 配置 role 合法（`mathematician` / `reviewer` / `simulator` / `physicist` / `coder` / `tester` 均为预设）
- [ ] 每个 stage 的 `verifier != member`（`bob` ≠ `alice`，满足 tollgate 硬约束）
- [ ] 每个 master 调用参数符合 `team_tollgate` schema（`stages[].{member,task,verifier,criteria}`）
- [ ] 每场景总时长 ≤ 8 min（远低于 30 min 上限）
- [ ] 成员 prompt 与评判脚本标记对齐：producer 发 `IMPL`/`DRIFT`，verifier 发 `VERDICT`


---

## 快速启动 Prompt（复制即用）

> 将以下任一 prompt 粘贴给 master 会话，AI 会自动完成完整闭环。tollgate 模式评判读 **producer + verifier** 两个成员的 .md：producer 的实现/数值结果 + verifier 的 VERDICT。

### 场景 1: 实现快速幂 + 验证（数学）

```text
执行 docs/orchestration-scenarios/09-team-tollgate/README.md「场景 1」的完整闭环并自动评判。

步骤：
1. 读 README「1.2 Team 配置」，按 team_create JSON 创建团队（producer + verifier 两个成员）
2. team_activate 激活
3. 读 README「1.3 Master 启动调用」，按 team_tollgate JSON 启动编排（1 个门：implement → verify）
4. team_results 轮询至 master 收到汇总（verifier PASS 才交付；FAIL 回退 producer 重做，受 max_gate_retries 限制）
5. 定位 <run_dir>（含 producer 与 verifier 的 .md）
6. 运行：bun docs/orchestration-scenarios/09-team-tollgate/check-math-fast-pow.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：producer 的 modPow 通过 3 用例（2^10 mod 1000 = 24、3^0 mod 7 = 1、7^256 mod 13 = 9）；verifier VERDICT = PASS。
```

### 场景 2: 实现 Verlet 求解器 + 验证（物理）

```text
执行 docs/orchestration-scenarios/09-team-tollgate/README.md「场景 2」的完整闭环并自动评判。

步骤：
1. 读 README「2.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「2.3 Master 启动调用」，按 team_tollgate JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/09-team-tollgate/check-physics-verlet.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：producer 报 DRIFT < 1e-3（Verlet 辛格式守恒）；verifier VERDICT = PASS。
```

### 场景 3: 实现字符串反转 + 验证（编程）

```text
执行 docs/orchestration-scenarios/09-team-tollgate/README.md「场景 3」的完整闭环并自动评判。

步骤：
1. 读 README「3.2 Team 配置」，按 team_create JSON 创建团队
2. team_activate 激活
3. 读 README「3.3 Master 启动调用」，按 team_tollgate JSON 启动编排
4. team_results 轮询至 master 收到汇总
5. 定位 <run_dir>
6. 运行：bun docs/orchestration-scenarios/09-team-tollgate/check-coding-reverse-str.ts <run_dir>
7. 按退出码报告：0 = PASS，1 = FAIL，2 = 用法/IO 错误

成功标准：producer 的 reverseStr 通过 3 用例（'abc'→'cba'、''→''、'a🚀b'→'b🚀a' 含 surrogate pair intact）；verifier VERDICT = PASS。
```
