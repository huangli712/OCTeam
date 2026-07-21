# team_tollgate Advanced Gate Features Demo

`team_tollgate` (advanced) demonstrates the three-valued verdict gate's advanced parameters: `reference` for Compare-style numerical verdicts against a golden reference, `max_gate_retries` for FAIL→retry producer correction loops, `escalate_to` for INVALID→escalate to a third-party fixer, and `max_invalid_cycles` to cap INVALID ping-pong across multi-gate V&V chains.

---

## Scenario Overview

| # | Domain | Scenario | Members | Gate Parameters Demonstrated | Est. Duration |
|---|------|------|--------|----------------------------|-----------|
| 1 | Math | Leibniz pi estimation with golden reference comparison | 2 | `reference` | ~8 min |
| 2 | Programming | isPrime implementation with FAIL→retry (edge case fix) | 2 | `max_gate_retries: 2` | ~12 min |
| 3 | Computational Physics | Velocity Verlet energy conservation with INVALID escalation | 3 | `escalate_to`, `max_invalid_cycles: 2` | ~12 min |
| 4 | Programming (challenge) | Multi-gate clamp + lerp V&V chain with INVALID tolerance | 6 | `escalate_to`, `max_invalid_cycles: 3` | ~80 min |

---

## Three-Valued Gate Mechanism (Recap)

After each stage produces output, an independent verifier inspects it and emits a tagged JSON verdict block:

```
<verdict>{"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."}</verdict>
```

The orchestration engine drives the gate state machine:

- **PASS**: Output is correct within tolerance. Advance to the next gate or deliver to master.
- **FAIL**: Output is wrong. The producer is sent back with the diff diagnostic to redo (up to `max_gate_retries` times, then the run fails).
- **INVALID**: The verifier cannot evaluate (broken reference, unparseable code, misaligned criteria). This is NOT the producer's fault. The stage is isolated and the issue is escalated to the verifier side. If `escalate_to` names a member, that member is dispatched to fix the verifier/reference; otherwise, INVALID escalates to the leader. The `max_invalid_cycles` parameter caps how many INVALID→escalate→re-verify ping-pong rounds are allowed before the gate fails.

The `reference` field appends a golden reference (a file path, known value, or expected range) to the verifier's prompt, enabling Compare-style numerical verdicts without hard-coding values in the criteria string.

---

## Scenario 1: Leibniz Pi Estimation with Reference Comparison

### 1.1 Scenario Description

**Background**: The Leibniz formula for pi is `pi/4 = 1 - 1/3 + 1/5 - 1/7 + ...` (infinite alternating sum of odd reciprocals). The series converges slowly, requiring thousands of terms for even modest accuracy. The `reference` parameter provides the verifier with a golden value (`pi = 3.14159265358979`) so it can issue a Compare-style numerical verdict: |estimate - reference| < tolerance → PASS.

**Goal**: The producer implements the Leibniz series with N=10000 terms, computes the pi estimate, and embeds it in a `PI_EST` marker. The verifier compares against the golden reference and issues PASS or FAIL.

**Success criteria (machine-evaluable)**:
- Producer output contains `<!-- PI_EST: <value> -->` marker
- |PI_EST - 3.14159265358979| < 0.05 (10000 terms achieve this easily)
- Verifier output contains `<verdict>{"result":"PASS",...}</verdict>` tagged JSON block

### 1.2 Team Configuration

```json
{
    "name": "pi-ref-gate",
    "description": "Leibniz pi estimation: implement (mathematician) then gate-verify (reviewer) against golden reference pi = 3.14159265358979",
    "members": [
        {
            "name": "alice",
            "role": "mathematician",
            "prompt": "You are a mathematician. You implement numerical algorithms in TypeScript with rigor, using minimal code. When asked to produce an implementation, embed the full TypeScript in a single ```typescript fenced block and always end with the requested numeric marker.\n\nYour output MUST end with a line exactly formatted: <!-- PI_EST: <numeric_value> -->"
        },
        {
            "name": "bob",
            "role": "reviewer",
            "prompt": "You are a reviewer. You verify numerical results against the gate's criteria and the provided golden reference. Emit a verdict: PASS if every criterion holds within tolerance, FAIL otherwise (naming the failure). Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<measured difference if FAIL, else empty>\"}</verdict>."
        }
    ]
}
```

**Role selection rationale**: Producer uses `mathematician` (can implement series summation and numerical computation); verifier uses `reviewer` (independent judge, receives the golden reference appended to its prompt by the `reference` field).

### 1.3 Master Launch Call

```json
{
    "tool": "team_tollgate",
    "args": {
        "team_id": "pi-ref-gate",
        "stages": [
            {
                "member": "alice",
                "task": "Estimate pi using the Leibniz formula: pi/4 = sum_{k=0}^{N-1} (-1)^k / (2k+1). Use N=10000 terms, multiply by 4. Embed code in a ```typescript fenced block. Your output MUST end with: <!-- PI_EST: <numeric_value> -->",
                "verifier": "bob",
                "criteria": "Compare the producer's PI_EST to the golden reference. |est - 3.14159| must be < 0.05. If within tolerance emit PASS, else FAIL with the measured difference.",
                "reference": "golden reference: pi = 3.14159265358979"
            }
        ],
        "timeout_ms": 600000
    }
}
```

### 1.4 Parameter Selection

- `reference`: "golden reference: pi = 3.14159265358979" — this text is appended to the verifier's prompt so bob can issue a Compare-style numerical verdict without the reference value being hard-coded in the criteria string. The verifier sees both the criteria (tolerance 0.05) and the reference value, enabling a clean |estimated - reference| calculation.
- `timeout_ms: 600000` (10 min) — producer (Leibniz summation) takes ~4 min, verifier takes ~2 min, with overhead margin.
- Single stage with `verifier != member` (`bob` != `alice`) — satisfies tollgate's "no self-verification" hard constraint.

### 1.5 Execution Flow (Timeline)

```
T+0m    master calls team_tollgate with reference field
T+0m    OCTeam dispatches stage-0 producer (alice, mathematician)
T+0~5m  alice writes Leibniz summation → runs N=10000 → reports PI_EST marker → idle
T+5m    gate triggers: dispatches verifier (bob, reviewer)
        bob's prompt includes the reference ("pi = 3.14159265358979")
T+5~8m  bob computes |PI_EST - 3.14159265358979| → compares to tolerance 0.05
T+8m    |diff| < 0.05 → PASS → pipeline ends, result delivered to master
T+8m    Run: bun check-math-pi-reference.ts <run_dir>
```

### 1.6 Check Script

[`check-math-pi-reference.ts`](./check-math-pi-reference.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
    - Producer estimate: regex `<!--\s*PI_EST:\s*([\d.eE+-]+)\s*-->`
    - Verifier verdict: `<verdict>{...}</verdict>` tagged JSON block (`JSON.parse` to get `result`)
- **Assertions**:
    1. PI_EST value exists and `Number.isFinite`
    2. `|PI_EST - 3.14159265358979| < 0.05`
    3. Verifier `result` is `PASS`

---

## Scenario 2: isPrime Implementation with FAIL→Retry

### 2.1 Scenario Description

**Background**: A prime-checking function `isPrime(n: number): boolean` seems trivial, but the edge case `n < 2` is a classic trap: implementations often forget to handle 1, 0, and negative numbers. The tollgate's `max_gate_retries: 2` gives the producer up to two chances to fix after a FAIL verdict. The verifier runs six test cases that specifically include the `n<2` boundary: `isPrime(2)=true, isPrime(1)=false, isPrime(0)=false, isPrime(-5)=false, isPrime(17)=true, isPrime(100)=false`.

**Goal**: The producer implements isPrime; the verifier runs the 6-case test suite. If any case fails, the producer gets the diff and up to 2 retries to fix.

**Success criteria (machine-evaluable)**:
- Producer output contains `<!-- IMPL: isPrime -->` marker and embeds a loadable ```typescript code block
- All 6 test cases pass: isPrime(2)=true, isPrime(1)=false, isPrime(0)=false, isPrime(-5)=false, isPrime(17)=true, isPrime(100)=false
- Final verifier output contains `<verdict>{"result":"PASS",...}</verdict>` tagged JSON block (the LAST verdict after any retry cycles)

### 2.2 Team Configuration

```json
{
    "name": "coverage-retry-gate",
    "description": "isPrime implementation: implement (coder) then gate-verify (tester) against 6 cases; max_gate_retries:2 for FAIL→fix loop",
    "members": [
        {
            "name": "alice",
            "role": "coder",
            "prompt": "You are a coder. You implement functions in clean TypeScript with minimal code. Embed the full TypeScript in a single ```typescript fenced block and declare it with an IMPL marker.\n\nYour output MUST end with a line exactly formatted: <!-- IMPL: isPrime -->"
        },
        {
            "name": "bob",
            "role": "tester",
            "prompt": "You are a tester. You verify implementations by running them against the gate's test cases, including edge cases. Emit a verdict: PASS if every case holds, FAIL otherwise (naming the failing case and expected vs actual). Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<failing case details if FAIL, else empty>\"}</verdict>."
        }
    ]
}
```

**Role selection rationale**: Producer uses `coder` (focused on implementation); verifier uses `tester` (specialized in running test suites and edge-case discovery). The `n<2` edge case is a known trap that coder agents miss on first attempt.

### 2.3 Master Launch Call

```json
{
    "tool": "team_tollgate",
    "args": {
        "team_id": "coverage-retry-gate",
        "stages": [
            {
                "member": "alice",
                "task": "Implement `function isPrime(n: number): boolean` -- returns true for prime numbers, false otherwise. MUST handle n < 2 (return false for 0, 1, and negatives). Embed in a ```typescript fenced block. Your output MUST end with: <!-- IMPL: isPrime -->",
                "verifier": "bob",
                "criteria": "Verify isPrime(2)=true, isPrime(1)=false, isPrime(0)=false, isPrime(-5)=false, isPrime(17)=true, isPrime(100)=false. All must pass for PASS. If any fail, emit FAIL naming the failing case."
            }
        ],
        "max_gate_retries": 2,
        "timeout_ms": 900000
    }
}
```

### 2.4 Parameter Selection

- `max_gate_retries: 2` — the key parameter being demonstrated. The producer gets up to 2 chances to fix after FAIL (first attempt often misses the `n<2` edge case, second or third attempt corrects it). This is higher than `09-team-tollgate`'s `max_gate_retries: 1`, explicitly demonstrating the retry-count escalation path.
- `timeout_ms: 900000` (15 min) — producer (~3 min) + verifier (~2 min) × up to 3 attempts (1 initial + 2 retries) ≈ 15 min.
- This scenario demonstrates that `max_gate_retries` is a **gate-level parameter**: it applies per-gate, independent of other gates in a multi-gate pipeline.

### 2.5 Execution Flow (Timeline)

```
T+0m     master calls team_tollgate with max_gate_retries: 2
T+0m     dispatches producer (alice, coder)
T+0~3m   alice writes isPrime → embeds code + IMPL marker → idle
T+3m     gate triggers: dispatches verifier (bob, tester), feeds criteria
T+3~5m   bob runs 6 test cases → finds isPrime(1) returns true (FAIL)
T+5m     FAIL → attempt 1/2: producer sent back with diff
T+5~7m   alice fixes n<2 edge case → embeds corrected code → idle
T+7m     gate re-triggers: dispatches verifier (bob)
T+7~9m   bob runs 6 cases → all pass → outputs VERDICT {result: "PASS"}
T+9m     PASS → pipeline ends, result delivered to master
T+9m     Run: bun check-coding-coverage-retry.ts <run_dir>
```

(If the first fix still fails, the producer gets one more retry (attempt 2/2). If the third verdict is still FAIL, the run fails with `tollgate_failed:max_gate_retries`.)

### 2.6 Check Script

[`check-coding-coverage-retry.ts`](./check-coding-coverage-retry.ts)

- **Load**: `runs/<run_id>/{alice,bob}.md`
- **Extract**:
    - Producer code: grab the LAST ` ```typescript ... ``` ` code block (post-retry fix, if any)
    - Final verifier verdict: LAST `<verdict>{...}</verdict>` tagged JSON block (after any retry cycles)
- **Assertions**:
    1. Producer code can be loaded via Bun.Transpiler + `new Function` as `isPrime` function
    2. isPrime(2)===true, isPrime(1)===false, isPrime(0)===false, isPrime(-5)===false, isPrime(17)===true, isPrime(100)===false
    3. Final verifier `result` is `PASS`

---

## Scenario 3: Velocity Verlet Energy Conservation with INVALID Escalation

### 3.1 Scenario Description

**Background**: The harmonic oscillator `ẍ = -x` (with `x0=1, v0=0`, energy `E = 0.5*(x²+v²)`, `E0 = 0.5`) is a standard test for symplectic integrators. Velocity Verlet preserves energy to bounded oscillation. The verifier must extract the producer's reported drift and compare it to the threshold. If the verifier **cannot evaluate** (unparseable drift, code won't load, criteria/reference mismatch), it emits INVALID, and the `escalate_to` member (carol) is dispatched to fix the verifier side, after which verification retries.

**Goal**: The producer implements Velocity Verlet and reports energy drift. The verifier checks drift < 1e-3. If the verifier cannot evaluate, emit INVALID; carol fixes the reference/verification logic, then the gate re-verifies.

**Success criteria (machine-evaluable)**:
- Producer output contains `<!-- DRIFT: <value> -->` marker
- Drift < 1e-3 (symplectic integrator property)
- FINAL verifier output (after any INVALID→escalate→re-verify cycles) contains `<verdict>{"result":"PASS",...}</verdict>`

### 3.2 Team Configuration

```json
{
    "name": "energy-escalate-gate",
    "description": "Velocity Verlet energy drift: implement (simulator), gate-verify (physicist) with energy tolerance; on INVALID escalate to carol (reviewer) for verifier-side fix",
    "members": [
        {
            "name": "alice",
            "role": "simulator",
            "prompt": "You are a simulator. You implement numerical integrators in TypeScript and run them to report measured quantities. Embed runnable code in a ```typescript fenced block and always end with the requested numeric marker.\n\nYour output MUST end with a line exactly formatted: <!-- DRIFT: <numeric_relative_drift> -->"
        },
        {
            "name": "bob",
            "role": "physicist",
            "prompt": "You are a physicist. You verify numerical results against physical conservation laws and known tolerances. If you can compute and verify the energy drift, emit PASS or FAIL. If you CANNOT evaluate (e.g. the drift marker is unparseable, the code will not load, or the reference is unclear), emit INVALID with a rationale explaining what went wrong.\n\nYour output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\" or \"INVALID\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<details>\"}</verdict>."
        },
        {
            "name": "carol",
            "role": "reviewer",
            "prompt": "You are a reviewer and escalation handler. When a verifier emits INVALID (cannot evaluate), you are dispatched to fix the verifier-side issue: clarify the reference, repair the verification criteria, or diagnose the evaluation failure. After fixing, you re-run the verification against the producer's output and emit a final PASS or FAIL verdict.\n\nYour output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<details>\"}</verdict>."
        }
    ]
}
```

**Role selection rationale**: Three members demonstrate the INVALID escalation chain. Producer `alice` (simulator) implements the integrator. Verifier `bob` (physicist) is the primary gate evaluator, but may emit INVALID if unparseable. Escalation handler `carol` (reviewer) is a third-party fixer who repairs the verifier side without penalizing the producer.

### 3.3 Master Launch Call

```json
{
    "tool": "team_tollgate",
    "args": {
        "team_id": "energy-escalate-gate",
        "stages": [
            {
                "member": "alice",
                "task": "Implement Velocity Verlet for the spring-mass system (k=1, m=1, omega^2=1, x0=1, v0=0). Run 1000 steps h=0.01. Report relative energy drift |E_end - E0|/E0 where E = 0.5*(x^2+v^2), E0 = 0.5. Embed code in a ```typescript fenced block. Your output MUST end with: <!-- DRIFT: <numeric_drift> -->",
                "verifier": "bob",
                "criteria": "Energy drift must be < 1e-3 (symplectic integrator). If you can compute and verify, emit PASS or FAIL. If you CANNOT evaluate (e.g. the drift value is unparseable or the code won't load), emit INVALID with a rationale.",
                "reference": "golden reference: E0 = 0.5 (initial energy); drift = |E_end - 0.5| / 0.5"
            }
        ],
        "escalate_to": "carol",
        "max_invalid_cycles": 2,
        "timeout_ms": 900000
    }
}
```

### 3.4 Parameter Selection

- `escalate_to: "carol"` — the key parameter being demonstrated. When the verifier emits INVALID (cannot evaluate), carol is dispatched instead of escalating to the leader. This is useful when a third member has expertise to fix the verifier/reference side (e.g. clarifying the energy formula, repairing the tolerance check). Without `escalate_to`, INVALID escalates to the leader (master) for manual intervention.
- `max_invalid_cycles: 2` — caps the INVALID→escalate→re-verify ping-pong to 2 rounds per gate. If carol fixes the reference but bob still emits INVALID on re-verification, carol gets one more chance. After 2 cycles, the gate fails with `invalid_cycles_exhausted`.
- `reference`: "golden reference: E0 = 0.5..." — gives the verifier the exact reference energy so it can compute drift independently.
- `timeout_ms: 900000` (15 min) — producer (~4 min) + verifier (~3 min) + possible escalation (~3 min per cycle × 2) ≈ 15 min.

### 3.5 Execution Flow (Timeline)

```
T+0m     master calls team_tollgate with escalate_to: carol, max_invalid_cycles: 2
T+0m     dispatches producer (alice, simulator)
T+0~4m   alice writes Velocity Verlet → runs 1000 steps → reports DRIFT marker → idle
T+4m     gate triggers: dispatches verifier (bob, physicist)
T+4~7m   bob attempts to evaluate → emits INVALID (cannot parse drift or evaluate)
T+7m     INVALID → gate isolated; carol dispatched (escalate_to)
T+7~10m  carol fixes reference/verification logic → re-verifies → emits PASS
T+10m    gate resolved: PASS → result delivered to master
T+10m    Run: bun check-physics-energy-escalate.ts <run_dir>
```

(The INVALID→escalate→re-verify path is a key difference from basic PASS/FAIL. The producer is never penalized for INVALID; only the verifier side is repaired. If after 3 cycles (initial INVALID + 2 escalations) the gate is still INVALID, the run fails with `tollgate_invalid:exhausted`.)

### 3.6 Check Script

[`check-physics-energy-escalate.ts`](./check-physics-energy-escalate.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol}.md` (carol.md optionally exists if escalation occurred)
- **Extract**:
    - Producer drift: regex `<!--\s*DRIFT:\s*([\d.eE+-]+)\s*-->`
    - FINAL verifier verdict: LAST `<verdict>{...}</verdict>` across bob.md and carol.md (carol's output is chronologically later if escalation occurred)
- **Assertions**:
    1. Drift value exists and `Number.isFinite`
    2. `drift < 1e-3` (symplectic conservation bound)
    3. Final verifier `result` is `PASS`

---

## Scenario 4: Multi-Gate clamp + lerp V&V Chain with INVALID Tolerance (Challenge-Level)

**Challenge-level notes**: This scenario uses **6 members and 2 serial gates** to demonstrate INVALID tolerance across a multi-gate V&V chain. Both gates share a single escalation handler (`escalate_to: "frank"`) with `max_invalid_cycles: 3`, showing that the INVALID ping-pong cap is per-gate and can survive repeated verifier-side failures without aborting the entire pipeline.

### 4.1 Scenario Description

**Background**: `clamp(n, lo, hi)` constrains a number to a range and `lerp(a, b, t)` performs linear interpolation. Both are simple but have subtle edge cases: clamp can silently produce wrong results if lo > hi (should either throw or swap), and lerp is often implemented incorrectly (e.g. `a + (b-a)*t` is the correct form, not `a*(1-t) + b*t` for floating-point precision). This scenario chains two independent implementation+verification gates, each prone to INVALID from the verifier side (unparseable code, unclear criteria). The shared escalation handler `frank` fixes verifier-side issues for both gates.

**Goal**: Gate 1 (alice→bob) implements and verifies clamp; Gate 2 (carol→dave) implements and verifies lerp. Both gates pass through frank on INVALID. The `max_invalid_cycles: 3` per gate allows up to 3 INVALID→escalate→re-verify rounds before failing.

**Success criteria (machine-evaluable)**:
- G1 producer (alice) code can be loaded as `clamp` function; G1 verifier (bob) FINAL verdict is PASS
- G2 producer (carol) code can be loaded as `lerp` function; G2 verifier (dave) FINAL verdict is PASS
- Cross-check: clamp(5,0,10)===5, clamp(-1,0,10)===0, clamp(15,0,10)===10
- Cross-check: lerp(0,10,0.5)===5, lerp(0,10,0)===0, lerp(0,10,1)===10

### 4.2 Team Configuration

```json
{
    "name": "multi-invalid-gate",
    "description": "Multi-gate clamp+lerp V&V chain: 2 serial gates with shared escalation handler (frank) and max_invalid_cycles:3 per gate",
    "members": [
        {
            "name": "alice",
            "role": "coder",
            "prompt": "You are a coder. You implement functions in clean TypeScript with minimal code. Embed the full TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPL: clamp -->"
        },
        {
            "name": "bob",
            "role": "tester",
            "prompt": "You are a tester. You verify implementations by running them against the gate's test cases. Emit a verdict: PASS if every case holds, FAIL otherwise. If you CANNOT evaluate (unparseable code, unclear criteria), emit INVALID with a rationale. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\" or \"INVALID\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<details>\"}</verdict>."
        },
        {
            "name": "carol",
            "role": "coder",
            "prompt": "You are a coder. You implement functions in clean TypeScript with minimal code. Embed the full TypeScript in a single ```typescript fenced block. Your output MUST end with a line exactly formatted: <!-- IMPL: lerp -->"
        },
        {
            "name": "dave",
            "role": "tester",
            "prompt": "You are a tester. You verify implementations by running them against the gate's test cases. Emit a verdict: PASS if every case holds, FAIL otherwise. If you CANNOT evaluate (unparseable code, unclear criteria), emit INVALID with a rationale. Your output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\" or \"INVALID\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<details>\"}</verdict>."
        },
        {
            "name": "erin",
            "role": "coder",
            "prompt": "placeholder member (reserved for future gate expansion, not dispatched in the current 2-gate scenario)"
        },
        {
            "name": "frank",
            "role": "reviewer",
            "prompt": "You are a reviewer and shared escalation handler. When a verifier emits INVALID (cannot evaluate), you are dispatched to fix the verifier-side issue for any gate: clarify the criteria, repair the code-loading logic, or re-express the reference. After fixing, you re-run the verification and emit a final PASS or FAIL verdict.\n\nYour output MUST end with exactly one line formatted: <verdict>{\"result\": \"PASS\" (or \"FAIL\"), \"rationale\": \"<one-sentence why>\", \"diff\": \"<details>\"}</verdict>."
        }
    ]
}
```

**Role selection rationale**: Three `coder` members (alice/carol/erin, though erin is a reserve) handle production for each gate; two `tester` members (bob/dave) verify independently; one `reviewer` (frank) serves as the shared escalation handler for both gates. The shared handler design shows that `escalate_to` can route INVALID from multiple gates to a single expert, reducing team overhead in multi-gate pipelines.

### 4.3 Master Launch Call

```json
{
    "tool": "team_tollgate",
    "args": {
        "team_id": "multi-invalid-gate",
        "stages": [
            {
                "member": "alice",
                "task": "Implement `function clamp(n: number, lo: number, hi: number): number` that constrains n to [lo, hi]. If lo > hi, you may either throw an error or swap them (document your choice). Embed in a ```typescript fenced block. Your output MUST end with: <!-- IMPL: clamp -->",
                "verifier": "bob",
                "criteria": "Verify clamp(5,0,10)=5, clamp(-1,0,10)=0, clamp(15,0,10)=10. All must pass for PASS. If you cannot evaluate, emit INVALID."
            },
            {
                "member": "carol",
                "task": "Implement `function lerp(a: number, b: number, t: number): number` for linear interpolation. Compute a + (b-a)*t (this form minimizes floating-point error). Embed in a ```typescript fenced block. Your output MUST end with: <!-- IMPL: lerp -->",
                "verifier": "dave",
                "criteria": "Verify lerp(0,10,0.5)=5, lerp(0,10,0)=0, lerp(0,10,1)=10. All must pass for PASS. If you cannot evaluate, emit INVALID."
            }
        ],
        "escalate_to": "frank",
        "max_invalid_cycles": 3,
        "timeout_ms": 2400000
    }
}
```

### 4.4 Parameter Selection

- `escalate_to: "frank"` — shared across both gates. When either bob (Gate 1) or dave (Gate 2) emits INVALID, frank is dispatched to fix the verifier side. This shows that a single escalation handler can serve multiple gates in a pipeline, reducing the need for per-gate handlers.
- `max_invalid_cycles: 3` — the key challenge-level parameter. Each gate independently allows up to 3 INVALID→escalate→re-verify ping-pong rounds. This is higher than scenario 3's `max_invalid_cycles: 2`, demonstrating that the cap scales; a V&V chain with potentially tricky verification semantics benefits from a generous INVALID budget without allowing infinite retry.
- Two serial gates (clamp → lerp) — Gate 2 depends on Gate 1 passing, so if Gate 1 exhausts its INVALID cycles and fails, the entire pipeline aborts before reaching Gate 2. The per-gate isolation of `max_invalid_cycles` means Gate 2 gets its own fresh 3-cycle budget.
- `timeout_ms: 2400000` (40 min) — challenge-level: 2 gates × (producer ~5 min + verifier ~3 min + up to 3 escalation cycles per gate × ~3 min) ≈ 40 min.

### 4.5 Execution Flow (Timeline)

```
T+0m      master calls team_tollgate (2 gates, escalate_to: frank, max_invalid_cycles: 3)
T+0m      dispatches G1 producer (alice, coder)
T+0~5m    alice writes clamp → embeds code + IMPL marker → idle
T+5m      G1 gate: dispatches verifier (bob, tester)
T+5~8m    bob runs 3 test cases → possible INVALID (cannot evaluate) → frank dispatched
T+8~11m   frank fixes verifier-side → re-verifies → PASS
T+11m     G1 PASS → G2 producer starts (carol, coder)
T+11~16m  carol writes lerp → embeds code + IMPL marker → idle
T+16m     G2 gate: dispatches verifier (dave, tester)
T+16~19m  dave runs 3 test cases → possible INVALID → frank dispatched
T+19~22m  frank fixes → re-verifies → PASS
T+22m     G2 PASS → pipeline ends, result delivered to master
T+22m     Run: bun check-coding-multi-invalid.ts <run_dir>
```

(If either gate needs multiple INVALID cycles, the timeline stretches. Each gate independently tracks its own `attempts_invalid` counter against `max_invalid_cycles`. Exhausting the cap causes `tollgate_invalid:exhausted` for that gate, failing the pipeline.)

### 4.6 Check Script

[`check-coding-multi-invalid.ts`](./check-coding-multi-invalid.ts)

- **Load**: `runs/<run_id>/{alice,bob,carol,dave,frank}.md` (6 files)
- **Extract**:
    - G1 code: alice.md LAST ` ```typescript ... ``` ` code block → load `clamp`
    - G1 verdict: bob.md LAST `<verdict>{...}</verdict>` tagged JSON block
    - G2 code: carol.md LAST ` ```typescript ... ``` ` code block → load `lerp`
    - G2 verdict: dave.md LAST `<verdict>{...}</verdict>` tagged JSON block
- **Assertions**:
    1. Both clr functions can be loaded via Bun.Transpiler + `new Function`
    2. clamp(5,0,10)===5, clamp(-1,0,10)===0, clamp(15,0,10)===10
    3. lerp(0,10,0.5)===5, lerp(0,10,0)===0, lerp(0,10,1)===10
    4. G1 verifier `result` is `PASS`
    5. G2 verifier `result` is `PASS`

---


## Quick-Start Prompt

Paste any of the following prompts into the master session and the AI will automatically complete the full loop. In tollgate mode, evaluation reads the producer + verifier + escalation handler members' .md files: the producer's implementation/numerical results + the verifier's (or escalation handler's) FINAL verdict.

### Scenario 1: Leibniz Pi Estimation (Reference Comparison)

```text
Execute the full closed loop for demos/14-team-tollgate/README.md "Scenario 1" with automatic evaluation.

Steps:
1. Read README "1.2 Team Configuration", create the team with team_create JSON (producer + verifier, 2 members)
2. team_activate to activate
3. Read README "1.3 Master Launch Call", start orchestration with the team_tollgate JSON (1 gate, reference field: golden pi)
4. team_results poll until master receives summary (verifier PASS against golden reference before delivery) (poll every 30s)
5. Locate <run_dir> (containing alice.md and bob.md)
6. Run: bun demos/14-team-tollgate/check-math-pi-reference.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: producer PI_EST within 0.05 of 3.14159265358979; verifier VERDICT = PASS.
```

### Scenario 2: isPrime with FAIL->Retry

```text
Execute the full closed loop for demos/14-team-tollgate/README.md "Scenario 2" with automatic evaluation.

Steps:
1. Read README "2.2 Team Configuration", create the team with team_create JSON
2. team_activate to activate
3. Read README "2.3 Master Launch Call", start orchestration with the team_tollgate JSON (max_gate_retries: 2)
4. team_results poll until master receives summary (FAIL sends producer back to redo; max 2 retries) (poll every 30s)
5. Locate <run_dir> (containing alice.md and bob.md)
6. Run: bun demos/14-team-tollgate/check-coding-coverage-retry.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: producer isPrime passes all 6 test cases (including n<2 edge case); FINAL verifier VERDICT = PASS.
```

### Scenario 3: Velocity Verlet with INVALID Escalation

```text
Execute the full closed loop for demos/14-team-tollgate/README.md "Scenario 3" with automatic evaluation.

Steps:
1. Read README "3.2 Team Configuration", create the team with team_create JSON (3 members: alice/bob/carol)
2. team_activate to activate
3. Read README "3.3 Master Launch Call", start orchestration with the team_tollgate JSON (escalate_to: carol, max_invalid_cycles: 2)
4. team_results poll until master receives summary (INVALID escalates to carol; she fixes and re-verifies) (poll every 30s)
5. Locate <run_dir> (containing alice.md, bob.md, and optionally carol.md)
6. Run: bun demos/14-team-tollgate/check-physics-energy-escalate.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: producer DRIFT < 1e-3 (symplectic integrator); FINAL verifier VERDICT = PASS (after any escalation cycles).
```

### Scenario 4: Multi-Gate clamp + lerp V&V Chain (Challenge-Level)

```text
Execute the full closed loop for demos/14-team-tollgate/README.md "Scenario 4" with automatic evaluation (challenge-level: 6 members, 2 serial V&V gates, shared escalation handler, max_invalid_cycles: 3).

Steps:
1. Read README "4.2 Team Configuration", create the team with team_create JSON (6 members: alice/bob/carol/dave/erin/frank)
2. team_activate to activate
3. Read README "4.3 Master Launch Call", start orchestration with the team_tollgate JSON (2 serial gates: clamp -> lerp; escalate_to: frank; max_invalid_cycles: 3)
4. team_results poll until master receives summary (each gate verifier must PASS before the next gate proceeds; INVALID escalates to frank for both gates) (poll every 30s)
5. Locate <run_dir> (containing 6 member .md files: alice/bob/carol/dave/erin/frank)
6. Run: bun demos/14-team-tollgate/check-coding-multi-invalid.ts <run_dir>
7. Report by exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error

Success criteria: G1 clamp(5,0,10)=5, clamp(-1,0,10)=0, clamp(15,0,10)=10 AND VERDICT1 = PASS; G2 lerp(0,10,0.5)=5, lerp(0,10,0)=0, lerp(0,10,1)=10 AND VERDICT2 = PASS. Both gates must PASS for overall PASS.
```
