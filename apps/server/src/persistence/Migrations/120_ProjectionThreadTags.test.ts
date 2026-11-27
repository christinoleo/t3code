import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("120_ProjectionThreadTags", (it) => {
  it.effect("backfills thread tags and keeps them equal to the thread payloads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 119 });
      const upsertThread = (threadId: string, payloadJson: string) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        )
        VALUES (
          ${threadId}, 'project-1', 'title', 'codex', 'full-access', 'default',
          '2026-11-27T00:00:00.000Z', '2026-11-27T00:00:00.000Z', ${payloadJson}
        )
        ON CONFLICT(thread_id) DO UPDATE SET payload_json = excluded.payload_json
      `;
      const tagged = (tags: ReadonlyArray<string>, extra: object = {}) =>
        JSON.stringify({ ...extra, tags });
      const indexed = () => sql<{ readonly thread_id: string; readonly tag: string }>`
        SELECT thread_id, tag FROM orchestration_v2_projection_thread_tags
        ORDER BY thread_id, tag
      `;
      const recount = () => sql<{ readonly thread_id: string; readonly tag: string }>`
        SELECT DISTINCT t.thread_id, tag.value AS tag
        FROM orchestration_v2_projection_threads t, json_each(t.payload_json, '$.tags') tag
        WHERE json_valid(t.payload_json) AND tag.type = 'text'
        ORDER BY t.thread_id, tag.value
      `;
      const assertTags = (expected: ReadonlyArray<readonly [string, string]>) =>
        Effect.gen(function* () {
          const actual = yield* indexed();
          assert.deepEqual(actual, yield* recount());
          assert.deepEqual(
            actual.map((row) => [row.thread_id, row.tag]),
            expected.map(([threadId, tag]) => [threadId, tag]),
          );
        });

      yield* upsertThread("thread-1", tagged(["a", "b"]));
      yield* upsertThread("thread-2", "{}");
      yield* upsertThread("thread-3", tagged(["a", "a"]));
      yield* upsertThread("damaged", "not json");
      yield* runMigrations();
      yield* assertTags([
        ["thread-1", "a"],
        ["thread-1", "b"],
        ["thread-3", "a"],
      ]);

      yield* upsertThread("thread-4", tagged(["c"]));
      yield* upsertThread("thread-2", tagged(["a"]));
      yield* upsertThread("thread-1", tagged(["b"], { title: "renamed" }));
      yield* upsertThread("thread-3", tagged(["a"], { title: "same tags" }));
      yield* upsertThread("damaged", "still not json");
      yield* assertTags([
        ["thread-1", "b"],
        ["thread-2", "a"],
        ["thread-3", "a"],
        ["thread-4", "c"],
      ]);

      yield* upsertThread("thread-4", "{}");
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'thread-1'`;
      yield* assertTags([
        ["thread-2", "a"],
        ["thread-3", "a"],
      ]);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM orchestration_v2_projection_thread_tags WHERE tag = 'a'
      `;
      assert.isTrue(
        plan.some((row) => row.detail.includes("orchestration_v2_projection_thread_tags_tag_idx")),
      );
    }),
  );
});
