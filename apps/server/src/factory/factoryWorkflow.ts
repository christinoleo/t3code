import {
  type Decision,
  FactoryProjectSettings,
  ProjectId,
  type ServerSettingsError,
  TASK_LABEL,
  TaskKind,
  type TaskState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import type { ProjectOperationError } from "../project/ProjectService.ts";
import { pullRequests } from "../workflows/forgeApi.ts";
import { signal, start, store } from "../workflows/stepServices.ts";
import { every, Tick } from "../workflows/triggers.ts";
import { skip, sleep, step, stop, within, workflow } from "../workflows/workflow.ts";
import {
  agent,
  type AgentFailure,
  type AskChoice,
  type AgentOptions,
  type AgentThread,
  ask,
} from "../workflows/workflowAgent.ts";
import { choosePlacement, HERE, type Machine, Placed, type Placement } from "./FactoryPlacement.ts";
import type { FactoryProject } from "./FactorySettings.ts";
import {
  displayKey,
  type FactoryTasks,
  type Phase,
  type Task,
  type TaskEntry,
  TaskId,
} from "./FactoryTasks.ts";
import { ReviewReport, TicketReport, WorkerReport } from "./reports.ts";
import { type Actor, isOpen } from "./taskModel.ts";
import * as TrackerMirror from "./TrackerMirror.ts";

/** One task's lifecycle; a revived task's next generation is a new run. */
const TaskRun = Schema.Struct({ task: TaskId, generation: Schema.Int });

/** What the definition's body reaches by closure, so its runs need nothing beyond `InRun`. */
export interface FactoryDeps {
  readonly tasks: FactoryTasks["Service"];
  readonly issues: TrackerMirror.MirrorIssues;
  readonly enabledProjects: Effect.Effect<ReadonlyArray<FactoryProject>, ServerSettingsError>;
  readonly projectSettings: (
    project: ProjectId,
  ) => Effect.Effect<FactoryProjectSettings, ServerSettingsError>;
  /** This machine's report and every reachable linked machine's, read now. */
  readonly machines: Effect.Effect<ReadonlyArray<Machine>, ProjectOperationError>;
  /** True once a linked worker the engine could not stop is stopped or gone. */
  readonly stopOrphan: (thread: AgentThread) => Effect.Effect<boolean>;
  /** Never fails: a thread left open is no reason to hold back a task that is done. */
  readonly settle: (thread: AgentThread) => Effect.Effect<void>;
  readonly baseTouchedSinceFork: (pullRequest: {
    readonly checkout: string;
    readonly base: string;
    readonly head: string;
  }) => Effect.Effect<boolean, Error>;
  /** Creates `branch` on the project's origin from `from`, unless it is there already. */
  readonly ensureBranch: (branch: {
    readonly project: string;
    readonly branch: string;
    readonly from: string;
  }) => Effect.Effect<void, Error>;
}

const Projects = Schema.Array(
  Schema.Struct({ id: ProjectId, scope: Schema.String, settings: FactoryProjectSettings }),
);
const Ready = Schema.Array(TaskRun);

const Brief = Schema.Struct({
  key: Schema.String,
  kind: TaskKind,
  scope: Schema.String,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  integration: Schema.Boolean,
  /** The branches of the open integration epics above it, outermost first. */
  epics: Schema.Array(Schema.String),
});
type Brief = typeof Brief.Type;

type Facts = Readonly<Record<string, string>>;

const MAIN = "main";
const epicBranch = (key: string) => `epic/${key}`;
const RETRO_CHECK = Duration.minutes(10);

/** Instructions live in the skill's markdown; a brief carries only the task's facts. */
const briefFor = (skill: string, task: Brief, settings: FactoryProjectSettings, facts: Facts) =>
  [
    `Use the \`${skill}\` skill for ${task.key} (${task.url}), run by the factory.`,
    Object.entries(facts)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
    `# ${task.title}\n\n${task.body}`,
    settings.instructions,
  ]
    .filter((part) => part.trim() !== "")
    .join("\n\n");

const FREE_RETRY_CAUSES: ReadonlySet<AgentFailure> = new Set(["unstarted", "died", "stopped"]);

type Judged = {
  readonly _tag: "done" | "opened-session" | "gave-up" | "needs-you";
  readonly detail: string;
};

const judgeWork = (report: WorkerReport): Judged =>
  report.outcome === "pull-request"
    ? { _tag: "done", detail: report.url }
    : report.outcome === "needs-you"
      ? { _tag: "needs-you", detail: report.question }
      : { _tag: "gave-up", detail: `${report.why} Try next: ${report.tryNext}` };

const judgeReview = (report: ReviewReport): Judged =>
  report.outcome === "approve"
    ? { _tag: "done", detail: "approved" }
    : report.outcome === "changes"
      ? { _tag: "done", detail: report.requests }
      : report.outcome === "needs-you"
        ? { _tag: "needs-you", detail: report.question }
        : { _tag: "gave-up", detail: report.why };

const judgeTicket = (report: TicketReport): Judged =>
  report.outcome === "resolved"
    ? { _tag: "done", detail: report.resolution }
    : report.outcome === "session"
      ? { _tag: "opened-session", detail: report.opening }
      : { _tag: "gave-up", detail: `${report.why} Try next: ${report.tryNext}` };

const needsYouWait = (nth: number) => `needs-you/${nth}`;

const DROP: AskChoice = { value: "drop", description: "Drop the task." };
const RETRY: ReadonlyArray<AskChoice> = [
  { value: "retry", description: "Go on; your reason goes to the next agent." },
  DROP,
];
const SESSION: ReadonlyArray<AskChoice> = [
  {
    value: "resolved",
    requireReason: true,
    description: "Close the ticket; your reason is its resolution.",
  },
  DROP,
];

const LOAD_SHOWS_A_START_MS = 30_000;
const lastStart = store.entry("factory/placement/last-start", Schema.Number);
const OrphanThread = Schema.Struct({ threadId: Schema.String, environment: Schema.String });
const ORPHANS = "factory/orphan/";
const orphan = (thread: typeof OrphanThread.Type) =>
  store.entry(`${ORPHANS}${thread.environment}/${thread.threadId}`, OrphanThread);

const taskWorkflow = (deps: FactoryDeps) =>
  workflow(
    "factory-task",
    {
      version: 1,
      payload: TaskRun,
      asks: { "needs-you": "Needs you", digest: "Epic digest" },
      onEnd: (payload, end) =>
        end.outcome !== "cancelled"
          ? Effect.void
          : Effect.flatMap(deps.tasks.get(payload.task), (found) =>
              found.generation === payload.generation && isOpen(found.state)
                ? deps.tasks.transition(
                    payload.task,
                    "dropped",
                    { kind: "factory", runId: end.id },
                    end.reason ?? "Its run was cancelled.",
                  )
                : Effect.void,
            ),
    },
    Effect.fn("factory.task")(function* (payload, run) {
      const by = { kind: "factory", runId: run.id } as const;
      const id = payload.task;
      const task = yield* step(
        "task",
        { returns: Brief },
        Effect.gen(function* () {
          const found = yield* deps.tasks.get(id);
          const epics: Array<string> = [];
          for (let above = found.parent; above !== null;) {
            const parent = yield* deps.tasks.get(above);
            if (!isOpen(parent.state) || !parent.labels.includes(TASK_LABEL.integration)) break;
            epics.unshift(epicBranch(displayKey(parent)));
            above = parent.parent;
          }
          return {
            key: displayKey(found),
            kind: found.kind,
            scope: found.scope,
            title: found.title,
            body: found.body,
            url: found.url,
            integration: found.labels.includes(TASK_LABEL.integration),
            epics,
          };
        }),
      );
      const settings = yield* step(
        "settings",
        { returns: FactoryProjectSettings },
        deps.projectSettings(ProjectId.make(task.scope)),
      );
      const budgets = settings.budgets;

      // A task dropped or revived since this run started is no longer this run's to move or merge.
      const ours = (found: Task) =>
        found.generation === payload.generation && found.state !== "dropped";
      const superseded = () => skip(`${task.key} was dropped or revived since this run started.`);
      let moves = 0;
      let state: TaskState = "ready";
      const move = (to: TaskState, reason?: string) =>
        Effect.flatMap(
          step(
            `move/${++moves}/${to}`,
            { returns: Schema.Boolean },
            Effect.flatMap(deps.tasks.get(id), (found) =>
              ours(found)
                ? Effect.as(deps.tasks.transition(id, to, by, reason), true)
                : Effect.succeed(false),
            ),
          ),
          (moved) => (moved ? Effect.sync(() => void (state = to)) : superseded()),
        );
      const enter = (to: TaskState) => (state === to ? Effect.void : move(to));
      // One step per entry, so a retried write does not repeat the ones before it.
      const write = (name: string, entry: Parameters<FactoryTasks["Service"]["record"]>[1]) =>
        step(
          name,
          { returns: Schema.Void },
          Effect.gen(function* () {
            if (ours(yield* deps.tasks.get(id))) yield* deps.tasks.record(id, entry);
          }),
        );
      const record = Effect.fnUntraced(function* (
        name: string,
        phase: Phase,
        thread: AgentThread | undefined,
        outcome: "succeeded" | "failed" | "needs-you",
        failure: "infra" | "agent" | null,
        detail: string,
        decisions: ReadonlyArray<Decision>,
      ) {
        yield* write(`${name}/record`, {
          type: "attempt",
          by,
          phase,
          thread:
            thread === undefined
              ? null
              : { threadId: thread.threadId, environmentId: thread.environment ?? null },
          outcome,
          failure,
          detail,
        });
        const decider =
          thread === undefined ? by : { kind: "agent" as const, threadId: thread.threadId };
        for (const [index, decision] of decisions.entries()) {
          yield* write(`${name}/decision/${index}`, { type: "decision", by: decider, decision });
        }
      });

      let asked = 0;
      const raise = Effect.fnUntraced(function* (
        reason: string,
        choices: ReadonlyArray<AskChoice>,
        pullRequest?: string,
      ) {
        yield* move("needs-you", reason);
        const answer = yield* ask(needsYouWait(++asked), {
          title: `${task.key} needs you: ${reason}`,
          kind: "needs-you",
          choices,
          links: [
            { label: task.key, url: task.url },
            ...(pullRequest === undefined || pullRequest === ""
              ? []
              : [{ label: "Pull request", url: pullRequest }]),
          ],
        });
        const given = Option.getOrUndefined(answer);
        if (given?.choice === "drop") {
          yield* move("dropped", given.reason ?? "Dropped from its Needs-you question.");
          return yield* stop(`${task.key} was dropped.`);
        }
        return given;
      });
      const needsYou = Effect.fnUntraced(function* (reason: string, pullRequest?: string) {
        const said = (yield* raise(reason, RETRY, pullRequest))?.reason?.trim() ?? "";
        return said === "" ? {} : { "Leo's answer": said };
      });

      let placements = 0;
      const place = Effect.fnUntraced(function* (
        provider: string | null,
        exclude: ReadonlyArray<string>,
      ) {
        // A provider reads as not ready until its first check after a restart, here or on a
        // peer, so `none` gets a second look a minute later before it asks.
        let unplaced = false;
        while (true) {
          const nth = ++placements;
          const placed = yield* within(
            "factory-placement",
            { limit: 1 },
            Effect.gen(function* () {
              const gap = yield* step(
                `place/${nth}/gap`,
                { returns: Schema.Number },
                Effect.gen(function* () {
                  const last = yield* lastStart.get;
                  const now = yield* Clock.currentTimeMillis;
                  return Option.match(last, {
                    onNone: () => 0,
                    onSome: (at) => Math.max(0, at + LOAD_SHOWS_A_START_MS - now),
                  });
                }),
              );
              if (gap > 0) yield* sleep(`place/${nth}/after-last-start`, Duration.millis(gap));
              return yield* step(
                `place/${nth}`,
                { returns: Placed },
                Effect.gen(function* () {
                  const machines = yield* Effect.option(deps.machines);
                  const now = yield* Clock.currentTimeMillis;
                  if (Option.isNone(machines)) return { _tag: "full" } as const;
                  const chosen = choosePlacement(
                    machines.value,
                    { project: task.scope, provider, exclude },
                    now,
                  );
                  if (chosen._tag === "placed") yield* lastStart.set(now);
                  return chosen;
                }),
              );
            }),
          );
          if (placed._tag === "placed" || (placed._tag === "none" && unplaced)) return placed;
          unplaced = placed._tag === "none";
          yield* sleep(`place/${nth}/${placed._tag}`, "1 minute");
        }
      });

      const attempts: Partial<Record<Phase, number>> = {};
      const threads: Array<AgentThread> = [];
      const phase = Effect.fn("factory.phase")(function* <A>(
        kind: "build" | "fix" | "review" | "final-review" | "research" | "session",
        budget: number,
        judge: (report: A) => Judged,
        decisionsOf: (report: A) => ReadonlyArray<Decision>,
        provider: string | null,
        launch: (facts: Facts, at: Placement) => AgentOptions<A, unknown>,
        given: Facts,
        pullRequest?: string,
      ) {
        let agentFailures = 0;
        let infraStreak = 0;
        let facts = given;
        let exclude: ReadonlyArray<string> = [];
        while (true) {
          yield* enter(kind === "review" || kind === "final-review" ? "reviewing" : "building");
          const placed = yield* place(provider, exclude);
          if (placed._tag === "none") {
            facts = { ...given, ...(yield* needsYou(placed.why, pullRequest)) };
            continue;
          }
          const at = placed.placement;
          const nth = (attempts[kind] ?? 0) + 1;
          attempts[kind] = nth;
          const name = `${kind}/${nth}`;
          const tried = yield* agent.try(name, launch(facts, at));
          if (tried.thread !== undefined) threads.push(tried.thread);
          let detail: string;
          let infra = false;
          exclude = [];
          if (tried.outcome === "failed") {
            infra = FREE_RETRY_CAUSES.has(tried.cause);
            detail = tried.reason;
            if (infra) exclude = [at.environment ?? HERE];
            const lost = tried.thread;
            if (tried.cause === "died" && lost?.environment !== undefined) {
              const stray = { threadId: lost.threadId, environment: lost.environment };
              yield* step(`${name}/orphan`, { returns: Schema.Void }, orphan(stray).set(stray));
            }
            yield* record(
              name,
              kind,
              tried.thread,
              "failed",
              infra ? "infra" : "agent",
              detail,
              [],
            );
          } else {
            const judged = judge(tried.value);
            detail = judged.detail;
            yield* record(
              name,
              kind,
              tried.thread,
              judged._tag === "done"
                ? "succeeded"
                : judged._tag === "gave-up"
                  ? "failed"
                  : "needs-you",
              judged._tag === "gave-up" ? "agent" : null,
              detail,
              decisionsOf(tried.value),
            );
            if (judged._tag === "done" || judged._tag === "opened-session") {
              return { report: tried.value, thread: tried.thread };
            }
            if (judged._tag === "needs-you") {
              facts = { ...given, ...(yield* needsYou(detail, pullRequest)) };
              agentFailures = 0;
              infraStreak = 0;
              continue;
            }
          }
          if (infra) infraStreak++;
          else {
            infraStreak = 0;
            agentFailures++;
          }
          if (infra ? infraStreak <= budgets.infraRetries : agentFailures < budget) {
            facts = { ...given, "Last attempt": detail };
            continue;
          }
          facts = {
            ...given,
            ...(yield* needsYou(
              infra
                ? `The ${kind} could not run ${infraStreak} times in a row: ${detail}`
                : `The ${kind} failed ${agentFailures} times: ${detail}`,
              pullRequest,
            )),
          };
          agentFailures = 0;
          infraStreak = 0;
        }
      });

      const model = settings.builder === null ? {} : { model: settings.builder };
      const base = task.epics.at(-1) ?? MAIN;
      // The worker pushes here from a worktree of its own: a launch refuses a branch that exists,
      // which a retried round's would. An earlier generation's branch outlives it.
      const branch = task.integration
        ? epicBranch(task.key)
        : `factory/${task.key}${payload.generation === 0 ? "" : `-g${payload.generation}`}`;
      const branchFacts = {
        "Base branch": base,
        Branch: branch,
        ...(task.integration ? { "Integration epic": branch } : {}),
      };
      let branchTries = 0;
      const ensureBranches = Effect.fnUntraced(function* () {
        const chain = [MAIN, ...task.epics, ...(task.integration ? [branch] : [])];
        for (const [index, from] of chain.slice(0, -1).entries()) {
          const made = chain[index + 1]!;
          while (true) {
            const tried = yield* step.try(
              `branch/${++branchTries}`,
              { returns: Schema.Void },
              deps.ensureBranch({ project: task.scope, branch: made, from }),
            );
            if (tried.outcome === "done") break;
            yield* needsYou(`${made} could not be created from ${from}: ${tried.reason}`);
          }
        }
      });
      const where = (at: Placement) =>
        at.environment === undefined
          ? { project: at.project, issue: { project: task.scope, url: task.url } }
          : { project: at.project, environment: at.environment };
      const work = (kind: "build" | "fix", given: Facts, pullRequest?: string) =>
        Effect.map(
          phase(
            kind,
            budgets.build,
            judgeWork,
            (report: WorkerReport) => report.decisions,
            settings.builder?.instanceId ?? null,
            (facts, at) => ({
              brief: briefFor("maestro-worker", task, settings, {
                ...branchFacts,
                ...(pullRequest === undefined ? {} : { "Pull request": pullRequest }),
                ...facts,
              }),
              title: `${kind === "build" ? "Build" : "Fix"} ${task.key}: ${task.title}`,
              returns: WorkerReport,
              ...model,
              ...where(at),
              workspace: {
                type: "worktree",
                baseRef: task.integration ? branch : base,
                startFromOrigin: true,
              },
              timeout: Duration.minutes(budgets.buildTimeoutMinutes),
            }),
            given,
            pullRequest,
          ),
          (done) => done.report,
        );

      const build = Effect.fnUntraced(function* () {
        yield* ensureBranches();
        const reviewer = yield* step(
          "reviewer",
          { returns: Schema.NullOr(Schema.Int) },
          settings.reviewers.length === 0
            ? Effect.succeed(null)
            : Random.nextIntBetween(0, settings.reviewers.length, { halfOpen: true }),
        );
        const reviewModel = reviewer === null ? undefined : settings.reviewers[reviewer];
        const review = (pullRequest: string, given: Facts) =>
          Effect.map(
            phase(
              task.integration ? "final-review" : "review",
              budgets.review,
              judgeReview,
              (report: ReviewReport) => report.decisions,
              reviewModel?.instanceId ?? null,
              (facts, at) => ({
                brief: briefFor("maestro-reviewer", task, settings, {
                  ...branchFacts,
                  "Pull request": pullRequest,
                  ...facts,
                }),
                title: `Review ${task.key}: ${task.title}`,
                returns: ReviewReport,
                ...(reviewModel === undefined ? {} : { model: reviewModel }),
                ...where(at),
                workspace: { type: "worktree", baseRef: branch, startFromOrigin: true },
                timeout: Duration.minutes(budgets.reviewTimeoutMinutes),
              }),
              given,
              pullRequest,
            ),
            (done) => done.report,
          );

        let waits = 0;
        const checks = (pullRequest: { readonly project: string; readonly url: string }) =>
          Effect.map(
            pullRequests.wait(`checks/${++waits}`, pullRequest, {
              until: "checks",
              timeout: Duration.minutes(budgets.reviewTimeoutMinutes),
            }),
            (standing) =>
              Option.isNone(standing)
                ? "stuck"
                : standing.value.state !== "open"
                  ? standing.value.state
                  : standing.value.checks === "failing"
                    ? "failing"
                    : "passing",
          );

        let facts: Facts = {};
        let pullRequest: { readonly project: string; readonly url: string } | undefined;
        let rounds = 0;
        let heads = 0;
        let mains = 0;
        let merges = 0;
        const spendRound = Effect.fnUntraced(function* (why: string) {
          if (++rounds <= budgets.fixRounds) return;
          const answer = yield* needsYou(
            `${why} That is past ${budgets.fixRounds} fix rounds.`,
            pullRequest?.url,
          );
          facts = { ...facts, ...answer };
          // The round that asked runs on Leo's answer, so it is the first of the fresh count.
          rounds = 1;
        });
        const fix = Effect.fnUntraced(function* (url: string, requests: string) {
          yield* spendRound(requests);
          yield* work("fix", { ...facts, Fix: requests }, url);
          facts = {};
        });
        const lost = Effect.fnUntraced(function* (url: string, standing: "closed" | "stuck") {
          facts = yield* needsYou(
            standing === "closed" ? `${url} was closed.` : `The checks on ${url} did not settle.`,
            url,
          );
          if (standing === "closed") pullRequest = undefined;
        });

        let childChecks = 0;
        while (
          task.integration &&
          !(yield* step(
            `children/${++childChecks}`,
            { returns: Schema.Boolean },
            Effect.map(deps.tasks.relations(id), ({ children }) =>
              children.some((child) => child.state === "done"),
            ),
          ))
        ) {
          facts = yield* needsYou(
            `None of ${task.key}'s children is done, so it has nothing to merge.`,
          );
        }

        while (true) {
          if (pullRequest === undefined) {
            const built = yield* work("build", facts);
            facts = {};
            const url = built.outcome === "pull-request" ? built.url : "";
            const head = yield* step.try(
              `head/${++heads}`,
              { returns: Schema.String },
              Effect.map(
                pullRequests.read({ project: task.scope, url }),
                (found) => found.headBranch,
              ),
            );
            if (head.outcome === "failed" || head.value !== branch) {
              facts = yield* needsYou(`${url} is not a pull request from ${branch}.`, url);
              continue;
            }
            pullRequest = { project: task.scope, url };
          }
          const url = pullRequest.url;
          yield* enter("reviewing");

          const before = yield* checks(pullRequest);
          if (before === "merged") break;
          if (before === "closed" || before === "stuck") {
            yield* lost(url, before);
            continue;
          }
          if (before === "failing") {
            yield* fix(url, `The checks on ${url} fail.`);
            continue;
          }

          const verdict = yield* review(url, facts);
          facts = {};
          if (verdict.outcome === "changes") {
            yield* fix(url, verdict.requests);
            continue;
          }

          const reviewedChecks = yield* checks(pullRequest);
          if (reviewedChecks === "merged") break;
          if (reviewedChecks === "closed" || reviewedChecks === "stuck") {
            yield* lost(url, reviewedChecks);
            continue;
          }
          if (reviewedChecks === "failing") {
            yield* fix(url, `After review, the checks on ${url} fail.`);
            continue;
          }

          const touched = yield* step.try(
            `main/${++mains}`,
            { returns: Schema.Boolean },
            Effect.flatMap(pullRequests.read(pullRequest), (found) =>
              deps.baseTouchedSinceFork({
                checkout: found.workspaceRoot,
                base: found.baseBranch,
                head: found.headBranch,
              }),
            ),
          );
          if (touched.outcome === "failed") {
            facts = yield* needsYou(
              `${base} could not be checked before merging: ${touched.reason}`,
              url,
            );
            continue;
          }
          if (touched.value) {
            yield* spendRound(`${base} changed files that ${url} changes since its review.`);
            facts = {
              ...facts,
              "Main changed": `${base} moved past this pull request's base and changed files it changes. ${task.integration ? "Merge it in" : "Rebase onto it"} and review again.`,
            };
            continue;
          }

          const merge = ++merges;
          const merged = yield* step.try(
            `merge/${merge}`,
            { returns: Schema.Boolean },
            Effect.flatMap(deps.tasks.get(id), (found) =>
              ours(found)
                ? Effect.as(
                    pullRequests.act(pullRequest!, "merge", { mergeMethod: settings.mergeMethod }),
                    true,
                  )
                : Effect.succeed(false),
            ),
          );
          if (merged.outcome === "done") {
            if (!merged.value) return yield* superseded();
            break;
          }
          // The host may have taken a merge whose reply was lost.
          const landed = yield* step.try(
            `merged/${merge}`,
            { returns: Schema.Boolean },
            Effect.map(pullRequests.read(pullRequest), (found) => found.state === "merged"),
          );
          if (landed.outcome === "done" && landed.value) break;
          facts = yield* needsYou(`${url} could not be merged: ${merged.reason}`, url);
        }
      });

      const postResolutionOnce = (resolution: string, by: Actor) =>
        step(
          "resolution",
          { returns: Schema.Void },
          Effect.gen(function* () {
            if (!ours(yield* deps.tasks.get(id))) return;
            const { entries } = yield* deps.tasks.timeline(id);
            if (entries.some((entry) => entry.type === "comment" && entry.body === resolution)) {
              return;
            }
            yield* deps.tasks.comment(id, resolution, by);
          }),
        );

      const ticket = Effect.fnUntraced(function* () {
        yield* ensureBranches();
        const done = yield* phase(
          task.kind === "research" ? "research" : "session",
          budgets.build,
          judgeTicket,
          (report: TicketReport) => report.decisions,
          settings.builder?.instanceId ?? null,
          (facts, at) => ({
            brief: briefFor("wayfinder", task, settings, {
              Kind: task.kind,
              "Base branch": base,
              ...facts,
            }),
            title: `${task.kind === "research" ? "Research" : "Open"} ${task.key}: ${task.title}`,
            returns: TicketReport,
            ...model,
            ...where(at),
            workspace: { type: "worktree", baseRef: base, startFromOrigin: true },
            timeout: Duration.minutes(budgets.buildTimeoutMinutes),
          }),
          {},
        );
        if (done.report.outcome === "resolved") {
          return yield* postResolutionOnce(done.report.resolution, {
            kind: "agent",
            threadId: done.thread.threadId,
          });
        }
        const answer = yield* raise(`its ${task.kind} session is open in its thread.`, SESSION);
        yield* postResolutionOnce(answer?.reason ?? "", { kind: "person", name: "you" });
      });

      yield* task.kind === "build" ? build() : ticket();
      yield* move("done");
      yield* step(
        "settle",
        { returns: Schema.Void },
        Effect.forEach(threads, deps.settle, { discard: true }),
      );
      if (!task.integration) return;

      const retro = yield* step(
        "retro",
        { returns: Schema.Struct({ id: TaskId, key: Schema.String, url: Schema.String }) },
        Effect.map(
          deps.tasks.create(
            {
              scope: task.scope,
              kind: "research",
              title: `Retro: ${task.title}`,
              body: `Use the \`retro\` skill on the integration epic ${task.key} (${task.url}), which just merged.`,
            },
            by,
          ),
          (filed) => ({ id: filed.id, key: displayKey(filed), url: filed.url }),
        ),
      );
      for (let checks = 1; ; checks++) {
        const closed = yield* step(
          `retro/${checks}`,
          { returns: Schema.Boolean },
          Effect.map(deps.tasks.get(retro.id), (found) => !isOpen(found.state)),
        );
        if (closed) break;
        yield* sleep(`retro-wait/${checks}`, RETRO_CHECK);
      }
      yield* step(
        "digest/comment",
        { returns: Schema.Void },
        Effect.flatMap(digestOf(deps.tasks, id, retro.id), (body) =>
          deps.tasks.comment(id, body, by),
        ),
      );
      yield* ask("seen", {
        title: `${task.key} merged: its digest of decisions is on the task`,
        kind: "digest",
        choices: ["seen"],
        links: [
          { label: task.key, url: task.url },
          { label: retro.key, url: retro.url },
        ],
      });
    }),
  );

const digestOf = Effect.fnUntraced(function* (
  tasks: FactoryTasks["Service"],
  epic: TaskId,
  retro: TaskId,
) {
  const { children } = yield* tasks.relations(epic);
  const sections: Array<string> = [];
  for (const found of [yield* tasks.get(epic), ...children, yield* tasks.get(retro)]) {
    const decisions = (yield* wholeTimeline(tasks, found.id)).flatMap((entry) =>
      entry.type === "decision" ? [entry.decision] : [],
    );
    if (decisions.length === 0) continue;
    sections.push(
      [
        `### ${displayKey(found)}: ${found.title}`,
        ...decisions.map(
          (decision) =>
            `- **${decision.what}**: ${decision.why} (instead of: ${decision.alternative})`,
        ),
      ].join("\n"),
    );
  }
  return [
    "## Digest",
    sections.length === 0 ? "No agent made a call of its own." : sections.join("\n\n"),
  ].join("\n\n");
});

const wholeTimeline = Effect.fnUntraced(function* (tasks: FactoryTasks["Service"], id: TaskId) {
  const entries: Array<TaskEntry> = [];
  let cursor: string | undefined;
  do {
    const page = yield* tasks.timeline(id, cursor);
    entries.unshift(...page.entries);
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  return entries;
});

const asksForSession = (before: ReadonlyArray<TaskEntry>) => {
  const opened = before.findLast((entry) => entry.type === "attempt");
  return opened?.type === "attempt" && opened.phase === "session" && opened.outcome === "needs-you";
};

const answerByComment = Effect.fnUntraced(function* (
  tasks: FactoryTasks["Service"],
  scope: string,
) {
  const { items } = yield* tasks.list({ scope, state: "open", limit: 1000 });
  for (const waiting of items.filter((found) => found.state === "needs-you")) {
    const entries = yield* wholeTimeline(tasks, waiting.id);
    const raisedAt = entries.findLastIndex(
      (entry) => entry.type === "state" && entry.to === "needs-you" && entry.by.kind === "factory",
    );
    const raised = entries[raisedAt];
    if (raised?.by.kind !== "factory") continue;
    const runId = raised.by.runId;
    const choice = asksForSession(entries.slice(0, raisedAt)) ? "resolved" : "retry";
    const comment = entries
      .slice(raisedAt + 1)
      .find(
        (entry) =>
          entry.type === "comment" && (entry.by.kind === "person" || entry.by.kind === "tracker"),
      );
    if (comment?.type !== "comment") continue;
    const nth = entries.filter(
      (entry) =>
        entry.type === "state" &&
        entry.to === "needs-you" &&
        entry.by.kind === "factory" &&
        entry.by.runId === runId,
    ).length;
    yield* signal(
      { runId, wait: needsYouWait(nth) },
      { choice, reason: comment.body },
      { id: `comment/${comment.id}` },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("factory could not answer a question with a comment", {
          task: waiting.id,
          error,
        }),
      ),
    );
  }
});

/** Two definitions, since a trigger's payload is its only one. */
export const makeFactoryWorkflows = (deps: FactoryDeps) => {
  const task = taskWorkflow(deps);
  const tick = workflow(
    "factory",
    { version: 1, payload: Tick, triggers: [every("1 minute")], concurrency: 1 },
    Effect.fn("factory.tick")(function* () {
      yield* step(
        "orphans",
        { returns: Schema.Void },
        Effect.gen(function* () {
          yield* Effect.forEach(
            yield* store.entries(ORPHANS, OrphanThread),
            ({ value }) =>
              Effect.flatMap(deps.stopOrphan(value), (stopped) =>
                stopped ? orphan(value).delete : Effect.void,
              ),
            { concurrency: "unbounded", discard: true },
          );
        }),
      );
      const projects = yield* step("projects", { returns: Projects }, deps.enabledProjects);
      const mirror = (name: string, sync: typeof TrackerMirror.intake, project: FactoryProject) =>
        step(
          `${name}/${project.id}`,
          { returns: Schema.Void },
          sync(deps.tasks, deps.issues, project).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`factory ${name} failed`, { project: project.id, error }),
            ),
          ),
        );
      for (const project of projects) {
        yield* mirror("intake", TrackerMirror.intake, project);
        yield* mirror("reconcile", TrackerMirror.reconcile, project);
        const ready = yield* step(
          `ready/${project.id}`,
          { returns: Ready },
          Effect.map(deps.tasks.dispatchable(project.scope), (tasks) =>
            tasks.map((found) => ({ task: found.id, generation: found.generation })),
          ),
        );
        for (const run of ready) {
          yield* step(
            `start/${run.task}/${run.generation}`,
            { returns: Schema.String },
            Effect.map(
              start(task, run, { key: `task/${run.task}/${run.generation}` }),
              ({ runId }) => runId,
            ),
          );
        }
        yield* step(
          `answers/${project.id}`,
          { returns: Schema.Void },
          answerByComment(deps.tasks, project.scope),
        );
        yield* mirror("mirror", TrackerMirror.send, project);
      }
      return yield* skip("tick");
    }),
  );
  return [tick, task];
};
