import {
  FactoryProjectSettings,
  FactoryProjectSettingsPatch,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as IssueTrackerConnections from "../../../issue/IssueTrackerConnections.ts";
import { MachineReport } from "../../../factory/FactoryPlacement.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
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

/** Fork-only (christinoleo/t3code#93). */
const FactoryMachineTool = Tool.make("factory_machine", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    HostResources.HostResources,
    ProjectService.ProjectService,
    ProviderRegistry.ProviderRegistry,
  ],
  description:
    "This machine's load, its projects by repository, and which providers are ready, for a linked T3 server placing factory workers.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: MachineReport,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads);

export const FactoryToolkit = Toolkit.make(FactoryConfigureTool, FactoryMachineTool);
