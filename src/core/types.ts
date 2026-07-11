/**
 * OCTeam data model types — barrel re-export.
 *
 * This file re-exports all types from per-subsystem files so existing imports
 * (`from "../core/types.js"`) continue to work unchanged. New code should
 * prefer importing directly from the focused file (e.g.
 * `from "../core/types/workflow.js"`) when only a single subsystem is needed.
 *
 * All types here are JSON-serializable — they are persisted to disk
 * (config.json / state.json / mailbox *.jsonl / tasks/*.json). Runtime-only
 * constructs that carry non-serializable handles (e.g. the Team wrapper with
 * its in-process mutex) live in state/store.ts, NOT here.
 *
 * Subsystem files (layered, no cycles):
 *   - workflow.ts         (Layer 0) WorkflowStep, Verdict, fanout/join metadata, WorkflowToolStep (external tool API)
 *   - messaging.ts        (Layer 0) Message, SdkMessage
 *   - task.ts             (Layer 0-1) ActiveTask union + 11 variants + enums + Stage/GatedStage/Approval/RouteBranch/Arena; Task/TaskStatus (shared cooperative tasklist)
 *   - team.ts             (Layer 2) TeamSpec, TeamState, MemberState, Bounds, LastModeRecord, StorageScope
 *   - runs.ts             (Layer 2) RunRecord, RunEvent, WorkflowRunStep
 */

export * from "./types/workflow.js"
export * from "./types/messaging.js"
export * from "./types/task.js"
export * from "./types/team.js"
export * from "./types/runs.js"
