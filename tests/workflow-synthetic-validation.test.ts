/**
 * Member-aware workflow graph validation for synthetic teams.
 *
 * validateWorkflowStepsAgainstMembers(steps, memberNames, teamName) validates a
 * workflow graph using ONLY caller-supplied member names -- no stored team, no
 * activation, no disk state. It reuses the exact team_workflow graph validator,
 * so unknown members, gate target errors, and self-verification are caught
 * identically to the live tool. This seam lets a planner validate generated
 * workflow JSON against generated team member names.
 */
import { describe, expect, test } from "bun:test"

import {
    validateWorkflowStepsAgainstMembers,
    type WorkflowToolStep,
} from "../src/tools/workflow/engine.js"

describe("validateWorkflowStepsAgainstMembers", () => {
    test("passes a valid task + gate against supplied members", () => {
        // Given: a task verified by a gate whose verifier differs from the task member
        const steps: WorkflowToolStep[] = [
            { kind: "task", member: "alice", task: "Implement the change" },
            { kind: "gate", verifier: "bob", criteria: "Change compiles and passes tests" },
        ]
        // When: validated against a synthetic roster containing both names
        const result = validateWorkflowStepsAgainstMembers(steps, ["alice", "bob"], "synthetic-team")
        // Then: the graph is valid
        expect(result).toBeNull()
    })

    test("rejects a task whose member is not in the supplied roster", () => {
        // Given: a task naming a member absent from the roster
        const steps: WorkflowToolStep[] = [
            { kind: "task", member: "ghost", task: "Do work" },
        ]
        // When: validated against a roster that lacks "ghost"
        const result = validateWorkflowStepsAgainstMembers(steps, ["alice"], "synthetic-team")
        // Then: the unknown member is reported
        expect(result).toContain('unknown member "ghost"')
    })

    test("rejects a gate whose verifier is also the verified task member", () => {
        // Given: a gate whose verifier equals the target task's member
        const steps: WorkflowToolStep[] = [
            { kind: "task", member: "alice", task: "Implement the change" },
            { kind: "gate", verifier: "alice", criteria: "Self review" },
        ]
        // When: validated against a roster containing that single member
        const result = validateWorkflowStepsAgainstMembers(steps, ["alice"], "synthetic-team")
        // Then: self-verification is rejected
        expect(result).toContain("no self-verification")
    })

    test("rejects a gate whose target_step cannot be resolved", () => {
        // Given: a gate targeting a step that does not precede it
        const steps: WorkflowToolStep[] = [
            { kind: "task", member: "alice", task: "Implement the change" },
            { kind: "gate", verifier: "bob", criteria: "Check", target_step: 3 },
        ]
        // When: validated against a roster containing both members
        const result = validateWorkflowStepsAgainstMembers(steps, ["alice", "bob"], "synthetic-team")
        // Then: the unresolved gate target is reported
        expect(result).toContain("must reference a previous task step")
    })

    test("validates with no team id or activation state", () => {
        // Given: an arbitrary, never-created team name and an in-memory roster
        const steps: WorkflowToolStep[] = [
            { kind: "task", member: "carol", task: "Draft the plan" },
        ]
        // When: validated with only the roster and a free-form team name
        const result = validateWorkflowStepsAgainstMembers(steps, ["carol"], "never-persisted-xyz")
        // Then: it resolves purely from the supplied names, no disk lookup
        expect(result).toBeNull()
    })
})
