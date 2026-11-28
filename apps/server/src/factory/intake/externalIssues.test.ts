import { expect, it } from "@effect/vitest";
import {
  type IssueListEntry,
  type IssueListInput,
  IssueTrackerKind,
  ProjectId,
  ServerSettings,
  factoryProjectSettingsOf,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { externalIssues } from "./externalIssues.ts";

const issue = (
  key: string,
  login: string | null,
  createdAt: string,
  isBot = false,
  scope = "me/alpha",
) =>
  ({
    projectId: ProjectId.make("alpha"),
    projectTitle: "alpha",
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope,
    key,
    displayKey: `#${key}`,
    title: `Issue ${key}`,
    url: `https://github.com/me/alpha/issues/${key}`,
    author: login === null ? null : { login, isBot, name: null, avatarUrl: null },
    state: { category: "open", name: "Open" },
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
  }) satisfies IssueListEntry;

const listed = (
  entries: ReadonlyArray<IssueListEntry>,
  viewers: Record<string, string> = {},
  errors: ReadonlyArray<{ projectId: ProjectId; projectTitle: string; message: string }> = [],
) => ({
  viewers,
  trackers: [],
  entries,
  errors,
  nextCursors: {},
});

const settings = factoryProjectSettingsOf(
  Schema.decodeSync(ServerSettings)({
    factory: { projects: { alpha: { enabled: true, enabledAt: "2026-11-28T10:00:00.000Z" } } },
  }),
  ProjectId.make("alpha"),
);

it.effect("external issue intake takes only other people's issues opened since its cursor", () =>
  Effect.gen(function* () {
    const mine = issue("3", "me", "2026-11-28T10:05:00.000Z");
    const all = [
      issue("1", "stranger", "2026-11-28T09:00:00.000Z"),
      issue("2", "stranger", "2026-11-28T10:01:00.000Z"),
      mine,
      issue("4", "renovate", "2026-11-28T10:06:00.000Z", true),
      issue("5", null, "2026-11-28T10:07:00.000Z"),
      issue("6", "stranger", "2026-11-28T10:08:00.000Z", false, "Upstream/Alpha"),
    ].toReversed();
    const source = externalIssues(
      {
        list: (input: IssueListInput) =>
          Effect.succeed(
            input.involvement === "authored" ? listed([mine], { "github.com": "me" }) : listed(all),
          ),
      },
      () => Effect.succeed({ host: "github.com", scope: "upstream/alpha" }),
    );

    const polled = yield* source.poll({
      project: { id: ProjectId.make("alpha"), scope: "alpha", settings },
      cursor: Option.none(),
    });

    expect(polled.reports.map((report) => report.links[0]!.label)).toEqual(["#2", "#5"]);
    expect(polled.reports[1]!.body).toMatch(/^Someone opened #5\./);
    expect(polled.cursor).toBe("2026-11-28T10:07:00.000Z");
  }),
);

it.effect("external issue intake files nothing and keeps its cursor while a listing fails", () =>
  Effect.gen(function* () {
    const failed = [{ projectId: ProjectId.make("alpha"), projectTitle: "alpha", message: "502" }];
    const poll = (failing: IssueListInput["involvement"]) =>
      externalIssues(
        {
          list: (input: IssueListInput) =>
            Effect.succeed(
              input.involvement === failing
                ? listed([], {}, failed)
                : listed([issue("3", "me", "2026-11-28T10:05:00.000Z")], { "github.com": "me" }),
            ),
        },
        () => Effect.undefined,
      ).poll({
        project: { id: ProjectId.make("alpha"), scope: "alpha", settings },
        cursor: Option.none(),
      });

    expect(yield* poll("authored")).toEqual({ reports: [], cursor: undefined });
    expect(yield* poll(undefined)).toEqual({ reports: [], cursor: undefined });
  }),
);
