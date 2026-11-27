import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { ProjectIconOverride } from "./project.ts";

/** Tags match by exact spelling and case after trimming. */
export const ThreadTag = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    /[\p{Cc}]/u.test(value) ? "A thread tag must be a single line of text." : true,
  ),
);
export type ThreadTag = typeof ThreadTag.Type;

/** Tags read back from storage or a peer. Lenient so a later tag rule never fails a whole thread. */
export const StoredThreadTags = Schema.Array(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeedSome([])),
);

export interface ThreadFolderTagChange {
  readonly tag: string;
  readonly tagged: boolean;
}

/** Adds the folder before removing other tags, so a partial failure never drops the thread back to its project. */
export function folderTagChanges(
  currentTags: ReadonlyArray<string>,
  folder: string | null,
): ReadonlyArray<ThreadFolderTagChange> {
  const removals = currentTags
    .filter((tag) => tag !== folder)
    .map((tag) => ({ tag, tagged: false }));
  return folder === null || currentTags.includes(folder)
    ? removals
    : [{ tag: folder, tagged: true }, ...removals];
}

/**
 * The `folderIcons` settings patch that moves folder `from`'s icon to `to`, or
 * drops it when `to` is null. A merge keeps the target folder's own icon, and
 * a `from` that kept some threads after a partial failure keeps its icon too.
 */
export function folderIconsPatchAfterEdit(
  icons: Readonly<Record<string, ProjectIconOverride>>,
  from: string,
  to: string | null,
  fromSurvives = false,
): Record<string, ProjectIconOverride | null> | null {
  const icon = icons[from];
  if (icon === undefined || from === to) return null;
  const patch: Record<string, ProjectIconOverride | null> = fromSurvives ? {} : { [from]: null };
  if (to !== null && icons[to] === undefined) patch[to] = icon;
  return Object.keys(patch).length > 0 ? patch : null;
}
