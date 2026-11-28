import {
  type Decision,
  FactoryProjectSettings,
  ProjectId,
  type ServerSettingsError,
  type TaskState,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { pullRequests } from "../workflows/forgeApi.ts";
import { signal, start } from "../workflows/stepServices.ts";
import { every, Tick } from "../workflows/triggers.ts";
import { skip, step, stop, workflow } from "../workflows/workflow.ts";
import {
  agent,
  type AgentFailure,
  type AgentOptions,
  type AgentThread,
  ask,
} from "../workflows/workflowAgent.ts";
import type { FactoryProject } from "./FactorySettings.ts";
import {
  displayKey,
  type FactoryTasks,
  type Phase,
  type Task,
  type TaskEntry,
  TaskId,
} from "./FactoryTasks.ts";
import { ReviewReport, WorkerReport } from "./reports.ts";
import { isOpen } from "./taskModel.ts";

/** One task's lifecycle; a revived task's next generation is a new run. */
const TaskRun = Schema.Struct({ task: TaskId, generation: Schema.Int });

/** What the definition's body reaches by closure, so its runs need nothing beyond `InRun`. */
export interface FactoryDeps {
  readonly tasks: FactoryTasks["Service"];
  readonly enabledProjects: Effect.Effect<ReadonlyArray<FactoryProject>, ServerSettingsError>;
  readonly projectSettings: (
    project: ProjectId,
  ) => Effect.Effect<FactoryProjectSettings, ServerSettingsError>;
  /** Never fails: a thread left open is no reason to hold back a task that is done. */
  readonly settle: (thread: AgentThread) => Effect.Effect<void>;
  readonly baseTouchedSinceFork: (pullRequest: {
    readonly checkout: string;
    readonly base: string;
    readonly head: string;
  }) => Effect.Effect<boolean, Error>;
}

const Projects = Schema.Array(Schema.Struct({ id: Schema.String, scope: Schema.String }));
const Ready = Schema.Array(TaskRun);

const Brief = Schema.Struct({
  key: Schema.String,
  scope: Schema.String,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
});
type Brief = typeof Brief.Type;

type Facts = Readonly<Record<string, string>>;

// Until integration epics (#95) give a task its own base.
const BASE = "main";

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

type Judged = { readonly _tag: "done" | "gave-up" | "needs-you"; readonly detail: string };

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

const needsYouWait = (nth: number) => `needs-you/${nth}`;

const taskWorkflow = (deps: FactoryDeps) =>
  workflow(
    "factory-task",
    {
      version: 1,
      payload: TaskRun,
      asks: { "needs-you": "Needs you" },
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
        Effect.map(deps.tasks.get(id), (found) => ({
          key: displayKey(found),
          scope: found.scope,
          title: found.title,
          body: found.body,
          url: found.url,
        })),
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
      const needsYou = Effect.fnUntraced(function* (reason: string, pullRequest?: string) {
        yield* move("needs-you", reason);
        const answer = yield* ask(needsYouWait(++asked), {
          title: `${task.key} needs you: ${reason}`,
          kind: "needs-you",
          choices: [
            { value: "retry", description: "Go on; your reason goes to the next agent." },
            { value: "drop", description: "Drop the task." },
          ],
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
        const said = given?.reason?.trim() ?? "";
        return said === "" ? {} : { "Leo's answer": said };
      });

      const attempts: Partial<Record<Phase, number>> = {};
      const threads: Array<AgentThread> = [];
      const phase = Effect.fn("factory.phase")(function* <A>(
        kind: "build" | "fix" | "review",
        budget: number,
        judge: (report: A) => Judged,
        decisionsOf: (report: A) => ReadonlyArray<Decision>,
        launch: (facts: Facts) => AgentOptions<A, unknown>,
        given: Facts,
        pullRequest?: string,
      ) {
        let agentFailures = 0;
        let infraStreak = 0;
        let facts = given;
        while (true) {
          yield* enter(kind === "review" ? "reviewing" : "building");
          const nth = (attempts[kind] ?? 0) + 1;
          attempts[kind] = nth;
          const name = `${kind}/${nth}`;
          const tried = yield* agent.try(name, launch(facts));
          if (tried.thread !== undefined) threads.push(tried.thread);
          let detail: string;
          let infra = false;
          if (tried.outcome === "failed") {
            infra = FREE_RETRY_CAUSES.has(tried.cause);
            detail = tried.reason;
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
                : judged._tag === "needs-you"
                  ? "needs-you"
                  : "failed",
              judged._tag === "gave-up" ? "agent" : null,
              detail,
              decisionsOf(tried.value),
            );
            if (judged._tag === "done") return tried.value;
            if (judged._tag === "needs-you") {
              facts = yield* needsYou(detail, pullRequest);
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
          facts = yield* needsYou(
            infra
              ? `The ${kind} could not run ${infraStreak} times in a row: ${detail}`
              : `The ${kind} failed ${agentFailures} times: ${detail}`,
            pullRequest,
          );
          agentFailures = 0;
          infraStreak = 0;
        }
      });

      const model = settings.builder === null ? {} : { model: settings.builder };
      // The worker pushes here from a worktree of its own: a launch refuses a branch that exists,
      // which a retried round's would. An earlier generation's branch outlives it.
      const branch = `factory/${task.key}${payload.generation === 0 ? "" : `-g${payload.generation}`}`;
      const issue = { project: task.scope, url: task.url };
      const work = (kind: "build" | "fix", given: Facts, pullRequest?: string) =>
        phase(
          kind,
          budgets.build,
          judgeWork,
          (report: WorkerReport) => report.decisions,
          (facts) => ({
            brief: briefFor("maestro-worker", task, settings, {
              "Base branch": BASE,
              Branch: branch,
              ...(pullRequest === undefined ? {} : { "Pull request": pullRequest }),
              ...facts,
            }),
            title: `${kind === "build" ? "Build" : "Fix"} ${task.key}: ${task.title}`,
            returns: WorkerReport,
            ...model,
            project: task.scope,
            workspace: { type: "worktree", baseRef: BASE, startFromOrigin: true },
            issue,
            timeout: Duration.minutes(budgets.buildTimeoutMinutes),
          }),
          given,
          pullRequest,
        );

      const reviewer = yield* step(
        "reviewer",
        { returns: Schema.NullOr(Schema.Int) },
        settings.reviewers.length === 0
          ? Effect.succeed(null)
          : Random.nextIntBetween(0, settings.reviewers.length, { halfOpen: true }),
      );
      const reviewModel = reviewer === null ? undefined : settings.reviewers[reviewer];
      const review = (pullRequest: string, given: Facts) =>
        phase(
          "review",
          budgets.review,
          judgeReview,
          (report: ReviewReport) => report.decisions,
          (facts) => ({
            brief: briefFor("maestro-reviewer", task, settings, {
              "Base branch": BASE,
              Branch: branch,
              "Pull request": pullRequest,
              ...facts,
            }),
            title: `Review ${task.key}: ${task.title}`,
            returns: ReviewReport,
            ...(reviewModel === undefined ? {} : { model: reviewModel }),
            project: task.scope,
            workspace: { type: "worktree", baseRef: branch, startFromOrigin: true },
            issue,
            timeout: Duration.minutes(budgets.reviewTimeoutMinutes),
          }),
          given,
          pullRequest,
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
        rounds = 0;
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
            `${BASE} could not be checked before merging: ${touched.reason}`,
            url,
          );
          continue;
        }
        if (touched.value) {
          yield* spendRound(`${BASE} changed files that ${url} changes since its review.`);
          facts = {
            ...facts,
            "Main changed": `${BASE} moved past this pull request's base and changed files it changes. Rebase onto it and review again.`,
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
      yield* move("done");
      yield* step(
        "settle",
        { returns: Schema.Void },
        Effect.forEach(threads, deps.settle, { discard: true }),
      );
    }),
  );

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
      { choice: "retry", reason: comment.body },
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
    { version: 1, payload: Tick, triggers: [every("1 minute")] },
    Effect.fn("factory.tick")(function* () {
      const projects = yield* step(
        "projects",
        { returns: Projects },
        Effect.map(deps.enabledProjects, (enabled) =>
          enabled.map((project) => ({ id: project.id, scope: project.scope })),
        ),
      );
      for (const project of projects) {
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
      }
      return yield* skip("tick");
    }),
  );
  return [tick, task];
};
