import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { choosePlacement, describeSelf, type Machine, stopOrphan } from "./FactoryPlacement.ts";

const lost = { threadId: "thread-1", environment: "env-lost" };

const machine = (environment: string | undefined, cpuUtilization: number, project: string) =>
  ({
    environment,
    receivedAt: 0,
    report: {
      resources: {
        sampledAt: 0,
        cpuUtilization,
        cpuCount: 8,
        availableMemoryBytes: 8e9,
        totalMemoryBytes: 16e9,
      },
      projects: [{ projectId: project, repositoryKey: "github.com/me/app" }],
      providers: [{ instanceId: "codex", ready: true }],
    },
  }) satisfies Machine;

it("a machine passed over after a lost worker still takes it when every other one is full", () => {
  expect(
    choosePlacement(
      [machine(undefined, 0.05, "here"), machine("env-busy", 0.99, "there")],
      { project: "here", provider: null, exclude: ["here"] },
      0,
    ),
  ).toEqual({ _tag: "placed", placement: { project: "here" } });
});

it.effect("a machine reports only the projects a worker can still launch in", () =>
  Effect.gen(function* () {
    const report = yield* describeSelf;
    expect(report.projects.map((project) => project.projectId)).toEqual(["live"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(HostResources.HostResources)({
          read: Effect.succeed(machine(undefined, 0, "").report.resources),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({
          listPage: () =>
            Effect.succeed({
              projects: [
                { id: "archived", archivedAt: new Date(0), repositoryIdentity: null },
                { id: "live", archivedAt: null, repositoryIdentity: null },
              ] as never,
              nextCursor: null,
            }),
        }),
      ),
    ),
  ),
);

it.effect("an orphan on a machine that never answers is left for the next tick", () =>
  Effect.gen(function* () {
    const stopping = yield* Effect.forkChild(stopOrphan(lost));
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(stopping)).toBe(false);
  }).pipe(Effect.provide(Layer.mock(PeerMcpClient.PeerMcpClient)({ call: () => Effect.never }))),
);

it.effect("an orphan is stopped as its Stop button does, so a watch cannot wake it again", () => {
  const sent: Array<unknown> = [];
  return Effect.gen(function* () {
    expect(yield* stopOrphan(lost)).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ threadId: "thread-1", stop: true })]);
  }).pipe(
    Effect.provide(
      Layer.mock(PeerMcpClient.PeerMcpClient)({
        call: (input) =>
          Effect.sync(() => {
            sent.push(input.arguments);
            return { threadId: "thread-1", runId: null, status: "no_active_run" } as never;
          }),
      }),
    ),
  );
});
