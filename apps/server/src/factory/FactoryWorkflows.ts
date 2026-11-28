import { CommandId, factoryProjectSettingsOf, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
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
    const threads = yield* ThreadManagement.ThreadManagementService;
    return makeFactoryWorkflows({
      tasks,
      enabledProjects: Effect.map(settings.getSettings, enabledProjects),
      projectSettings: (project) =>
        Effect.map(settings.getSettings, (all) => factoryProjectSettingsOf(all, project)),
      // Threads on linked environments are settled once placement puts workers there (#93).
      settle: (thread) =>
        thread.environment === undefined
          ? threads
              .settleThread({
                threadId: ThreadId.make(thread.threadId),
                // One settle per thread, however often the step is retried.
                commandId: CommandId.make(`factory:settle:${thread.threadId}`),
                byOwnAgent: false,
              })
              .pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("factory could not settle a worker thread", {
                        thread,
                        cause,
                      }),
                ),
              )
          : Effect.void,
    });
  }),
).pipe(Layer.provide(FactoryTasks.layer));
