import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  EnvironmentId,
  ProjectId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as IssueTrackerConnections from "../issue/IssueTrackerConnections.ts";
import * as IssueTrackerRegistry from "../issue/IssueTrackerRegistry.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as FactoryTasks from "./FactoryTasks.ts";
import * as TaskTracker from "./TaskTracker.ts";

const ENVIRONMENT = EnvironmentId.make("env-owner");
const shell = (id: string, title: string) =>
  ({
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-28T00:00:00.000Z",
    updatedAt: "2026-11-28T00:00:00.000Z",
  }) satisfies OrchestrationProjectShell;
const PROJECTS = [shell("alpha", "Alpha"), shell("beta", "Beta")];

const fakes = Layer.mergeAll(
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(ENVIRONMENT),
    getDescriptor: Effect.succeed({ label: "omarchy" } as ExecutionEnvironmentDescriptor),
  }),
  Layer.mock(ProjectService.ProjectService)({
    listShells: () => Effect.succeed(PROJECTS),
    getShell: (projectId) =>
      Effect.succeed(Option.fromNullishOr(PROJECTS.find((project) => project.id === projectId))),
  }),
);
const layer = FactoryTasks.layer.pipe(
  Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, fakes)),
);

const target = (scope: string, key: string) => ({ cwd: "/work", host: "t3", scope, key });
const FACTORY = { kind: "factory", runId: "run-1" } as const;

const tracker = Effect.flatMap(TaskTracker.make, (api) =>
  Effect.map(FactoryTasks.FactoryTasks, (tasks) => ({ api, tasks })),
);

describe("TaskTracker", () => {
  it.effect("files tasks with numbered keys per project and reads them back as issues", () =>
    Effect.gen(function* () {
      const { api } = yield* tracker;
      const create = (scope: string, title: string, labels: ReadonlyArray<string> = []) =>
        api.create!({
          cwd: "/work",
          host: "t3",
          scope,
          title,
          body: "Why.",
          labels,
          assignees: [],
        });
      const first = yield* create("alpha", "Fix the tick", ["kind/research", "urgent"]);
      const second = yield* create("alpha", "Write the store");
      const other = yield* create("beta", "Elsewhere");
      expect([first.key, first.displayKey, second.key, other.key]).toEqual(["1", "T3-1", "2", "1"]);
      expect(yield* Effect.flip(create("nowhere", "Lost"))).toMatchObject({ reason: "not-found" });

      for (const url of [first.url, first.url.replace("key=1", "key=+1+")]) {
        expect(api.parseIssueUrl(new URL(url))).toEqual({
          host: "t3",
          scope: "alpha",
          key: "1",
          workspace: ENVIRONMENT,
        });
      }

      const listed = yield* api.listIssues({
        cwd: "/work",
        host: "t3",
        scope: "alpha",
        involvement: "all",
        state: "open",
        limit: 1,
        sort: "created",
      });
      expect(listed.items.map((issue) => issue.title)).toEqual(["Write the store"]);
      const rest = yield* api.listIssues({
        cwd: "/work",
        host: "t3",
        scope: "alpha",
        involvement: "all",
        state: "open",
        limit: 1,
        sort: "created",
        cursor: listed.nextCursor!,
      });
      expect([rest.items.map((issue) => issue.title), rest.nextCursor]).toEqual([
        ["Fix the tick"],
        null,
      ]);

      yield* api.comment!({ ...target("alpha", "1"), body: "On it." });
      yield* api.update!({ ...target("alpha", "1"), labels: ["kind/build"] });
      const detail = yield* api.getIssue(target("alpha", "1"));
      expect(detail).toMatchObject({
        key: "1",
        title: "Fix the tick",
        body: "Why.",
        labels: [{ name: "kind/build" }],
        commentCount: 1,
        comments: [{ body: "On it." }],
      });
      expect(
        yield* Effect.flip(api.update!({ ...target("alpha", "1"), labels: ["blocked"] })),
      ).toMatchObject({ reason: "failed" });
      expect(
        yield* Effect.flip(
          api.update!({ ...target("alpha", "1"), labels: ["kind/build", "kind/task"] }),
        ),
      ).toMatchObject({ reason: "failed" });
      expect(yield* Effect.flip(api.getIssue(target("alpha", "ENG-1")))).toMatchObject({
        reason: "not-found",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "maps the lifecycle: Done and Dropped close, the working states are the factory's",
    () =>
      Effect.gen(function* () {
        const { api, tasks } = yield* tracker;
        yield* api.create!({
          cwd: "/work",
          host: "t3",
          scope: "alpha",
          title: "A task",
          body: "",
          labels: [],
          assignees: [],
        });
        const issue = target("alpha", "1");
        const state = Effect.map(api.getIssue(issue), (detail) => detail.state);
        const task = yield* tasks.byKey("alpha", 1);

        expect((yield* api.getIssue(issue)).states.map((entry) => entry.name)).toEqual([
          "Ready",
          "Building",
          "Reviewing",
          "Needs you",
          "Done",
          "Dropped",
        ]);
        expect(yield* state).toEqual({ category: "open", name: "Ready" });
        expect(yield* Effect.flip(api.setState!({ ...issue, state: "Building" }))).toMatchObject({
          detail: "Building is set by the factory; answer its Needs-you question instead.",
        });

        yield* tasks.transition(task.id, "building", FACTORY);
        expect(yield* state).toEqual({ category: "open", name: "Building" });
        yield* tasks.transition(task.id, "done", FACTORY);
        expect(yield* state).toEqual({
          category: "closed",
          name: "Done",
          closeReason: "completed",
        });

        yield* api.setState!({ ...issue, state: "Ready" });
        expect((yield* tasks.get(task.id)).generation).toBe(task.generation + 1);
        yield* api.setState!({ ...issue, state: "Dropped" });
        expect(yield* state).toEqual({
          category: "closed",
          name: "Dropped",
          closeReason: "not planned",
        });
        const closed = yield* api.listIssues({
          cwd: "/work",
          host: "t3",
          scope: "alpha",
          involvement: "all",
          state: "closed",
          limit: 10,
          sort: "updated",
        });
        expect(closed.items.map((entry) => entry.key)).toEqual(["1"]);
        expect(
          (yield* api.getIssue(issue)).events.map((event) => [event.kind, event.detail]),
        ).toEqual([
          ["state-changed", "Building"],
          ["closed", "Done"],
          ["reopened", "Ready"],
          ["closed", "Dropped"],
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("the detail shows the newest comments, and older ones page in behind them", () =>
    Effect.gen(function* () {
      const { api } = yield* tracker;
      yield* api.create!({
        cwd: "/work",
        host: "t3",
        scope: "alpha",
        title: "Chatty",
        body: "",
        labels: [],
        assignees: [],
      });
      const issue = target("alpha", "1");
      for (let n = 1; n <= 101; n++) yield* api.comment!({ ...issue, body: `c${n}` });
      const detail = yield* api.getIssue(issue);
      expect([detail.comments[0]?.body, detail.comments.at(-1)?.body]).toEqual(["c2", "c101"]);
      const older = yield* api.getComments!({ ...issue, cursor: detail.commentsCursor! });
      expect([older.comments.map((comment) => comment.body), older.nextCursor]).toEqual([
        ["c1"],
        null,
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists the viewer's own tasks in full pages", () =>
    Effect.gen(function* () {
      const { api, tasks } = yield* tracker;
      yield* api.create!({
        cwd: "/work",
        host: "t3",
        scope: "alpha",
        title: "Mine",
        body: "",
        labels: [],
        assignees: [],
      });
      for (const title of ["Filed by the factory", "Also the factory's"]) {
        yield* tasks.create({ scope: "alpha", title, body: "" }, FACTORY);
      }
      const page = yield* api.listIssues({
        cwd: "/work",
        host: "t3",
        scope: "alpha",
        involvement: "authored",
        viewer: "you",
        state: "open",
        limit: 1,
        sort: "updated",
      });
      expect([page.items.map((issue) => issue.title), page.nextCursor]).toEqual([["Mine"], null]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a person's drop that races the factory's next move is never overwritten", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      // The in-memory database runs each query synchronously, so only a file one interleaves them.
      const onDisk = FactoryTasks.layer.pipe(
        Layer.provideMerge(
          Layer.merge(SqlitePersistence.layerFromPath(`${directory}/state.sqlite`), fakes),
        ),
      );
      yield* Effect.gen(function* () {
        const { api, tasks } = yield* tracker;
        yield* api.create!({
          cwd: "/work",
          host: "t3",
          scope: "alpha",
          title: "A task",
          body: "",
          labels: [],
          assignees: [],
        });
        const task = yield* tasks.byKey("alpha", 1);
        yield* tasks.transition(task.id, "building", FACTORY);
        yield* Effect.all(
          [
            tasks.transition(task.id, "dropped", { kind: "person", name: "you" }),
            Effect.ignore(tasks.transition(task.id, "reviewing", FACTORY)),
          ],
          { concurrency: "unbounded" },
        );
        expect((yield* tasks.get(task.id)).state).toBe("dropped");
      }).pipe(Effect.provide(onDisk));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("attaches to a project with no credential, and refuses one", () =>
    Effect.gen(function* () {
      const api: StandaloneIssueTrackerApi = yield* TaskTracker.make;
      return yield* Effect.gen(function* () {
        const connections = yield* IssueTrackerConnections.IssueTrackerConnections;
        expect((yield* connections.list).trackers).toMatchObject([
          {
            tracker: "t3",
            credentialFree: true,
            connected: true,
            account: "omarchy",
            workspace: ENVIRONMENT,
            scopes: [
              { key: "alpha", name: "Alpha" },
              { key: "beta", name: "Beta" },
            ],
          },
        ]);
        expect(
          yield* Effect.flip(connections.connect({ tracker: api.kind, token: "secret" })),
        ).toMatchObject({ reason: "rejected", detail: "T3 tasks needs no credential." });
      }).pipe(
        Effect.provide(
          IssueTrackerConnections.layer.pipe(
            Layer.provideMerge(IssueTrackerBindings.layer),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  IssueTrackerRegistry.IssueTrackerRegistry,
                  IssueTrackerRegistry.fromTrackers([api]),
                ),
                // Nothing is ever read from it: there is no secret to read.
                Layer.mock(ServerSecretStore.ServerSecretStore)({}),
                NodeCrypto.layer,
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(layer)),
  );
});
