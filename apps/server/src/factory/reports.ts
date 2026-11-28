// What the factory's agents submit through `t3_submit_output`. The skills' "Run by the factory"
// sections describe these shapes to the agents.
import { Decision } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decisions = Schema.Array(Decision);

export const WorkerReport = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("pull-request"), url: Schema.String, decisions }),
  Schema.Struct({ outcome: Schema.Literal("needs-you"), question: Schema.String, decisions }),
  Schema.Struct({
    outcome: Schema.Literal("gave-up"),
    why: Schema.String,
    tryNext: Schema.String,
    decisions,
  }),
]);
export type WorkerReport = typeof WorkerReport.Type;

export const ReviewReport = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("approve"), decisions }),
  Schema.Struct({ outcome: Schema.Literal("changes"), requests: Schema.String, decisions }),
  Schema.Struct({ outcome: Schema.Literal("needs-you"), question: Schema.String, decisions }),
  Schema.Struct({ outcome: Schema.Literal("gave-up"), why: Schema.String, decisions }),
]);
export type ReviewReport = typeof ReviewReport.Type;
