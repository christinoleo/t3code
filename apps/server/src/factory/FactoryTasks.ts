/**
 * The single writer of every task's state. A scope is one project's id; numbers start at 1 so
 * keys work wherever an issue number does.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import {
  TASK_LABEL,
  TaskKind,
  TaskState,
  Decision,
  IssueRef,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { RunEnd } from "../workflows/workflow.ts";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { Actor, isOpen, OPEN_STATES, refusal, revives } from "./taskModel.ts";

export const TaskId = Schema.Int.pipe(Schema.brand("TaskId"));
export type TaskId = typeof TaskId.Type;

export const ExternalIssue = Schema.Struct({ ref: IssueRef, url: Schema.String });
export type ExternalIssue = typeof ExternalIssue.Type;

export interface Task {
  readonly id: TaskId;
  /** The queue: the id of the project here whose tasks these are. */
  readonly scope: string;
  /** Per-scope sequence, which is the tracker key. */
  readonly number: number;
  readonly kind: TaskKind;
  readonly state: TaskState;
  /** Bumps on revive or reopen; names the run that owns the task. */
  readonly generation: number;
  readonly title: string;
  readonly body: string;
  /** Free labels; the kind and `blocked` labels are added on read. */
  readonly labels: ReadonlyArray<string>;
  readonly parent: TaskId | null;
  /** An open task blocks it, or an integration parent's children are still open. */
  readonly blocked: boolean;
  readonly external: ExternalIssue | null;
  readonly author: Actor;
  readonly commentCount: number;
  readonly url: string;
  /** Every write bumps it; the mirror pushes what is past its last mirrored revision. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

const entryFields = { id: Schema.String, at: Schema.String, by: Actor };
/** Append-only. */
export const TaskEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("comment"), ...entryFields, body: Schema.String }),
  Schema.Struct({ type: Schema.Literal("decision"), ...entryFields, decision: Decision }),
  Schema.Struct({
    type: Schema.Literal("attempt"),
    ...entryFields,
    phase: Schema.Literals(["build", "fix", "review", "final-review", "research", "triage"]),
    thread: Schema.NullOr(
      Schema.Struct({ threadId: Schema.String, environmentId: Schema.NullOr(Schema.String) }),
    ),
    outcome: Schema.Literals(["succeeded", "failed", "needs-you"]),
    failure: Schema.NullOr(Schema.Literals(["infra", "agent"])),
    detail: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("state"),
    ...entryFields,
    from: TaskState,
    to: TaskState,
    reason: Schema.NullOr(Schema.String),
  }),
]);
export type TaskEntry = typeof TaskEntry.Type;
const decodeEntry = Schema.decodeUnknownSync(TaskEntry);

export type Phase = Extract<TaskEntry, { type: "attempt" }>["phase"];
export type AttemptRecord = Omit<Extract<TaskEntry, { type: "attempt" }>, "id" | "at">;
export type DecisionRecord = Omit<Extract<TaskEntry, { type: "decision" }>, "id" | "at">;

export interface TaskDraft {
  readonly scope: string;
  readonly kind?: TaskKind | undefined;
  readonly title: string;
  readonly body: string;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly parent?: TaskId | undefined;
  readonly blockedBy?: ReadonlyArray<TaskId> | undefined;
}

/**
 * Only the present fields are written; `labels` is the whole set, kind label included, and
 * `blockedBy` the whole set of blockers. A null `parent` takes the task out of its parent.
 */
export interface TaskPatch {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly parent?: TaskId | null | undefined;
  readonly blockedBy?: ReadonlyArray<TaskId> | undefined;
}

export interface TaskRelations {
  readonly parent: Task | null;
  readonly children: ReadonlyArray<Task>;
  readonly blockedBy: ReadonlyArray<Task>;
  readonly blocking: ReadonlyArray<Task>;
}

export interface TaskQuery {
  readonly scope: string;
  readonly state: "open" | "closed" | "all";
  /** Labels a task must carry, every one of them, the derived ones included. */
  readonly labels?: ReadonlyArray<string> | undefined;
  /** Only tasks this person filed. */
  readonly createdBy?: string | undefined;
  readonly sort?: "updated" | "created" | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()(
  "TaskNotFoundError",
  { task: Schema.String },
) {
  override get message(): string {
    return `There is no task ${this.task}.`;
  }
}

export class TaskTransitionError extends Schema.TaggedError<TaskTransitionError>()(
  "TaskTransitionError",
  { task: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A write the store refuses for what it asks, not for where the task is in its lifecycle. */
export class TaskInvalidError extends Schema.TaggedError<TaskInvalidError>()("TaskInvalidError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class TaskStoreError extends Schema.TaggedError<TaskStoreError>()("TaskStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The task store failed in ${this.operation}.`;
  }
}

export type TaskError = TaskNotFoundError | TaskInvalidError | TaskStoreError;

export class FactoryTasks extends Context.Service<
  FactoryTasks,
  {
    readonly create: (draft: TaskDraft, by: Actor) => Effect.Effect<Task, TaskError>;
    readonly get: (id: TaskId) => Effect.Effect<Task, TaskNotFoundError | TaskStoreError>;
    readonly byKey: (
      scope: string,
      number: number,
    ) => Effect.Effect<Task, TaskNotFoundError | TaskStoreError>;
    /** The newest page, oldest first within it; `next` leads to the page before it. */
    readonly timeline: (
      id: TaskId,
      cursor?: string,
    ) => Effect.Effect<
      { readonly entries: ReadonlyArray<TaskEntry>; readonly next: string | null },
      TaskNotFoundError | TaskStoreError
    >;
    readonly list: (
      query: TaskQuery,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<Task>; readonly next: string | null },
      TaskStoreError
    >;
    readonly relations: (id: TaskId) => Effect.Effect<TaskRelations, TaskError>;
    readonly update: (id: TaskId, patch: TaskPatch, by: Actor) => Effect.Effect<Task, TaskError>;
    readonly comment: (id: TaskId, body: string, by: Actor) => Effect.Effect<TaskEntry, TaskError>;
    /** The lifecycle's only gate: refuses a move the table forbids for this actor. */
    readonly transition: (
      id: TaskId,
      to: TaskState,
      by: Actor,
      reason?: string,
    ) => Effect.Effect<Task, TaskTransitionError | TaskNotFoundError | TaskStoreError>;
    readonly record: (
      id: TaskId,
      entry: AttemptRecord | DecisionRecord,
    ) => Effect.Effect<void, TaskNotFoundError | TaskStoreError>;
    /** Ready, unblocked, auto-dispatched kinds in one scope, oldest first. */
    readonly dispatchable: (scope: string) => Effect.Effect<ReadonlyArray<Task>, TaskStoreError>;
    /** What a run that ended without a final state leaves the task as: cancelled→dropped, else ready. */
    readonly runEnded: (id: TaskId, end: RunEnd) => Effect.Effect<void, string>;
    readonly unmirrored: (
      scope: string,
    ) => Effect.Effect<
      ReadonlyArray<Task & { readonly newEntries: ReadonlyArray<TaskEntry> }>,
      TaskStoreError
    >;
    readonly markMirrored: (
      id: TaskId,
      revision: number,
      entryId: string | null,
    ) => Effect.Effect<void, TaskStoreError>;
  }
>()("t3/factory/FactoryTasks") {}

const TIMELINE_PAGE = 100;

const ActorJson = Schema.fromJsonString(Actor);

const TaskRow = Schema.Struct({
  id: TaskId,
  scope: Schema.String,
  number: Schema.Int,
  kind: TaskKind,
  state: TaskState,
  generation: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  labels_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  parent_id: Schema.NullOr(TaskId),
  external_json: Schema.NullOr(Schema.fromJsonString(ExternalIssue)),
  author_json: ActorJson,
  revision: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  blocked: Schema.Int,
  comment_count: Schema.Int,
});
const decodeTaskRow = Schema.decodeUnknownSync(TaskRow);

const EntryRow = Schema.Struct({
  id: Schema.Int,
  at: Schema.String,
  actor_json: ActorJson,
  type: Schema.String,
  payload_json: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeEntryRow = Schema.decodeUnknownSync(EntryRow);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const KIND_PREFIX = TASK_LABEL.kind("build").slice(0, -"build".length);
const isKindLabel = (label: string) => label.startsWith(KIND_PREFIX);

const isTaskKind = Schema.is(TaskKind);

export const TASK_TRACKER_KIND = "t3";
export const TASK_TRACKER_HOST = "t3";
export const TASK_URL_HOST = "app.t3.codes";

const taskUrl = (environmentId: EnvironmentId, scope: string, number: number) => {
  const url = new URL(`https://${TASK_URL_HOST}/issues`);
  url.searchParams.set("selectedEnvironmentId", environmentId);
  url.searchParams.set("selectedProjectId", scope);
  url.searchParams.set("selectedHost", TASK_TRACKER_HOST);
  url.searchParams.set("tracker", TASK_TRACKER_KIND);
  url.searchParams.set("scope", scope);
  url.searchParams.set("key", String(number));
  return url.href;
};

export const displayKey = (task: Pick<Task, "number">) => `T3-${task.number}`;

export const shownLabels = (task: Task) => [
  TASK_LABEL.kind(task.kind),
  ...(task.blocked ? [TASK_LABEL.blocked] : []),
  ...task.labels,
];

const notImplemented = (operation: string) =>
  Effect.fn(`FactoryTasks.${operation}`)(function* (..._: ReadonlyArray<unknown>) {
    return yield* Effect.die(new Error(`FactoryTasks.${operation} is not implemented yet.`));
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const failed =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.mapError(effect, (cause) => new TaskStoreError({ operation, cause }));

  const toTask = (row: unknown): Task => {
    const decoded = decodeTaskRow(row);
    return {
      id: decoded.id,
      scope: decoded.scope,
      number: decoded.number,
      kind: decoded.kind,
      state: decoded.state,
      generation: decoded.generation,
      title: decoded.title,
      body: decoded.body,
      labels: decoded.labels_json,
      parent: decoded.parent_id,
      blocked: decoded.blocked !== 0,
      external: decoded.external_json,
      author: decoded.author_json,
      commentCount: decoded.comment_count,
      url: taskUrl(environmentId, decoded.scope, decoded.number),
      revision: decoded.revision,
      createdAt: decoded.created_at,
      updatedAt: decoded.updated_at,
      closedAt: decoded.closed_at,
    };
  };

  const toEntry = (row: unknown): TaskEntry => {
    const decoded = decodeEntryRow(row);
    return decodeEntry({
      ...decoded.payload_json,
      type: decoded.type,
      id: String(decoded.id),
      at: decoded.at,
      by: decoded.actor_json,
    });
  };

  const selectTasks = sql`
    SELECT t.*, EXISTS (
      SELECT 1 FROM factory_task_edges e JOIN factory_tasks b ON b.id = e.blocker_id
      WHERE e.task_id = t.id AND b.state IN ${sql.in(OPEN_STATES)}
    ) AS blocked, (
      SELECT COUNT(*) FROM factory_task_entries c
      WHERE c.task_id = t.id AND c.type IN ('comment', 'decision')
    ) AS comment_count
    FROM factory_tasks t
  `;

  const only = (task: string) => (rows: ReadonlyArray<unknown>) =>
    rows[0] === undefined
      ? Effect.fail(new TaskNotFoundError({ task }))
      : Effect.succeed(toTask(rows[0]));

  const find = (id: TaskId) =>
    sql`${selectTasks} WHERE t.id = ${id}`.pipe(failed("get"), Effect.flatMap(only(String(id))));

  /**
   * Reads and writes under the writer's lock, so a write that raced this one is checked against
   * the row it left, not overwritten from a stale read.
   */
  const locked = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          SqlError.isSqlError(error) ? new TaskStoreError({ operation, cause: error }) : error,
        ),
      );

  const append = (id: TaskId, at: string, by: Actor, type: TaskEntry["type"], payload: object) =>
    sql<{ readonly id: number }>`
      INSERT INTO factory_task_entries (task_id, at, actor_json, type, payload_json)
      VALUES (${id}, ${at}, ${encodeJson(by)}, ${type}, ${encodeJson(payload)})
      RETURNING id
    `.pipe(Effect.map((rows) => rows[0]!.id));

  const touch = (id: TaskId, at: string) =>
    sql`UPDATE factory_tasks SET revision = revision + 1, updated_at = ${at} WHERE id = ${id}`;

  const appendEntry = (
    operation: string,
    id: TaskId,
    by: Actor,
    type: TaskEntry["type"],
    payload: object,
  ) =>
    Effect.flatMap(now, (at) =>
      locked(
        operation,
        Effect.gen(function* () {
          yield* find(id);
          const entryId = yield* append(id, at, by, type, payload).pipe(failed(operation));
          yield* touch(id, at).pipe(failed(operation));
          return { id: String(entryId), at };
        }),
      ),
    );

  /** `blocked` is dropped: it follows the blockers, and a label edit sends back what it was shown. */
  const splitLabels = Effect.fn("FactoryTasks.splitLabels")(function* (
    shown: ReadonlyArray<string>,
  ) {
    const labels = shown.filter((label) => label !== TASK_LABEL.blocked);
    const kinds = labels.filter(isKindLabel).map((label) => label.slice(KIND_PREFIX.length));
    if (kinds.length > 1) {
      return yield* new TaskInvalidError({ detail: "A task has one kind." });
    }
    const free = [...new Set(labels.filter((label) => !isKindLabel(label)))];
    const kind = kinds[0];
    if (kind === undefined) return { kind: undefined, free };
    if (!isTaskKind(kind)) {
      return yield* new TaskInvalidError({
        detail: `There is no task kind ${kind}. Use one of ${TaskKind.literals.join(", ")}.`,
      });
    }
    return { kind, free };
  });

  /** Refuses a parent that is the task itself or sits under it. */
  const setParent = Effect.fn("FactoryTasks.setParent")(function* (
    id: TaskId,
    parent: TaskId | null,
  ) {
    if (parent !== null) {
      const loops = yield* sql`
        WITH RECURSIVE ancestors(id) AS (
          SELECT ${parent}
          UNION SELECT t.parent_id FROM factory_tasks t JOIN ancestors a ON t.id = a.id
          WHERE t.parent_id IS NOT NULL
        )
        SELECT 1 FROM ancestors WHERE id = ${id}
      `.pipe(failed("update"));
      if (loops.length > 0) {
        return yield* new TaskInvalidError({
          detail: "A task cannot be its own parent, nor sit under one of its own children.",
        });
      }
    }
    yield* sql`UPDATE factory_tasks SET parent_id = ${parent} WHERE id = ${id}`.pipe(
      failed("update"),
    );
  });

  /** Refuses a blocker that is the task itself or waits on it: neither could ever start. */
  const setBlockers = Effect.fn("FactoryTasks.setBlockers")(function* (
    id: TaskId,
    blockers: ReadonlyArray<TaskId>,
  ) {
    const unique = [...new Set(blockers)];
    if (unique.length > 0) {
      const loops = yield* sql`
        WITH RECURSIVE reached(id) AS (
          SELECT id FROM factory_tasks WHERE id IN ${sql.in(unique)}
          UNION SELECT e.blocker_id FROM factory_task_edges e JOIN reached r ON e.task_id = r.id
          WHERE e.blocker_id IS NOT NULL
        )
        SELECT 1 FROM reached WHERE id = ${id}
      `.pipe(failed("update"));
      if (loops.length > 0) {
        return yield* new TaskInvalidError({
          detail: "A task cannot be blocked by itself, nor by a task that waits on it.",
        });
      }
    }
    yield* sql`
      DELETE FROM factory_task_edges WHERE task_id = ${id} AND blocker_id IS NOT NULL
    `.pipe(failed("update"));
    for (const blocker of unique) {
      yield* sql`
        INSERT INTO factory_task_edges (task_id, blocker_id) VALUES (${id}, ${blocker})
      `.pipe(failed("update"));
    }
  });

  const relations: FactoryTasks["Service"]["relations"] = Effect.fn("FactoryTasks.relations")(
    function* (id) {
      const task = yield* find(id);
      const related = (rows: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
        rows.pipe(
          failed("relations"),
          Effect.map((found) => found.map(toTask)),
        );
      return {
        parent: task.parent === null ? null : yield* find(task.parent),
        children: yield* related(sql`${selectTasks} WHERE t.parent_id = ${id} ORDER BY t.id`),
        blockedBy: yield* related(sql`
          ${selectTasks} WHERE t.id IN (
            SELECT blocker_id FROM factory_task_edges WHERE task_id = ${id}
          ) ORDER BY t.id
        `),
        blocking: yield* related(sql`
          ${selectTasks} WHERE t.id IN (
            SELECT task_id FROM factory_task_edges WHERE blocker_id = ${id}
          ) ORDER BY t.id
        `),
      };
    },
  );

  const create: FactoryTasks["Service"]["create"] = Effect.fn("FactoryTasks.create")(
    function* (draft, by) {
      const labels = yield* splitLabels(draft.labels ?? []);
      const kind = draft.kind ?? labels.kind ?? "build";
      const at = yield* now;
      return yield* locked(
        "create",
        Effect.gen(function* () {
          const [next] = yield* sql<{ readonly number: number }>`
            SELECT COALESCE(MAX(number), 0) + 1 AS number FROM factory_tasks
            WHERE scope = ${draft.scope}
          `.pipe(failed("create"));
          const [row] = yield* sql<{ readonly id: number }>`
            INSERT INTO factory_tasks (
              scope, number, kind, state, title, body, labels_json, parent_id,
              author_json, created_at, updated_at
            ) VALUES (
              ${draft.scope}, ${next!.number}, ${kind}, 'ready', ${draft.title}, ${draft.body},
              ${encodeJson(labels.free)}, ${draft.parent ?? null}, ${encodeJson(by)},
              ${at}, ${at}
            )
            RETURNING id
          `.pipe(failed("create"));
          const id = TaskId.make(row!.id);
          if (draft.blockedBy !== undefined) yield* setBlockers(id, draft.blockedBy);
          return yield* find(id);
        }),
      );
    },
  );

  const byKey: FactoryTasks["Service"]["byKey"] = (scope, number) =>
    sql`${selectTasks} WHERE t.scope = ${scope} AND t.number = ${number}`.pipe(
      failed("byKey"),
      Effect.flatMap(only(`${scope}#${number}`)),
    );

  const timeline: FactoryTasks["Service"]["timeline"] = Effect.fn("FactoryTasks.timeline")(
    function* (id, cursor) {
      yield* find(id);
      const before = cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(cursor);
      const rows = yield* sql`
        SELECT id, at, actor_json, type, payload_json FROM factory_task_entries
        WHERE task_id = ${id} AND id < ${before} ORDER BY id DESC LIMIT ${TIMELINE_PAGE + 1}
      `.pipe(failed("timeline"));
      const entries = rows.slice(0, TIMELINE_PAGE).map(toEntry).reverse();
      return {
        entries,
        next: rows.length > TIMELINE_PAGE ? (entries[0]?.id ?? null) : null,
      };
    },
  );

  const list: FactoryTasks["Service"]["list"] = Effect.fn("FactoryTasks.list")(function* (query) {
    const order = query.sort === "created" ? sql`t.created_at DESC` : sql`t.updated_at DESC`;
    const rows =
      yield* sql`${selectTasks} WHERE t.scope = ${query.scope} ORDER BY ${order}, t.id DESC`.pipe(
        failed("list"),
      );
    const wanted = query.labels ?? [];
    const matching = rows
      .map(toTask)
      .filter((task) => query.state === "all" || (query.state === "open") === isOpen(task.state))
      .filter(
        (task) =>
          query.createdBy === undefined ||
          (task.author.kind === "person" && task.author.name === query.createdBy),
      )
      .filter((task) => {
        const shown = shownLabels(task);
        return wanted.every((label) => shown.includes(label));
      });
    // A queue holds tens or hundreds of tasks, so a page is a slice of the whole listing.
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const end = start + query.limit;
    return {
      items: matching.slice(start, end),
      next: end < matching.length ? String(end) : null,
    };
  });

  const update: FactoryTasks["Service"]["update"] = Effect.fn("FactoryTasks.update")(
    function* (id, patch, _by) {
      const labels = patch.labels === undefined ? undefined : yield* splitLabels(patch.labels);
      const at = yield* now;
      return yield* locked(
        "update",
        Effect.gen(function* () {
          const task = yield* find(id);
          yield* sql`
            UPDATE factory_tasks SET
              title = ${patch.title ?? task.title},
              body = ${patch.body ?? task.body},
              kind = ${labels?.kind ?? task.kind},
              labels_json = ${encodeJson(labels?.free ?? task.labels)}
            WHERE id = ${id}
          `.pipe(failed("update"));
          if (patch.parent !== undefined) yield* setParent(id, patch.parent);
          if (patch.blockedBy !== undefined) yield* setBlockers(id, patch.blockedBy);
          yield* touch(id, at).pipe(failed("update"));
          return yield* find(id);
        }),
      );
    },
  );

  const comment: FactoryTasks["Service"]["comment"] = Effect.fn("FactoryTasks.comment")(
    function* (id, body, by) {
      const entry = yield* appendEntry("comment", id, by, "comment", { body });
      return { type: "comment", ...entry, by, body } satisfies TaskEntry;
    },
  );

  /** A dropped blocker will never finish, so each open task it held is told it no longer waits. */
  const unblockDependents = Effect.fn("FactoryTasks.unblockDependents")(function* (
    blocker: Task,
    at: string,
    by: Actor,
  ) {
    const dependents = yield* sql<{ readonly id: number }>`
      SELECT t.id FROM factory_task_edges e JOIN factory_tasks t ON t.id = e.task_id
      WHERE e.blocker_id = ${blocker.id} AND t.state IN ${sql.in(OPEN_STATES)}
    `.pipe(failed("transition"));
    const body = `${blocker.title} (${displayKey(blocker)}) was dropped, so it no longer blocks this task.`;
    for (const dependent of dependents) {
      const id = TaskId.make(dependent.id);
      yield* append(id, at, by, "comment", { body }).pipe(failed("transition"));
      yield* touch(id, at).pipe(failed("transition"));
    }
  });

  const transition: FactoryTasks["Service"]["transition"] = Effect.fn("FactoryTasks.transition")(
    function* (id, to, by, reason) {
      const at = yield* now;
      return yield* locked(
        "transition",
        Effect.gen(function* () {
          const task = yield* find(id);
          // Asked again for where it already is, the move is done: a retried step changes nothing.
          if (task.state === to) return task;
          const refused = refusal(task.state, to, by);
          if (refused !== null) {
            return yield* new TaskTransitionError({ task: String(id), detail: refused });
          }
          yield* sql`
            UPDATE factory_tasks SET
              state = ${to},
              generation = generation + ${revives(task.state, to) ? 1 : 0},
              closed_at = ${isOpen(to) ? null : at}
            WHERE id = ${id}
          `.pipe(failed("transition"));
          yield* append(id, at, by, "state", { from: task.state, to, reason: reason ?? null }).pipe(
            failed("transition"),
          );
          yield* touch(id, at).pipe(failed("transition"));
          if (to === "dropped" && isOpen(task.state)) yield* unblockDependents(task, at, by);
          return yield* find(id);
        }),
      );
    },
  );

  const record: FactoryTasks["Service"]["record"] = Effect.fn("FactoryTasks.record")(
    function* (id, entry) {
      const { type, by, ...payload } = entry;
      yield* appendEntry("record", id, by, type, payload);
    },
  );

  return FactoryTasks.of({
    create,
    get: find,
    byKey,
    timeline,
    list,
    relations,
    update,
    comment,
    transition,
    record,
    dispatchable: notImplemented("dispatchable"),
    runEnded: notImplemented("runEnded"),
    unmirrored: notImplemented("unmirrored"),
    markMirrored: notImplemented("markMirrored"),
  });
});

export const layer = Layer.effect(FactoryTasks, make);
