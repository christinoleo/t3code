import * as Schema from "effect/Schema";
import { TASK_STATES, TaskState } from "@t3tools/contracts";

export const Actor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("factory"), runId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("person"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tracker"), url: Schema.String }),
]);
export type Actor = typeof Actor.Type;

export const isOpen = (state: TaskState) => TASK_STATES[state].category === "open";

export const OPEN_STATES = TaskState.literals.filter(isOpen);

type Moves = Partial<Record<TaskState, ReadonlyArray<TaskState>>>;

const outside: Moves = {
  ...Object.fromEntries(OPEN_STATES.map((state) => [state, ["dropped"]])),
  dropped: ["ready"],
};
const byHand: Moves = { ...outside, done: ["ready"] };

const MOVES: Record<Actor["kind"], Moves> = {
  factory: {
    ready: ["building", "needs-you", "dropped"],
    // Research and triage finish without a review.
    building: ["reviewing", "done", "needs-you", "dropped"],
    reviewing: ["building", "done", "needs-you", "dropped"],
    "needs-you": ["building", "reviewing", "ready", "dropped"],
    // A cancelled run drops its task wherever it stands.
    done: ["dropped"],
  },
  person: byHand,
  agent: byHand,
  tracker: outside,
};

export const refusal = (from: TaskState, to: TaskState, actor: Actor): string | null => {
  if (MOVES[actor.kind][from]?.includes(to)) return null;
  if (actor.kind !== "factory" && isOpen(to) && to !== "ready") {
    return `${TASK_STATES[to].name} is set by the factory; answer its Needs-you question instead.`;
  }
  return `A task cannot go from ${TASK_STATES[from].name} to ${TASK_STATES[to].name}.`;
};

/** A closed task brought back is a new generation, so the factory starts a fresh run for it. */
export const revives = (from: TaskState, to: TaskState) => !isOpen(from) && isOpen(to);
