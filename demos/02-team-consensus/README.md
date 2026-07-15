# team_consensus Orchestration Scenario Demo

`team_consensus` runs a multi-round structured debate where all members state positions on a `topic` and converge toward consensus round by round; each member emits `<consensus>{"agreed": true|false}</consensus>` each round; when all `agreed=true`, consensus is reached.

---

## Scenario Overview

| # | Domain | Scenario | Members | Role | max_rounds | Est. Total Duration |
|---|------|------|--------|------|------------|-----------|
| 1 | Math | Small-array stable sort algorithm selection | 3 | `mathematician` | 6 | ~24 min |
| 2 | Computational Physics | 1D heat diffusion time scheme selection | 3 | `simulator` | 6 | ~20 min |
| 3 | Programming | Short-text string matching algorithm selection | 3 | `coder` | 6 | ~20 min |
| 4 | Math | 60-digit RSA modulus factoring algorithm selection (challenge-level) | 6 | `mathematician` | 5 | ~35 min |

---

## Scenario 1: Small-Array Stable Sort Algorithm Selection

### 1.1 Scenario Description

**Background**: When data is small (n<50) and nearly sorted, but stability is a hard constraint, insertion sort / TimSort / merge sort each have advantages. Insertion sort approaches O(n) with low inversion counts; TimSort is a hybrid algorithm with specialized optimizations for small arrays (minrun + galloping); merge sort is strictly O(n log n) but has larger constants. Which is "optimal" depends on inversion density — precisely the kind of open-ended problem suitable for multi-round debate convergence.

**Goal**: 3 members each defend one algorithm, converging through ≤6 rounds of debate to a consensus conclusion: "name one algorithm + one criterion condition" (e.g., insertion sort when inversion count < n²/16, otherwise TimSort).

**Success criteria (machine-verifiable)**:
- Each member's final-round output contains a `<consensus>{"agreed": ..., "choice": "..."}</consensus>` marker
- All three members `agreed: true` in the final round (true consensus reached, not max_rounds exhausted)
- The `choice` field value matches a known algorithm name (`insertion|timsort|merge`)
- All three members' `choice` converge to the same algorithm name (genuine consensus)

### 1.2 Team Config

```json
{
  "name": "sort-debate",
  "description": "Stable sort selection for n<50 nearly-sorted arrays: 3-way consensus debate",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are the advocate for INSERTION SORT in a 3-way debate. Topic: For n<50 nearly-sorted elements that require a STABLE sort, which algorithm is optimal: insertion sort, TimSort, or merge sort? Make the strongest technical case for insertion sort: O(n) best case on nearly-sorted input, O(n+k) where k = inversion count, O(1) auxiliary memory, cache-friendly sequential access, lowest constant factors, no recursion overhead. Across rounds engage honestly with the other advocates (timsort, merge-sort); concede regimes where they win. The group's goal is a consensus naming ONE algorithm plus a decision condition (e.g. 'insertion sort when inversion count < n^2/16, else TimSort'). End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are the advocate for TIMSORT in a 3-way debate. Topic: For n<50 nearly-sorted elements that require a STABLE sort, which algorithm is optimal: insertion sort, TimSort, or merge sort? Make the strongest technical case for TimSort: hybrid adaptive mergesort, exploits existing runs (O(n) on sorted data), production-tested (Python/Java/V8 default), stable, degrades gracefully to O(n log n) worst case. Note for n<50 it uses a small insertion-sort 'minrun' then merges, combining the strengths of both. Across rounds engage honestly with the other advocates (insertion, merge-sort); concede regimes where they win. The group's goal is a consensus naming ONE algorithm plus a decision condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are the advocate for MERGE SORT in a 3-way debate. Topic: For n<50 nearly-sorted elements that require a STABLE sort, which algorithm is optimal: insertion sort, TimSort, or merge sort? Make the strongest technical case for merge sort: strict O(n log n) worst/average/best, stable, predictable performance independent of input distribution, and the foundation on which TimSort is built. Acknowledge the higher constant factor vs insertion sort on tiny n, but argue the predictability and the n log n ceiling matter. Across rounds engage honestly with the other advocates (insertion, timsort); concede regimes where they win. The group's goal is a consensus naming ONE algorithm plus a decision condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    }
  ]
}
```

**Role selection rationale**: `mathematician` uses the `oct-junior` agent, capable of complexity analysis, counterexample construction, and numerical verification — perfectly matching the algorithm selection debate needs.

### 1.3 Master Launch Invocation

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "sort-debate",
    "topic": "For n<50 nearly-sorted elements that require stable sort, which algorithm is optimal: insertion sort, TimSort, or merge sort?",
    "max_rounds": 6,
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- `max_rounds: 6` — algorithm selection is an open question; the core arguments typically resolve within 3 rounds of "state position → mutual rebuttal → converge", with 6 rounds as convergence headroom
- `timeout_ms: 1800000` (30 min) — ample headroom; normally ~10 min to converge
- No `token_budget` — the topic is small, tokens are naturally bounded; prioritize convergence quality
- No `signoff_*` parameters — `team_consensus` by design has no signoff gate; all members `agreed=true` is the pass condition (see source wf-013 comment)

### 1.4 Execution Flow (Timeline)

```
T+0m    master calls team_consensus (topic, max_rounds=6)
T+0m    OCTeam dispatches 3 mathematicians in parallel, Round 1: each states position
T+0~3m  each member reads topic → gives algorithm defense + complexity arguments + <consensus agreed=false>
T+3m    Round 2: members read each other's arguments → rebut / concede
T+3~6m  each member adjusts position, partial concession + <consensus agreed=true|false>
T+6m    Round 3 (if needed): converge to common conclusion
T+6~9m  all agreed=true, consensus reached, run ends
T+9m    run: bun check-math-sort-stability.ts <run_dir>
```

### 1.5 Check Script

[`check-math-sort-stability.ts`](./check-math-sort-stability.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**: global regex `<consensus>([\s\S]*?)</consensus>`, take the last tag as the final round
- **Assertions**:
  1. Each member has at least one `<consensus>` tag
  2. Each member's final round `agreed: true` (true consensus, not max_rounds exhausted)
  3. Each member's final round `choice` matches `/^(insertion|timsort|merge)/i`
  4. All three members' `choice` converge to the same algorithm name (case-insensitive normalized)

---

## Scenario 2: 1D Heat Diffusion Time Scheme Selection

### 2.1 Scenario Description

**Background**: For the 1D heat equation `u_t = u_xx` discretized via finite differences on a uniform grid, the time integration scheme determines stability and accuracy. Given `dt=0.01`, `dx=0.1`, the diffusion number `r = dt/dx² = 0.01/0.01 = 1.0`. The explicit FTCS CFL condition `r ≤ 0.5` is violated here — the explicit scheme is numerically unstable, requiring an implicit-class scheme instead. But implicit (1st-order in time) and Crank-Nicolson (2nd-order in time) still involve tradeoffs in accuracy vs computational cost.

**Goal**: 3 members each defend one scheme (explicit FTCS / fully-implicit / Crank-Nicolson), converging through ≤6 rounds of debate to a consensus conclusion: "select one scheme + cite the CFL stability condition (explicit `r = dt/dx² ≤ 0.5`)".

**Success criteria (machine-verifiable)**:
- Each member's final-round output contains a `<consensus>{"agreed": ..., "choice": "..."}</consensus>` marker
- All three members `agreed: true` in the final round
- The `choice` field value matches a known scheme name (`explicit|implicit|crank`)
- All three members' `choice` converge to the same scheme name (explicit FTCS should be eliminated because r=1.0>0.5; expected convergence to `implicit` or `crank`)

### 2.2 Team Config

```json
{
  "name": "heat-debate",
  "description": "1D heat equation u_t=u_xx time scheme: 3-way consensus debate (FTCS vs implicit vs Crank-Nicolson)",
  "members": [
    {
      "name": "alice",
      "role": "simulator",
      "prompt": "You are the advocate for EXPLICIT FTCS (Forward-Time Centered-Space) in a 3-way debate. Topic: For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose a time scheme: explicit FTCS / fully-implicit / Crank-Nicolson. Make the strongest case for explicit FTCS: trivial to implement, no linear solve per step, O(N) per timestep, and second-order in space. CRUCIAL: you MUST compute the diffusion number r = dt/dx^2 = 0.01/(0.1^2) = 1.0 and acknowledge the CFL stability condition r <= 0.5 for explicit schemes. Since r=1.0 > 0.5, be honest that explicit FTCS is UNSTABLE for these parameters — argue only for the regime where it would win (smaller dt). Across rounds engage with implicit-advocate and crank-advocate; concede when r violates CFL. The group's goal is a consensus naming ONE scheme plus the CFL condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<scheme-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "bob",
      "role": "simulator",
      "prompt": "You are the advocate for FULLY-IMPLICIT (Backward Euler) in a 3-way debate. Topic: For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose a time scheme: explicit FTCS / fully-implicit / Crank-Nicolson. Make the strongest case for fully-implicit (Backward Euler): unconditionally stable for any r (no CFL limit), first-order accurate in time (O(dt)) and second-order in space (O(dx^2)), requires solving a tridiagonal system per step (O(N) via Thomas algorithm). Given r = dt/dx^2 = 1.0 > 0.5, the explicit scheme is unstable, so implicit is the minimum stable upgrade. Across rounds engage with explicit-advocate and crank-advocate; concede the accuracy advantage of Crank-Nicolson. The group's goal is a consensus naming ONE scheme plus the CFL condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<scheme-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "carol",
      "role": "simulator",
      "prompt": "You are the advocate for CRANK-NICOLSON in a 3-way debate. Topic: For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose a time scheme: explicit FTCS / fully-implicit / Crank-Nicolson. Make the strongest case for Crank-Nicolson: unconditionally stable (like fully-implicit), second-order accurate in BOTH time and space (O(dt^2 + dx^2)), the accuracy leader. Same tridiagonal solve cost per step as fully-implicit. Given r = dt/dx^2 = 1.0 > 0.5, explicit is unstable; the real debate is accuracy: Crank-Nicolson beats Backward Euler on temporal accuracy. Across rounds engage with explicit-advocate and implicit-advocate; concede that for very stiff problems Backward Euler's damping can be desirable. The group's goal is a consensus naming ONE scheme plus the CFL condition. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<scheme-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    }
  ]
}
```

**Role selection rationale**: `simulator` is purpose-built for numerical simulation (PDE/finite difference/stability analysis), fitting the heat diffusion scheme selection scenario.

### 2.3 Master Launch Invocation

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "heat-debate",
    "topic": "For u_t = u_xx on a uniform grid with dt=0.01, dx=0.1, choose: explicit FTCS / fully-implicit / Crank-Nicolson.",
    "max_rounds": 6,
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- `max_rounds: 6` — the CFL criterion is a hard constraint (r=1.0>0.5 directly eliminates explicit), leaving implicit vs Crank-Nicolson resolvable in one round, with 6 rounds as convergence headroom
- `timeout_ms: 1800000` (30 min) — ample headroom
- No `signoff_*` parameters — the consensus mechanism is the gate

### 2.4 Execution Flow (Timeline)

```
T+0m    master calls team_consensus (topic, max_rounds=6)
T+0m    OCTeam dispatches 3 simulators in parallel, Round 1: each states position + compute r
T+0~3m  each member computes CFL: r=1.0>0.5 → explicit self-eliminated
T+3m    Round 2: alice concedes; implicit vs crank debate accuracy
T+3~6m  members converge to unconditionally stable scheme (implicit or crank)
T+6m    Round 3 (if needed): all agreed=true
T+6~9m  consensus reached
T+9m    run: bun check-physics-heat-diffusion.ts <run_dir>
```

### 2.5 Check Script

[`check-physics-heat-diffusion.ts`](./check-physics-heat-diffusion.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**: global regex `<consensus>([\s\S]*?)</consensus>`, take the last tag as the final round
- **Assertions**:
  1. Each member has at least one `<consensus>` tag
  2. Each member's final round `agreed: true`
  3. Each member's final round `choice` matches `/^(explicit|implicit|crank)/i`
  4. All three members' `choice` converge to the same scheme name
  5. Final consensus scheme ≠ `explicit` (since r=1.0 violates CFL, the explicit scheme should be eliminated)

---

## Scenario 3: Short-Text String Matching Algorithm Selection

### 3.1 Scenario Description

**Background**: Pattern matching is a fundamental algorithm problem. When text is very short (<1KB) and patterns are also short (≤32 chars), naive, KMP, Boyer-Moore, and Sunday each have applicable domains: naive has minimal constants (zero preprocessing), KMP guarantees O(n+m) worst case but its preprocessing overhead is not worthwhile for small input, Sunday (Horspool variant) averages O(n/m) sublinear, Boyer-Moore excels for longer patterns. For short text, "optimal" depends on the text/pattern length ratio — ideal for multi-round debate.

**Goal**: 3 members each defend one algorithm (naive / KMP / Sunday), converging through ≤6 rounds of debate to a consensus conclusion: "a decision tree keyed on text/pattern lengths" (e.g., naive when n×m<256, otherwise Sunday).

**Success criteria (machine-verifiable)**:
- Each member's final-round output contains a `<consensus>{"agreed": ..., "choice": "..."}</consensus>` marker
- All three members `agreed: true` in the final round
- The `choice` field value matches a known algorithm name (`naive|kmp|boyer|sunday`)
- All three members' `choice` converge to the same algorithm name

### 3.2 Team Config

```json
{
  "name": "string-debate",
  "description": "Short-text pattern matching (<1KB, pattern<=32): 3-way consensus debate (naive / KMP / Sunday)",
  "members": [
    {
      "name": "alice",
      "role": "coder",
      "prompt": "You are the advocate for the NAIVE (brute-force) string matcher in a 3-way debate. Topic: For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday. Make the strongest case for naive: zero preprocessing, O(nm) worst case but O(n) on typical text with early mismatch on first char, lowest constant factor, branch-predictor friendly, no extra memory. For n<1KB the quadratic ceiling never bites in practice. Across rounds engage with kmp-advocate (whose O(n+m) worst case shines on repetitive text) and sunday-advocate (whose average O(n/m) wins on larger n); concede regimes where they win. The group's goal is a consensus decision tree keyed on text/pattern lengths. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "bob",
      "role": "coder",
      "prompt": "You are the advocate for KMP (Knuth-Morris-Pratt) in a 3-way debate. Topic: For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday. Make the strongest case for KMP: guaranteed O(n+m) worst case (never degrades on repetitive/DNA-like text), O(m) preprocessing for the failure function, deterministic performance independent of alphabet. The worst-case guarantee is the differentiator vs naive (which can hit O(nm) on adversarial input like 'aaaa...aab' in 'aaaa...a'). Across rounds engage with naive-advocate (whose constants are lower for tiny n) and sunday-advocate (whose average case is sublinear); concede that for uniformly random short text naive or Sunday may win on wall-clock. The group's goal is a consensus decision tree keyed on text/pattern lengths. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "carol",
      "role": "coder",
      "prompt": "You are the advocate for SUNDAY (a.k.a. Sunday / Horspool-variant) string matching in a 3-way debate. Topic: For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday. Make the strongest case for Sunday: average-case O(n/m) sublinear (skips m chars on mismatch using the bad-character table), simple preprocessing (O(alphabet+m)), and the practical winner on typical text for short-to-medium patterns. For short text <1KB with patterns <=32 it consistently beats KMP on wall-clock while being simpler than full Boyer-Moore (no good-suffix rule). Across rounds engage with naive-advocate (whose zero-overhead wins for tiny n) and kmp-advocate (whose worst-case guarantee Sunday lacks); concede regimes where they win. The group's goal is a consensus decision tree keyed on text/pattern lengths. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<algorithm-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    }
  ]
}
```

**Role selection rationale**: `coder` uses the `oct-junior` agent, capable of writing benchmark code and measuring short-text matching wall-clock times to support arguments — fitting the algorithm implementation debate.

### 3.3 Master Launch Invocation

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "string-debate",
    "topic": "For pattern matching on short text (<1KB) with patterns <=32 chars, choose: naive / KMP / Boyer-Moore / Sunday.",
    "max_rounds": 6,
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- `max_rounds: 6` — the short-text scenario has clear boundaries (n<1KB); the core comparison typically finishes within 3 rounds of "state position → empirical comparison → converge to decision tree", with 6 rounds as convergence headroom
- `timeout_ms: 1800000` (30 min) — ample headroom; normally ~8 min to converge
- No `signoff_*` parameters — the consensus mechanism is the gate

### 3.4 Execution Flow (Timeline)

```
T+0m    master calls team_consensus (topic, max_rounds=6)
T+0m    OCTeam dispatches 3 coders in parallel, Round 1: each states position
T+0~3m  each member gives algorithm analysis (complexity + applicable boundaries)
T+3m    Round 2: members may write benchmarks to measure short-text wall-clock → rebut with data
T+3~6m  members partition applicable domains by text/pattern length
T+6m    Round 3 (if needed): converge to decision tree, all agreed=true
T+6~8m  consensus reached
T+8m    run: bun check-coding-string-match.ts <run_dir>
```

### 3.5 Check Script

[`check-coding-string-match.ts`](./check-coding-string-match.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md`
- **Extract**: global regex `<consensus>([\s\S]*?)</consensus>`, take the last tag as the final round
- **Assertions**:
  1. Each member has at least one `<consensus>` tag
  2. Each member's final round `agreed: true`
  3. Each member's final round `choice` matches `/^(naive|kmp|boyer|sunday)/i`
  4. All three members' `choice` converge to the same algorithm name (case-insensitive normalized)

---

## Scenario 4: 60-Digit RSA Modulus Factoring Algorithm Selection (Challenge-Level)

> **Challenge-level note**: This scenario deliberately breaks the easy-level constraint of "≤4 members, ≤30 min", using **6 members × `max_rounds=5`** to simulate a realistic cryptographic algorithm selection debate — more candidates, deeper complexity hierarchy, slower convergence. Estimated total duration ≈ 35 min.

### 4.1 Scenario Description

**Background**: Factoring a ~60-digit decimal (~200-bit) RSA modulus `N = p·q` (p, q both ~30-digit primes) is a classic problem in number theory and computational number theory. Six mainstream algorithms each have different complexity classes and domains of applicability:

| Algorithm | Complexity (N is modulus) | Applicability for 60-digit balanced semiprime |
|------|--------------------|-----------------------------|
| Trial division | `O(N^(1/2))` ≈ `O(10^30)` | Completely infeasible (only effective for small factors) |
| Pollard rho | `O(p^(1/2))` ≈ `O(N^(1/4))` ≈ `10^15` | Infeasible for balanced semiprime (only strong for small/medium factors) |
| Lenstra ECM | `L_p[1/2]` (depends on smallest factor p) | Dominated by sieve methods when balanced (strongest for unbalanced factors) |
| Quadratic sieve QS | `L_N[1/2, 1]` (sub-exponential) | Competitive at 60-digit due to low overhead, strong wall-clock contender |
| Number field sieve NFS | `L_N[1/3, 1.923]` (sub-exponential, asymptotically optimal) | Standard/record-class tool, strongest scalability |
| Shor's quantum algorithm | `O((log N)^3)` (polynomial) | Polynomial time but requires fault-tolerant quantum computer, currently future-relevant only |

Key criterion: For a **balanced** 60-digit RSA semiprime, trial division / Pollard rho / ECM are all dominated by the sub-exponential sieve methods; QS may have a slight wall-clock edge at 60-digit, but NFS is asymptotically optimal (`L[1/3]`), the record holder, and the industry standard. Shor's is the only known polynomial-time algorithm, but currently lacks a sufficiently large fault-tolerant quantum computer — it is future-relevant.

**Goal**: 6 members each defend one algorithm, converging through ≤5 rounds of debate to a consensus conclusion: "select one best **practical classical** method (expected NFS) + explicitly acknowledge Shor's quantum algorithm as future-relevant".

**Success criteria (machine-verifiable)**:
- Each member's final-round output contains a `<consensus>{"agreed": ..., "choice": "..."}</consensus>` marker
- All six members `agreed: true` in the final round (true consensus reached, not max_rounds exhausted)
- Each member's final round `choice` ∈ {`nfs`, `number-field-sieve`, `quadratic-sieve`, `qs`, `pollard-rho`, `ecm`, `shor`, `trial-division`}
- At least one member's argument mentions one of the keywords `{sub-exponential, 60-digit, rsa, quantum}` (confirming the debate is anchored on the RSA factoring problem)

### 4.2 Team Config

```json
{
  "name": "rsa-debate",
  "description": "60-digit (~200-bit) RSA modulus factoring: 6-way challenge consensus debate (trial division / Pollard rho / QS / NFS / Lenstra ECM / Shor)",
  "members": [
    {
      "name": "alice",
      "role": "mathematician",
      "prompt": "You are the advocate for TRIAL DIVISION in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest technical case for trial division: trivial to implement, zero preprocessing, finds small factors immediately, O(N^(1/2)) worst case. CRUCIAL: be honest — for a balanced 60-digit RSA semiprime, trial division up to N^(1/2) needs ~10^30 divisions, utterly infeasible; trial division only wins when N has a tiny prime factor, which a properly generated RSA modulus does not. Across rounds concede decisively to the sub-exponential sieves (QS L_N[1/2], NFS L_N[1/3]) and to Shor's polynomial-time quantum algorithm (future-relevant). The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant (needs a fault-tolerant quantum computer not yet available at scale). End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "bob",
      "role": "mathematician",
      "prompt": "You are the advocate for POLLARD RHO in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for Pollard rho: expected O(p^(1/2)) = O(N^(1/4)) time to find a factor p, O(1) memory, simple randomized Floyd-cycle loop, the go-to for small/medium factors and a standard subroutine in factoring tools. CRUCIAL: be honest — for a balanced 60-digit RSA semiprime, N^(1/4) ≈ 10^15 iterations, far beyond practical reach; Pollard rho is dominated by the sub-exponential sieves on balanced semiprimes and only wins when one factor is small. Concede to QS/NFS for the balanced case; note rho remains useful as a small-factor pre-screen. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "carol",
      "role": "mathematician",
      "prompt": "You are the advocate for the QUADRATIC SIEVE (QS) in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for QS: sub-exponential complexity L_N[1/2, 1], the fastest general-purpose classical factoring algorithm for numbers below ~100 digits, low constant overhead, fully classical, the workhorse behind 1990s RSA factoring challenges. For 60-digit moduli QS is competitive with or faster than NFS on wall-clock because NFS's larger overhead only pays off above the QS/NFS crossover (historically ~100-110 digits). Across rounds engage honestly: concede that NFS has the better asymptotic exponent L_N[1/3] and is the universal record/standard tool for large sizes, and that for a balanced semiprime trial division/Pollard rho/ECM are all dominated by the sieves; argue QS is the practical wall-clock winner specifically at 60-digit. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "dave",
      "role": "mathematician",
      "prompt": "You are the advocate for the NUMBER FIELD SIEVE (NFS) in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for NFS: sub-exponential complexity L_N[1/3, c] with c≈1.923 — the asymptotically fastest known classical factoring algorithm, the method behind every modern RSA factoring record (RSA-155, RSA-768, RSA-250), and the de-facto standard general-purpose factoring engine for cryptographically relevant sizes. Although QS may have lower wall-clock overhead specifically around 60-digit (below the QS/NFS crossover), NFS is the scalable, standard, record-holding choice that generalizes to any serious RSA factoring target. Across rounds engage honestly: concede QS's overhead advantage at 60-digit but argue the consensus should name NFS as the best practical classical method because it is the standard, scalable, asymptotically superior tool. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "erin",
      "role": "mathematician",
      "prompt": "You are the advocate for LENSTRA'S ELLIPTIC CURVE METHOD (ECM) in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for ECM: sub-exponential in the size of the SMALLEST factor p (L_p[1/2, ...]) rather than in N, the champion when one factor is much smaller than the other, fully classical, widely deployed (GMP-ECM). CRUCIAL: be honest — for a BALANCED 60-digit RSA semiprime (two ~30-digit primes), ECM's runtime depends on the ~30-digit factor: L_p[1/2] is far slower than the sieves' L_N[1/2] or L_N[1/3] in N, so ECM is dominated by QS/NFS on balanced semiprimes; ECM only wins for unbalanced factors (one small prime). Concede to QS/NFS for the balanced case; note ECM stays useful as a small-factor pre-screen. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    },
    {
      "name": "frank",
      "role": "mathematician",
      "prompt": "You are the advocate for SHOR'S QUANTUM ALGORITHM in a 6-way debate. Topic: For factoring a ~60-digit (~200-bit) RSA modulus N=p*q (two ~30-digit primes) in practice, which algorithm should be used? Candidates: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, Shor's quantum algorithm. Make the strongest case for Shor's algorithm: polynomial time O((log N)^3), the only known polynomial-time factoring algorithm, provably efficient on a sufficiently large fault-tolerant quantum computer, and the canonical motivation for the entire post-quantum cryptography effort. CRUCIAL: be honest about the present — no fault-tolerant quantum computer with enough logical qubits to factor a 60-digit (200-bit) RSA modulus exists today; current experimental demonstrations factor only tiny numbers (e.g., 15, 21). So Shor is FUTURE-relevant, not a practical choice today. Argue the consensus must (a) select the best PRACTICAL CLASSICAL method for today (expected NFS) AND (b) explicitly acknowledge Shor as the asymptotic/long-term winner that motivates post-quantum migration. The group's goal is a consensus naming ONE best PRACTICAL classical method for a 60-digit RSA modulus (expected NFS), while explicitly acknowledging Shor's quantum algorithm as future-relevant. End your final-round output with a line exactly: <consensus>{\"agreed\": true|false, \"choice\": \"<method-name>\"}</consensus>. CRITICAL: the choice field is MANDATORY in every <consensus> emission — never omit it. It must name the candidate you ultimately ENDORSE as the group consensus — NOT the one you were assigned to advocate. If you concede to another member's position, choice MUST equal the conceded-to candidate."
    }
  ]
}
```

**Member→method mapping**: alice→trial division, bob→Pollard rho, carol→quadratic sieve QS, dave→number field sieve NFS, erin→Lenstra ECM, frank→Shor's quantum algorithm.

**Role selection rationale**: All 6 members use `mathematician` (`oct-junior` agent), capable of complexity hierarchy analysis (`O` / sub-exponential `L[]`), logarithmic calculation, and counterexample construction — perfectly matching the deep debate needs of cryptographic algorithm selection.

### 4.3 Master Launch Invocation

```json
{
  "tool": "team_consensus",
  "args": {
    "team_id": "rsa-debate",
    "topic": "For factoring a ~60-digit (~200-bit) RSA modulus in practice, which algorithm should be used? Consider: trial division, Pollard rho, quadratic sieve (QS), number field sieve (NFS), Lenstra ECM, and Shor's quantum algorithm.",
    "max_rounds": 5,
    "timeout_ms": 2400000
  }
}
```

**Parameter selection**:
- `max_rounds: 5` — 6 algorithms, deep complexity hierarchy, requires more rounds for weak candidates (trial division / Pollard rho / ECM) to concede sequentially, for QS vs NFS to fully compare, and for Shor to be positioned as "future-relevant"
- `timeout_ms: 2400000` (40 min) — 6 members × 5 rounds, ample headroom; normally ~35 min to converge
- No `token_budget` — the topic is deep, tokens are naturally bounded; prioritize convergence quality
- No `signoff_*` parameters — `team_consensus` by design has no signoff gate; all members `agreed=true` is the pass condition (see source wf-013 comment)

### 4.4 Execution Flow (Timeline)

```
T+0m    master calls team_consensus (topic, max_rounds=5)
T+0m    OCTeam dispatches 6 mathematicians in parallel, Round 1: each states position + complexity hierarchy
T+0~5m  each member gives complexity (O / sub-exponential L[]) + feasibility criteria for 60-digit
T+5m    Round 2: trial division / Pollard rho self-eliminate (infeasible); ECM concedes
T+5~12m weak candidates acknowledge dominance by sieve family
T+12m   Round 3: QS vs NFS debate wall-clock vs asymptotic; Shor positioned as "future-relevant"
T+12~20m members gradually converge to NFS (standard / scalable / record-class)
T+20m   Round 4-5: all agreed=true, explicitly acknowledge Shor future relevance
T+20~35m consensus reached
T+35m   run: bun check-math-factoring-consensus.ts <run_dir>
```

### 4.5 Check Script

[`check-math-factoring-consensus.ts`](./check-math-factoring-consensus.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,dave,erin,frank}.md` (6 members)
- **Extract**: global regex `<consensus>([\s\S]*?)</consensus>`, take the last tag as the final round
- **Assertions**:
  1. Each member has at least one `<consensus>` tag
  2. Each member's final round `agreed: true` (true consensus, not max_rounds exhausted)
  3. Each member's final round `choice`, normalized, ∈ allowed set {`nfs`, `number-field-sieve`, `quadratic-sieve`, `qs`, `pollard-rho`, `ecm`, `shor`, `trial-division`}
  4. At least one member's full argument matches one of the keywords `{sub-exponential, 60-digit, rsa, quantum}` (confirming anchoring on the RSA factoring problem)

---

## Acceptance Checklist

- [ ] 4 check scripts pass `tsc -p demos/tsconfig.json` (no type errors)
- [ ] Each team config has valid roles (`mathematician` / `simulator` / `coder` are all presets)
- [ ] Each master invocation parameters conform to `team_consensus` schema (`team_id` / `topic` / `max_rounds` / `timeout_ms`)
- [ ] Each invocation has **no** `signoff_*` parameters (the consensus mechanism is the gate, source wf-013)
- [ ] Easy-level scenarios (1-3) total duration ≤ 24 min; challenge-level scenario 4 ≈ 35 min (6 members × `max_rounds=5`, deliberately breaking the standard 30 min limit for scale extension)
- [ ] Member prompts explicitly define `<consensus>` output format conventions, aligned with check scripts


---

## Quick-Start Prompt (Copy and Use)

> Paste any of the following prompts to the master session, and the AI will automatically complete the full closed loop of "create team → activate → launch orchestration → wait for aggregation → run check script". All specific configs directly reference the corresponding sections of this README.

### Scenario 1: Small-Scale Sort Selection (Math)

```text
Run the full closed loop of demos/02-team-consensus/README.md "Scenario 1" and auto-evaluate.

Steps:
1. Read README "1.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "1.3 Master Launch Invocation", start the orchestration using the team_consensus JSON
4. team_results poll until master receives summary (consensus at most max_rounds rounds)
5. Locate <run_dir> (contains each member <member>.md)
6. Run: bun demos/02-team-consensus/check-math-sort-stability.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: all members emit `"agreed": true` in final round; consensus choice ∈ {insertion, timsort, merge}.
```

### Scenario 2: 1D Heat Conduction Time Scheme Selection (Physics)

```text
Run the full closed loop of demos/02-team-consensus/README.md "Scenario 2" and auto-evaluate.

Steps:
1. Read README "2.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "2.3 Master Launch Invocation", start the orchestration using the team_consensus JSON
4. team_results poll until master receives summary
5. Locate <run_dir>
6. Run: bun demos/02-team-consensus/check-physics-heat-diffusion.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: all members `"agreed": true` in final round; consensus choice ∈ {explicit, implicit, crank-nicolson}.
```

### Scenario 3: Short-Text String Matching Selection (Programming)

```text
Run the full closed loop of demos/02-team-consensus/README.md "Scenario 3" and auto-evaluate.

Steps:
1. Read README "3.2 Team Config", create the team using the team_create JSON
2. team_activate
3. Read README "3.3 Master Launch Invocation", start the orchestration using the team_consensus JSON
4. team_results poll until master receives summary
5. Locate <run_dir>
6. Run: bun demos/02-team-consensus/check-coding-string-match.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: all members `"agreed": true` in final round; consensus choice ∈ {naive, kmp, boyer, sunday}.
```

### Scenario 4: 60-Digit RSA Modulus Factoring Algorithm Selection (Challenge-Level, Math)

```text
Run the full closed loop of demos/02-team-consensus/README.md "Scenario 4" and auto-evaluate (challenge-level, 6 members × max_rounds=5, estimated ~35 min).

Steps:
1. Read README "4.2 Team Config", create the team using the team_create JSON (6 mathematicians)
2. team_activate
3. Read README "4.3 Master Launch Invocation", start the orchestration using the team_consensus JSON (max_rounds=5)
4. team_results poll until master receives summary (consensus at most 5 rounds, longer wait expected)
5. Locate <run_dir> (contains 6 member <member>.md files)
6. Run: bun demos/02-team-consensus/check-math-factoring-consensus.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: all 6 members `"agreed": true` in final round; each choice ∈ {nfs, number-field-sieve, quadratic-sieve, qs, pollard-rho, ecm, shor, trial-division}; at least one member's argument mentions one of {sub-exponential, 60-digit, rsa, quantum}. Expected consensus converges to NFS, acknowledging Shor's quantum algorithm as future-relevant.
```
