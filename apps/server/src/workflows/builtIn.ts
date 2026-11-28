import * as Context from "effect/Context";

import type { WorkflowDefinition } from "./workflow.ts";

/** Fork-only: definitions that need no file; a file that defines one again is held back. */
export const BuiltInWorkflows = Context.Reference<ReadonlyArray<WorkflowDefinition>>(
  "t3/workflows/BuiltInWorkflows",
  { defaultValue: () => [] },
);
