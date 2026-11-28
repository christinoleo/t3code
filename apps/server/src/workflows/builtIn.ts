// Fork-only: workflows the server ships with, registered beside the definition files.
import * as Context from "effect/Context";

import type { WorkflowDefinition } from "./workflow.ts";

/** Definitions that need no file. A file that defines one of them again is held back. */
export const BuiltInWorkflows = Context.Reference<ReadonlyArray<WorkflowDefinition>>(
  "t3/workflows/BuiltInWorkflows",
  { defaultValue: () => [] },
);
