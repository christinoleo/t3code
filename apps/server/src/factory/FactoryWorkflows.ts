import { CommandId, factoryProjectSettingsOf, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
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
    const vcs = yield* GitVcsDriver.GitVcsDriver;
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      Effect.map(
        vcs.execute({ operation: "factory.baseTouchedSinceFork", cwd, args, timeoutMs: 120_000 }),
        (result) => result.stdout.trim(),
      );
    const files = (listed: string) => listed.split("\n").filter((file) => file !== "");
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
      baseTouchedSinceFork: Effect.fn("FactoryWorkflows.baseTouchedSinceFork")(function* ({
        checkout,
        base,
        head,
      }) {
        const [baseRef, headRef] = [`refs/remotes/origin/${base}`, `refs/remotes/origin/${head}`];
        yield* git(checkout, [
          "fetch",
          "--quiet",
          "origin",
          `+refs/heads/${base}:${baseRef}`,
          `+refs/heads/${head}:${headRef}`,
        ]);
        const from = yield* git(checkout, ["merge-base", baseRef, headRef]);
        const moved = new Set(files(yield* git(checkout, ["diff", "--name-only", from, baseRef])));
        if (moved.size === 0) return false;
        const changes = files(yield* git(checkout, ["diff", "--name-only", from, headRef]));
        return changes.some((file) => moved.has(file));
      }),
    });
  }),
).pipe(Layer.provide(Layer.merge(FactoryTasks.layer, GitVcsDriver.layer)));
