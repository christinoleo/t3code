// @effect-diagnostics nodeBuiltinImport:off - reads the repo's workflow skills.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const skillsRoot = NodeURL.fileURLToPath(new URL("../workflow/skills", import.meta.url));

// Many agents run these skills at once against the same release, so one overwriting
// a name it did not just create destroys another agent's work.
it("no workflow skill overwrites a shared upload", () => {
  const overwrites = NodeFS.readdirSync(skillsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .flatMap((entry) => {
      const path = NodePath.join(entry.parentPath, entry.name);
      return NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          line.includes("--clobber")
            ? [
                `${NodePath.relative(skillsRoot, path)}:${index + 1}: drop --clobber, pick an unused name`,
              ]
            : [],
        );
    });
  expect(overwrites).toEqual([]);
});
