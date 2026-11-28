import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { start } from "../workflows/stepServices.ts";
import { every, Tick } from "../workflows/triggers.ts";
import { skip, step, workflow } from "../workflows/workflow.ts";
import type { FactoryProject } from "./FactorySettings.ts";
import { type FactoryTasks, TaskId } from "./FactoryTasks.ts";
import type { ServerSettingsError } from "@t3tools/contracts";

/** One task's lifecycle; a revived task's next generation is a new run. */
const TaskRun = Schema.Struct({ task: TaskId, generation: Schema.Int });

/** What the definition's body reaches by closure, so its runs need nothing beyond `InRun`. */
export interface FactoryDeps {
  readonly tasks: FactoryTasks["Service"];
  readonly enabledProjects: Effect.Effect<ReadonlyArray<FactoryProject>, ServerSettingsError>;
}

const Projects = Schema.Array(Schema.Struct({ id: Schema.String, scope: Schema.String }));
const Ready = Schema.Array(TaskRun);

const taskWorkflow = (_deps: FactoryDeps) =>
  workflow("factory-task", { version: 1, payload: TaskRun }, (run) =>
    Effect.die(new Error(`The factory's run for task ${run.task} is not implemented yet.`)),
  );

/** Two definitions, since a trigger's payload is its only one. */
export const makeFactoryWorkflows = (deps: FactoryDeps) => {
  const task = taskWorkflow(deps);
  const tick = workflow(
    "factory",
    { version: 1, payload: Tick, triggers: [every("1 minute")] },
    Effect.fn("factory.tick")(function* () {
      const projects = yield* step(
        "projects",
        { returns: Projects },
        Effect.map(deps.enabledProjects, (enabled) =>
          enabled.map((project) => ({ id: project.id, scope: project.scope })),
        ),
      );
      for (const project of projects) {
        const ready = yield* step(
          `ready/${project.id}`,
          { returns: Ready },
          Effect.map(deps.tasks.dispatchable(project.scope), (tasks) =>
            tasks.map((found) => ({ task: found.id, generation: found.generation })),
          ),
        );
        for (const run of ready) {
          yield* step(
            `start/${run.task}/${run.generation}`,
            { returns: Schema.String },
            Effect.map(
              start(task, run, { key: `task/${run.task}/${run.generation}` }),
              ({ runId }) => runId,
            ),
          );
        }
      }
      return yield* skip("tick");
    }),
  );
  return [tick, task];
};
