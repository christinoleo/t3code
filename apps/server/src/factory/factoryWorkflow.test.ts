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
import { WorkflowAgentError, WorkflowAgents } from "../workflows/WorkflowAgents.ts";
import { unavailable, WorkflowForge, WorkflowForgeError } from "../workflows/WorkflowForge.ts";
import * as Workflows from "../workflows/Workflows.ts";
import { factoryEngine, runFactory } from "./factory.testkit.ts";
import type { FactoryDeps } from "./factoryWorkflow.ts";
import { enabledProjects } from "./FactorySettings.ts";
import * as FactoryTasks from "./FactoryTasks.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
// The engine's clock runs as fast as the test lets it, so a busy machine passes hours between
// two steps. Only a test about a timeout gets a short one.
const PATIENT = { buildTimeoutMinutes: 525_600, reviewTimeoutMinutes: 525_600 };
const settingsWith = (projects: Record<string, { readonly enabled: boolean }>) =>
  decodeSettings({
    factory: {
      projects: Object.fromEntries(
        Object.entries(projects).map(([id, project]) => [id, { ...project, budgets: PATIENT }]),
      ),
    },
  });

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
  baseTouchedSinceFork: FactoryDeps["baseTouchedSinceFork"] = () => Effect.succeed(false),
): FactoryDeps => ({
  tasks,
  enabledProjects: Effect.map(Ref.get(settings), enabledProjects),
  projectSettings: (project) =>
    Effect.map(Ref.get(settings), (all) => factoryProjectSettingsOf(all, project)),
  settle: (thread) => Effect.sync(() => void settled.push(thread)),
  baseTouchedSinceFork,
});

const tickAt = (minute: number) =>
  Effect.flatMap(Workflows.Workflows, (workflows) =>
    workflows.start(
      "factory",
      { scheduledAt: `2026-11-28T10:0${minute}:00.000Z` },
      { idempotencyKey: `tick-${minute}` },
    ),
  );

const waitAsked = (runId: string, nth: number) =>
  Effect.flatMap(Workflows.Workflows, (workflows) =>
    workflows.waitFor(
      runId,
      (run) => run.status === "waiting" && run.detail === `needs-you/${nth}`,
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
    const file = (scope: string, title: string) => tasks.create({ scope, title, body: "" }, PERSON);
    const settings = yield* Ref.make(
      settingsWith({ alpha: { enabled: true }, beta: { enabled: false } }),
    );
    const alphaBuild = yield* file(ProjectId.make("alpha"), "Build it");
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
const kindOf = (step: string) => step.split("/")[0]!;
const PULL_REQUEST = "https://github.com/me/alpha/pull/7";
const decided = (what: string) => ({ what, why: `${what} is reversible`, alternative: "ask" });

it.effect("a ready task is built, reviewed and merged by one run, then ends Done", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const reviewModel = { instanceId: "codex", model: "gpt-review" };
    const settings = yield* Ref.make(
      decodeSettings({
        factory: {
          projects: {
            alpha: {
              enabled: true,
              mergeMethod: "rebase",
              reviewers: [reviewModel],
              budgets: PATIENT,
            },
          },
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
          if (input.origin.step === "build/1") yield* Deferred.succeed(building, undefined);
          return { threadId: `thread-${input.origin.step}`, turnId: input.key };
        }),
      result: (turn) => {
        const step = kindOf(started.find((input) => input.key === turn.turnId)!.origin.step);
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
            headBranch: `factory/${FactoryTasks.displayKey(task)}`,
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
      ["build", "succeeded", "thread-build/1"],
      ["review", "succeeded", "thread-review/1"],
    ]);
    expect(
      entries.flatMap((entry) =>
        entry.type === "decision" ? [[entry.decision.what, entry.by]] : [],
      ),
    ).toEqual([
      ["Kept the API", { kind: "agent", threadId: "thread-build/1" }],
      ["Fixed a typo", { kind: "agent", threadId: "thread-review/1" }],
    ]);
    const review = started.find((input) => input.origin.step === "review/1")!;
    expect(review.thread).toBeUndefined();
    expect(review.model).toMatchObject(reviewModel);
    expect(merges).toEqual([
      {
        pullRequest: { project: "alpha", url: PULL_REQUEST },
        action: "merge",
        options: { mergeMethod: "rebase" },
      },
    ]);
    expect(settled.map((thread) => thread.threadId)).toEqual(["thread-build/1", "thread-review/1"]);
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
          branches.push(/^Branch: (.+)$/m.exec(input.prompt)?.[1]);
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
        yield* waitAsked(second.runId, 1);

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

it.effect("a pull request from another branch is neither reviewed nor merged", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
    const task = yield* tasks.create(
      { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
      PERSON,
    );
    const steps: Array<string> = [];
    const agents = WorkflowAgents.of({
      start: (input) =>
        Effect.sync(() => {
          steps.push(input.origin.step);
          return { threadId: `thread-${input.origin.step}`, turnId: input.key };
        }),
      result: () =>
        Effect.succeed({
          ending: "completed" as const,
          detail: "",
          reply: "",
          output: { outcome: "pull-request", url: PULL_REQUEST, decisions: [] },
        }),
      interrupt: () => Effect.succeed("ended" as const),
    });
    const merges: Array<unknown> = [];
    const forge = WorkflowForge.of({
      ...unavailable,
      pullRequests: {
        ...unavailable.pullRequests,
        read: () => Effect.succeed({ headBranch: "someone-else" } as never),
        act: (pullRequest) => Effect.sync(() => void merges.push(pullRequest)),
      },
    });

    yield* runFactory(
      depsOver(tasks, settings),
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        yield* startedBy(yield* tickAt(0));
        const [run] = (yield* workflows.list()).filter(
          (found) => found.workflow === "factory-task",
        );
        yield* waitAsked(run!.runId, 1);
      }),
      { agents, forge },
    );

    expect(steps).toEqual(["build/1"]);
    expect(merges).toEqual([]);
    expect((yield* tasks.get(task.id)).state).toBe("needs-you");
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("a timeline write that fails once is retried without repeating the attempt", () =>
  Effect.gen(function* () {
    const real = yield* FactoryTasks.FactoryTasks;
    let failedOnce = false;
    const tasks: FactoryTasks.FactoryTasks["Service"] = {
      ...real,
      record: (id, entry) => {
        if (entry.type !== "decision" || failedOnce) return real.record(id, entry);
        failedOnce = true;
        return Effect.fail(new Error("SQLITE_BUSY") as never);
      },
    };
    const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
    const task = yield* real.create(
      { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
      PERSON,
    );
    const agents = WorkflowAgents.of({
      start: (input) => Effect.succeed({ threadId: "thread-build", turnId: input.key }),
      result: () =>
        Effect.succeed({
          ending: "completed" as const,
          detail: "",
          reply: "",
          output: {
            outcome: "gave-up",
            why: "Stuck.",
            tryNext: "Again.",
            decisions: [decided("a")],
          },
        }),
      interrupt: () => Effect.succeed("ended" as const),
    });

    yield* runFactory(
      depsOver(tasks, settings),
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        yield* startedBy(yield* tickAt(0));
        const [run] = (yield* workflows.list()).filter(
          (found) => found.workflow === "factory-task",
        );
        yield* waitAsked(run!.runId, 1);
      }),
      { agents },
    );

    const { entries } = yield* real.timeline(task.id);
    expect(entries.filter((entry) => entry.type === "attempt")).toHaveLength(2);
    expect(entries.filter((entry) => entry.type === "decision")).toHaveLength(2);
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

const scripted = (
  script: (step: string) => Schema.Json | "unstartable" | "never",
  started: Array<Started> = [],
) =>
  WorkflowAgents.of({
    start: (input) =>
      Effect.suspend(() => {
        started.push(input);
        return script(input.origin.step) === "unstartable"
          ? Effect.fail(new WorkflowAgentError({ reason: "the machine is gone" }))
          : Effect.succeed({ threadId: `thread-${input.origin.step}`, turnId: input.key });
      }),
    result: (turn) => {
      const plan = script(started.findLast((input) => input.key === turn.turnId)!.origin.step);
      return plan === "never"
        ? Effect.never
        : Effect.succeed({ ending: "completed" as const, detail: "", reply: "", output: plan });
    },
    interrupt: () => Effect.succeed("stopped" as const),
  });

const attemptOf = (step: string) => Number(step.split("/")[1]);
const promptOf = (started: ReadonlyArray<Started>, step: string) =>
  started.find((input) => input.origin.step === step)!.prompt;
const taskRun = Effect.flatMap(Workflows.Workflows, (workflows) =>
  Effect.map(workflows.list(), (runs) => runs.find((run) => run.workflow === "factory-task")!),
);
const statesOf = (entries: ReadonlyArray<FactoryTasks.TaskEntry>) =>
  entries.flatMap((entry) => (entry.type === "state" ? [`${entry.from}>${entry.to}`] : []));
const GAVE_UP = { outcome: "gave-up", why: "Stuck.", tryNext: "Read the logs.", decisions: [] };

it.effect(
  "infra failures are free up to five in a row, give-ups and stalls spend the build's two, and each cap asks Leo",
  () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTasks.FactoryTasks;
      const settings = yield* Ref.make(
        decodeSettings({
          factory: {
            projects: { alpha: { enabled: true, budgets: { ...PATIENT, buildTimeoutMinutes: 1 } } },
          },
        }),
      );
      const task = yield* tasks.create(
        { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
        PERSON,
      );
      const started: Array<Started> = [];
      const agents = scripted((step) => {
        const nth = attemptOf(step);
        if (nth === 1) return GAVE_UP;
        if (nth === 7) return "never";
        return nth <= 13 ? "unstartable" : GAVE_UP;
      }, started);

      yield* runFactory(
        depsOver(tasks, settings),
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          yield* startedBy(yield* tickAt(0));
          const run = yield* taskRun;
          yield* waitAsked(run.runId, 1);
          yield* workflows.answer(run.runId, "needs-you/1", {
            choice: "retry",
            reason: "Use the other machine.",
          });
          yield* waitAsked(run.runId, 2);
          yield* workflows.answer(run.runId, "needs-you/2", { choice: "drop" });
          yield* workflows.waitFor(run.runId, (found) => found.status === "stopped");
        }),
        { agents },
      );

      const { entries } = yield* tasks.timeline(task.id);
      expect(entries.flatMap((entry) => (entry.type === "attempt" ? [entry.failure] : []))).toEqual(
        ["agent", ...Array(5).fill("infra"), "agent", ...Array(6).fill("infra")],
      );
      expect(statesOf(entries)).toEqual([
        "ready>building",
        "building>needs-you",
        "needs-you>building",
        "building>needs-you",
        "needs-you>dropped",
      ]);
      const reasons = entries.flatMap((entry) =>
        entry.type === "state" && entry.to === "needs-you" ? [entry.reason] : [],
      );
      expect(reasons[0]).toMatch(/^The build failed 2 times: .*not done after 1m/);
      expect(reasons[1]).toMatch(/^The build could not run 6 times in a row: /);
      expect(promptOf(started, "build/2")).toContain(
        "Last attempt: Stuck. Try next: Read the logs.",
      );
      expect(promptOf(started, "build/8")).toContain("Leo's answer: Use the other machine.");
      expect((yield* tasks.get(task.id)).state).toBe("dropped");
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("a Needs you outlives a restart, and Leo's comment on the task answers it", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
    const task = yield* tasks.create(
      { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
      PERSON,
    );
    const started: Array<Started> = [];
    const agents = scripted(
      (step) =>
        attemptOf(step) <= 2
          ? GAVE_UP
          : { outcome: "needs-you", question: "Which API?", decisions: [] },
      started,
    );
    const boot = yield* factoryEngine(depsOver(tasks, settings), { agents });

    const run = yield* boot(
      Effect.gen(function* () {
        yield* startedBy(yield* tickAt(0));
        const found = yield* taskRun;
        yield* waitAsked(found.runId, 1);
        return found;
      }),
    );
    yield* boot(
      Effect.gen(function* () {
        yield* waitAsked(run.runId, 1);
        yield* tasks.comment(task.id, "Keep the old API.", PERSON);
        yield* startedBy(yield* tickAt(1));
        yield* waitAsked(run.runId, 2);
      }),
    );

    expect(promptOf(started, "build/3")).toContain("Leo's answer: Keep the old API.");
    const { entries } = yield* tasks.timeline(task.id);
    expect(statesOf(entries)).toEqual([
      "ready>building",
      "building>needs-you",
      "needs-you>building",
      "building>needs-you",
    ]);
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "red checks, requested changes and main moving each spend a fix round, and a third asks Leo",
  () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTasks.FactoryTasks;
      const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
      const task = yield* tasks.create(
        { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
        PERSON,
      );
      let ci = "failure";
      let landed = false;
      const started: Array<Started> = [];
      const opened = { outcome: "pull-request", url: PULL_REQUEST, decisions: [] };
      const agents = scripted((step) => {
        if (step === "fix/1") ci = "success";
        if (step === "fix/2")
          return { outcome: "needs-you", question: "Which name?", decisions: [] };
        if (step === "review/1")
          return { outcome: "changes", requests: "Rename it.", decisions: [] };
        return kindOf(step) === "review" ? { outcome: "approve", decisions: [] } : opened;
      }, started);
      const forge = WorkflowForge.of({
        ...unavailable,
        pullRequests: {
          ...unavailable.pullRequests,
          read: () =>
            Effect.sync(
              () =>
                ({
                  state: landed ? "merged" : "open",
                  mergeability: "mergeable",
                  url: PULL_REQUEST,
                  headBranch: `factory/${FactoryTasks.displayKey(task)}`,
                  checks: [{ name: "test", status: ci, description: null, url: null }],
                }) as never,
            ),
          act: () =>
            Effect.suspend(() => {
              landed = true;
              return Effect.fail(new WorkflowForgeError({ reason: "the connection reset" }));
            }),
        },
      });
      const baseTouchedSinceFork = () =>
        Effect.sync(() => !started.some((input) => input.origin.step === "review/3"));

      yield* runFactory(
        depsOver(tasks, settings, [], baseTouchedSinceFork),
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          yield* startedBy(yield* tickAt(0));
          const run = yield* taskRun;
          yield* waitAsked(run.runId, 1);
          yield* workflows.answer(run.runId, "needs-you/1", {
            choice: "retry",
            reason: "Call it run.",
          });
          yield* waitAsked(run.runId, 2);
          yield* workflows.answer(run.runId, "needs-you/2", { choice: "retry" });
          yield* workflows.waitFor(run.runId, (found) => found.status === "completed");
        }),
        { agents, forge },
      );

      expect(started.map((input) => input.origin.step)).toEqual([
        "build/1",
        "fix/1",
        "review/1",
        "fix/2",
        "fix/3",
        "review/2",
        "review/3",
      ]);
      expect(promptOf(started, "fix/1")).toContain(`Fix: The checks on ${PULL_REQUEST} fail.`);
      expect(promptOf(started, "fix/2")).toContain("Fix: Rename it.");
      expect(promptOf(started, "fix/3")).toContain("Fix: Rename it.");
      expect(promptOf(started, "fix/3")).toContain("Leo's answer: Call it run.");
      expect(promptOf(started, "review/3")).toContain("Main changed: ");
      const { entries } = yield* tasks.timeline(task.id);
      expect(statesOf(entries)).toEqual([
        "ready>building",
        "building>reviewing",
        "reviewing>building",
        "building>reviewing",
        "reviewing>building",
        "building>needs-you",
        "needs-you>building",
        "building>reviewing",
        "reviewing>needs-you",
        "needs-you>reviewing",
        "reviewing>done",
      ]);
      expect(
        entries.findLast((entry) => entry.type === "state" && entry.to === "needs-you"),
      ).toMatchObject({ reason: expect.stringContaining("past 2 fix rounds") });
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("cancelling a task's run drops the task", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
    const task = yield* tasks.create(
      { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
      PERSON,
    );
    const building = yield* Deferred.make<void>();
    const agents = scripted(() => {
      Deferred.doneUnsafe(building, Effect.void);
      return "never";
    });

    yield* runFactory(
      depsOver(tasks, settings),
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        yield* startedBy(yield* tickAt(0));
        yield* Deferred.await(building);
        const run = yield* taskRun;
        yield* workflows.cancel(run.runId, "Not needed.");
        yield* workflows.waitFor(run.runId, (found) => found.status === "cancelled");
      }),
      { agents },
    );

    const { entries } = yield* tasks.timeline(task.id);
    expect(statesOf(entries)).toEqual(["ready>building", "building>dropped"]);
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("a tick starts a run for each ticket on a map's frontier, and for no other", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
    const scope = ProjectId.make("alpha");
    const map = yield* tasks.create(
      { scope, kind: "map", title: "Pick a store", body: "" },
      PERSON,
    );
    const ticket = (
      title: string,
      kind: "research" | "grilling",
      blockedBy?: ReadonlyArray<FactoryTasks.TaskId>,
    ) => tasks.create({ scope, kind, title, body: "", parent: map.id, blockedBy }, PERSON);
    const read = yield* ticket("Read the docs", "research");
    const talk = yield* ticket("Talk it through", "grilling");
    yield* ticket("Talk after the reading", "grilling", [read.id]);
    const claimed = yield* ticket("Already taken", "grilling");
    const resolved = yield* ticket("Already answered", "research");
    const elsewhere = { kind: "factory", runId: "an-earlier-run" } as const;
    yield* tasks.transition(claimed.id, "building", elsewhere);
    yield* tasks.transition(resolved.id, "building", elsewhere);
    yield* tasks.transition(resolved.id, "done", elsewhere);

    yield* runFactory(
      depsOver(tasks, settings),
      Effect.gen(function* () {
        expect(yield* startedBy(yield* tickAt(0))).toEqual([
          `start/${read.id}/0`,
          `start/${talk.id}/0`,
        ]);
      }),
      { agents: scripted(() => "never") },
    );
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("a research ticket runs unattended and ends Done with its resolution", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
    const task = yield* tasks.create(
      { scope: ProjectId.make("alpha"), kind: "research", title: "Which store?", body: "" },
      PERSON,
    );
    const started: Array<Started> = [];
    const settled: Array<AgentThread> = [];
    const agents = scripted(
      () => ({ outcome: "resolved", resolution: "SQLite fits.", decisions: [decided("Read v3")] }),
      started,
    );

    yield* runFactory(
      depsOver(tasks, settings, settled),
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        yield* startedBy(yield* tickAt(0));
        const run = yield* taskRun;
        yield* workflows.waitFor(run.runId, (found) => found.status === "completed");
      }),
      { agents },
    );

    expect(started.map((input) => input.origin.step)).toEqual(["research/1"]);
    expect(promptOf(started, "research/1")).toContain("Use the `wayfinder` skill");
    const { entries } = yield* tasks.timeline(task.id);
    expect(statesOf(entries)).toEqual(["ready>building", "building>done"]);
    expect(
      entries.flatMap((entry) => (entry.type === "comment" ? [[entry.body, entry.by]] : [])),
    ).toEqual([["SQLite fits.", { kind: "agent", threadId: "thread-research/1" }]]);
    expect(settled.map((thread) => thread.threadId)).toEqual(["thread-research/1"]);
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "a grilling ticket primes a thread, asks Leo there, and closes when the thread records its resolution",
  () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTasks.FactoryTasks;
      const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
      const task = yield* tasks.create(
        { scope: ProjectId.make("alpha"), kind: "grilling", title: "Which store?", body: "" },
        PERSON,
      );
      const settled: Array<AgentThread> = [];
      const agents = scripted(() => ({
        outcome: "session",
        opening: "What must the store survive?",
        decisions: [],
      }));

      yield* runFactory(
        depsOver(tasks, settings, settled),
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          yield* startedBy(yield* tickAt(0));
          const run = yield* taskRun;
          yield* waitAsked(run.runId, 1);
          const [question] = yield* workflows.questions;
          expect(question?.thread?.threadId).toBe("thread-session/1");
          expect(question?.request).toMatchObject({ choices: ["resolved", "drop"] });

          yield* tasks.comment(task.id, "SQLite, since it must survive restarts.", PERSON);
          yield* startedBy(yield* tickAt(1));
          yield* workflows.waitFor(run.runId, (found) => found.status === "completed");
        }),
        { agents },
      );

      const { entries } = yield* tasks.timeline(task.id);
      expect(statesOf(entries)).toEqual(["ready>building", "building>needs-you", "needs-you>done"]);
      expect(entries.filter((entry) => entry.type === "comment")).toHaveLength(1);
      expect(settled.map((thread) => thread.threadId)).toEqual(["thread-session/1"]);
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);
