import type { ProjectId } from "@t3tools/contracts";
import type { ProviderWorkflowRun } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";

import type { PullRequestError } from "../../pullRequest/PullRequestService.ts";
import { IntakeError, type IntakeSource, since, time } from "./IntakeSource.ts";

export const ciOnMain = (
  branch: string,
  failedRuns: (input: {
    readonly projectId: ProjectId;
    readonly branch: string;
  }) => Effect.Effect<ReadonlyArray<ProviderWorkflowRun>, PullRequestError>,
): IntakeSource => ({
  id: "ci-on-main",
  trusted: true,
  enabled: (intake) => intake.ciOnMain,
  poll: Effect.fn("FactoryIntake.ciOnMain")(
    function* ({ project, cursor }) {
      const from = since(project, cursor);
      if (from === undefined) return { reports: [], cursor: undefined };
      const runs = yield* failedRuns({ projectId: project.id, branch });
      const fresh = runs
        // A pull request from a fork's branch of the same name runs on that branch too.
        .filter((run) => !run.event.startsWith("pull_request") && time(run.finishedAt) >= time(from))
        .toSorted((a, b) => time(a.finishedAt) - time(b.finishedAt));
      return {
        reports: fresh.map((run) => ({
          // A re-run keeps its id, so one that fails again files nothing.
          dedupeKey: run.id,
          title: `CI failing on ${branch}: ${run.name}`,
          body: `The ${run.name} workflow run on \`${branch}\` (started by ${run.event}) failed at ${run.finishedAt}, on commit ${run.headSha}.`,
          links: run.url === null ? [] : [{ label: run.name, url: run.url }],
        })),
        cursor: fresh.at(-1)?.finishedAt ?? from,
      };
    },
    Effect.mapError((cause) => new IntakeError({ source: "ci-on-main", cause })),
  ),
});
