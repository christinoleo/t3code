/**
 * The factory's task store as a standalone issue tracker, `t3`, so tasks show wherever issues
 * do. It needs no credential: the store is this server's own. A scope is a project here, and a
 * key the task's number in it.
 */
import * as Effect from "effect/Effect";
import {
  IssueTrackerKind,
  ProjectId,
  TASK_STATES,
  TaskState,
  type IssueActor,
  type IssueCapabilities,
  type IssueComment,
  type IssueEvent,
  type IssueRelationRef,
  type IssueRelationTarget,
  type IssueRelationsInput,
  type StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTarget,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  FactoryTasks,
  TASK_TRACKER_HOST,
  TASK_TRACKER_KIND,
  TASK_URL_HOST,
  displayKey,
  shownLabels,
  type Task,
  type TaskEntry,
} from "./FactoryTasks.ts";
import type { Actor } from "./taskModel.ts";

const KIND = IssueTrackerKind.make(TASK_TRACKER_KIND);

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: KIND,
  displayName: "T3 tasks",
  host: TASK_TRACKER_HOST,
  scopeNoun: "queue",
  credential: { label: "None", helpUrl: null },
  credentialFree: true,
};

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: true,
  events: true,
  search: false,
  relations: true,
};

/** Who writes through the tracker: a person in the panel, or an agent on their behalf. */
const VIEWER = "you";
const BY_VIEWER: Actor = { kind: "person", name: VIEWER };

const STATES = TaskState.literals.map((state) => TASK_STATES[state]);

const toActor = (actor: Actor): IssueActor => {
  switch (actor.kind) {
    case "person":
      return { login: actor.name, name: null, avatarUrl: null };
    case "factory":
      return { login: "factory", name: "T3 factory", avatarUrl: null, isBot: true };
    case "agent":
      return { login: "agent", name: null, avatarUrl: null, isBot: true };
    case "tracker":
      return { login: "tracker", name: actor.url, avatarUrl: null, isBot: true };
  }
};

const toRelationTarget = (task: Task): IssueRelationTarget => ({
  scope: task.scope,
  key: String(task.number),
  displayKey: displayKey(task),
  title: task.title,
  url: task.url,
  state: TASK_STATES[task.state],
});

const toSummary = (task: Task): TrackerIssueSummary => ({
  key: String(task.number),
  displayKey: displayKey(task),
  title: task.title,
  url: task.url,
  author: toActor(task.author),
  state: TASK_STATES[task.state],
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  closedAt: task.closedAt,
  assignees: [],
  labels: shownLabels(task).map((name) => ({ name, color: null })),
  commentCount: task.commentCount,
});

const toComment = (entry: TaskEntry): ReadonlyArray<IssueComment> => {
  const comment = (body: string): IssueComment => ({
    id: entry.id,
    author: toActor(entry.by),
    body,
    createdAt: entry.at,
    url: null,
  });
  switch (entry.type) {
    case "comment":
      return [comment(entry.body)];
    case "decision":
      return [
        comment(
          `**Decided:** ${entry.decision.what}\n\n**Why:** ${entry.decision.why}\n\n**Instead of:** ${entry.decision.alternative}`,
        ),
      ];
    default:
      return [];
  }
};

const toEvent = (entry: TaskEntry): ReadonlyArray<IssueEvent> => {
  if (entry.type !== "state") return [];
  const from = TASK_STATES[entry.from].category;
  const to = TASK_STATES[entry.to];
  return [
    {
      id: entry.id,
      kind:
        from === to.category ? "state-changed" : to.category === "closed" ? "closed" : "reopened",
      actor: toActor(entry.by),
      createdAt: entry.at,
      detail: to.name,
    },
  ];
};

/** The task number a key names: a positive decimal, so it reads anywhere an issue number does. */
const parseKey = (key: string) => (/^[1-9]\d*$/.test(key.trim()) ? Number(key.trim()) : null);

export const make = Effect.gen(function* () {
  const tasks = yield* FactoryTasks;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;

  const failed =
    (operation: string) =>
    <A, R>(effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>) =>
      Effect.mapError(
        effect,
        (error) =>
          new IssueTrackerError({
            tracker: KIND,
            operation,
            reason: error._tag === "TaskNotFoundError" ? "not-found" : "failed",
            detail: error.message,
            cause: error,
          }),
      );

  const requireTask = Effect.fn("TaskTracker.requireTask")(function* (
    operation: string,
    input: IssueTarget,
  ) {
    const number = parseKey(input.key);
    if (number === null) {
      return yield* new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "not-found",
        detail: `${input.key} is not a task number.`,
      });
    }
    return yield* tasks.byKey(input.scope, number).pipe(failed(operation));
  });

  const resolveRef = (operation: string, scope: string, ref: IssueRelationRef) =>
    requireTask(operation, {
      cwd: "",
      host: TASK_TRACKER_HOST,
      scope: ref.scope ?? scope,
      key: ref.key,
    }).pipe(Effect.map((task) => task.id));

  const resolveRelations = Effect.fn("TaskTracker.resolveRelations")(function* (
    operation: string,
    scope: string,
    relations: IssueRelationsInput | undefined,
  ) {
    const parent = relations?.parent;
    const blockedBy = relations?.blockedBy;
    return {
      parent:
        parent === undefined
          ? undefined
          : parent === null
            ? null
            : yield* resolveRef(operation, scope, parent),
      blockedBy:
        blockedBy === undefined
          ? undefined
          : yield* Effect.forEach(blockedBy, (ref) => resolveRef(operation, scope, ref)),
    };
  });

  const api: StandaloneIssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    standalone: DESCRIPTOR,

    parseIssueUrl: (url) => {
      if (
        url.host !== TASK_URL_HOST ||
        url.pathname !== "/issues" ||
        url.searchParams.get("tracker") !== TASK_TRACKER_KIND
      ) {
        return null;
      }
      const scope = url.searchParams.get("scope");
      const number = parseKey(url.searchParams.get("key") ?? "");
      const workspace = url.searchParams.get("selectedEnvironmentId");
      if (!scope || number === null || !workspace) return null;
      return { host: TASK_TRACKER_HOST, scope, key: String(number), workspace };
    },

    probeCredential: () =>
      Effect.all({
        descriptor: environment.getDescriptor,
        shells: projects.listShells(),
      }).pipe(
        Effect.map(({ descriptor, shells }) => ({
          account: descriptor.label,
          workspace: environmentId,
          scopes: shells.map((shell) => ({ key: shell.id, name: shell.title })),
        })),
        Effect.mapError(
          (cause) =>
            new IssueTrackerError({
              tracker: KIND,
              operation: "probeCredential",
              reason: "failed",
              detail: "This server's projects could not be read.",
              cause,
            }),
        ),
      ),

    getViewer: () => Effect.succeed(VIEWER),

    listIssues: Effect.fn("TaskTracker.listIssues")(function* (input) {
      // Tasks have no assignees or mentions.
      if (input.involvement === "assigned" || input.involvement === "mentioned") {
        return { items: [], nextCursor: null };
      }
      const page = yield* tasks
        .list({
          scope: input.scope,
          state: input.state,
          labels: input.labels,
          createdBy: input.involvement === "all" ? undefined : input.viewer,
          sort: input.sort,
          limit: input.limit,
          cursor: input.cursor,
        })
        .pipe(failed("listIssues"));
      return { items: page.items.map(toSummary), nextCursor: page.next };
    }),

    getIssue: Effect.fn("TaskTracker.getIssue")(function* (input) {
      const task = yield* requireTask("getIssue", input);
      const timeline = yield* tasks.timeline(task.id).pipe(failed("getIssue"));
      const related = yield* tasks.relations(task.id).pipe(failed("getIssue"));
      return {
        ...toSummary(task),
        body: task.body,
        viewer: VIEWER,
        viewerPermissions: {
          setState: true,
          comment: true,
          edit: true,
          labels: true,
          assignees: false,
        },
        states: STATES,
        comments: timeline.entries.flatMap(toComment),
        commentsCursor: timeline.next,
        events: timeline.entries.flatMap(toEvent),
        linkedPullRequests: [],
        relations: {
          parent: related.parent === null ? null : toRelationTarget(related.parent),
          children: related.children.map(toRelationTarget),
          blockedBy: related.blockedBy.map(toRelationTarget),
          blocking: related.blocking.map(toRelationTarget),
        },
      };
    }),

    getIssueLink: Effect.fn("TaskTracker.getIssueLink")(function* (input) {
      const summary = toSummary(yield* requireTask("getIssueLink", input));
      return { title: summary.title, url: summary.url, displayKey: summary.displayKey };
    }),

    getComments: Effect.fn("TaskTracker.getComments")(function* (input) {
      const task = yield* requireTask("getComments", input);
      const page = yield* tasks.timeline(task.id, input.cursor).pipe(failed("getComments"));
      return { comments: page.entries.flatMap(toComment), nextCursor: page.next };
    }),

    create: Effect.fn("TaskTracker.create")(function* (input) {
      const project = yield* projects.getShell(ProjectId.make(input.scope)).pipe(failed("create"));
      if (project._tag === "None") {
        return yield* new IssueTrackerError({
          tracker: KIND,
          operation: "create",
          reason: "not-found",
          detail: "There is no such project on this server.",
        });
      }
      const { parent, blockedBy } = yield* resolveRelations("create", input.scope, input.relations);
      const task = yield* tasks
        .create(
          {
            scope: input.scope,
            title: input.title,
            body: input.body,
            labels: input.labels,
            parent: parent ?? undefined,
            blockedBy,
          },
          BY_VIEWER,
        )
        .pipe(failed("create"));
      const summary = toSummary(task);
      return { key: summary.key, displayKey: summary.displayKey, url: summary.url };
    }),

    comment: Effect.fn("TaskTracker.comment")(function* (input) {
      const task = yield* requireTask("comment", input);
      yield* tasks.comment(task.id, input.body, BY_VIEWER).pipe(failed("comment"));
    }),

    update: Effect.fn("TaskTracker.update")(function* (input) {
      const task = yield* requireTask("update", input);
      const relations = yield* resolveRelations("update", input.scope, input.relations);
      yield* tasks
        .update(
          task.id,
          { title: input.title, body: input.body, labels: input.labels, ...relations },
          BY_VIEWER,
        )
        .pipe(failed("update"));
    }),

    setState: Effect.fn("TaskTracker.setState")(function* (input) {
      const task = yield* requireTask("setState", input);
      const state = TaskState.literals.find((name) => TASK_STATES[name].name === input.state);
      if (state === undefined) {
        return yield* new IssueTrackerError({
          tracker: KIND,
          operation: "setState",
          reason: "failed",
          detail: `A task has no "${input.state}" state.`,
        });
      }
      yield* tasks.transition(task.id, state, BY_VIEWER).pipe(failed("setState"));
    }),
  };
  return api;
});
