import { every, Tick } from "../workflows/triggers.ts";
import { skip, workflow } from "../workflows/workflow.ts";
import type { FactoryTasks } from "./FactoryTasks.ts";

/** What the definition's body reaches by closure, so its runs need nothing beyond `InRun`. */
export interface FactoryDeps {
  readonly tasks: FactoryTasks["Service"];
}

/** Skips each tick so its runs are pruned. */
export const makeFactoryWorkflow = (_deps: FactoryDeps) =>
  workflow("factory", { version: 1, payload: Tick, triggers: [every("1 minute")] }, () =>
    skip("tick"),
  );
