// Fork-only: the built-in software factory's task model (christinoleo/t3code#85).
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { IssueState } from "./issue.ts";
import { ModelSelection } from "./modelSelection.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

export const TASK_TRACKER_KIND = "t3";

export const TaskKind = Schema.Literals(["build", "research", "grilling", "prototype", "task"]);
export type TaskKind = typeof TaskKind.Type;

export const TaskState = Schema.Literals([
  "ready",
  "building",
  "reviewing",
  "needs-you",
  "done",
  "dropped",
]);
export type TaskState = typeof TaskState.Type;

/** The one list of states, in workflow order. */
export const TASK_STATES = {
  ready: { category: "open", name: "Ready" },
  building: { category: "open", name: "Building" },
  reviewing: { category: "open", name: "Reviewing" },
  "needs-you": { category: "open", name: "Needs you" },
  done: { category: "closed", name: "Done", closeReason: "completed" },
  dropped: { category: "closed", name: "Dropped", closeReason: "not planned" },
} as const satisfies Record<TaskState, IssueState>;

export const TASK_LABEL = {
  /** Writable: setting it changes the task's kind. */
  kind: (kind: TaskKind) => `kind/${kind}`,
  /** Derived from open blockers, and refused on write. */
  blocked: "blocked",
  integration: "integration",
  triage: "triage",
  untrusted: "untrusted",
} as const;

/** A call a worker made on its own, kept on the task for audit. */
export const Decision = Schema.Struct({
  what: Schema.String,
  why: Schema.String,
  alternative: Schema.String,
});
export type Decision = typeof Decision.Type;

const budgetFields = {
  build: PositiveInt,
  review: PositiveInt,
  fixRounds: PositiveInt,
  infraRetries: PositiveInt,
  buildTimeoutMinutes: PositiveInt,
  reviewTimeoutMinutes: PositiveInt,
};
const intakeFields = {
  /** Null turns tracker intake off. */
  trackerLabel: Schema.NullOr(TrimmedNonEmptyString),
  ciOnMain: Schema.Boolean,
  externalIssues: Schema.Boolean,
  t3Feedback: Schema.Boolean,
  posthogErrors: Schema.Boolean,
};
const projectFields = {
  enabled: Schema.Boolean,
  /** Intake counts only labels added after it. Kept when the factory is turned off and on again. */
  enabledAt: Schema.NullOr(IsoDateTime),
  /** Null builds with the project's default model. */
  builder: Schema.NullOr(ModelSelection),
  /** Each review picks one at random. */
  reviewers: Schema.Array(ModelSelection),
  /** Added to every worker's brief. */
  instructions: Schema.String,
  mergeMethod: PullRequestMergeMethod,
};

const defaulted = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

export const FactoryBudgets = Schema.Struct({
  build: defaulted(budgetFields.build, 2),
  review: defaulted(budgetFields.review, 2),
  fixRounds: defaulted(budgetFields.fixRounds, 2),
  infraRetries: defaulted(budgetFields.infraRetries, 5),
  buildTimeoutMinutes: defaulted(budgetFields.buildTimeoutMinutes, 240),
  reviewTimeoutMinutes: defaulted(budgetFields.reviewTimeoutMinutes, 120),
});
export type FactoryBudgets = typeof FactoryBudgets.Type;

export const FactoryIntake = Schema.Struct({
  trackerLabel: defaulted(intakeFields.trackerLabel, "ready-for-agent"),
  ciOnMain: defaulted(intakeFields.ciOnMain, false),
  externalIssues: defaulted(intakeFields.externalIssues, false),
  t3Feedback: defaulted(intakeFields.t3Feedback, false),
  posthogErrors: defaulted(intakeFields.posthogErrors, false),
});
export type FactoryIntake = typeof FactoryIntake.Type;

export const FactoryProjectSettings = Schema.Struct({
  enabled: defaulted(projectFields.enabled, false),
  enabledAt: defaulted(projectFields.enabledAt, null),
  builder: defaulted(projectFields.builder, null),
  reviewers: defaulted(projectFields.reviewers, []),
  budgets: defaulted(FactoryBudgets, {}),
  instructions: defaulted(projectFields.instructions, ""),
  mergeMethod: defaulted(projectFields.mergeMethod, "squash"),
  intake: defaulted(FactoryIntake, {}),
});
export type FactoryProjectSettings = typeof FactoryProjectSettings.Type;

const DEFAULT_FACTORY_PROJECT_SETTINGS: FactoryProjectSettings = Schema.decodeSync(
  FactoryProjectSettings,
)({});

export const FactorySettings = Schema.Struct({
  projects: defaulted(Schema.Record(ProjectId, FactoryProjectSettings), {}),
});
export type FactorySettings = typeof FactorySettings.Type;

export const FactoryProjectSettingsPatch = Schema.Struct({
  ...Struct.map(projectFields, Schema.optionalKey),
  budgets: Schema.optionalKey(Schema.Struct(Struct.map(budgetFields, Schema.optionalKey))),
  intake: Schema.optionalKey(Schema.Struct(Struct.map(intakeFields, Schema.optionalKey))),
});
export type FactoryProjectSettingsPatch = typeof FactoryProjectSettingsPatch.Type;

export const factoryProjectSettingsOf = (
  settings: { readonly factory: FactorySettings },
  projectId: ProjectId,
): FactoryProjectSettings =>
  settings.factory.projects[projectId] ?? DEFAULT_FACTORY_PROJECT_SETTINGS;

/**
 * Applies `ServerSettingsPatch.factory` inside the settings write. Field by field like the rest of
 * settings, except that a builder replaces the stored one (merged, a new model would keep the old
 * model's options), and a stored `enabledAt` wins, so two racing turn-ons keep the first stamp.
 */
export const applyFactorySettingsPatch = (
  current: FactorySettings,
  patch: { readonly projects: Readonly<Record<ProjectId, FactoryProjectSettingsPatch>> },
): FactorySettings => ({
  projects: {
    ...current.projects,
    ...Object.fromEntries(
      Object.entries(patch.projects).map(([projectId, fields]) => {
        const saved = factoryProjectSettingsOf({ factory: current }, ProjectId.make(projectId));
        return [
          projectId,
          {
            ...saved,
            ...fields,
            budgets: { ...saved.budgets, ...fields.budgets },
            intake: { ...saved.intake, ...fields.intake },
            enabledAt: saved.enabledAt ?? fields.enabledAt ?? null,
          },
        ];
      }),
    ),
  },
});

/**
 * The server settings patch for one project's factory. Turning it on also turns on Workflows,
 * which run it, and stamps `enabledAt` the first time. The caller then binds the project to its
 * `t3` scope, which settings cannot do.
 */
export const factorySettingsPatch = (
  current: FactoryProjectSettings,
  projectId: ProjectId,
  patch: Omit<FactoryProjectSettingsPatch, "enabledAt">,
  now: string,
) => {
  const turnsOn = patch.enabled === true && !current.enabled;
  const stamped = turnsOn && current.enabledAt === null ? { ...patch, enabledAt: now } : patch;
  return {
    turnsOn,
    patch: {
      ...(turnsOn ? { workflowsEnabled: true } : {}),
      factory: { projects: { [projectId]: stamped } },
    },
  };
};
