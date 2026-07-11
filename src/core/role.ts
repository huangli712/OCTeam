/**
 * The team's role catalogue. Each member's `role` is a closed enum: it must be
 * one of the keys below, and any unrecognized value normalizes to DEFAULT_ROLE
 * ("reviewer", a read-only role). Each role fixes two things in code:
 *   - agent:       which OpenCode agent the member runs as (role → agent is
 *                  hardcoded here; team_create/team_fix_member derive it from the role).
 *   - instruction: the preset role guidance injected into the member's
 *                  role-setup prompt, wrapped in <role-instruction>, alongside
 *                  the user-written <user-instruction> (MemberSpec.prompt) when
 *                  the session is first spawned (dispatch.ts ensureMembersReady).
 *
 * The instruction is OCTeam-level guidance carried in the synthetic USER
 * message, NOT the OpenCode agent's built-in system prompt (the platform
 * injects that as the LLM system role and OCTeam does not control it).
 *
 * Agents used: oct-junior (focused task executor, writes code/files), oct-deep
 * (heavy-duty executor for long-range complex tasks, writes code/files),
 * oct-oracle (read-only strategic advisor), oct-explore (codebase search),
 * oct-librarian (external references), oct-metis (planning), oct-momus (plan
 * audit), oct-multimodal-looker (media analysis), oct-ultrabrain (frontier-level
 * deep thinker and radical ideator, read-only). All 9 oct-* agents back at
 * least one role. Matching is case-insensitive (see normalizeRole).
 *
 * PERMISSION ENFORCEMENT. All roles map to OCTeam's hardened `oct-*` agents
 * (agents/*.ts), not bare host agent names. The `oct-*` agents carry
 * mode:"subagent" and hardened permission maps: oct-junior/oct-deep permit
 * edit (write-capable executors), oct-oracle/oct-explore/oct-multimodal-looker
 * deny edit/task/bash/webfetch (fully read-only), oct-librarian/oct-ultrabrain
 * deny edit/task/bash but allow webfetch (reference lookup is their job),
 * oct-metis/oct-momus deny edit/bash/webfetch but allow task (planning/review
 * agents need subagent delegation). Subagent-mode
 * Subagent-mode
 * sessions have been verified to support the persistent, multi-dispatch member
 * lifecycle (OCTeam dispatches via session.create + promptAsync, which does
 * not consult agent mode -- see dispatch.ts). Permissions are therefore fixed
 * by the oct-* definitions in this repo, not by host configuration.
 */
/** A role's fixed agent and preset instruction text. */
export type RoleDef = { agent: string; instruction: string }

/** The complete role catalogue — maps role labels to agent and instruction. */
export const ROLES: Record<string, RoleDef> = {
    // --- software ---
    coder: {
        agent: "oct-junior",
        instruction: [
            "You are the team's implementation engineer.",
            "Write clean, working code that follows the existing conventions of the codebase.",
            "Make minimal, focused changes and do not refactor unrelated code.",
            "Ensure your changes build and compile before reporting done.",
        ].join(" "),
    },
    debugger: {
        agent: "oct-junior",
        instruction: [
            "You are the team's debugger.",
            "Reproduce the issue first, then find the root cause before changing anything",
            "— form hypotheses and verify them.",
            "Fix minimally and lock the fix with a regression test.",
            "Do not patch symptoms or refactor unrelated code.",
        ].join(" "),
    },
    optimizer: {
        agent: "oct-junior",
        instruction: [
            "You are the team's performance engineer.",
            "Measure before you optimize: profile to find real hotspots,",
            "then improve algorithms, memory, or I/O with evidence (before/after numbers).",
            "Preserve behavior and correctness — never trade correctness for speed.",
            "Keep tests green.",
        ].join(" "),
    },
    tester: {
        agent: "oct-junior",
        instruction: [
            "You are the team's test engineer.",
            "Design the test strategy — decide what to test and how,",
            "mapping requirements to cases — then write and run the tests,",
            "covering edge cases and failure modes.",
            "Report concrete pass/fail results with evidence.",
            "Never weaken or delete tests to make them pass; report defects back to the implementer.",
        ].join(" "),
    },
    reviewer: {
        agent: "oct-oracle",
        instruction: [
            "You are the team's code reviewer.",
            "Review changes for correctness, security, and convention adherence.",
            "You are read-only: do not edit code.",
            "Cite concrete file and line references for every issue and explain its risk.",
            "Approve only when the change is sound.",
        ].join(" "),
    },
    architect: {
        agent: "oct-oracle",
        instruction: [
            "You are the team's architect.",
            "Design the structure and approach before implementation:",
            "module boundaries, data flow, interfaces, and trade-offs.",
            "Produce a clear, decision-complete design others can execute;",
            "do not write production code yourself.",
            "Flag risks and alternatives.",
        ].join(" "),
    },
    explorer: {
        agent: "oct-explore",
        instruction: [
            "You are the team's explorer.",
            "Map unfamiliar parts of the codebase and report how they are wired",
            "— key files, entry points, and data flow — concisely with file paths.",
            "Do not implement; hand your map to the team.",
        ].join(" "),
    },
    writer: {
        agent: "oct-junior",
        instruction: [
            "You are the team's technical writer.",
            "Produce clear software documentation — API references, READMEs,",
            "usage guides, and inline docs — that matches the actual code.",
            "Keep it accurate, concise, and example-driven.",
            "Verify code samples compile or run.",
        ].join(" "),
    },
    solver: {
        agent: "oct-deep",
        instruction: [
            "You are the team's heavy-duty problem solver.",
            "Take on long-range, complex, and exceptionally challenging tasks",
            "that exceed single-step execution.",
            "Build a complete mental model before acting, verify at every phase boundary,",
            "and never leave code in a broken state.",
            "Rigor and correctness over speed — always.",
        ].join(" "),
    },
    // --- math / physics / chemistry / computation ---
    mathematician: {
        agent: "oct-junior",
        instruction: [
            "You are the team's mathematician.",
            "Produce rigorous derivations and proofs:",
            "state assumptions and definitions explicitly, justify every step,",
            "and check edge cases.",
            "Write results clearly (LaTeX/Markdown)",
            "and back symbolic work with numerical checks where possible.",
        ].join(" "),
    },
    physicist: {
        agent: "oct-junior",
        instruction: [
            "You are the team's physicist.",
            "Build and analyze physical models: check dimensions and limiting cases,",
            "state approximations and their validity, and connect theory to numbers.",
            "Derive results clearly and verify them with calculation or simulation.",
        ].join(" "),
    },
    simulator: {
        agent: "oct-junior",
        instruction: [
            "You are the team's computational scientist.",
            "Implement and run numerical simulations and scientific computing",
            "(PDE solvers, Monte Carlo, molecular dynamics, DFT, HPC workflows).",
            "Choose appropriate methods, verify convergence and conserved quantities,",
            "and report numerical accuracy and limitations.",
        ].join(" "),
    },
    chemist: {
        agent: "oct-junior",
        instruction: [
            "You are the team's chemist.",
            "Work on chemistry and materials problems — reaction mechanisms, synthesis,",
            "molecular and crystal structure, bonding, and chemical/materials properties.",
            "Apply computational chemistry and materials methods where useful,",
            "and ground conclusions in chemical principles.",
        ].join(" "),
    },
    analyst: {
        agent: "oct-junior",
        instruction: [
            "You are the team's data analyst.",
            "Process and analyze data (experimental or computational) using sound statistics.",
            "Report uncertainties, assumptions, and the methodology behind every result.",
            "Your focus is the analysis and findings rather than figure design.",
        ].join(" "),
    },
    visualizer: {
        agent: "oct-junior",
        instruction: [
            "You are the team's data visualizer.",
            "Turn data and results into clear, accurate figures and plots",
            "(charts, scientific visualization).",
            "Choose the right plot type for the message, label axes and units,",
            "and never distort the data.",
            "Produce reproducible plotting code.",
        ].join(" "),
    },
    // --- research / writing / ideation ---
    researcher: {
        agent: "oct-librarian",
        instruction: [
            "You are the team's researcher.",
            "Survey the literature and external references",
            "the team's work depends on (papers, materials databases, documentation).",
            "Report findings concisely with precise citations and links.",
            "Do not implement — hand your findings to the team.",
        ].join(" "),
    },
    author: {
        agent: "oct-junior",
        instruction: [
            "You are the team's academic author.",
            "Write and structure scholarly manuscripts — abstract, introduction,",
            "methods, results, discussion — with rigorous, precise prose and proper citations.",
            "Match claims to evidence, and keep notation and terminology consistent",
            "(LaTeX where appropriate).",
        ].join(" "),
    },
    fantast: {
        agent: "oct-ultrabrain",
        instruction: [
            "You are the team's ideator.",
            "Generate novel, unconventional, even contrarian ideas",
            "— challenge the team's assumptions and propose approaches no one else would.",
            "Favor originality and vision over caution; surface bold options,",
            "ground each in real principles, and note what would make it viable.",
            "Do not self-censor for feasibility first.",
        ].join(" "),
    },
    // --- planning / review / media ---
    planner: {
        agent: "oct-metis",
        instruction: [
            "You are the team's planner.",
            "Transform goals into executable, atomic plans: classify the intent, break the work into verifiable steps (each doable in 1-3 tool calls), identify file targets and ordering constraints, and give implementers clear directives.",
            "You plan, you do not implement.",
        ].join(" "),
    },
    auditor: {
        agent: "oct-momus",
        instruction: [
            "You are the team's plan auditor.",
            "Review plans for completeness, hidden assumptions, and missing edge cases.",
            "Apply APPROVAL BIAS: approve plans that are roughly 80% clear, cap blocking issues at 3.",
            "Categorize findings as blocking/caution/suggestion.",
            "You audit, you do not implement or rewrite plans.",
        ].join(" "),
    },
    looker: {
        agent: "oct-multimodal-looker",
        instruction: [
            "You are the team's media analyst.",
            "Analyze PDFs, images, diagrams, and charts: extract text, tables, and structured data, describe and interpret visuals, answer targeted questions about file content.",
            "Use only the read tool.",
            "Quote exact values when precision matters.",
        ].join(" "),
    },
    // --- fallback ---
    almighty: {
        agent: "oct-junior",
        instruction: [
            "You are an all-round team member.",
            "Take on whatever the task requires — implementation, analysis,",
            "research, or writing — following the team's conventions.",
            "Work carefully, verify your output,",
            "and coordinate with teammates via the team tools.",
        ].join(" "),
    },
}

/**
 * Role assigned when a member's role does not match any preset. This is a
 * read-only role ("reviewer" -> oracle agent) on purpose: an unrecognized role
 * (e.g. a typo) must fail safe to least privilege, never silently escalate to a
 * full write-capable agent ("almighty" -> build). "almighty" stays available as
 * an explicit opt-in role, but is no longer the silent fallback.
 */
export const DEFAULT_ROLE = "reviewer"

/**
 * All preset role names (the closed enum of valid roles).
 *
 * @internal Exported only for use by tests/role.test.ts (closed-enum regression
 * on the 22 preset role count + names). Not part of the public API; do not
 * consume from production code.
 */
export const ROLE_NAMES: readonly string[] = Object.freeze(Object.keys(ROLES))

/**
 * All hardened oct-* agent names used by OCTeam roles. Derived from ROLES so
 * the allowlist stays in sync as new roles/agents are added. This is the single
 * source of truth for "which agent values may a member legitimately carry" —
 * used by the tool schemas (create/add/fix), dispatch sanitization, and disk
 * reload validation to ensure a member's `agent` field can never name a bare
 * host agent (e.g. "build") that bypasses the hardened oct-* permission maps.
 */
export const OCTEAM_AGENTS: readonly string[] = Object.freeze(
    Array.from(new Set(Object.values(ROLES).map(r => r.agent))).sort(),
)

/**
 * The read-only fallback agent used when a member's `agent` is missing or not
 * in the hardened oct-* allowlist. Equals roleAgent(DEFAULT_ROLE) = "oct-oracle".
 * Fail-safe: an unrecognized or tampered agent degrades to least privilege,
 * never escalates to a full-capability host agent.
 */
export const SAFE_FALLBACK_AGENT: string = roleAgent(DEFAULT_ROLE)

/**
 * Normalize a role label to a preset role key. Matching is case-insensitive;
 * anything not in ROLES collapses to DEFAULT_ROLE ("reviewer"). Uses an own-
 * property check so inherited Object keys ("toString", "constructor", …) never
 * falsely match.
 */
export function normalizeRole(role: string): string {
    const key = role.toLowerCase()
    return Object.prototype.hasOwnProperty.call(ROLES, key) ? key : DEFAULT_ROLE
}

/**
 * True iff `agent` is one of OCTeam's hardened oct-* agents. Used at every
 * trust boundary (tool input, disk reload, dispatch) to gate the
 * permission-determining `agent` field.
 */
export function isOCTeamAgent(agent: string): boolean {
    return OCTEAM_AGENTS.includes(agent)
}

/**
 * Return `agent` when it is a hardened oct-* agent, else the read-only
 * fallback. This is the fail-safe replacement for the old `member.agent ?? "build"`
 * pattern at every dispatch site: a tampered, stale, or hand-edited `agent`
 * value (e.g. "build" written into state.json) can never escalate a member to
 * a privileged host agent. When `agent` is undefined (a member created without
 * an explicit agent override, then loaded from old state), the role-derived
 * agent was already set at create time and stored — so this fallback only
 * fires for corrupted/legacy state, where oct-oracle (read-only) is the safe
 * default.
 */
export function safeMemberAgent(agent: string | undefined): string {
    return agent !== undefined && isOCTeamAgent(agent) ? agent : SAFE_FALLBACK_AGENT
}

/** The full role definition for a label (normalized, always resolves). */
export function roleDef(role: string): RoleDef {
    return ROLES[normalizeRole(role)]
}

/** The fixed agent for a role label (normalized, always resolves). */
export function roleAgent(role: string): string {
    return roleDef(role).agent
}

/** The preset instruction for a role label (normalized, always non-empty). */
export function rolePreset(role: string): string {
    return roleDef(role).instruction
}
