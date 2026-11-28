import {
  type Decision,
  FactoryProjectSettings,
  ProjectId,
  type ServerSettingsError,
  type TaskState,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { pullRequests } from "../workflows/forgeApi.ts";
import { start } from "../workflows/stepServices.ts";
import { every, Tick } from "../workflows/triggers.ts";
import { skip, step, workflow } from "../workflows/workflow.ts";
import { agent, type AgentThread } from "../workflows/workflowAgent.ts";
import type { FactoryProject } from "./FactorySettings.ts";
import { displayKey, type FactoryTasks, type Phase, TaskId } from "./FactoryTasks.ts";
import { ReviewReport, WorkerReport } from "./reports.ts";

/** One task's lifecycle; a revived task's next generation is a new run. */
const TaskRun = Schema.Struct({ task: TaskId, generation: Schema.Int });

/** What the definition's body reaches by closure, so its runs need nothing beyond `InRun`. */
export interface FactoryDeps {
  readonly tasks: FactoryTasks["Service"];
  readonly enabledProjects: Effect.Effect<ReadonlyArray<FactoryProject>, ServerSettingsError>;
  /** Read once per run, so a run started before the factory was turned off still finishes. */
  readonly projectSettings: (
    project: ProjectId,
  ) => Effect.Effect<FactoryProjectSettings, ServerSettingsError>;
  /** Never fails: a thread left open is no reason to hold back a task that is done. */
  readonly settle: (thread: AgentThread) => Effect.Effect<void>;
}

const Projects = Schema.Array(Schema.Struct({ id: Schema.String, scope: Schema.String }));
const Ready = Schema.Array(TaskRun);

/** What a run keeps of its task: the facts its briefs and addresses are made from. */
const Brief = Schema.Struct({
  key: Schema.String,
  scope: Schema.String,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
});
type Brief = typeof Brief.Type;

// Until integration epics (#95) give a task its own base.
const BASE = "main";

/** The one line that names the skill; every other word of instruction is in its markdown. */
const briefFor = (
  skill: string,
  task: Brief,
  settings: FactoryProjectSettings,
  facts: Readonly<Record<string, string>>,
) =>
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

const taskWorkflow = (deps: FactoryDeps) =>
  workflow(
    "factory-task",
    { version: 1, payload: TaskRun },
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

      let moves = 0;
      const move = (to: TaskState, reason?: string) =>
        step(
          `move/${++moves}/${to}`,
          { returns: Schema.Void },
          Effect.asVoid(deps.tasks.transition(id, to, by, reason)),
        );
      const record = (
        phase: Phase,
        thread: AgentThread | undefined,
        outcome: "succeeded" | "failed" | "needs-you",
        detail: string,
        decisions: ReadonlyArray<Decision>,
      ) =>
        step(
          `${phase}/record`,
          { returns: Schema.Void },
          Effect.gen(function* () {
            yield* deps.tasks.record(id, {
              type: "attempt",
              by,
              phase,
              thread:
                thread === undefined
                  ? null
                  : { threadId: thread.threadId, environmentId: thread.environment ?? null },
              outcome,
              failure: outcome === "failed" ? "agent" : null,
              detail,
            });
            const decider =
              thread === undefined ? by : { kind: "agent" as const, threadId: thread.threadId };
            for (const decision of decisions) {
              yield* deps.tasks.record(id, { type: "decision", by: decider, decision });
            }
          }),
        );
      // #92 replaces this with retries, budgets, fix rounds and a question that resumes the task.
      const needsYou = (reason: string) => move("needs-you", reason);

      const branch = `factory/${task.key}`;
      const issue = { project: task.scope, url: task.url };
      yield* move("building");
      const built = yield* agent.try("build", {
        brief: briefFor("maestro-worker", task, settings, { "Base branch": BASE, Branch: branch }),
        title: `Build ${task.key}: ${task.title}`,
        returns: WorkerReport,
        ...(settings.builder === null ? {} : { model: settings.builder }),
        project: task.scope,
        workspace: { type: "worktree", baseRef: BASE, branch, startFromOrigin: true },
        issue,
        timeout: Duration.minutes(settings.budgets.buildTimeoutMinutes),
      });
      if (built.outcome === "failed") {
        yield* record("build", built.thread, "failed", built.reason, []);
        return yield* needsYou(`The build failed: ${built.reason}`);
      }
      const report = built.value;
      if (report.outcome !== "pull-request") {
        const said =
          report.outcome === "needs-you"
            ? report.question
            : `${report.why} Try next: ${report.tryNext}`;
        yield* record(
          "build",
          built.thread,
          report.outcome === "needs-you" ? "needs-you" : "failed",
          said,
          report.decisions,
        );
        return yield* needsYou(said);
      }
      yield* record("build", built.thread, "succeeded", report.url, report.decisions);
      const pullRequest = { project: task.scope, url: report.url };
      yield* move("reviewing");

      // Checks that are missing count as passing: not every repository runs CI.
      const checksFail = (name: string) =>
        Effect.map(pullRequests.wait(name, pullRequest, { until: "checks" }), (standing) => {
          if (standing._tag === "None") return "it was not seen settling";
          const at = standing.value;
          if (at.state !== "open") return `${report.url} is ${at.state}`;
          return at.checks === "failing" ? `the checks on ${report.url} fail` : null;
        });
      const ci = yield* checksFail("checks");
      if (ci !== null) return yield* needsYou(`Before review, ${ci}.`);

      const reviewer = yield* step(
        "reviewer",
        { returns: Schema.NullOr(Schema.Int) },
        settings.reviewers.length === 0
          ? Effect.succeed(null)
          : Random.nextIntBetween(0, settings.reviewers.length, { halfOpen: true }),
      );
      const reviewModel = reviewer === null ? undefined : settings.reviewers[reviewer];
      const reviewed = yield* agent.try("review", {
        brief: briefFor("maestro-reviewer", task, settings, {
          "Base branch": BASE,
          Branch: branch,
          "Pull request": report.url,
        }),
        title: `Review ${task.key}: ${task.title}`,
        returns: ReviewReport,
        ...(reviewModel === undefined ? {} : { model: reviewModel }),
        project: task.scope,
        workspace: { type: "worktree", baseRef: branch, startFromOrigin: true },
        issue,
        timeout: Duration.minutes(settings.budgets.reviewTimeoutMinutes),
      });
      if (reviewed.outcome === "failed") {
        yield* record("review", reviewed.thread, "failed", reviewed.reason, []);
        return yield* needsYou(`The review failed: ${reviewed.reason}`);
      }
      const verdict = reviewed.value;
      if (verdict.outcome !== "approve") {
        const said =
          verdict.outcome === "changes"
            ? verdict.requests
            : verdict.outcome === "needs-you"
              ? verdict.question
              : verdict.why;
        yield* record(
          "review",
          reviewed.thread,
          verdict.outcome === "needs-you" ? "needs-you" : "failed",
          said,
          verdict.decisions,
        );
        return yield* needsYou(said);
      }
      yield* record("review", reviewed.thread, "succeeded", "approved", verdict.decisions);

      // The reviewer may have pushed fixes, so its head's checks are waited for too.
      const approvedCi = yield* checksFail("checks/approved");
      if (approvedCi !== null) return yield* needsYou(`After review, ${approvedCi}.`);
      const merged = yield* step.try(
        "merge",
        { returns: Schema.Void },
        pullRequests.act(pullRequest, "merge", { mergeMethod: settings.mergeMethod }),
      );
      if (merged.outcome === "failed") {
        return yield* needsYou(`${report.url} could not be merged: ${merged.reason}`);
      }
      yield* move("done");
      yield* step(
        "settle",
        { returns: Schema.Void },
        Effect.forEach([built.thread, reviewed.thread], deps.settle, { discard: true }),
      );
    }),
  );

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
      }
      return yield* skip("tick");
    }),
  );
  return [tick, task];
};
