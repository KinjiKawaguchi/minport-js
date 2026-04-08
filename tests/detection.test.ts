import { afterEach, describe, expect, it } from "vitest";

import { checkPaths } from "../src/checker.js";
import { cleanupTempProject, createTempProject } from "./helpers/temp-project.js";

describe("checkPaths", () => {
  const projects: string[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) {
      cleanupTempProject(project);
    }
  });

  it("detects shortest imports for multiple bindings, aliases, and type-only imports", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }, null, 2),
      "src/app.ts": `
import { User, Settings } from "./domain/user/models";
import { Service as Alias } from "./services/internal/impl";
import type { Shape } from "./types/internal/models";
`,
      "src/domain/index.ts": `export { User, Settings } from "./user";`,
      "src/domain/user/index.ts": `export { User, Settings } from "./models";`,
      "src/domain/user/models.ts": `
export interface User { id: string }
export interface Settings { theme: string }
`,
      "src/services/index.ts": `export { Service } from "./internal/impl";`,
      "src/services/internal/impl.ts": `export class Service {}`,
      "src/types/index.ts": `export type { Shape } from "./internal/models";`,
      "src/types/internal/models.ts": `export interface Shape { kind: string }`,
    });
    projects.push(project);

    const result = checkPaths(["src"], { cwd: project });

    expect(result.filesChecked).toBe(8);
    expect(result.filesSkipped).toBe(0);
    expect(result.violations).toEqual([
      expect.objectContaining({
        filePath: expect.stringContaining("/src/app.ts"),
        originalPath: "./domain/user/models",
        shorterPath: "./domain",
        name: "Settings",
      }),
      expect.objectContaining({
        originalPath: "./domain/user/models",
        shorterPath: "./domain",
        name: "User",
      }),
      expect.objectContaining({
        originalPath: "./services/internal/impl",
        shorterPath: "./services",
        name: "Service",
      }),
      expect.objectContaining({
        originalPath: "./types/internal/models",
        shorterPath: "./types",
        name: "Shape",
      }),
    ]);
  });

  it("respects package.json excludes and inline ignore comments", () => {
    const project = createTempProject({
      "package.json": JSON.stringify(
        {
          name: "fixture",
          minport: {
            exclude: ["src/excluded/**"],
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }, null, 2),
      "src/index.ts": `export { Thing } from "./deep";`,
      "src/deep.ts": `export const Thing = 1;`,
      "src/app.ts": `import { Thing } from "./deep"; // minport-ignore`,
      "src/excluded/file.ts": `import { Thing } from "../deep";`,
    });
    projects.push(project);

    const result = checkPaths(["src"], { cwd: project });

    expect(result.violations).toEqual([]);
    expect(result.filesChecked).toBe(3);
  });

  it("skips syntax errors and surfaces read warnings", () => {
    const warnings: string[] = [];
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "src/broken.ts": "import { Foo from './foo';",
      "src/ok.ts": "export const Ok = 1;",
    });
    projects.push(project);

    const result = checkPaths(["src"], {
      cwd: project,
      reporter: {
        warn(message: string): void {
          warnings.push(message);
        },
      },
    });

    expect(result.filesChecked).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(warnings[0]).toContain("broken.ts");
  });

  it("throws on missing targets", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
    });
    projects.push(project);

    expect(() => checkPaths(["missing"], { cwd: project })).toThrowError(/Target does not exist/);
  });
});
