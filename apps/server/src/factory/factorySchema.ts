import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Every object `createFactorySchema` makes, so startup can tell whether any is missing. */
export const FACTORY_SCHEMA_OBJECTS = [
  "factory_tasks",
  "factory_tasks_scope_state_idx",
  "factory_tasks_parent_idx",
  "factory_task_edges",
  "factory_task_edges_task_idx",
  "factory_task_edges_blocker_idx",
  "factory_task_entries",
  "factory_task_entries_task_idx",
];

/** The task store's tables. Rows change in place; only the timeline in `entries` keeps history. */
export const createFactorySchema = Effect.fn("factorySchema.create")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_tasks (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL,
      number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      parent_id INTEGER REFERENCES factory_tasks(id),
      external_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      mirrored_revision INTEGER NOT NULL DEFAULT 0,
      mirrored_entry_id INTEGER,
      author_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE (scope, number)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_tasks_scope_state_idx ON factory_tasks(scope, state)
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_tasks_parent_idx ON factory_tasks(parent_id)`;
  // A blocker is a task here (`blocker_id`) or an issue on another server (`blocker_url`).
  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_task_edges (
      task_id INTEGER NOT NULL REFERENCES factory_tasks(id),
      blocker_id INTEGER REFERENCES factory_tasks(id),
      blocker_url TEXT,
      blocker_display TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_task_edges_task_idx ON factory_task_edges(task_id)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_task_edges_blocker_idx ON factory_task_edges(blocker_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS factory_task_entries (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES factory_tasks(id),
      at TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS factory_task_entries_task_idx ON factory_task_entries(task_id, id)
  `;
});
