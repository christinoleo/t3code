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

const Seen = Schema.Struct({ wasOpen: Schema.Boolean, commentsAfter: Schema.String });
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
    limit: 100,
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
      const detail = yield* issues.detail(ref);
      const labelled = detail.events.findLast(
        (event) => event.kind === "labeled" && event.detail === label,
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
        yield* seenOf(task).set({ wasOpen: true, commentsAfter: latestComment(detail) });
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
  const mirrored = yield* mirroredTasks(tasks, project.scope);
  for (const task of mirrored.filter(trackerCanMove)) {
    yield* Effect.gen(function* () {
      const detail = yield* issues.detail(task.external.ref);
      const by = { kind: "tracker", url: task.external.url } as const;
      const seenEntry = seenOf(task);
      const seen = Option.getOrElse(yield* seenEntry.get, () => ({
        wasOpen: true,
        commentsAfter: task.createdAt,
      }));
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
  const refOf = (related: Task): IssueRelationRef | null => {
    const external = mirrored.find((found) => found.id === related.id)?.external.ref;
    return external === undefined || !sameTracker(external, ref)
      ? null
      : { scope: external.scope, key: external.key };
  };
  const isTask = (target: IssueRelationRef) =>
    mirrored.some(
      (found) =>
        sameTracker(found.external.ref, ref) &&
        found.external.ref.scope === target.scope &&
        found.external.ref.key === target.key,
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
      const relabel =
        detail.capabilities.labels &&
        (labels.length !== shown.length || labels.some((name) => !shown.includes(name)));
      const relations = yield* relationsToWrite(tasks, { ...task, external }, detail, mirrored);
      if (relabel || relations !== undefined) {
        yield* issues.update({
          ...external.ref,
          ...(relabel ? { labels } : {}),
          ...(relations === undefined ? {} : { relations }),
        });
      }
      for (const entry of task.newEntries) {
        const body = detail.capabilities.comment ? commentFor(task, entry) : null;
        if (body !== null)
          yield* issues.comment({ ...external.ref, body: `${FACTORY_AUTHOR_MARK}\n${body}` });
        yield* tasks.markMirrored(task.id, { entryId: entry.id });
      }
      yield* tasks.markMirrored(task.id, { revision: task.revision });
    }).pipe(logFailureAndContinue("mirror a task to its issue", { task: task.id }));
  }
});
