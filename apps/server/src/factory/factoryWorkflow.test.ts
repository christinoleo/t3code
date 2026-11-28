import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  factoryProjectSettingsOf,
  ProjectId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { AgentThread } from "../workflows/workflowAgent.ts";
import { WorkflowAgents } from "../workflows/WorkflowAgents.ts";
import { unavailable, WorkflowForge } from "../workflows/WorkflowForge.ts";
import * as Workflows from "../workflows/Workflows.ts";
import { runFactory } from "./factory.testkit.ts";
import type { FactoryDeps } from "./factoryWorkflow.ts";
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

const depsOver = (
  tasks: FactoryTasks.FactoryTasks["Service"],
  settings: Ref.Ref<ServerSettings>,
  settled: Array<AgentThread> = [],
): FactoryDeps => ({
  tasks,
  enabledProjects: Effect.map(Ref.get(settings), enabledProjects),
  projectSettings: (project) =>
    Effect.map(Ref.get(settings), (all) => factoryProjectSettingsOf(all, project)),
  settle: (thread) => Effect.sync(() => void settled.push(thread)),
});

const tickAt = (minute: number) =>
  Effect.flatMap(Workflows.Workflows, (workflows) =>
    workflows.start(
      "factory",
      { scheduledAt: `2026-11-28T10:0${minute}:00.000Z` },
      { idempotencyKey: `tick-${minute}` },
    ),
  );

const startedBy = (tickRun: { readonly runId: string }) =>
  Effect.gen(function* () {
    const workflows = yield* Workflows.Workflows;
    yield* workflows.waitFor(tickRun.runId, (run) => run.status === "skipped");
    const { steps } = yield* workflows.get(tickRun.runId);
    return steps.map((step) => step.name).filter((name) => name.startsWith("start/"));
  });

it.effect("a tick starts task runs only in projects whose factory is on", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const file = (scope: string, title: string, kind: "build" | "grilling" = "build") =>
      tasks.create({ scope, kind, title, body: "" }, PERSON);
    const settings = yield* Ref.make(
      settingsWith({ alpha: { enabled: true }, beta: { enabled: false } }),
    );
    const alphaBuild = yield* file(ProjectId.make("alpha"), "Build it");
    const talk = yield* file(ProjectId.make("alpha"), "Talk it through", "grilling");
    yield* tasks.create(
      {
        scope: ProjectId.make("alpha"),
        title: "Waits on the talk",
        body: "",
        blockedBy: [talk.id],
      },
      PERSON,
    );
    yield* file(ProjectId.make("beta"), "Off here");

    yield* runFactory(
      depsOver(tasks, settings),
      Effect.gen(function* () {
        expect(yield* startedBy(yield* tickAt(0))).toEqual([`start/${alphaBuild.id}/0`]);

        yield* Ref.set(settings, settingsWith({ alpha: { enabled: false } }));
        yield* file(ProjectId.make("alpha"), "Filed while off");
        expect(yield* startedBy(yield* tickAt(1))).toEqual([]);
      }),
    );
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

type Started = Parameters<WorkflowAgents["Service"]["start"]>[0];
const PULL_REQUEST = "https://github.com/me/alpha/pull/7";
const decided = (what: string) => ({ what, why: `${what} is reversible`, alternative: "ask" });

it.effect("a ready task is built, reviewed and merged by one run, then ends Done", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const reviewModel = { instanceId: "codex", model: "gpt-review" };
    const settings = yield* Ref.make(
      decodeSettings({
        factory: {
          projects: { alpha: { enabled: true, mergeMethod: "rebase", reviewers: [reviewModel] } },
        },
      }),
    );
    const task = yield* tasks.create(
      { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
      PERSON,
    );

    const reports: Record<string, Schema.Json> = {
      build: { outcome: "pull-request", url: PULL_REQUEST, decisions: [decided("Kept the API")] },
      review: { outcome: "approve", decisions: [decided("Fixed a typo")] },
    };
    const started: Array<Started> = [];
    const building = yield* Deferred.make<void>();
    const buildMayEnd = yield* Deferred.make<void>();
    const agents = WorkflowAgents.of({
      start: (input) =>
        Effect.gen(function* () {
          started.push(input);
          if (input.origin.step === "build") yield* Deferred.succeed(building, undefined);
          return { threadId: `thread-${input.origin.step}`, turnId: input.key };
        }),
      result: (turn) => {
        const step = started.find((input) => input.key === turn.turnId)!.origin.step;
        return Effect.as(step === "build" ? Deferred.await(buildMayEnd) : Effect.void, {
          ending: "completed" as const,
          detail: "",
          reply: "",
          output: reports[step],
        });
      },
      interrupt: () => Effect.succeed("ended" as const),
    });
    const merges: Array<unknown> = [];
    const forge = WorkflowForge.of({
      ...unavailable,
      pullRequests: {
        ...unavailable.pullRequests,
        read: () =>
          Effect.succeed({
            state: "open",
            mergeability: "mergeable",
            url: PULL_REQUEST,
            checks: [{ name: "test", status: "success", description: null, url: null }],
          } as never),
        act: (pullRequest, action, options) =>
          Effect.sync(() => void merges.push({ pullRequest, action, options })),
      },
    });
    const settled: Array<AgentThread> = [];

    yield* runFactory(
      depsOver(tasks, settings, settled),
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        expect(yield* startedBy(yield* tickAt(0))).toEqual([`start/${task.id}/0`]);
        yield* Deferred.await(building);
        expect(yield* startedBy(yield* tickAt(1))).toEqual([]);
        yield* Deferred.succeed(buildMayEnd, undefined);

        const runs = (yield* workflows.list()).filter((run) => run.workflow === "factory-task");
        expect(runs).toHaveLength(1);
        yield* workflows.waitFor(runs[0]!.runId, (run) => run.status === "completed");
      }),
      { agents, forge },
    );

    const { entries } = yield* tasks.timeline(task.id);
    expect(
      entries.flatMap((entry) => (entry.type === "state" ? [`${entry.from}>${entry.to}`] : [])),
    ).toEqual(["ready>building", "building>reviewing", "reviewing>done"]);
    expect(
      entries.flatMap((entry) =>
        entry.type === "attempt" ? [[entry.phase, entry.outcome, entry.thread?.threadId]] : [],
      ),
    ).toEqual([
      ["build", "succeeded", "thread-build"],
      ["review", "succeeded", "thread-review"],
    ]);
    expect(
      entries.flatMap((entry) =>
        entry.type === "decision" ? [[entry.decision.what, entry.by]] : [],
      ),
    ).toEqual([
      ["Kept the API", { kind: "agent", threadId: "thread-build" }],
      ["Fixed a typo", { kind: "agent", threadId: "thread-review" }],
    ]);
    const review = started.find((input) => input.origin.step === "review")!;
    expect(review.thread).toBeUndefined();
    expect(review.model).toMatchObject(reviewModel);
    expect(merges).toEqual([
      {
        pullRequest: { project: "alpha", url: PULL_REQUEST },
        action: "merge",
        options: { mergeMethod: "rebase" },
      },
    ]);
    expect(settled.map((thread) => thread.threadId)).toEqual(["thread-build", "thread-review"]);
    expect((yield* tasks.get(task.id)).state).toBe("done");
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("a run whose task is dropped and revived leaves it to the new generation's run", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
    const task = yield* tasks.create(
      { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
      PERSON,
    );
    const branches: Array<string | undefined> = [];
    const firstBuilding = yield* Deferred.make<void>();
    const firstMayEnd = yield* Deferred.make<void>();
    const agents = WorkflowAgents.of({
      start: (input) =>
        Effect.gen(function* () {
          const workspace = input.launch?.workspace;
          if (workspace?.type === "worktree") branches.push(workspace.branch);
          yield* Deferred.succeed(firstBuilding, undefined);
          return { threadId: `thread-${branches.length}`, turnId: `${branches.length}` };
        }),
      result: (turn) =>
        turn.turnId === "1"
          ? Effect.as(Deferred.await(firstMayEnd), {
              ending: "completed" as const,
              detail: "",
              reply: "",
              output: { outcome: "pull-request", url: PULL_REQUEST, decisions: [] },
            })
          : Effect.succeed({
              ending: "completed" as const,
              detail: "",
              reply: "",
              output: { outcome: "gave-up", why: "Stuck.", tryNext: "Again.", decisions: [] },
            }),
      interrupt: () => Effect.succeed("ended" as const),
    });

    yield* runFactory(
      depsOver(tasks, settings),
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const taskRuns = Effect.map(workflows.list(), (runs) =>
          runs.filter((run) => run.workflow === "factory-task"),
        );
        yield* startedBy(yield* tickAt(0));
        yield* Deferred.await(firstBuilding);
        const [first] = yield* taskRuns;
        yield* tasks.transition(task.id, "dropped", PERSON);
        yield* tasks.transition(task.id, "ready", PERSON);
        expect(yield* startedBy(yield* tickAt(1))).toEqual([`start/${task.id}/1`]);
        const second = (yield* taskRuns).find((run) => run.runId !== first!.runId)!;
        yield* workflows.waitFor(second.runId, (run) => run.status === "completed");

        yield* Deferred.succeed(firstMayEnd, undefined);
        yield* workflows.waitFor(first!.runId, (run) => run.status === "skipped");
      }),
      { agents },
    );

    expect(new Set(branches).size).toBe(2);
    const { entries } = yield* tasks.timeline(task.id);
    expect(
      entries.flatMap((entry) => (entry.type === "state" ? [`${entry.from}>${entry.to}`] : [])),
    ).toEqual([
      "ready>building",
      "building>dropped",
      "dropped>ready",
      "ready>building",
      "building>needs-you",
    ]);
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);
