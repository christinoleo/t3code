// Fork-only (christinoleo/t3code#93).
import { chooseLoadBalancedEnvironment } from "@t3tools/client-runtime/load-balancing";
import {
  canProviderStartThreads,
  type EnvironmentId,
  HostResourcesSnapshot,
  OrchestratorMcpThreadInterruptResult,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import type { AgentThread } from "../workflows/workflowAgent.ts";

export const MachineReport = Schema.Struct({
  resources: Schema.NullOr(HostResourcesSnapshot),
  projects: Schema.Array(
    Schema.Struct({ projectId: Schema.String, repositoryKey: Schema.NullOr(Schema.String) }),
  ),
  providers: Schema.Array(Schema.Struct({ instanceId: Schema.String, ready: Schema.Boolean })),
});
export type MachineReport = typeof MachineReport.Type;

export interface Machine {
  /** The linked environment; absent for this one. */
  readonly environment: string | undefined;
  readonly report: MachineReport;
  /** When the owner got the report, so clocks on different machines are never compared. */
  readonly receivedAt: number;
}

export const Placement = Schema.Struct({
  environment: Schema.optional(Schema.String),
  /** The project's id on that machine. */
  project: Schema.String,
});
export type Placement = typeof Placement.Type;

export const Placed = Schema.Union([
  Schema.TaggedStruct("placed", { placement: Placement }),
  Schema.TaggedStruct("full", {}),
  Schema.TaggedStruct("none", { why: Schema.String }),
]);
export type Placed = typeof Placed.Type;

export const HERE = "here";

export interface PlacementNeed {
  /** The project here. */
  readonly project: string;
  /** The model's provider instance; null takes any ready one. */
  readonly provider: string | null;
  /** Machines to pass over when another can run it: linked environment ids, or `HERE`. */
  readonly exclude: ReadonlyArray<string>;
}

/**
 * Eligible is the same repository there and the provider ready, with every weight Normal.
 * `full` when eligible machines exist but all are too busy or unread; `none` when there are none.
 */
export const choosePlacement = (
  machines: ReadonlyArray<Machine>,
  need: PlacementNeed,
  now: number,
): Placed => {
  const repositoryKey =
    machines
      .find((machine) => machine.environment === undefined)
      ?.report.projects.find((project) => project.projectId === need.project)?.repositoryKey ??
    null;
  const eligible = machines.flatMap((machine) => {
    const project =
      machine.environment === undefined
        ? need.project
        : repositoryKey === null
          ? undefined
          : machine.report.projects.find((there) => there.repositoryKey === repositoryKey)
              ?.projectId;
    const ready = machine.report.providers.some(
      (provider) =>
        provider.ready && (need.provider === null || provider.instanceId === need.provider),
    );
    return project !== undefined && ready
      ? [{ id: machine.environment ?? HERE, machine, project }]
      : [];
  });
  if (eligible.length === 0) {
    return {
      _tag: "none",
      why: `No machine has this project with ${need.provider === null ? "a provider" : `provider ${need.provider}`} ready.`,
    };
  }
  const choose = (pool: typeof eligible) => {
    const chosen = chooseLoadBalancedEnvironment(
      pool.map((candidate) => ({
        environmentId: candidate.id,
        resources: candidate.machine.report.resources,
        receivedAt: candidate.machine.receivedAt,
        weight: 1,
      })),
      now,
    );
    return pool.find((candidate) => candidate.id === chosen);
  };
  const found =
    choose(eligible.filter((candidate) => !need.exclude.includes(candidate.id))) ??
    choose(eligible);
  if (found === undefined) return { _tag: "full" };
  return {
    _tag: "placed",
    placement: {
      ...(found.machine.environment === undefined
        ? {}
        : { environment: found.machine.environment }),
      project: found.project,
    },
  };
};

export const describeSelf = Effect.gen(function* () {
  const resources = yield* HostResources.HostResources;
  const projectService = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const projects: Array<MachineReport["projects"][number]> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: Effect.Success<ReturnType<typeof projectService.listPage>> =
      yield* projectService.listPage({ cursor, limit: 100 });
    for (const project of page.projects) {
      if (project.archivedAt != null) continue;
      projects.push({
        projectId: project.id,
        repositoryKey:
          project.repositoryIdentity == null
            ? null
            : repositoryGroupingKeyOf(project.repositoryIdentity),
      });
    }
    cursor = page.nextCursor;
  }
  return {
    resources: yield* resources.read,
    projects,
    providers: (yield* providers.getProviders).map((provider) => ({
      instanceId: provider.instanceId,
      ready: provider.enabled && canProviderStartThreads(provider),
    })),
  } satisfies MachineReport;
});

const OWNER_LIMITS = { runtimeMode: "full-access", interactionMode: "default" } as const;
const PEER_ANSWER = Duration.seconds(5);
/** Only a peer's handshake is bounded, and a lost machine can hold a reused session's call open. */
const PEER_ACTION = Duration.seconds(10);

export const machines = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const here = yield* describeSelf;
  const local: Machine = {
    environment: undefined,
    report: here,
    receivedAt: yield* Clock.currentTimeMillis,
  };
  if (!(yield* links.enabled)) return [local];
  const linked = yield* links.list.pipe(Effect.orElseSucceed(() => []));
  const answered = yield* Effect.forEach(
    linked.filter((link) => link.status === "reachable"),
    (link) =>
      peers
        .call({
          environmentId: link.environmentId,
          tool: "factory_machine",
          arguments: {},
          limits: OWNER_LIMITS,
          success: MachineReport,
        })
        .pipe(
          Effect.timeout(PEER_ANSWER),
          Effect.flatMap((report) =>
            Effect.map(Clock.currentTimeMillis, (receivedAt) =>
              Option.some<Machine>({ environment: link.environmentId, report, receivedAt }),
            ),
          ),
          Effect.orElseSucceed(() => Option.none<Machine>()),
        ),
    { concurrency: "unbounded" },
  );
  return [local, ...answered.flatMap(Option.toArray)];
});

// An expired or revoked link may be linked again, and then the worker is still there to stop.
const finalCodes = new Set(["thread_not_found", "run_not_found", "invalid_request"]);

export const stopOrphan = (thread: AgentThread) =>
  Effect.flatMap(PeerMcpClient.PeerMcpClient, (peers) =>
    peers
      .call({
        environmentId: thread.environment as EnvironmentId,
        tool: "t3_thread_interrupt",
        arguments: {
          threadId: thread.threadId,
          stop: true,
          reason: "Its factory worker was replaced",
        },
        limits: OWNER_LIMITS,
        success: OrchestratorMcpThreadInterruptResult,
      })
      .pipe(
        Effect.timeout(PEER_ACTION),
        Effect.as(true),
        Effect.catch((error) => Effect.succeed("code" in error && finalCodes.has(error.code))),
      ),
  );

export const settleLinked = (thread: AgentThread) =>
  Effect.flatMap(PeerMcpClient.PeerMcpClient, (peers) =>
    peers
      .call({
        environmentId: thread.environment as EnvironmentId,
        tool: "t3_thread_organize",
        arguments: { threadId: thread.threadId, action: "settle" },
        limits: OWNER_LIMITS,
        success: Schema.Unknown,
      })
      .pipe(Effect.timeout(PEER_ACTION)),
  );
