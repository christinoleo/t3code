import { describe, expect, it } from "vite-plus/test";

import { folderIconsPatchAfterEdit, folderTagChanges } from "./threadTags.ts";

describe("folderTagChanges", () => {
  it.each([
    {
      name: "moves into a new folder before leaving the others",
      tags: ["a", "b"],
      folder: "c",
      expected: [
        { tag: "c", tagged: true },
        { tag: "a", tagged: false },
        { tag: "b", tagged: false },
      ],
    },
    {
      name: "keeps the target and drops the rest",
      tags: ["a", "b"],
      folder: "b",
      expected: [{ tag: "a", tagged: false }],
    },
    { name: "is a no-op when already only in the folder", tags: ["a"], folder: "a", expected: [] },
    {
      name: "moves back to the project by removing every tag",
      tags: ["a", "b"],
      folder: null,
      expected: [
        { tag: "a", tagged: false },
        { tag: "b", tagged: false },
      ],
    },
    { name: "is a no-op back in the project", tags: [], folder: null, expected: [] },
  ])("$name", ({ tags, folder, expected }) => {
    expect(folderTagChanges(tags, folder)).toEqual(expected);
  });
});

describe("folderIconsPatchAfterEdit", () => {
  it("moves a renamed folder's icon and drops a deleted one", () => {
    const rocket = { kind: "emoji", emoji: "🚀" } as const;
    const star = { kind: "emoji", emoji: "⭐" } as const;
    const icons = { ops: rocket, infra: star };
    expect(folderIconsPatchAfterEdit(icons, "ops", "build")).toEqual({ ops: null, build: rocket });
    // Merging keeps the target folder's own icon.
    expect(folderIconsPatchAfterEdit(icons, "ops", "infra")).toEqual({ ops: null });
    expect(folderIconsPatchAfterEdit(icons, "ops", null)).toEqual({ ops: null });
    expect(folderIconsPatchAfterEdit(icons, "docs", "build")).toBeNull();
    // A folder that kept threads after a partial failure keeps its icon.
    expect(folderIconsPatchAfterEdit(icons, "ops", "build", true)).toEqual({ build: rocket });
    expect(folderIconsPatchAfterEdit(icons, "ops", null, true)).toBeNull();
  });
});
