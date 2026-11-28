import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import WorkflowsMigration from "../persistence/Migrations/110_Workflows.ts";
import WorkflowSkippedRunsMigration from "../persistence/Migrations/113_WorkflowSkippedRuns.ts";
import WorkflowRunTagsMigration from "../persistence/Migrations/115_WorkflowRunTags.ts";
import WorkflowMailSenderMigration from "../persistence/Migrations/117_WorkflowMailSender.ts";
import WorkflowPoolsMigration from "../persistence/Migrations/118_WorkflowPools.ts";
import WorkflowRunSubjectMigration from "../persistence/Migrations/119_WorkflowRunSubject.ts";
import { WorkflowAgents } from "../workflows/WorkflowAgents.ts";
import * as WorkflowEngine from "../workflows/WorkflowEngine.ts";
import { WorkflowForge, unavailable } from "../workflows/WorkflowForge.ts";
import type * as Workflows from "../workflows/Workflows.ts";
import { type FactoryDeps, makeFactoryWorkflows } from "./factoryWorkflow.ts";

/**
 * A Workflows engine on a fresh database running only the factory's definitions, built from
 * `deps`, with the agents and forge a test plays. Each `boot` is the server starting on that one
 * database, so a second is a restart. Time runs while `use` does, since the engine polls and
 * backs off on the clock.
 */
export const factoryEngine = Effect.fnUntraced(function* (
  deps: FactoryDeps,
  plays: {
    readonly agents?: WorkflowAgents["Service"];
    readonly forge?: WorkflowForge["Service"];
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-" });
  const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
  yield* Effect.provide(
    Effect.andThen(WorkflowsMigration, WorkflowSkippedRunsMigration).pipe(
      Effect.andThen(WorkflowRunTagsMigration),
      Effect.andThen(WorkflowMailSenderMigration),
      Effect.andThen(WorkflowPoolsMigration),
      Effect.andThen(WorkflowRunSubjectMigration),
    ),
    database,
  );
  const engine = WorkflowEngine.layer(makeFactoryWorkflows(deps)).pipe(
    Layer.provide(
      plays.agents === undefined
        ? Layer.mock(WorkflowAgents)({})
        : Layer.succeed(WorkflowAgents, plays.agents),
    ),
    Layer.provide(Layer.succeed(WorkflowForge, plays.forge ?? unavailable)),
    Layer.provide(database),
    Layer.provide(NodeCrypto.layer),
  );
  return <A, E>(use: Effect.Effect<A, E, Workflows.Workflows>) =>
    Effect.raceFirst(
      Effect.scoped(Effect.provide(use, Layer.fresh(engine))),
      Effect.forever(TestClock.adjust("1 second")),
    );
});

/** One boot of `factoryEngine`. */
export const runFactory = Effect.fnUntraced(function* <A, E>(
  deps: FactoryDeps,
  use: Effect.Effect<A, E, Workflows.Workflows>,
  plays: Parameters<typeof factoryEngine>[1] = {},
) {
  const boot = yield* factoryEngine(deps, plays);
  return yield* boot(use);
});
