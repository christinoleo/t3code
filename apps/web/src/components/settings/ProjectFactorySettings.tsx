// Fork-only: the software factory's per-project settings (christinoleo/t3code#85).
import {
  factoryProjectSettingsOf,
  factorySettingsPatch,
  type FactoryBudgets,
  type FactoryIntake,
  type FactoryProjectSettingsPatch,
  IssueTrackerKind,
  type ModelSelection,
  type ProjectId,
  type PullRequestMergeMethod,
  TASK_TRACKER_KIND,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { msg, useGT, useMessages } from "gt-react";
import { XIcon } from "lucide-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { issueTrackerEnvironment } from "../../state/issueTrackers";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { AdvancedSettings } from "./AdvancedSettings";
import { resolveDefaultModelSettingsPresentation } from "./ProjectDefaultsSettings.logic";
import { SecretInput } from "./SecretInput";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

const MERGE_METHODS = {
  squash: msg("Squash"),
  merge: msg("Merge commit"),
  rebase: msg("Rebase"),
  "fast-forward": msg("Fast-forward"),
} satisfies Record<PullRequestMergeMethod, string>;

const BUDGETS = {
  build: { title: msg("Build attempts"), description: msg("Agent failures before Needs you.") },
  review: { title: msg("Review attempts"), description: msg("Agent failures before Needs you.") },
  fixRounds: {
    title: msg("Fix rounds"),
    description: msg("Review-and-fix rounds, failing CI included, before Needs you."),
  },
  infraRetries: {
    title: msg("Free retries"),
    description: msg("Restarts and lost machines in a row before Needs you."),
  },
  buildTimeoutMinutes: {
    title: msg("Build time limit"),
    description: msg("Minutes before a build counts as stalled."),
  },
  reviewTimeoutMinutes: {
    title: msg("Review time limit"),
    description: msg("Minutes before a review counts as stalled."),
  },
} satisfies Record<keyof FactoryBudgets, { title: string; description: string }>;

const INTAKE = {
  ciOnMain: { title: msg("Failing CI on main"), description: msg("Each failure becomes a task.") },
  externalIssues: {
    title: msg("Other people's issues"),
    description: msg("Triaged read-only; their tasks wait for your approval."),
  },
  t3Feedback: {
    title: msg("T3 feedback and crash reports"),
    description: msg("Each report is triaged into a task."),
  },
  posthogErrors: {
    title: msg("PostHog errors"),
    description: msg("New or spiking errors are triaged into tasks."),
  },
} satisfies Record<Exclude<keyof FactoryIntake, "trackerLabel">, unknown>;

/** One block per checkout: each environment runs its own copy of the project's factory. */
export function ProjectFactorySettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const { environments } = useEnvironments();
  const checkouts = members.filter(
    (member) =>
      !member.isScratch &&
      environments.some(
        (environment) =>
          environment.environmentId === member.environmentId &&
          environment.connection.phase === "connected",
      ),
  );
  return checkouts.map((member) => (
    <CheckoutFactory
      key={member.physicalProjectKey}
      member={member}
      showCheckout={checkouts.length > 1}
    />
  ));
}

function CheckoutFactory({
  member,
  showCheckout,
}: {
  member: SidebarProjectGroupMember;
  showCheckout: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const environmentId = member.environmentId;
  const projectId: ProjectId = member.id;
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const bind = useAtomCommand(issueTrackerEnvironment.bindProject, {
    label: "bind project to T3 tasks",
  });
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const factory = factoryProjectSettingsOf(settings, projectId);

  const save = async (patch: Omit<FactoryProjectSettingsPatch, "enabledAt">) => {
    const next = factorySettingsPatch(factory, projectId, patch, new Date().toISOString());
    if (next.turnsOn) {
      const bound = await bind({
        environmentId,
        input: {
          projectId,
          binding: { tracker: IssueTrackerKind.make(TASK_TRACKER_KIND), scope: projectId },
        },
      });
      if (bound._tag !== "Success") return;
    }
    updateSettings(next.patch);
  };

  const posthog = settings.factory.posthog[projectId];
  const savePosthog = (fields: { projectUrl?: string; apiKey?: string }) =>
    updateSettings({ factory: { posthog: { [projectId]: fields } } });

  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId);
  const shown =
    factory.builder ??
    resolveDefaultModelSettingsPresentation(
      { entries: instanceEntries, providers, settings, projectId },
      m,
    ).selection ??
    null;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    shown?.instanceId ?? null,
    shown?.model ?? null,
  );
  const toggleReviewer = (instanceId: ModelSelection["instanceId"], model: string) => {
    const has = factory.reviewers.some(
      (reviewer) => reviewer.instanceId === instanceId && reviewer.model === model,
    );
    void save({
      reviewers: has
        ? factory.reviewers.filter(
            (reviewer) => !(reviewer.instanceId === instanceId && reviewer.model === model),
          )
        : [...factory.reviewers, createModelSelection(instanceId, model)],
    });
  };

  const numberRow = (key: keyof FactoryBudgets) => (
    <SettingsRow
      key={key}
      title={m(BUDGETS[key].title)}
      description={m(BUDGETS[key].description)}
      control={
        <Input
          key={factory.budgets[key]}
          type="number"
          min={1}
          className="w-24"
          defaultValue={factory.budgets[key]}
          aria-label={m(BUDGETS[key].title)}
          onBlur={(event) => {
            const value = Number.parseInt(event.target.value, 10);
            if (Number.isInteger(value) && value >= 1 && value !== factory.budgets[key]) {
              void save({ budgets: { [key]: value } });
            } else {
              event.target.value = String(factory.budgets[key]);
            }
          }}
        />
      }
    />
  );

  return (
    <SettingsSection id="project-factory" title={gt("Factory")}>
      <SettingsRow
        title={gt("Factory")}
        description={
          <>
            {gt(
              "Builds this project's T3 tasks into merged pull requests on its own, and asks you only what it can't decide. On also turns on Workflows and lists the project's T3 tasks in Issues. Off starts no new tasks; running ones finish.",
            )}
            {showCheckout ? (
              <span className="mt-1 block truncate">
                {member.environmentLabel ?? gt("Environment")} · {member.workspaceRoot}
              </span>
            ) : null}
          </>
        }
        control={
          <Switch
            checked={factory.enabled}
            onCheckedChange={(checked) => void save({ enabled: Boolean(checked) })}
            aria-label={gt("Factory")}
          />
        }
      />
      <SettingsRow
        title={gt("Builder model")}
        description={gt("Builds each task. Unset uses the project's default model.")}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {shown !== null ? (
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={shown.instanceId}
                model={shown.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel={gt("Builder model")}
                {...(factory.builder === null ? { triggerLabel: gt("Project default") } : {})}
                onInstanceModelChange={(instanceId, model) =>
                  void save({ builder: createModelSelection(instanceId, model) })
                }
              />
            ) : null}
            {factory.builder !== null ? (
              <Button size="xs" variant="outline" onClick={() => void save({ builder: null })}>
                {gt("Use default")}
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title={gt("Review models")}
        description={gt(
          "Each review picks one at random, so the reviewer is never the agent that built it. None uses the builder model.",
        )}
        control={
          shown !== null ? (
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={factory.reviewers[0]?.instanceId ?? shown.instanceId}
              model={factory.reviewers[0]?.model ?? shown.model}
              selectedModels={factory.reviewers}
              onToggleModel={toggleReviewer}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              isComposerOwned={false}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel={gt("Review models")}
              {...(factory.reviewers.length === 0
                ? { triggerLabel: gt("None") }
                : factory.reviewers.length > 1
                  ? {
                      triggerLabel: gt("{count} models", {
                        count: String(factory.reviewers.length),
                      }),
                    }
                  : {})}
              onInstanceModelChange={toggleReviewer}
            />
          ) : null
        }
      />
      <SettingsRow
        title={gt("Merge method")}
        description={gt("How the factory merges a pull request its reviewer approved.")}
        control={
          <Select
            value={factory.mergeMethod}
            onValueChange={(value) => void save({ mergeMethod: value as PullRequestMergeMethod })}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={gt("Merge method")}>
              <SelectValue>
                {(value: PullRequestMergeMethod) => m(MERGE_METHODS[value])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MERGE_METHODS) as PullRequestMergeMethod[]).map((method) => (
                <SelectItem key={method} hideIndicator value={method}>
                  {m(MERGE_METHODS[method])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={gt("Instructions")}
        description={gt("Added to every worker's brief, for rules this project's agents follow.")}
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={factory.instructions}
            defaultValue={factory.instructions}
            rows={3}
            aria-label={gt("Factory instructions")}
            onBlur={(event) => {
              const instructions = event.target.value.trim();
              if (instructions !== factory.instructions) void save({ instructions });
            }}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title={gt("Intake label")}
        description={gt(
          "An issue on the project's tracker that gets this label becomes a task. Only labels added after the factory first turned on count. Empty turns it off.",
        )}
        control={
          <Input
            key={factory.intake.trackerLabel ?? ""}
            className="w-full sm:w-48"
            defaultValue={factory.intake.trackerLabel ?? ""}
            aria-label={gt("Intake label")}
            onBlur={(event) => {
              const label = event.target.value.trim();
              const trackerLabel = label === "" ? null : label;
              if (trackerLabel !== factory.intake.trackerLabel) {
                void save({ intake: { trackerLabel } });
              }
            }}
          />
        }
      />
      {(Object.keys(INTAKE) as Array<keyof typeof INTAKE>).map((key) => (
        <SettingsRow
          key={key}
          title={m(INTAKE[key].title)}
          description={m(INTAKE[key].description)}
          control={
            <Switch
              checked={factory.intake[key]}
              onCheckedChange={(checked) => void save({ intake: { [key]: Boolean(checked) } })}
              aria-label={m(INTAKE[key].title)}
            />
          }
        />
      ))}
      {factory.intake.posthogErrors ? (
        <>
          <SettingsRow
            title={gt("PostHog project")}
            description={gt("The project's page in PostHog, as its address bar shows it.")}
            control={
              <Input
                key={posthog?.projectUrl ?? ""}
                className="w-full sm:w-72"
                defaultValue={posthog?.projectUrl ?? ""}
                placeholder="https://us.posthog.com/project/12345"
                aria-label={gt("PostHog project")}
                onBlur={(event) => {
                  const projectUrl = event.target.value.trim();
                  if (projectUrl !== (posthog?.projectUrl ?? "")) savePosthog({ projectUrl });
                }}
              />
            }
          />
          <SettingsRow
            title={gt("PostHog API key")}
            description={gt(
              "A personal API key with read access to error tracking. It stays on this server.",
            )}
            control={
              <div className="flex w-full min-w-0 items-center gap-2 sm:w-72">
                <SecretInput
                  size="sm"
                  className="min-w-0 flex-1"
                  configured={(posthog?.apiKey ?? "") !== ""}
                  value=""
                  aria-label={gt("PostHog API key")}
                  onCommit={(apiKey) => savePosthog({ apiKey })}
                />
                {(posthog?.apiKey ?? "") !== "" ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-destructive"
                    onClick={() => savePosthog({ apiKey: "" })}
                    aria-label={gt("Clear PostHog API key")}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            }
          />
        </>
      ) : null}
      <AdvancedSettings targetIds={[]}>
        {(Object.keys(BUDGETS) as Array<keyof FactoryBudgets>).map(numberRow)}
      </AdvancedSettings>
    </SettingsSection>
  );
}
