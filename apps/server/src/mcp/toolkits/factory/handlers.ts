import { factoryProjectSettingsOf, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { configure } from "../../../factory/FactorySettings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { FactoryToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(FactoryToolkit, {
  factory_configure: McpToolAccess.writesEnvironment(
    ({ environmentId: _environmentId, projectId, ...patch }, check) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const settings = yield* Settings.ServerSettingsService;
        const run = Effect.gen(function* () {
          // The turn may have ended, or the thread's modes changed, while this waited for the lock.
          yield* check;
          if (Object.keys(patch).length === 0) {
            return factoryProjectSettingsOf(yield* settings.getSettings, projectId);
          }
          return yield* configure(projectId, patch);
        }).pipe(
          Effect.catchTags({
            IssueTrackerConnectionError: (error) =>
              Effect.fail(
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.detail }),
              ),
            ServerSettingsError: () => Effect.fail(unavailable()),
            ProjectOperationError: () => Effect.fail(unavailable()),
          }),
        );
        return yield* scope.thread === undefined
          ? run
          : executor.withLock(scope.thread.threadId, run);
      }),
  ),
});
