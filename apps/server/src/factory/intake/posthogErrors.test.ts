import { expect, it } from "@effect/vitest";
import {
  FactoryBudgets,
  FactoryIntake,
  FactoryPosthog,
  FactoryProjectSettings,
  ProjectId,
  ServerSettings,
  factoryProjectSettingsOf,
  secretSettingsFields,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { posthogErrors } from "./posthogErrors.ts";

const settings = factoryProjectSettingsOf(
  Schema.decodeSync(ServerSettings)({
    factory: { projects: { alpha: { enabled: true, enabledAt: "2026-11-28T10:00:00.000Z" } } },
  }),
  ProjectId.make("alpha"),
);
const project = { id: ProjectId.make("alpha"), scope: "alpha", settings };
const config = { projectUrl: "https://eu.posthog.com/project/42/dashboard", apiKey: "phx_secret" };

const issue = (id: string, first_seen: string | null) => ({
  id,
  status: "active",
  name: `TypeError ${id}`,
  description: `Cannot read ${id}`,
  first_seen,
});
const spike = (id: string, issueId: string, detected_at: string) => ({
  id,
  issue: { id: issueId, name: `TypeError ${issueId}`, description: null },
  detected_at,
  computed_baseline: 2.5,
  current_bucket_value: 40,
});

const posthog = (requests: Array<{ url: string; authorization: string | undefined }>) =>
  HttpClient.make((request) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const results = request.url.includes("/error_tracking/issues/")
      ? [
          issue("new", "2026-11-28T10:20:00.000Z"),
          issue("old", "2026-11-01T00:00:00.000Z"),
          issue("unseen", null),
        ]
      : [
          spike("s1", "old", "2026-11-28T10:10:00.000Z"),
          spike("s2", "new", "2026-11-28T10:25:00.000Z"),
        ];
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ results })));
  });

it.effect("PostHog error intake reports new and spiking errors as untrusted crash data", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const source = posthogErrors(posthog(requests), () => Effect.succeed(config));

    const first = yield* source.poll({ project, cursor: Option.none() });
    const again = yield* source.poll({ project, cursor: Option.fromUndefinedOr(first.cursor) });

    expect(source.trusted).toBe(false);
    expect(first.reports.map((report) => report.dedupeKey)).toEqual(["spike/s1", "issue/new"]);
    expect(first.reports[1]!.links).toEqual([
      { label: "PostHog issue", url: "https://eu.posthog.com/project/42/error-tracking/new" },
    ]);
    expect(first.cursor).toBe("2026-11-28T10:20:00.000Z");
    expect(again.reports.map((report) => report.dedupeKey)).toEqual(["issue/new"]);
    expect(JSON.stringify([first, again])).not.toContain("phx_secret");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/projects/42/error_tracking/issues/",
      "/api/projects/42/error_tracking/spike_events/",
      "/api/projects/42/error_tracking/issues/",
      "/api/projects/42/error_tracking/spike_events/",
    ]);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(
      new Set(["Bearer phx_secret"]),
    );
  }),
);

it.effect("PostHog error intake reports nothing and logs why without a key", () => {
  const logged: Array<unknown> = [];
  const logger = Logger.make(({ message }) => logged.push(message));
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  return Effect.gen(function* () {
    const polled = yield* posthogErrors(posthog(requests), () =>
      Effect.succeed({ ...config, apiKey: "" }),
    ).poll({ project, cursor: Option.none() });

    expect(polled).toEqual({ reports: [], cursor: undefined });
    expect(requests).toEqual([]);
    expect(String(logged.flat())).toMatch(/no PostHog project URL and API key/);
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it("keeps the PostHog key out of the project settings every factory run journals", () => {
  expect(secretSettingsFields(FactoryPosthog)).toEqual(["apiKey"]);
  for (const schema of [FactoryProjectSettings, FactoryIntake, FactoryBudgets]) {
    expect(secretSettingsFields(schema)).toEqual([]);
  }
});
