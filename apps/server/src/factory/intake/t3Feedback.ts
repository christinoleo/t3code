import * as Effect from "effect/Effect";

import type { FeedbackReport, FeedbackStorageError } from "../../feedback/FeedbackReport.ts";
import { IntakeError, type IntakeSource, since, time } from "./IntakeSource.ts";

export const t3Feedback = (
  newestFirst: Effect.Effect<ReadonlyArray<FeedbackReport>, FeedbackStorageError>,
): IntakeSource => ({
  id: "t3-feedback",
  trusted: true,
  enabled: (intake) => intake.t3Feedback,
  poll: ({ project, cursor }) =>
    newestFirst.pipe(
      Effect.mapError((cause) => new IntakeError({ source: "t3-feedback", cause })),
      Effect.map((stored) => {
        const from = since(project, cursor);
        if (from === undefined) return { reports: [], cursor: undefined };
        const fresh = stored.filter((report) => time(report.createdAt) >= time(from)).toReversed();
        return {
          reports: fresh.map((report) => ({
            dedupeKey: report.id,
            title: `T3 ${report.kind}: ${report.subject}`,
            body: [
              `An agent reported this ${report.kind} about \`${report.subject}\` on ${report.createdAt}${report.threadId === null ? "" : `, in thread ${report.threadId}`}.`,
              `**Expected:** ${report.expected}`,
              `**Actual:** ${report.actual}`,
              ...(report.workaround === "" ? [] : [`**Workaround:** ${report.workaround}`]),
            ].join("\n\n"),
            links: [],
          })),
          cursor: fresh.at(-1)?.createdAt ?? from,
        };
      }),
    ),
});
