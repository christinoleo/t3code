import {
  factoryProjectSettingsOf,
  factorySettingsPatch,
  IssueTrackerKind,
  OrchestratorMcpFailure,
  ProjectId,
  TASK_TRACKER_KIND,
  type FactoryProjectSettings,
  type FactoryProjectSettingsPatch,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as IssueTrackerConnections from "../issue/IssueTrackerConnections.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettingsService from "../serverSettings.ts";

/** A project whose factory is on. Its queue, the task store scope, is the project's id. */
export interface FactoryProject {
  readonly id: ProjectId;
  readonly scope: string;
  readonly settings: FactoryProjectSettings;
}

export const enabledProjects = (settings: ServerSettings): ReadonlyArray<FactoryProject> =>
  Object.entries(settings.factory.projects).flatMap(([id, project]) =>
    project.enabled ? [{ id: ProjectId.make(id), scope: id, settings: project }] : [],
  );

/**
 * Changes one project's factory settings and returns them. Turning the factory on binds the
 * project's Issues to its queue first, so a binding that fails leaves the factory off.
 */
export const configure = Effect.fn("FactorySettings.configure")(function* (
  projectId: ProjectId,
  patch: Omit<FactoryProjectSettingsPatch, "enabledAt">,
) {
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const connections = yield* IssueTrackerConnections.IssueTrackerConnections;
  const project = yield* projects.getShell(projectId);
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `No project ${projectId} on this environment.`,
    });
  }
  const current = factoryProjectSettingsOf(yield* settings.getSettings, projectId);
  const now = DateTime.formatIso(yield* DateTime.now);
  const next = factorySettingsPatch(current, projectId, patch, now);
  if (next.turnsOn) {
    yield* connections.bindProject({
      projectId,
      binding: { tracker: IssueTrackerKind.make(TASK_TRACKER_KIND), scope: projectId },
    });
  }
  return factoryProjectSettingsOf(yield* settings.updateSettings(next.patch), projectId);
});
