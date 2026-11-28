import { expect, it } from "@effect/vitest";
import { ProjectId, ServerSettings, factoryProjectSettingsOf } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ciOnMain } from "./ciOnMain.ts";

const run = (id: string, finishedAt: string, event = "push") => ({
  id,
  name: `CI ${id}`,
  url: `https://github.com/me/alpha/actions/runs/${id}`,
  headSha: `sha${id}`,
  event,
  finishedAt,
});

const settings = factoryProjectSettingsOf(
  Schema.decodeSync(ServerSettings)({
    factory: { projects: { alpha: { enabled: true, enabledAt: "2026-11-28T10:00:00.000Z" } } },
  }),
  ProjectId.make("alpha"),
);
const project = { id: ProjectId.make("alpha"), scope: "alpha", settings };

it.effect("CI intake reports main's runs that failed since its cursor, oldest first", () =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    const source = ciOnMain("main", ({ branch }) => {
      asked.push(branch);
      return Effect.succeed([
        run("4", "2026-11-28T10:09:00.000Z", "pull_request"),
        run("3", "2026-11-28T10:07:00.000Z"),
        run("2", "2026-11-28T10:03:00.000Z", "schedule"),
        run("1", "2026-11-28T09:00:00.000Z"),
      ]);
    });

    const first = yield* source.poll({ project, cursor: Option.none() });
    const again = yield* source.poll({ project, cursor: Option.some("2026-11-28T10:08:00.000Z") });

    expect(asked).toEqual(["main", "main"]);
    expect(first.reports.map((report) => report.dedupeKey)).toEqual(["2", "3"]);
    expect(first.reports[0]).toMatchObject({
      title: "CI failing on main: CI 2",
      links: [{ label: "CI 2", url: "https://github.com/me/alpha/actions/runs/2" }],
    });
    expect(first.cursor).toBe("2026-11-28T10:07:00.000Z");
    expect(again).toEqual({ reports: [], cursor: "2026-11-28T10:08:00.000Z" });
    expect(source.enabled({ ...settings.intake, ciOnMain: false })).toBe(false);
  }),
);
