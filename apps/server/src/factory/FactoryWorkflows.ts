import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BuiltInWorkflows } from "../workflows/builtIn.ts";
import * as FactoryTasks from "./FactoryTasks.ts";
import { makeFactoryWorkflow } from "./factoryWorkflow.ts";

/** The factory's definition, built from the services its body uses. */
export const layer = Layer.effect(
  BuiltInWorkflows,
  Effect.map(FactoryTasks.FactoryTasks, (tasks) => [makeFactoryWorkflow({ tasks })]),
).pipe(Layer.provide(FactoryTasks.layer));
