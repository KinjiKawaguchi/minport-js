import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkPaths } from "../src/checker.js";
import { cleanupTempProject, createTempProject } from "./helpers/temp-project.js";

describe("edge cases", () => {
  const projects: string[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) {
      cleanupTempProject(project);
    }
  });

  it("handles empty files, tsx/mts files, and dynamic imports", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "src/empty.ts": "",
      "src/component.tsx": `export const Component = () => <div />;`,
      "src/module.mts": `const value = await import("./dynamic.js"); export { value };`,
    });
    projects.push(project);

    const result = checkPaths(["src"], { cwd: project });

    expect(result.filesChecked).toBe(3);
    expect(result.filesSkipped).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("skips duplicate symlink targets and unsupported files", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "src/original.ts": `export const Value = 1;`,
      "src/link.ts": { symlink: path.join("original.ts") },
      "src/image.png": new Uint8Array([137, 80, 78, 71]),
    });
    projects.push(project);

    const result = checkPaths(["src"], { cwd: project });

    expect(result.filesChecked).toBe(1);
    expect(result.filesSkipped).toBe(0);
  });

  it("gracefully handles invalid package and tsconfig configuration files", () => {
    const project = createTempProject({
      "package.json": "{not-valid-json",
      "tsconfig.json": "{not-valid-json",
      "src/app.ts": `import { Value } from "./lib/deep/file";`,
      "src/lib/index.ts": `export { Value } from "./deep/file";`,
      "src/lib/deep/file.ts": `export const Value = 1;`,
    });
    projects.push(project);

    const result = checkPaths(["src"], { cwd: project });

    expect(result.violations).toEqual([
      expect.objectContaining({
        shorterPath: "./lib",
      }),
    ]);
  });
});
