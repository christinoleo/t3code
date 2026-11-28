import {
  type IssueDetail,
  type IssueRef,
  type IssueRelationRef,
  type IssueRelationsInput,
  type IssueSummary,
  TASK_STATES,
  TASK_TRACKER_KIND,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueService } from "../issue/IssueService.ts";
import { store } from "../workflows/stepServices.ts";
import type { FactoryProject } from "./FactorySettings.ts";
import { displayKey, type FactoryTasks, type Task, type TaskEntry } from "./FactoryTasks.ts";
import { isOpen } from "./taskModel.ts";

export type MirrorIssues = Pick<IssueService["Service"], "list" | "detail" | "comment" | "update">;

const FACTORY_AUTHOR_MARK = "<!-- t3-factory -->";
const STATE_LABEL_PREFIX = "factory/";

const Seen = Schema.Struct({
  wasOpen: Schema.Boolean,
  commentsAfter: Schema.String,
  updatedAt: Schema.optional(Schema.String),
});
const LISTED = 100;
const seenOf = (task: Task) => store.entry(`factory/mirror/${task.id}`, Seen);
const judgedOf = (scope: string, issue: IssueSummary) =>
  store.entry(
    `factory/intake/${scope}/${issue.tracker} ${issue.host} ${issue.scope} ${issue.key}`,
    Schema.String,
  );

const time = (iso: string) => Date.parse(iso);

type Mirrored = Task & { readonly external: NonNullable<Task["external"]> };

const sameTracker = (a: IssueRef, b: Pick<IssueRef, "tracker" | "host">) =>
  a.tracker === b.tracker && (a.host ?? null) === (b.host ?? null);
const sameIssue = (a: IssueRef, b: Pick<IssueRef, "tracker" | "host" | "scope" | "key">) =>
  sameTracker(a, b) && a.scope === b.scope && a.key === b.key;

const mirroredTasks = Effect.fnUntraced(function* (tasks: FactoryTasks["Service"], scope: string) {
  const { items } = yield* tasks.list({ scope, state: "all", limit: 100_000 });
  return items.filter((task): task is Mirrored => task.external !== null);
});

const logFailureAndContinue = (what: string, about: Record<string, unknown>) =>
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(`factory could not ${what}`, { ...about, cause }),
  );

const trackerCanMove = (task: Task) => task.state !== "done";

const latestComment = (detail: IssueDetail) =>
  detail.comments.reduce(
    (latest, comment) => (time(comment.createdAt) > time(latest) ? comment.createdAt : latest),
    detail.createdAt,
  );

export const intake = Effect.fn("TrackerMirror.intake")(function* (
  tasks: FactoryTasks["Service"],
  issues: MirrorIssues,
  project: FactoryProject,
) {
  const label = project.settings.intake.trackerLabel;
  const since = project.settings.enabledAt;
  if (label === null || since === null) return;
  const listed = yield* issues.list({
    projectId: project.id,
    state: "open",
    labels: [label],
    limit: LISTED,
    sort: "updated",
  });
  const mirrored = yield* mirroredTasks(tasks, project.scope);
  for (const issue of listed.entries) {
    // A label added later bumps the issue's update time, so an older one was labelled before.
    if (issue.tracker === TASK_TRACKER_KIND || time(issue.updatedAt) < time(since)) continue;
    if (mirrored.some((task) => sameIssue(task.external.ref, issue))) continue;
    const judged = judgedOf(project.scope, issue);
    if (Option.getOrUndefined(yield* judged.get) === issue.updatedAt) continue;
    yield* Effect.gen(function* () {
      const ref: IssueRef = {
        projectId: project.id,
        tracker: issue.tracker,
        host: issue.host,
        scope: issue.scope,
        key: issue.key,
      };
      // The cache may predate the label the listing just showed.
      const detail = yield* issues.detail({ ...ref, refresh: true });
      const labelled = detail.events.findLast(
        (event) => event.kind === "labeled" && event.detail?.toLowerCase() === label.toLowerCase(),
      );
      if (labelled !== undefined && time(labelled.createdAt) >= time(since)) {
        const task = yield* tasks.create(
          {
            scope: project.scope,
            title: detail.title,
            body: detail.body,
            external: { ref, url: detail.url },
          },
          { kind: "tracker", url: detail.url },
        );
        yield* seenOf(task).set({
          wasOpen: true,
          commentsAfter: latestComment(detail),
          updatedAt: detail.updatedAt,
        });
      }
      yield* judged.set(issue.updatedAt);
    }).pipe(logFailureAndContinue("file an issue", { issue: issue.url }));
  }
});

export const reconcile = Effect.fn("TrackerMirror.reconcile")(function* (
  tasks: FactoryTasks["Service"],
  issues: MirrorIssues,
  project: FactoryProject,
) {
  const watched = (yield* mirroredTasks(tasks, project.scope)).filter(trackerCanMove);
  if (watched.length === 0) return;
  const listed = yield* issues.list({
    projectId: project.id,
    state: "all",
    limit: LISTED,
    sort: "updated",
  });
  // Dropped tasks pile up, so only an issue the listing shows as changed gets a full read.
  const unchanged = (ref: IssueRef, seenAt: string | undefined) => {
    if (seenAt === undefined) return false;
    const inScope = listed.entries.filter(
      (entry) => sameTracker(entry, ref) && entry.scope === ref.scope,
    );
    const found = inScope.find((entry) => entry.key === ref.key);
    if (found !== undefined) return found.updatedAt === seenAt;
    // Missing from a full page means a hundred issues changed after it, all later than `seenAt`
    // if it changed too.
    return (
      inScope.length >= LISTED &&
      Math.min(...inScope.map((entry) => time(entry.updatedAt))) <= time(seenAt)
    );
  };
  for (const task of watched) {
    yield* Effect.gen(function* () {
      const seenEntry = seenOf(task);
      const seen: typeof Seen.Type = Option.getOrElse(yield* seenEntry.get, () => ({
        wasOpen: true,
        commentsAfter: task.createdAt,
      }));
      if (unchanged(task.external.ref, seen.updatedAt)) return;
      const detail = yield* issues.detail(task.external.ref);
      const by = { kind: "tracker", url: task.external.url } as const;
      const open = detail.state.category === "open";
      let state = task.state;
      if (seen.wasOpen && !open && isOpen(state)) {
        state = (yield* tasks.transition(task.id, "dropped", by, "Its issue was closed.")).state;
      } else if (!seen.wasOpen && open && state === "dropped") {
        state = (yield* tasks.transition(task.id, "ready", by, "Its issue was reopened.")).state;
      }
      const fresh = detail.comments
        .filter((comment) => time(comment.createdAt) > time(seen.commentsAfter))
        .toSorted((a, b) => time(a.createdAt) - time(b.createdAt));
      for (const comment of fresh) {
        if (!isOpen(state) || comment.body.includes(FACTORY_AUTHOR_MARK)) continue;
        yield* tasks.comment(task.id, comment.body, {
          kind: "tracker",
          url: comment.url ?? task.external.url,
        });
      }
      yield* seenEntry.set({
        wasOpen: open,
        commentsAfter: fresh.at(-1)?.createdAt ?? seen.commentsAfter,
        updatedAt: detail.updatedAt,
      });
    }).pipe(logFailureAndContinue("read a mirrored issue", { task: task.id }));
  }
});

const commentFor = (task: Task, entry: TaskEntry): string | null => {
  if (entry.by.kind === "tracker") return null;
  switch (entry.type) {
    case "state": {
      const reason = entry.reason === null ? "" : `\n\n${entry.reason}`;
      const reply = entry.to === "needs-you" ? "\n\nReply here to answer." : "";
      return `**${displayKey(task)}** is now ${TASK_STATES[entry.to].name}.${reason}${reply}`;
    }
    case "decision":
      return `**Decided:** ${entry.decision.what}\n\n**Why:** ${entry.decision.why}\n\n**Instead of:** ${entry.decision.alternative}`;
    case "comment":
      return entry.body;
    case "attempt":
      return null;
  }
};

const relationsToWrite = Effect.fnUntraced(function* (
  tasks: FactoryTasks["Service"],
  task: Mirrored,
  detail: IssueDetail,
  mirrored: ReadonlyArray<Mirrored>,
) {
  const current = detail.relations;
  if (current === undefined || detail.capabilities.relations !== true) return undefined;
  const ref = task.external.ref;
  const refOf = (related: Task): IssueRelationRef | null =>
    related.external === null || !sameTracker(related.external.ref, ref)
      ? null
      : { scope: related.external.ref.scope, key: related.external.ref.key };
  const isTask = (target: IssueRelationRef) =>
    mirrored.some((found) =>
      sameIssue(found.external.ref, { ...ref, scope: target.scope ?? ref.scope, key: target.key }),
    );
  const keyOf = (target: IssueRelationRef) => `${target.scope ?? ref.scope} ${target.key}`;
  const stored = yield* tasks.relations(task.id);
  const write: { parent?: IssueRelationRef | null; blockedBy?: ReadonlyArray<IssueRelationRef> } =
    {};

  const parent = stored.parent === null ? null : refOf(stored.parent);
  const shownParent = current.parent;
  if (parent !== null) {
    if (shownParent === null || keyOf(shownParent) !== keyOf(parent)) write.parent = parent;
  } else if (shownParent !== null && isTask(shownParent)) {
    write.parent = null;
  }

  const blockers = stored.blockedBy.flatMap((blocker) => {
    const found = refOf(blocker);
    return found === null ? [] : [found];
  });
  const kept = current.blockedBy.filter((target) => !isTask(target));
  const wanted = [...kept.map((target) => ({ scope: target.scope, key: target.key })), ...blockers];
  const shown = new Set(current.blockedBy.map(keyOf));
  if (wanted.length !== shown.size || wanted.some((target) => !shown.has(keyOf(target)))) {
    write.blockedBy = wanted;
  }
  return Object.keys(write).length === 0 ? undefined : (write satisfies IssueRelationsInput);
});

export const send = Effect.fn("TrackerMirror.send")(function* (
  tasks: FactoryTasks["Service"],
  issues: MirrorIssues,
  project: FactoryProject,
) {
  const pending = yield* tasks.unmirrored(project.scope);
  if (pending.length === 0) return;
  const mirrored = yield* mirroredTasks(tasks, project.scope);
  for (const task of pending) {
    const external = task.external;
    if (external === null) continue;
    yield* Effect.gen(function* () {
      const detail = yield* issues.detail(external.ref);
      const shown = detail.labels.map((label) => label.name);
      const labels = [
        ...shown.filter((name) => !name.startsWith(STATE_LABEL_PREFIX)),
        `${STATE_LABEL_PREFIX}${task.state}`,
      ];
      // An upstream issue of a fork is read-only, so its task is mirrored in only.
      const writable = detail.writable;
      const relabel =
        writable &&
        detail.capabilities.labels &&
        (labels.length !== shown.length || labels.some((name) => !shown.includes(name)));
      const relations = writable
        ? yield* relationsToWrite(tasks, { ...task, external }, detail, mirrored)
        : undefined;
      // A refused label or link must not hold back the comments; it is retried next tick.
      const updated =
        !relabel && relations === undefined
          ? true
          : yield* issues
              .update({
                ...external.ref,
                ...(relabel ? { labels } : {}),
                ...(relations === undefined ? {} : { relations }),
              })
              .pipe(
                Effect.as(true),
                logFailureAndContinue("label or link an issue", { task: task.id }),
                Effect.map((done) => done === true),
              );
      for (const entry of task.newEntries) {
        const body = writable && detail.capabilities.comment ? commentFor(task, entry) : null;
        if (body !== null)
          yield* issues.comment({ ...external.ref, body: `${FACTORY_AUTHOR_MARK}\n${body}` });
        yield* tasks.markMirrored(task.id, { entryId: entry.id });
      }
      if (updated) yield* tasks.markMirrored(task.id, { revision: task.revision });
    }).pipe(logFailureAndContinue("mirror a task to its issue", { task: task.id }));
  }
});
