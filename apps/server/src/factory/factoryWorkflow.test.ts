import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ProjectId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Workflows from "../workflows/Workflows.ts";
import { runFactory } from "./factory.testkit.ts";
import { enabledProjects } from "./FactorySettings.ts";
import * as FactoryTasks from "./FactoryTasks.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const settingsWith = (projects: Record<string, { readonly enabled: boolean }>) =>
  decodeSettings({ factory: { projects } });

const store = FactoryTasks.layer.pipe(
  Layer.provideMerge(
    Layer.merge(
      SqlitePersistence.layerMemory,
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-owner")),
        getDescriptor: Effect.succeed({ label: "omarchy" } as ExecutionEnvironmentDescriptor),
      }),
    ),
  ),
);

const PERSON = { kind: "person", name: "Leo" } as const;

it.effect("a tick starts task runs only in projects whose factory is on", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const file = (scope: string, title: string, kind: "build" | "grilling" = "build") =>
      tasks.create({ scope, kind, title, body: "" }, PERSON);
    const settings = yield* Ref.make(
      settingsWith({ alpha: { enabled: true }, beta: { enabled: false } }),
    );
    const alphaBuild = yield* file(ProjectId.make("alpha"), "Build it");
    yield* file(ProjectId.make("alpha"), "Talk it through", "grilling");
    const blocker = yield* file(ProjectId.make("alpha"), "Talk it through first", "grilling");
    const blocked = yield* file(ProjectId.make("alpha"), "Waits on the talk");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_task_edges (task_id, blocker_id) VALUES (${blocked.id}, ${blocker.id})`;
    yield* file(ProjectId.make("beta"), "Off here");

    const started = (tickRun: string) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        yield* workflows.waitFor(tickRun, (run) => run.status === "skipped");
        const { steps } = yield* workflows.get(tickRun);
        return steps.map((step) => step.name).filter((name) => name.startsWith("start/"));
      });

    yield* runFactory(
      { tasks, enabledProjects: Effect.map(Ref.get(settings), enabledProjects) },
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const first = yield* workflows.start(
          "factory",
          { scheduledAt: "2026-11-28T10:00:00.000Z" },
          { idempotencyKey: "tick-1" },
        );
        expect(yield* started(first.runId)).toEqual([`start/${alphaBuild.id}/0`]);

        yield* Ref.set(settings, settingsWith({ alpha: { enabled: false } }));
        yield* file(ProjectId.make("alpha"), "Filed while off");
        const second = yield* workflows.start(
          "factory",
          { scheduledAt: "2026-11-28T10:01:00.000Z" },
          { idempotencyKey: "tick-2" },
        );
        expect(yield* started(second.runId)).toEqual([]);
      }),
    );
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);
