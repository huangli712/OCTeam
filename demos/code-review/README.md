# Code Review: Audit + Confirm

A 2-stage code review chain (**Audit → Confirm Defects**), completed by 2 independent teams × 2 orchestration primitives chained together. Audit runs once; triage loops in **groups of 5** until all findings are debated. Master acts as the integration hub, teams are isolated from each other with hand-to-hand data passing.

**Output: a confirmed findings list. No code is modified.** Bug fixing is **not** part of this scenario — it lives in the separate **bug-fix scenario** ([`../code-bugfix/README.md`](../code-bugfix/README.md)), whose input is exactly this scenario's output.

**Self-use template**: not bound to a specific target, no check scripts included. Replace `<TARGET>` with the code you want to review (file / module / directory), run using the quick-start prompt at the end of this document; the validity of findings is **for you to judge**.

## Workflow Overview

| Phase | Team | Orchestration Primitive | Input | Output (handoff marker) |
|------|------|---------|------|---------------------|
| ① Audit (once) | **audit-team** | `team_parallel` | `<TARGET>` source code | `<!-- FINDING: <id>:<dim>:<severity> -->` |
| ② Confirm Defects (once per group, ≤5 items) | **triage-team** | `team_arbitrate` | Current group's findings | `<!-- CONFIRMED: <id> -->` |

② loops G=⌈N/5⌉ times in groups of 5 (last group may have fewer than 5). After audit deduplication and merging, **do not filter by severity**; high/medium/low are all kept.

Uses 2 orchestration primitives: **parallel / arbitrate**.

```
<TARGET> ──► audit-team (parallel) ──findings──► master
                                                 │ Deduplicate+merge + group (5 per group, last group may have fewer than 5)
                                                 ▼
                           ┌─── loop G groups ────────────┐
                           │                               │
                           │  triage-team (arbitrate)      │
                           │    ◄── current group findings (≤5) ──
                           │    └── confirmed (current group) ──► master
                           └───────────────────────────────┘
                                                 │ All groups done
                                                 ▼
                           master ──► confirmed findings list ──► you judge
                           (bug fixing is a separate scenario: ../code-bugfix/)
```

## How to Use

1. **Determine `<TARGET>`**: the code path you want to review (single file / directory / module name).
2. **Run 2 teams in sequence** (§1–§2). Each team goes through its full lifecycle: `team_create` → `team_activate` → `team_<mode>` → collect output → `team_deactivate`.
3. **Handoff**: audit findings are deduplicated and merged by master then **grouped in batches of 5** (no severity filtering); each group's findings → current group's arbitrate topic; all groups' CONFIRMED → final confirmed findings list.
4. **Judge**: you read the confirmed findings list and decide the outcome yourself. This scenario **has no regression gate / no check scripts / no code modification**.

---

## §1 audit-team (`team_parallel`) — Audit

### 1.1 Phase Description

8 reviewers **audit** `<TARGET>` in parallel, each with a dedicated dimension (dimension is baked into the member prompt, parallel runs isolated). Coverage: correctness/boundaries, logic/algorithms, concurrency/races, security/input validation, error handling/resource cleanup, performance/efficiency, API contracts/type safety, maintainability/code smells.

### 1.2 Team Configuration

```json
{
  "name": "cr-audit",
  "description": "Code review audit team: 8 reviewers scan <TARGET> in parallel, each a dedicated dimension",
  "members": [
    {
      "name": "alice",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in CORRECTNESS & BOUNDARIES. Audit the code at the given <TARGET> for: off-by-one errors, wrong operators (e.g. < vs <=, == vs ===), boundary-condition bugs, numeric/comparison errors, capacity/limit checks gone wrong. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:correctness:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id (e.g. tasks-off-by-one-capacity). Report every issue — do not self-censor."
    },
    {
      "name": "sam",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in LOGIC & ALGORITHMS. Audit the code at the given <TARGET> for: incorrect algorithms, wrong control flow, logic that does not match intent, missed edge cases (null/empty/extreme input), state-machine errors. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:logic:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "bob",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in CONCURRENCY & RACES. Audit the code at the given <TARGET> for: mutex/lock coverage gaps, TOCTOU (time-of-check-to-time-of-use), data races, async ordering bugs, deadlock potential. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:concurrency:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "carol",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in SECURITY & INPUT VALIDATION. Audit the code at the given <TARGET> for: injection, path traversal, auth/authz gaps, untrusted-input handling, unsafe deserialization, symlink/rename races on filesystem paths. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:security:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "dave",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in ERROR HANDLING & RESOURCE CLEANUP. Audit the code at the given <TARGET> for: swallowed errors, empty/over-broad catch blocks, resource leaks (unclosed handles), partial-failure cleanup gaps, unhandled promise rejections. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:errorhandling:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "nina",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in PERFORMANCE & EFFICIENCY. Audit the code at the given <TARGET> for: hot-path inefficiencies, unnecessary allocations, O(n^2) or worse complexity where O(n) suffices, redundant work, sync I/O on hot paths, missing caching where beneficial. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:performance:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "omar",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in API CONTRACTS & TYPE SAFETY. Audit the code at the given <TARGET> for: unsafe type assertions (as any / @ts-ignore), missing input validation at trust boundaries, broken invariants/contracts, schema validation gaps, public API misuse. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:apicontracts:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    },
    {
      "name": "pat",
      "role": "reviewer",
      "prompt": "You are a code reviewer specializing in MAINTAINABILITY & CODE SMELL. Audit the code at the given <TARGET> for: duplicated logic, excessive cyclomatic complexity, magic numbers, dead code, unclear naming, overly long functions. For EACH issue found, emit a line exactly formatted: <!-- FINDING: <stable-kebab-id>:maintainability:<severity> --> followed by a short description (file:line, what is wrong, impact). severity is one of high|medium|low. Use a stable kebab-case id. Report every issue — do not self-censor."
    }
  ]
}
```

**Role selection**: `reviewer` is a read-only role (audits should not modify code), 8 symmetric members, differences come from dimension prompts.

### 1.3 Master Launch Call

```json
{
  "tool": "team_parallel",
  "args": {
    "team_id": "cr-audit",
    "mode": "isolated",
    "task": "Audit the code at <TARGET> for actionable issues strictly within YOUR ASSIGNED DIMENSION (see your role brief). For each issue, emit the <!-- FINDING: <id>:<dim>:<severity> --> marker exactly as your brief specifies, followed by a short description. Report every issue you find.",
    "reduce_policy": "merge",
    "reducer_member": "pat",
    "timeout_ms": 1800000
  }
}
```

**Parameter selection**:
- `mode: isolated` + dimension baked into member prompts — 8 parallel lanes each scan one dimension, with no overlap.
- `reduce_policy: merge` + `reducer_member: pat` — 8 lane outputs are **merged** into one (preserving all dimension findings, no summary/selection), giving the triage-team the complete findings list. The reducer must be a team member (looked up by the tool via `team.members.find()`); pat is chosen because the maintainability dimension naturally fits the perspective of "aggregating global findings", and the reduce phase prompt is fixed as mechanical merging (no conflict with the audit dimension prompt).
- No `signoff_policy` set — parallel defaults to no signoff, results are collected when done.

### 1.4 Lifecycle Steps (master)

```
team_create(cr-audit)         # Use §1.2 JSON
team_activate(cr-audit)       # Activate (confirm no other active team currently)
team_parallel(...)            # Use §1.3 JSON
# Wait for 8 reviewers' output → team_results for the summary
team_deactivate(cr-audit)     # Release, make way for next team
```

### 1.5 Output and Handoff

- Master extracts all `<!-- FINDING: <id>:<dim>:<severity> -->` from the 8 member outputs, **compiles a findings list** (id + dim + severity + description), and also maintains an **id → description map** (needed later by §2 debate topics, and by the bug-fix scenario's tollgate task expansion if you choose to run it).
- **Deduplication and merge (no severity filtering)**: deduplicate by id, merge multi-dimension findings with the same id into one entry; **keep all severity levels** (high / medium / low all retained), do not discard any low-level findings. Severity is only used as context info for triage debaters, not for filtering.
- If after deduplication there are **0 findings** (no findings from any dimension), master reports truthfully and **aborts the workflow**.
- **Grouping (5 per group)**: split the deduplicated list in merge order into groups of 5; the last group may have fewer than 5. Group count G = ⌈total count / 5⌉.
- These groups enter the §2 triage loop **strictly serially**; **you must wait until the current group's triage debate is fully completed before entering the next group** — groups are **not parallelized**, no interleaving. Intra-group and inter-group ordering follows merge order, **no reordering by severity**.

---

## §2 triage-team (`team_arbitrate`) — Confirm Defects (Real-vs-False-Positive Debate)

### 2.1 Phase Description

> triage-team runs **once per group** in the §1.5 grouping loop using `team_arbitrate`: each run only debates the current group's findings (≤5 items), no mixing across groups, no cumulative cross-group debating.

6 debaters (2 reviewer + 2 architect + 1 coder + 1 explorer) debate **the current group's findings** across multiple rounds: **which are real issues, which are false positives**. **This phase does not discuss fix strategies** — fix approaches belong to the bug-fix scenario's coder ([`../code-bugfix/README.md`](../code-bugfix/README.md)). After the debate, 1 `arbiter` (sam) weighs all positions and issues a **binding ruling** — **only confirms findings where debaters reached consensus** (those with remaining disagreement are discarded by default).

### 2.2 Team Configuration

```json
{
  "name": "cr-triage",
  "description": "Code review triage team: 6 debaters (2 reviewers + 2 architects + 1 coder + 1 explorer) + 1 arbiter triage audit findings via arbitrate — debate real-vs-false-positive, arbiter confirms only consensus findings; NOT fix strategies",
  "members": [
    {
      "name": "erin",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues (not false positives). For each finding argue ONLY: is it a genuine issue? does the code actually exhibit the described problem? Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "frank",
      "role": "reviewer",
      "prompt": "You are a reviewer debating which audit findings are REAL, actionable issues (not false positives). For each finding argue ONLY: is it a genuine issue? does the code actually exhibit the described problem? Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "grace",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL. Weigh whether the described problem genuinely violates design invariants or contracts. Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "quinn",
      "role": "architect",
      "prompt": "You are an architect debating which audit findings are REAL. Weigh whether the described problem genuinely violates design invariants, contracts, or long-term correctness. Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "mona",
      "role": "coder",
      "prompt": "You are a CODER debating which audit findings are REAL. Approach each finding SKEPTICALLY from an implementer's perspective: by default suspect it is a false positive — ask whether real-world code paths actually trigger the described behavior, whether existing guards or context already cover it, whether the described impact is genuinely reachable. Only concede a finding is real if presented with concrete evidence (a triggering call path, a missing guard, a demonstrated failure). Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "ruby",
      "role": "explorer",
      "prompt": "You are an EXPLORER debating which audit findings are REAL. Approach each finding SKEPTICALLY from a codebase-traversal perspective: by default suspect it is a false positive — trace whether the flagged code is actually reachable in real execution, whether callers or upstream already validate the input, whether the described race or error window can actually open. Only concede a finding is real if presented with concrete evidence (a live call path reaching the code, an unguarded entry point, a demonstrated trigger). Engage with your teammates' positions across rounds. Do NOT discuss fix strategies — that is delegated to the fix team. Do NOT emit CONFIRMED markers — the arbiter weighs all positions and issues a binding ruling."
    },
    {
      "name": "sam",
      "role": "arbiter",
      "prompt": "You are the ARBITER. Six debaters (2 reviewers, 2 architects, 1 coder, 1 explorer) debated which audit findings are REAL, actionable issues. Weigh all positions impartially across the rounds. Apply this BINDING rule: confirm a finding ONLY IF the debaters reached consensus that it is real — i.e. no substantive dissent remained, or any initial skepticism was withdrawn when confronted with concrete evidence (a triggering call path, a missing guard, a demonstrated failure). Findings with unresolved disagreement are rejected as unconfirmed. Do NOT discuss fix strategies — that is delegated to the fix team. In your FINAL ruling, emit one line per confirmed finding exactly formatted: <!-- CONFIRMED: <finding-id> --> (rejected findings are simply omitted), then emit exactly one line formatted: <ruling>{\"decision\":\"<comma-separated confirmed ids, or none>\",\"rationale\":\"<which findings reached consensus and which did not, and why>\"}</ruling>."
    }
  ]
}
```

**Role selection**: erin/frank use `reviewer` (read-only deep review), grace/quinn use `architect` (architectural perspective on whether invariants/contracts are genuinely violated). mona uses `coder` (implementer perspective, default skepticism about triggerability), ruby uses `explorer` (codebase reachability perspective, default skepticism about path reachability), both inclined to play devil's advocate — tend to classify as false positives unless convinced by concrete evidence (triggering call chain, missing guard, demonstrable failure). sam uses `arbiter` (not a debater, not master) — after the debate, weighs 6 positions and issues a ruling under the binding rule of "only confirm consensus findings". The debate focus converges to "real or false positive", deferring strategy.

### 2.3 Master Launch Call

```json
{
  "tool": "team_arbitrate",
  "args": {
    "team_id": "cr-triage",
    "task": "<Paste the current group's findings (≤5 items) verbatim: each FINDING id/dim/severity/description>",
    "arbiter": "sam",
    "debaters": ["erin", "frank", "grace", "quinn", "mona", "ruby"],
    "max_rounds": 6,
    "timeout_ms": 2400000
  }
}
```

**Parameter selection**:
- `task` = the **current group's** findings (master extracts ≤5 from §1.5 grouping and pastes them in by hand); arbitrate's `task` is the dispute topic.
- `arbiter: "sam"` (role=`arbiter`) — not a debater, not master; weighs 6 debater positions and issues a binding ruling.
- `debaters` — 6 debaters (erin/frank/grace/quinn/mona/ruby), ≥2 and unique, none may be the arbiter.
- `max_rounds: 6` — gives sufficient debate space, with maneuver room for large numbers of findings.
- No `signoff_policy` set — the arbiter's ruling is itself the endpoint (equivalent to `none` gate).

### 2.4 Lifecycle Steps (master)

triage-team is reused per group in the loop, defined once and activated **once for the whole loop** (no other team competes for the active slot — audit-team is already deactivated, and fix-team belongs to the bug-fix scenario):

```
team_create(cr-triage)         # Defined once
team_activate(cr-triage)       # Activate once, stays active across all groups

for each group g in 1..G:        # §1.5 grouping loop
    team_arbitrate(...)          # task = group g findings (≤5 items), arbiter=sam
    # Wait for arbiter's ruling → team_results for current group's confirmed

team_deactivate(cr-triage)     # All groups done, release the team
```

### 2.5 Output and Handoff (Final)

- Master extracts all `<!-- CONFIRMED: <id> -->` from **each group's** arbiter ruling output, deduplicates into that group's confirmed list.
- **Final output**: after all G groups complete, master compiles the **final confirmed findings list** — every CONFIRMED id across all groups, in merge order, each with its description looked up from the §1.5 id → description map — and presents it to the user for judgment. **This scenario ends here.**
- If the final confirmed list is **empty** (no finding survived debate), master reports truthfully; there is nothing to hand off and the bug-fix scenario is unnecessary.
- The final confirmed findings list is also the **standard input for the bug-fix scenario** ([`../code-bugfix/README.md`](../code-bugfix/README.md)), should you choose to run it afterwards.

---

## End-to-End Timeline (master perspective)

```
T+0   team_create(cr-audit) → team_activate → team_parallel
        8 reviewers audit <TARGET> in parallel
T+~12  Collect findings → deduplicate+merge (no filtering) → group (5 per group, last group may have fewer than 5)
        → team_deactivate(cr-audit)
        If 0 findings after dedup → abort, report truthfully
        Group count G = ⌈total count / 5⌉

team_create(cr-triage) → team_activate(cr-triage)

for g in 1..G:                          # Grouping loop: one arbitrate per group
    team_arbitrate(task = group g findings, arbiter=sam, ≤6 rounds)
        6 debaters debate current group's real vs false positive → arbiter(sam) only confirms consensus findings

team_deactivate(cr-triage)

Compile final confirmed findings list → present to user → scenario ends
(Bug fixing is NOT part of this scenario — run ../code-bugfix/ separately if you want fixes)
```

(Durations are order-of-magnitude estimates only; larger `<TARGET>` and more groups G increase time.)

---

## Quick-Start Prompt

> Replace `<TARGET>` with the code path you want to review, paste the entire block to the master session. Master will run 2 teams in sequence, executing each step per this README's JSON configuration, with data hand-carried between teams by master.

```text
Run the code review scenario (audit + confirm) per demos/code-review/README.md, target code = <TARGET>.
Execute 2 teams in sequence, each follows the full lifecycle of "team_create → team_activate → team_<mode> → team_results → team_deactivate". Only one active team allowed at a time — must deactivate before switching.
1. audit-team (team_parallel, §1): per §1.2 team_create, §1.3 team_parallel. 8 reviewers audit <TARGET> in parallel. Deactivate when done. Compile all <!-- FINDING: ... --> markers into a findings list, maintaining an id→description map. **Only deduplicate + merge, no severity filtering** (high/medium/low all retained). If 0 after dedup → abort workflow. Then **group: 5 per group, last group may have fewer than 5**, group count G = ⌈total count / 5⌉.
2. triage-team (team_arbitrate, §2): team_create(cr-triage) once → team_activate(cr-triage) → for g in 1..G run team_arbitrate (task = group g findings (≤5 items), arbiter=sam, max_rounds=6), one run per group. 6 debaters debate which are real issues and which are false positives — no fix strategy discussion; arbiter only confirms consensus findings. After all G groups, team_deactivate(cr-triage).
3. Compile the final confirmed findings list (all groups' <!-- CONFIRMED: <id> --> in merge order, with descriptions from the id→description map) and present it to me for my judgment. **Do NOT run any fix team** — bug fixing is a separate scenario (demos/code-bugfix/README.md).
Notes:
- Member names must come from the 32-name preset pool (alice/bob/carol/dave/erin/frank/grace/mona/quinn/ruby/sam...), roles must use preset values like reviewer/architect/coder.
- Always team_deactivate the current team before switching, otherwise team_activate will be rejected.
- **No severity filtering**: after dedup, keep high/medium/low all retained, 5 per group (last group may have fewer than 5).
- **Strict serial between groups, no parallelism**: one group's triage fully completes before entering the next group. Never run triage for multiple groups concurrently.
- When a team is running, poll team_progress/team_results at 30-second intervals, no more frequent.
```
