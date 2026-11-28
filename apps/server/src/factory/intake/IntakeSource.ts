// Fork-only: automatic intake for the factory (christinoleo/t3code#96).
import { type FactoryIntake, TASK_LABEL } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { store } from "../../workflows/stepServices.ts";
import type { FactoryProject } from "../FactorySettings.ts";
import type { FactoryTasks } from "../FactoryTasks.ts";
import type { Actor } from "../taskModel.ts";

export interface IntakeReport {
  /** The store files one task per key and source, so a report polled again files nothing. */
  readonly dedupeKey: string;
  readonly title: string;
  readonly body: string;
  readonly links: ReadonlyArray<{ readonly label: string; readonly url: string }>;
}

export class IntakeError extends Schema.TaggedError<IntakeError>()("IntakeError", {
  source: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The ${this.source} intake could not be read.`;
  }
}

export interface IntakeSource {
  readonly id: "t3-feedback" | "external-issues";
  readonly trusted: boolean;
  readonly enabled: (intake: FactoryIntake) => boolean;
  /**
   * Reports since `cursor`, or since the factory was turned on when there is none yet, oldest
   * first. A report at the cursor itself may come again; the dedupe key absorbs it.
   */
  readonly poll: (input: {
    readonly project: FactoryProject;
    readonly cursor: Option.Option<string>;
  }) => Effect.Effect<
    { readonly reports: ReadonlyArray<IntakeReport>; readonly cursor: string | undefined },
    IntakeError
  >;
}

const bodyOf = (report: IntakeReport) =>
  [report.body, ...report.links.map((link) => `- [${link.label}](${link.url})`)].join("\n\n");

export const intake = Effect.fn("FactoryIntake.intake")(function* (
  tasks: FactoryTasks["Service"],
  source: IntakeSource,
  project: FactoryProject,
  by: Actor,
) {
  const at = `factory/intake/${project.scope}/${source.id}`;
  const cursor = store.entry(`${at}/cursor`, Schema.String);
  const polled = yield* source.poll({ project, cursor: yield* cursor.get });
  for (const report of polled.reports) {
    const filed = store.entry(`${at}/report/${report.dedupeKey}`, Schema.Number);
    if (Option.isSome(yield* filed.get)) continue;
    const task = yield* tasks.create(
      {
        scope: project.scope,
        kind: "research",
        title: report.title,
        body: bodyOf(report),
        labels: [TASK_LABEL.triage, ...(source.trusted ? [] : [TASK_LABEL.untrusted])],
      },
      by,
    );
    yield* filed.set(task.id);
  }
  if (polled.cursor !== undefined) yield* cursor.set(polled.cursor);
});

export const time = (iso: string) => Date.parse(iso);

export const since = (project: FactoryProject, cursor: Option.Option<string>) =>
  Option.getOrElse(cursor, () => project.settings.enabledAt ?? undefined);
