import { expect, it } from "@effect/vitest";
import {
  type IssueTrackerBindProjectInput,
  type OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as IssueTrackerConnections from "../issue/IssueTrackerConnections.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { configure } from "./FactorySettings.ts";

const ALPHA = ProjectId.make("alpha");
const binds: Array<IssueTrackerBindProjectInput> = [];

const layer = Layer.mergeAll(
  ServerSettings.ServerSettingsService.layerTest(),
  Layer.mock(ProjectService.ProjectService)({
    getShell: (projectId) =>
      Effect.succeed(
        projectId === ALPHA
          ? Option.some({ id: ALPHA, title: "Alpha" } as OrchestrationProjectShell)
          : Option.none(),
      ),
  }),
  Layer.mock(IssueTrackerConnections.IssueTrackerConnections)({
    bindProject: (input) => Effect.sync(() => void binds.push(input)),
  }),
);

it.effect("turning the factory on binds its queue, turns on Workflows and stamps when, once", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* TestClock.setTime(Date.parse("2026-11-28T10:00:00.000Z"));

    const on = yield* configure(ALPHA, { enabled: true, budgets: { build: 3 } });
    expect(on).toMatchObject({
      enabled: true,
      enabledAt: "2026-11-28T10:00:00.000Z",
      budgets: { build: 3, review: 2 },
      intake: { trackerLabel: "ready-for-agent" },
    });
    expect((yield* settings.getSettings).workflowsEnabled).toBe(true);
    expect(binds).toEqual([{ projectId: ALPHA, binding: { tracker: "t3", scope: "alpha" } }]);

    yield* settings.updateSettings({ workflowsEnabled: false });
    yield* TestClock.setTime(Date.parse("2026-11-28T12:00:00.000Z"));
    yield* configure(ALPHA, { enabled: false });
    const again = yield* configure(ALPHA, { enabled: true, instructions: "Be brief." });
    expect(again).toMatchObject({
      enabledAt: "2026-11-28T10:00:00.000Z",
      budgets: { build: 3 },
      instructions: "Be brief.",
    });
    expect((yield* settings.getSettings).workflowsEnabled).toBe(true);

    yield* configure(ALPHA, { mergeMethod: "rebase" });
    expect(binds).toHaveLength(2);
    expect(
      yield* Effect.flip(configure(ProjectId.make("nowhere"), { enabled: true })),
    ).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.provide(layer)),
);
