import { CommandId, factoryProjectSettingsOf, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { readFeedbackReports } from "../feedback/FeedbackList.ts";
import * as IssueService from "../issue/IssueService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { BuiltInWorkflows } from "../workflows/builtIn.ts";
import type { AgentThread } from "../workflows/workflowAgent.ts";
import * as FactoryTasks from "./FactoryTasks.ts";
import { machines, settleLinked, stopOrphan } from "./FactoryPlacement.ts";
import { enabledProjects } from "./FactorySettings.ts";
import { MAIN, makeFactoryWorkflows } from "./factoryWorkflow.ts";
import { ciOnMain } from "./intake/ciOnMain.ts";
import { externalIssues } from "./intake/externalIssues.ts";
import { t3Feedback } from "./intake/t3Feedback.ts";

export const layer = Layer.effect(
  BuiltInWorkflows,
  Effect.gen(function* () {
    const tasks = yield* FactoryTasks.FactoryTasks;
    const settings = yield* ServerSettings.ServerSettingsService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const vcs = yield* GitVcsDriver.GitVcsDriver;
    const issues = yield* IssueService.IssueService;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const sql = yield* SqlClient.SqlClient;
    const gitFor = (operation: string) => (cwd: string, args: ReadonlyArray<string>) =>
      Effect.map(vcs.execute({ operation, cwd, args, timeoutMs: 120_000 }), (result) =>
        result.stdout.trim(),
      );
    const git = gitFor("factory.baseTouchedSinceFork");
    const files = (listed: string) => listed.split("\n").filter((file) => file !== "");
    const services = yield* Effect.context<
      | HostResources.HostResources
      | ProjectService.ProjectService
      | ProviderRegistry.ProviderRegistry
      | PeerLinks.PeerLinks
      | PeerMcpClient.PeerMcpClient
    >();
    const quietly = <A, E, R>(thread: AgentThread, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("factory could not settle a worker thread", { thread, cause }),
        ),
      );
    return makeFactoryWorkflows({
      tasks,
      issues,
      intake: [
        t3Feedback(Effect.provideService(readFeedbackReports, SqlClient.SqlClient, sql)),
        externalIssues(issues, (project) =>
          Effect.map(projects.getShell(project), (shell) => {
            // A fork binds its upstream first and its own repository second.
            const bindings = sourceControlDefinitions.issueBindings(
              Option.getOrUndefined(shell)?.repositoryIdentity,
            );
            return bindings.length > 1 ? bindings[0] : undefined;
          }),
        ),
        ciOnMain(MAIN, pullRequests.failedBranchRuns),
      ],
      enabledProjects: Effect.map(settings.getSettings, enabledProjects),
      projectSettings: (project) =>
        Effect.map(settings.getSettings, (all) => factoryProjectSettingsOf(all, project)),
      machines: Effect.provide(machines, services),
      stopOrphan: (thread) => Effect.provide(stopOrphan(thread), services),
      settle: (thread) =>
        thread.environment === undefined
          ? quietly(
              thread,
              threads.settleThread({
                threadId: ThreadId.make(thread.threadId),
                // One settle per thread, however often the step is retried.
                commandId: CommandId.make(`factory:settle:${thread.threadId}`),
                byOwnAgent: false,
              }),
            )
          : quietly(thread, Effect.provide(settleLinked(thread), services)),
      baseTouchedSinceFork: Effect.fn("FactoryWorkflows.baseTouchedSinceFork")(function* ({
        checkout,
        base,
        head,
      }) {
        const [baseRef, headRef] = [`refs/remotes/origin/${base}`, `refs/remotes/origin/${head}`];
        yield* git(checkout, [
          "fetch",
          "--quiet",
          "origin",
          `+refs/heads/${base}:${baseRef}`,
          `+refs/heads/${head}:${headRef}`,
        ]);
        const from = yield* git(checkout, ["merge-base", baseRef, headRef]);
        const moved = new Set(files(yield* git(checkout, ["diff", "--name-only", from, baseRef])));
        if (moved.size === 0) return false;
        const changes = files(yield* git(checkout, ["diff", "--name-only", from, headRef]));
        return changes.some((file) => moved.has(file));
      }),
      ensureBranch: Effect.fn("FactoryWorkflows.ensureBranch")(function* ({
        project,
        branch,
        from,
      }) {
        const { workspaceRoot: checkout } = yield* Effect.flatMap(
          projects.getById(ProjectId.make(project)),
          Effect.fromOption,
        );
        const run = gitFor("factory.ensureBranch");
        if ((yield* run(checkout, ["ls-remote", "origin", `refs/heads/${branch}`])) !== "") return;
        const fromRef = `refs/remotes/origin/${from}`;
        yield* run(checkout, ["fetch", "--quiet", "origin", `+refs/heads/${from}:${fromRef}`]);
        yield* run(checkout, ["push", "--quiet", "origin", `${fromRef}:refs/heads/${branch}`]);
      }),
    });
  }),
).pipe(Layer.provide(Layer.merge(FactoryTasks.layer, GitVcsDriver.layer)));
