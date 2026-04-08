import { afterEach, describe, expect, it } from "vitest";

import { checkPaths } from "../src/checker.js";
import { cleanupTempProject, createTempProject } from "./helpers/temp-project.js";

describe("third-party resolution", () => {
  const projects: string[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) {
      cleanupTempProject(project);
    }
  });

  it("detects shorter imports from installed third-party packages", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "src/app.ts": `import { PublicThing } from "pkg/deep/internal";`,
      "node_modules/pkg/package.json": JSON.stringify(
        {
          name: "pkg",
          exports: {
            ".": "./dist/index.js",
          },
        },
        null,
        2,
      ),
      "node_modules/pkg/dist/index.js": `export { PublicThing } from "./internal.js";`,
      "node_modules/pkg/dist/internal.js": `export const PublicThing = 1;`,
      "node_modules/pkg/deep/internal.js": `export { PublicThing } from "../dist/internal.js";`,
    });
    projects.push(project);

    const result = checkPaths(["src"], { cwd: project });

    expect(result.violations).toEqual([
      expect.objectContaining({
        originalPath: "pkg/deep/internal",
        shorterPath: "pkg",
        name: "PublicThing",
      }),
    ]);
  });

  it("prefers package exports over conflicting filesystem entrypoints", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "src/app.ts": `import { PublicThing } from "pkg/deep/internal";`,
      "node_modules/pkg/package.json": JSON.stringify(
        {
          name: "pkg",
          exports: {
            ".": "./dist/index.js",
          },
        },
        null,
        2,
      ),
      "node_modules/pkg/index.js": `export const PublicThing = "wrong";`,
      "node_modules/pkg/dist/index.js": `export { PublicThing } from "./internal.js";`,
      "node_modules/pkg/dist/internal.js": `export const PublicThing = 1;`,
      "node_modules/pkg/deep/internal.js": `export { PublicThing } from "../dist/internal.js";`,
    });
    projects.push(project);

    const result = checkPaths(["src"], { cwd: project });

    expect(result.violations[0]).toMatchObject({
      shorterPath: "pkg",
    });
  });

  it("skips missing third-party packages without crashing", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "src/app.ts": `import { Missing } from "missing-package/internal";`,
    });
    projects.push(project);

    const result = checkPaths(["src"], { cwd: project });

    expect(result.violations).toEqual([]);
    expect(result.filesSkipped).toBe(0);
  });
});
