import {
  FactoryProjectSettings,
  FactoryProjectSettingsPatch,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Tool, Toolkit } from "effect/ai";

import * as IssueTrackerConnections from "../../../issue/IssueTrackerConnections.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork-only (christinoleo/t3code#85). */
const FactoryConfigureTool = Tool.make("factory_configure", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    ProjectService.ProjectService,
    Settings.ServerSettingsService,
    IssueTrackerConnections.IssueTrackerConnections,
  ],
  description:
    "Read or change a project's software factory, which builds its T3 tasks into merged PRs. `enabled: true` also turns on Workflows and shows the project's T3 tasks in Issues; false starts no new tasks while running ones finish. Omitted fields are unchanged; with only `projectId` it reads. Live full-access or default caller thread only.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    ...Struct.omit(FactoryProjectSettingsPatch.fields, ["enabledAt"]),
  }),
  success: FactoryProjectSettings,
}).annotate(Tool.Destructive, true);

export const FactoryToolkit = Toolkit.make(FactoryConfigureTool);
