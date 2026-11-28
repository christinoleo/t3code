import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  factoryProjectSettingsOf,
  IssueTrackerKind,
  ProjectId,
  ServerSettings,
  TASK_LABEL,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import type { Machine, MachineReport } from "./FactoryPlacement.ts";
import { enabledProjects } from "./FactorySettings.ts";
import * as FactoryTasks from "./FactoryTasks.ts";
import type { IntakeSource } from "./intake/IntakeSource.ts";
import type { MirrorIssues } from "./TrackerMirror.ts";

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

const report = (
  cpuUtilization: number,
  projects: ReadonlyArray<string>,
  providers: ReadonlyArray<{ readonly instanceId: string; readonly ready: boolean }> = [
    { instanceId: "codex", ready: true },
  ],
): MachineReport => ({
  resources: {
    sampledAt: 0,
    cpuUtilization,
    cpuCount: 8,
    availableMemoryBytes: 8_000_000_000,
    totalMemoryBytes: 16_000_000_000,
  },
  projects: projects.map((name) => ({
    projectId: name,
    repositoryKey: `github.com/me/${name.replace(/-there$/, "")}`,
  })),
  providers,
});

const reported = (
  now: () => ReadonlyArray<readonly [environment: string | undefined, report: MachineReport]>,
) =>
  Effect.flatMap(Clock.currentTimeMillis, (receivedAt) =>
    Effect.sync(() =>
      now().map(([environment, report]): Machine => ({ environment, report, receivedAt })),
    ),
  );

const depsOver = (
  tasks: FactoryTasks.FactoryTasks["Service"],
  settings: Ref.Ref<ServerSettings>,
  settled: Array<AgentThread> = [],
  baseTouchedSinceFork: FactoryDeps["baseTouchedSinceFork"] = () => Effect.succeed(false),
  issues: MirrorIssues = fakeTracker().issues,
  ensureBranch: FactoryDeps["ensureBranch"] = () => Effect.void,
  placement: Partial<Pick<FactoryDeps, "machines" | "stopOrphan">> = {},
): FactoryDeps => ({
  tasks,
  issues,
  machines: reported(() => [[undefined, report(0.1, ["alpha", "beta"])]]),
  stopOrphan: () => Effect.succeed(true),
  ...placement,
  enabledProjects: Effect.map(Ref.get(settings), enabledProjects),
  projectSettings: (project) =>
    Effect.map(Ref.get(settings), (all) => factoryProjectSettingsOf(all, project)),
  settle: (thread) => Effect.sync(() => void settled.push(thread)),
  baseTouchedSinceFork,
  ensureBranch,
  intake: [],
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
    yield* tasks.create(
      {
        scope: ProjectId.make("alpha"),
        title: "Hardening Leo has not approved",
        body: "",
        labels: [TASK_LABEL.approval],
      },
      PERSON,
    );

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

interface FakeIssue {
  readonly key: string;
  open: boolean;
  labels: Array<string>;
  updatedAt: string;
  readonly events: ReadonlyArray<{
    readonly kind: "labeled";
    readonly detail: string;
    readonly createdAt: string;
  }>;
  readonly comments: Array<{ readonly body: string; readonly createdAt: string }>;
  blockedBy: Array<string>;
  readonly refusesLabels?: boolean;
}

const REPO = { tracker: "github", host: "github.com", scope: "me/alpha" } as const;
const issueUrl = (key: string) => `https://github.com/me/alpha/issues/${key}`;

const fakeTracker = (issues: ReadonlyArray<FakeIssue> = []) => {
  const reads: Array<string> = [];
  const posted: Array<{ readonly key: string; readonly body: string }> = [];
  let seconds = 0;
  const later = () => `2026-11-28T12:00:${String(++seconds).padStart(2, "0")}.000Z`;
  const find = (key: string) => issues.find((issue) => issue.key === key)!;
  const target = (key: string) => ({
    scope: REPO.scope,
    key,
    displayKey: `#${key}`,
    title: `Issue ${key}`,
    url: issueUrl(key),
    state: { category: "open", name: "Open" },
  });
  const summary = (issue: FakeIssue) => ({
    ...REPO,
    key: issue.key,
    displayKey: `#${issue.key}`,
    title: `Issue ${issue.key}`,
    url: issueUrl(issue.key),
    updatedAt: issue.updatedAt,
  });
  const fake: MirrorIssues = {
    list: (input) =>
      Effect.sync(
        () =>
          ({
            entries: issues
              .filter(
                (issue) =>
                  (input.state === "all" || issue.open === (input.state === "open")) &&
                  (input.labels ?? []).every((label) => issue.labels.includes(label)),
              )
              .map(summary),
          }) as never,
      ),
    detail: (input) =>
      Effect.sync(() => {
        reads.push(input.key);
        const issue = find(input.key);
        return {
          ...summary(issue),
          body: `Body of ${issue.key}`,
          createdAt: "2026-11-28T08:00:00.000Z",
          state: issue.open
            ? { category: "open", name: "Open" }
            : { category: "closed", name: "Closed" },
          labels: issue.labels.map((name) => ({ name, color: null })),
          events: issue.events,
          comments: issue.comments.map((comment, index) => ({
            id: `${issue.key}-${index}`,
            author: null,
            url: `${issueUrl(issue.key)}#comment-${index}`,
            ...comment,
          })),
          writable: true,
          capabilities: { labels: true, comment: true, relations: true },
          relations: {
            parent: null,
            children: [],
            blockedBy: issue.blockedBy.map(target),
            blocking: [],
          },
        } as never;
      }),
    comment: (input) =>
      Effect.sync(() => {
        posted.push({ key: input.key, body: input.body });
        const issue = find(input.key);
        issue.updatedAt = later();
        issue.comments.push({ body: input.body, createdAt: issue.updatedAt });
      }),
    update: (input) =>
      Effect.suspend(() => {
        const issue = find(input.key);
        if (issue.refusesLabels === true) return Effect.fail("no triage access" as never);
        issue.updatedAt = later();
        if (input.labels !== undefined) issue.labels = [...input.labels];
        if (input.relations?.blockedBy !== undefined) {
          issue.blockedBy = input.relations.blockedBy.map((ref) => ref.key);
        }
        return Effect.void;
      }),
  };
  return { issues: fake, reads, posted, later };
};

const issue = (key: string, fields: Partial<FakeIssue> = {}): FakeIssue => ({
  key,
  open: true,
  labels: [],
  updatedAt: "2026-11-28T09:00:00.000Z",
  events: [],
  comments: [],
  blockedBy: [],
  ...fields,
});
const labelledAt = (createdAt: string) => ({
  labels: ["ready-for-agent"],
  updatedAt: createdAt,
  events: [{ kind: "labeled" as const, detail: "ready-for-agent", createdAt }],
});
const mirroring = (key: string) => ({
  ref: {
    projectId: ProjectId.make("alpha"),
    ...REPO,
    tracker: IssueTrackerKind.make("github"),
    key,
  },
  url: issueUrl(key),
});
const ON_AT_NINE = decodeSettings({
  factory: {
    projects: { alpha: { enabled: true, enabledAt: "2026-11-28T09:00:00.000Z", budgets: PATIENT } },
  },
});
const tick = (minute: number) =>
  Effect.flatMap(tickAt(minute), (run) =>
    Effect.flatMap(Workflows.Workflows, (workflows) =>
      workflows.waitFor(run.runId, (found) => found.status === "skipped"),
    ),
  );

it.effect("tracker intake files each issue labelled after the factory was turned on, once", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(ON_AT_NINE);
    const github = fakeTracker([
      issue("1", {
        ...labelledAt("2026-11-28T08:00:00.000Z"),
        updatedAt: "2026-11-28T09:30:00.000Z",
      }),
      issue("2", labelledAt("2026-11-28T09:10:00.000Z")),
      issue("3", labelledAt("2026-11-28T08:30:00.000Z")),
      issue("4", { updatedAt: "2026-11-28T09:40:00.000Z" }),
    ]);

    yield* runFactory(
      depsOver(tasks, settings, [], undefined, github.issues),
      Effect.andThen(tick(0), tick(1)),
      { agents: scripted(() => "never") },
    );

    const { items } = yield* tasks.list({ scope: "alpha", state: "all", limit: 10 });
    expect(items.map((task) => [task.title, task.body, task.external])).toEqual([
      ["Issue 2", "Body of 2", mirroring("2")],
    ]);
    expect(github.reads.filter((key) => key === "1")).toEqual(["1"]);
    expect(github.reads).not.toContain("3");
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "closing a mirrored issue drops its task and reopening revives it, while the issue follows the store",
  () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTasks.FactoryTasks;
      const settings = yield* Ref.make(ON_AT_NINE);
      const blocker = issue("5");
      const blocked = issue("6", { labels: ["bug", "factory/building"], blockedBy: ["99"] });
      const github = fakeTracker([blocker, blocked]);
      const talk = (key: string, blockedBy: ReadonlyArray<FactoryTasks.TaskId> = []) =>
        tasks.create(
          {
            scope: ProjectId.make("alpha"),
            kind: "map",
            title: `Talk ${key}`,
            body: "",
            blockedBy,
            external: mirroring(key),
          },
          PERSON,
        );
      const first = yield* talk("5");
      yield* talk("6", [first.id]);
      yield* tasks.record(first.id, {
        type: "decision",
        by: { kind: "agent", threadId: "thread-1" },
        decision: decided("Kept the API"),
      });

      yield* runFactory(
        depsOver(tasks, settings, [], undefined, github.issues),
        Effect.gen(function* () {
          yield* tick(0);
          expect(blocker.labels).toEqual(["factory/ready"]);
          expect(blocked.labels).toEqual(["bug", "factory/ready"]);
          expect(blocked.blockedBy).toEqual(["99", "5"]);

          blocker.open = false;
          blocker.updatedAt = github.later();
          yield* tick(1);
          expect((yield* tasks.get(first.id)).state).toBe("dropped");
          expect(blocker.labels).toEqual(["factory/dropped"]);

          blocker.open = true;
          blocker.updatedAt = github.later();
          yield* tick(2);
          expect(yield* tasks.get(first.id)).toMatchObject({ state: "ready", generation: 1 });

          yield* tasks.transition(first.id, "dropped", PERSON, "Not now.");
          yield* tick(3);
          expect((yield* tasks.get(first.id)).state).toBe("dropped");

          yield* tick(4);
          const readsBefore = github.reads.length;
          yield* tick(5);
          expect(github.reads.length).toBe(readsBefore);
        }),
      );

      expect(github.posted).toEqual([
        { key: "5", body: expect.stringContaining("**Decided:** Kept the API") },
        { key: "5", body: expect.stringContaining("**T3-1** is now Dropped.\n\nNot now.") },
        { key: "6", body: expect.stringContaining("Talk 5 (T3-1) was dropped") },
      ]);
      const { entries } = yield* tasks.timeline(first.id);
      expect(entries.filter((entry) => entry.type === "comment")).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("an issue comment answers Needs you, even on an issue that refuses labels", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(ON_AT_NINE);
    const mirrored = issue("7", { refusesLabels: true });
    const github = fakeTracker([mirrored]);
    yield* tasks.create(
      { scope: ProjectId.make("alpha"), title: "Ship it", body: "", external: mirroring("7") },
      PERSON,
    );
    const started: Array<Started> = [];
    const resumed = yield* Deferred.make<void>();
    const agents = scripted((step) => {
      if (step === "build/1")
        return { outcome: "needs-you", question: "Which API?", decisions: [] };
      Deferred.doneUnsafe(resumed, Effect.void);
      return "never";
    }, started);

    yield* runFactory(
      depsOver(tasks, settings, [], undefined, github.issues),
      Effect.gen(function* () {
        yield* tick(0);
        const run = yield* taskRun;
        yield* waitAsked(run.runId, 1);
        yield* tick(1);
        expect(github.posted.at(-1)?.body).toContain("Reply here to answer.");

        mirrored.updatedAt = github.later();
        mirrored.comments.push({ body: "Keep the old API.", createdAt: mirrored.updatedAt });
        yield* tick(2);
        yield* Deferred.await(resumed);
      }),
      { agents },
    );

    const { entries } = yield* tasks.timeline((yield* tasks.byKey("alpha", 1)).id);
    expect(statesOf(entries)).toEqual([
      "ready>building",
      "building>needs-you",
      "needs-you>building",
    ]);
    expect(promptOf(started, "build/2")).toContain("Leo's answer: Keep the old API.");
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "an integration epic lands its children on its branch, then merges itself and digests every decision",
  () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTasks.FactoryTasks;
      const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
      const alpha = ProjectId.make("alpha");
      const epic = yield* tasks.create(
        { scope: alpha, title: "Epic", body: "", labels: [TASK_LABEL.integration] },
        PERSON,
      );
      const children = [
        yield* tasks.create({ scope: alpha, title: "One", body: "", parent: epic.id }, PERSON),
        yield* tasks.create({ scope: alpha, title: "Two", body: "", parent: epic.id }, PERSON),
      ];
      const epicKey = FactoryTasks.displayKey(epic);
      const epicBranch = `epic/${epicKey}`;

      const started: Array<Started> = [];
      const keyOf = (input: Started) => /for (T3-\d+) /.exec(input.prompt)![1]!;
      const urlOf = (key: string) => `https://github.com/me/alpha/pull/${key.slice(3)}`;
      const agents = WorkflowAgents.of({
        start: (input) =>
          Effect.sync(() => {
            started.push(input);
            return { threadId: `thread-${started.length}`, turnId: input.key };
          }),
        result: (turn) => {
          const input = started.find((found) => found.key === turn.turnId)!;
          const key = keyOf(input);
          return Effect.succeed({
            ending: "completed" as const,
            detail: "",
            reply: "",
            output: input.prompt.includes("maestro-reviewer")
              ? { outcome: "approve", decisions: [decided(`${key} reviewed`)] }
              : { outcome: "pull-request", url: urlOf(key), decisions: [decided(`${key} built`)] },
          });
        },
        interrupt: () => Effect.succeed("ended" as const),
      });
      const merged: Array<string> = [];
      const forge = WorkflowForge.of({
        ...unavailable,
        pullRequests: {
          ...unavailable.pullRequests,
          read: (pullRequest) => {
            const url = "url" in pullRequest ? pullRequest.url : "";
            return Effect.succeed({
              state: merged.includes(url) ? "merged" : "open",
              mergeability: "mergeable",
              url,
              headBranch:
                url === urlOf(epicKey) ? epicBranch : `factory/T3-${url.split("/").pop()}`,
              checks: [{ name: "test", status: "success", description: null, url: null }],
            } as never);
          },
          act: (pullRequest) =>
            Effect.sync(() => void merged.push("url" in pullRequest ? pullRequest.url : "")),
        },
      });
      const branches: Array<string> = [];

      yield* runFactory(
        depsOver(tasks, settings, [], undefined, undefined, ({ branch, from }) =>
          Effect.sync(() => void branches.push(`${from}>${branch}`)),
        ),
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const taskRuns = Effect.map(workflows.list(), (runs) =>
            runs.filter((run) => run.workflow === "factory-task"),
          );
          expect(yield* startedBy(yield* tickAt(0))).toEqual(
            children.map((child) => `start/${child.id}/0`),
          );
          const childRuns = (yield* taskRuns).map((run) => run.runId);
          for (const runId of childRuns) {
            yield* workflows.waitFor(runId, (found) => found.status === "completed");
          }

          expect(yield* startedBy(yield* tickAt(1))).toEqual([`start/${epic.id}/0`]);
          const epicRunId = (yield* taskRuns).find((run) => !childRuns.includes(run.runId))!.runId;
          yield* workflows.waitFor(epicRunId, (run) => run.detail === "sleep retro-wait/1");
          const { items } = yield* tasks.list({ scope: alpha, state: "open", limit: 10 });
          const retro = items.find((found) => found.kind === "research")!;
          const retroRun = { kind: "factory", runId: "retro" } as const;
          yield* tasks.record(retro.id, {
            type: "decision",
            by: retroRun,
            decision: decided("Mode skill says to split by layer"),
          });
          yield* tasks.transition(retro.id, "building", retroRun);
          yield* tasks.transition(retro.id, "done", retroRun);
          yield* workflows.waitFor(
            epicRunId,
            (run) => run.status === "waiting" && run.detail === "seen",
          );
        }),
        { agents, forge },
      );

      for (const child of children) {
        const build = started.find((input) => keyOf(input) === FactoryTasks.displayKey(child))!;
        expect(build.prompt).toContain(`Base branch: ${epicBranch}`);
        expect(build.launch?.workspace).toMatchObject({ baseRef: epicBranch });
        expect((yield* tasks.get(child.id)).state).toBe("done");
      }
      expect(new Set(branches)).toEqual(new Set([`main>${epicBranch}`]));
      expect(merged.slice(0, 2).toSorted()).toEqual(
        children.map((child) => urlOf(FactoryTasks.displayKey(child))),
      );
      expect(merged.slice(2)).toEqual([urlOf(epicKey)]);

      const { entries } = yield* tasks.timeline(epic.id);
      expect(statesOf(entries)).toEqual(["ready>building", "building>reviewing", "reviewing>done"]);
      expect(entries.flatMap((entry) => (entry.type === "attempt" ? [entry.phase] : []))).toEqual([
        "build",
        "final-review",
      ]);
      const digest = entries.findLast((entry) => entry.type === "comment");
      for (const what of [
        `${epicKey} built`,
        `${epicKey} reviewed`,
        ...children.flatMap((child) => [
          `${FactoryTasks.displayKey(child)} built`,
          `${FactoryTasks.displayKey(child)} reviewed`,
        ]),
        "Mode skill says to split by layer",
      ]) {
        expect(digest?.type === "comment" ? digest.body : "").toContain(what);
      }
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("an epic branch that can't be created asks Leo before any agent starts", () =>
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
    const alpha = ProjectId.make("alpha");
    const epic = yield* tasks.create(
      { scope: alpha, title: "Epic", body: "", labels: [TASK_LABEL.integration] },
      PERSON,
    );
    const child = yield* tasks.create(
      { scope: alpha, title: "One", body: "", parent: epic.id },
      PERSON,
    );
    const started: Array<Started> = [];

    yield* runFactory(
      depsOver(tasks, settings, [], undefined, undefined, () =>
        Effect.fail(new Error("push rejected") as never),
      ),
      Effect.gen(function* () {
        yield* startedBy(yield* tickAt(0));
        yield* waitAsked((yield* taskRun).runId, 1);
      }),
      { agents: scripted(() => "never", started) },
    );

    expect(started).toEqual([]);
    expect((yield* tasks.get(child.id)).state).toBe("needs-you");
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "a task under a nested epic builds on that epic's branch, cut from the outer epic's",
  () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTasks.FactoryTasks;
      const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
      const alpha = ProjectId.make("alpha");
      const epic = (title: string, parent?: FactoryTasks.TaskId) =>
        tasks.create(
          { scope: alpha, title, body: "", labels: [TASK_LABEL.integration], parent },
          PERSON,
        );
      const outer = yield* epic("Outer");
      const inner = yield* epic("Inner", outer.id);
      yield* tasks.create({ scope: alpha, title: "Leaf", body: "", parent: inner.id }, PERSON);
      const [outerBranch, innerBranch] = [outer, inner].map(
        (found) => `epic/${FactoryTasks.displayKey(found)}`,
      );
      const branches: Array<string> = [];
      const started: Array<Started> = [];

      yield* runFactory(
        depsOver(tasks, settings, [], undefined, undefined, ({ branch, from }) =>
          Effect.sync(() => void branches.push(`${from}>${branch}`)),
        ),
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          yield* startedBy(yield* tickAt(0));
          yield* workflows.waitFor((yield* taskRun).runId, () => started.length === 1);
        }),
        { agents: scripted(() => "never", started) },
      );

      expect(branches).toEqual([`main>${outerBranch}`, `${outerBranch}>${innerBranch}`]);
      expect(started[0]?.prompt).toContain(`Base branch: ${innerBranch}`);
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

const placementTask = Effect.gen(function* () {
  const tasks = yield* FactoryTasks.FactoryTasks;
  const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
  const task = yield* tasks.create(
    { scope: ProjectId.make("alpha"), title: "Ship it", body: "" },
    PERSON,
  );
  return { tasks, settings, task };
});

it.effect("a worker goes to the least busy machine with the project and a ready provider", () =>
  Effect.gen(function* () {
    const { tasks, settings } = yield* placementTask;
    const started: Array<Started> = [];
    const agents = scripted(() => GAVE_UP, started);
    const machines = reported(() => [
      [undefined, report(0.9, ["alpha"])],
      ["env-bare", report(0, ["other-there"])],
      ["env-logged-out", report(0, ["alpha-there"], [{ instanceId: "codex", ready: false }])],
      ["env-worker", report(0.5, ["alpha-there"])],
    ]);

    yield* runFactory(
      depsOver(tasks, settings, [], undefined, undefined, undefined, { machines }),
      Effect.gen(function* () {
        yield* startedBy(yield* tickAt(0));
        yield* waitAsked((yield* taskRun).runId, 1);
      }),
      { agents },
    );

    expect(started.map((input) => [input.environment, input.project])).toEqual([
      ["env-worker", "alpha-there"],
      ["env-worker", "alpha-there"],
    ]);
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("a burst of workers spreads across machines as each start shows in the load", () =>
  Effect.gen(function* () {
    const { tasks, settings } = yield* placementTask;
    yield* tasks.create({ scope: ProjectId.make("alpha"), title: "And this", body: "" }, PERSON);
    const started: Array<Started> = [];
    const both = yield* Deferred.make<void>();
    const agents = WorkflowAgents.of({
      start: (input) =>
        Effect.gen(function* () {
          started.push(input);
          if (started.length === 2) yield* Deferred.succeed(both, undefined);
          return { threadId: `thread-${started.length}`, turnId: input.key };
        }),
      result: () => Effect.never,
      interrupt: () => Effect.succeed("ended" as const),
    });
    const busy = (environment: string | undefined) =>
      0.1 + 0.4 * started.filter((input) => input.environment === environment).length;
    const machines = reported(() => [
      [undefined, report(busy(undefined), ["alpha"])],
      ["env-worker", report(busy("env-worker"), ["alpha-there"])],
    ]);

    yield* runFactory(
      depsOver(tasks, settings, [], undefined, undefined, undefined, { machines }),
      Effect.gen(function* () {
        yield* startedBy(yield* tickAt(0));
        yield* Deferred.await(both);
      }),
      { agents },
    );

    expect(new Set(started.map((input) => input.environment))).toEqual(
      new Set([undefined, "env-worker"]),
    );
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "a worker whose machine is lost is retried elsewhere for free, and stopped there once it answers",
  () =>
    Effect.gen(function* () {
      const { tasks, settings, task } = yield* placementTask;
      const started: Array<Started> = [];
      const retried = yield* Deferred.make<void>();
      const agents = WorkflowAgents.of({
        start: (input) =>
          Effect.gen(function* () {
            started.push(input);
            if (input.environment === undefined) yield* Deferred.succeed(retried, undefined);
            return {
              threadId: `thread-${started.length}`,
              turnId: input.key,
              ...(input.environment === undefined ? {} : { environment: input.environment }),
            };
          }),
        result: (turn) =>
          started.find((input) => input.key === turn.turnId)!.environment === undefined
            ? Effect.never
            : Effect.succeed({ ending: "failed" as const, detail: "connection lost", reply: "" }),
        interrupt: (thread) =>
          thread.environment === undefined
            ? Effect.succeed("stopped" as const)
            : Effect.fail(new WorkflowAgentError({ reason: "unreachable" })),
      });
      const machines = reported(() => [
        [undefined, report(0.5, ["alpha"])],
        ["env-worker", report(0.1, ["alpha-there"])],
      ]);
      const stops: Array<AgentThread> = [];
      const stopOrphan = (thread: AgentThread) => Effect.sync(() => stops.push(thread) > 1);

      yield* runFactory(
        depsOver(tasks, settings, [], undefined, undefined, undefined, { machines, stopOrphan }),
        Effect.gen(function* () {
          yield* startedBy(yield* tickAt(0));
          yield* Deferred.await(retried);
          for (const minute of [1, 2, 3]) yield* startedBy(yield* tickAt(minute));
        }),
        { agents },
      );

      expect(started.map((input) => input.environment)).toEqual(["env-worker", undefined]);
      const { entries } = yield* tasks.timeline(task.id);
      expect(entries.flatMap((entry) => (entry.type === "attempt" ? [entry.failure] : []))).toEqual(
        ["infra"],
      );
      expect(stops).toEqual([
        { threadId: "thread-1", environment: "env-worker" },
        { threadId: "thread-1", environment: "env-worker" },
      ]);
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("a task no machine can run asks Leo instead of waiting", () =>
  Effect.gen(function* () {
    const { tasks, settings, task } = yield* placementTask;
    const machines = reported(() => [
      [undefined, report(0.1, ["alpha"], [{ instanceId: "codex", ready: false }])],
    ]);

    yield* runFactory(
      depsOver(tasks, settings, [], undefined, undefined, undefined, { machines }),
      Effect.gen(function* () {
        yield* startedBy(yield* tickAt(0));
        yield* waitAsked((yield* taskRun).runId, 1);
      }),
    );

    const { entries } = yield* tasks.timeline(task.id);
    expect(
      entries.flatMap((entry) =>
        entry.type === "state" && entry.to === "needs-you" ? [entry.reason] : [],
      ),
    ).toEqual(["No machine has this project with a provider ready."]);
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect("a provider not yet checked after a restart is waited for, not asked about", () =>
  Effect.gen(function* () {
    const { tasks, settings, task } = yield* placementTask;
    const started: Array<Started> = [];
    const agents = scripted(() => GAVE_UP, started);
    let looks = 0;
    const machines = Effect.suspend(() =>
      reported(() => [
        [undefined, report(0.1, ["alpha"], [{ instanceId: "codex", ready: looks++ > 0 }])],
      ]),
    );

    yield* runFactory(
      depsOver(tasks, settings, [], undefined, undefined, undefined, { machines }),
      Effect.gen(function* () {
        yield* startedBy(yield* tickAt(0));
        yield* waitAsked((yield* taskRun).runId, 1);
      }),
      { agents },
    );

    expect(started.length).toBeGreaterThan(0);
    const { entries } = yield* tasks.timeline(task.id);
    expect(
      entries.flatMap((entry) =>
        entry.type === "state" && entry.to === "needs-you" ? [entry.reason] : [],
      ),
    ).not.toContain("No machine has this project with a provider ready.");
  }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

const repeatingSource = (
  id: IntakeSource["id"],
  trusted: boolean,
  reports: ReadonlyArray<string>,
  cursors: Array<string | null>,
): IntakeSource => ({
  id,
  trusted,
  enabled: (intake) => (id === "t3-feedback" ? intake.t3Feedback : intake.externalIssues),
  poll: ({ cursor }) =>
    Effect.sync(() => {
      cursors.push(Option.getOrNull(cursor));
      return {
        reports: reports.map((title) => ({
          dedupeKey: title,
          title,
          body: `${title} happened.`,
          links: [{ label: "Report", url: `https://example.test/${title}` }],
        })),
        cursor: `after ${reports.at(-1)}`,
      };
    }),
});

it.effect(
  "a source files one triage task per report while its toggle is on, an untrusted one's marked so",
  () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTasks.FactoryTasks;
      const intakeOf = (externalIssues: boolean) =>
        decodeSettings({
          factory: {
            projects: {
              alpha: {
                enabled: true,
                budgets: PATIENT,
                intake: { t3Feedback: true, externalIssues },
              },
            },
          },
        });
      const settings = yield* Ref.make(intakeOf(false));
      const feedbackCursors: Array<string | null> = [];
      const issueCursors: Array<string | null> = [];
      const deps = {
        ...depsOver(tasks, settings),
        intake: [
          repeatingSource("t3-feedback", true, ["Tool crashed", "Wrong title"], feedbackCursors),
          repeatingSource("external-issues", false, ["Stranger's bug"], issueCursors),
        ],
      };
      const filed = Effect.map(
        tasks.list({ scope: "alpha", state: "all", limit: 100 }),
        ({ items }) =>
          items
            .map((task) => [task.title, task.kind, task.labels.toSorted()])
            .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      );

      yield* runFactory(
        deps,
        Effect.gen(function* () {
          yield* startedBy(yield* tickAt(0));
          yield* startedBy(yield* tickAt(1));
          expect(issueCursors).toEqual([]);
          expect(yield* filed).toEqual([
            ["Tool crashed", "research", ["triage"]],
            ["Wrong title", "research", ["triage"]],
          ]);

          yield* Ref.set(settings, intakeOf(true));
          yield* startedBy(yield* tickAt(2));
        }),
        { agents: scripted(() => "never") },
      );

      expect(feedbackCursors).toEqual([null, "after Wrong title", "after Wrong title"]);
      expect(yield* filed).toEqual([
        ["Stranger's bug", "research", ["triage", "untrusted"]],
        ["Tool crashed", "research", ["triage"]],
        ["Wrong title", "research", ["triage"]],
      ]);
      const [stranger] = (yield* tasks.list({
        scope: "alpha",
        state: "all",
        limit: 100,
      })).items.filter((task) => task.title === "Stranger's bug");
      expect(stranger!.body).toContain("- [Report](https://example.test/Stranger's bug)");
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "a trusted triage files its build at once; an untrusted one triages read-only and waits for the approve tap",
  () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTasks.FactoryTasks;
      const settings = yield* Ref.make(settingsWith({ alpha: { enabled: true } }));
      const triageOf = (title: string, labels: ReadonlyArray<string>) =>
        tasks.create(
          { scope: ProjectId.make("alpha"), kind: "research", title, body: "", labels },
          PERSON,
        );
      const trusted = yield* triageOf("Feedback", ["triage"]);
      const untrusted = yield* triageOf("Stranger", ["triage", "untrusted"]);
      const started: Array<Started> = [];
      const agents = scripted(
        () => ({ outcome: "file", title: "Fix the crash", body: "Repro: run it.", decisions: [] }),
        started,
      );
      const builds = Effect.map(
        tasks.list({ scope: "alpha", state: "all", limit: 100 }),
        ({ items }) => items.filter((task) => task.kind === "build"),
      );

      yield* runFactory(
        depsOver(tasks, settings),
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          yield* startedBy(yield* tickAt(0));
          const runs = (yield* workflows.list()).filter((run) => run.workflow === "factory-task");
          const settled = yield* Effect.forEach(runs, (run) =>
            workflows.waitFor(
              run.runId,
              (found) =>
                found.status === "completed" ||
                (found.status === "waiting" && found.detail === "approve"),
            ),
          );
          const waiting = settled.find((run) => run.status === "waiting")!;
          expect(settled.map((run) => run.status).toSorted()).toEqual(["completed", "waiting"]);
          expect((yield* tasks.get(untrusted.id)).state).toBe("needs-you");
          expect((yield* builds).length).toBe(1);

          yield* tasks.comment(untrusted.id, "Looks fine, build it.", PERSON);
          yield* startedBy(yield* tickAt(1));
          expect((yield* workflows.get(waiting.runId)).run.detail).toBe("approve");

          yield* workflows.answer(waiting.runId, "approve", { choice: "build" });
          yield* workflows.waitFor(waiting.runId, (found) => found.status === "completed");
        }),
        { agents },
      );

      const filed = yield* builds;
      expect(filed.map((task) => task.title)).toEqual(["Fix the crash", "Fix the crash"]);
      expect(filed.every((task) => task.body.startsWith("Repro: run it."))).toBe(true);
      expect((yield* tasks.get(trusted.id)).state).toBe("done");
      expect((yield* tasks.get(untrusted.id)).state).toBe("done");
      const launched = started
        .filter((input) => input.origin.step.startsWith("triage/"))
        .map((input) => [
          input.prompt.includes("Use the `triage-issues` skill"),
          input.launch?.interactionMode,
        ]);
      expect(launched).toHaveLength(2);
      expect(launched).toContainEqual([true, "plan"]);
      expect(launched).toContainEqual([true, undefined]);
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)), Effect.scoped),
);
