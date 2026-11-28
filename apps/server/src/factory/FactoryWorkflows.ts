import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { BuiltInWorkflows } from "../workflows/builtIn.ts";
import * as FactoryTasks from "./FactoryTasks.ts";
import { enabledProjects } from "./FactorySettings.ts";
import { makeFactoryWorkflows } from "./factoryWorkflow.ts";

export const layer = Layer.effect(
  BuiltInWorkflows,
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* ServerSettings.ServerSettingsService;
    return makeFactoryWorkflows({
      tasks,
      enabledProjects: Effect.map(settings.getSettings, enabledProjects),
    });
  }),
).pipe(Layer.provide(FactoryTasks.layer));
