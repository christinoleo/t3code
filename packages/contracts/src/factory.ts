// Fork-only: the built-in software factory's task model (christinoleo/t3code#85).
import * as Schema from "effect/Schema";

import type { IssueState } from "./issue.ts";

export const TaskKind = Schema.Literals(["build", "research", "grilling", "prototype", "task"]);
export type TaskKind = typeof TaskKind.Type;

export const TaskState = Schema.Literals([
  "ready",
  "building",
  "reviewing",
  "needs-you",
  "done",
  "dropped",
]);
export type TaskState = typeof TaskState.Type;

/** The one list of states, in workflow order. The tracker driver, the mirror and the panel derive from it. */
export const TASK_STATES = {
  ready: { category: "open", name: "Ready" },
  building: { category: "open", name: "Building" },
  reviewing: { category: "open", name: "Reviewing" },
  "needs-you": { category: "open", name: "Needs you" },
  done: { category: "closed", name: "Done", closeReason: "completed" },
  dropped: { category: "closed", name: "Dropped", closeReason: "not planned" },
} as const satisfies Record<TaskState, IssueState>;

export const TASK_LABEL = {
  /** Writable: setting it changes the task's kind. */
  kind: (kind: TaskKind) => `kind/${kind}`,
  /** Derived from open blockers, and refused on write. */
  blocked: "blocked",
  integration: "integration",
  triage: "triage",
  untrusted: "untrusted",
} as const;

/** A call a worker made on its own, kept on the task for audit. */
export const Decision = Schema.Struct({
  what: Schema.String,
  why: Schema.String,
  alternative: Schema.String,
});
export type Decision = typeof Decision.Type;
