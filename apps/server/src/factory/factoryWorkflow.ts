import { every, Tick } from "../workflows/triggers.ts";
import { skip, workflow } from "../workflows/workflow.ts";
import type { FactoryTasks } from "./FactoryTasks.ts";

/** What the definition's body reaches by closure, so its runs need nothing beyond `InRun`. */
export interface FactoryDeps {
  readonly tasks: FactoryTasks["Service"];
}

/**
 * The factory: one short run a minute that takes in work, mirrors it and dispatches it, then
 * skips so it is pruned. Nothing is dispatched yet.
 */
export const makeFactoryWorkflow = (_deps: FactoryDeps) =>
  workflow("factory", { version: 1, payload: Tick, triggers: [every("1 minute")] }, () =>
    skip("tick"),
  );
