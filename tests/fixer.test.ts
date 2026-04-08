import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkAndFixPaths } from "../src/checker.js";
import { parseSourceFile } from "../src/import-parser.js";
import { cleanupTempProject, createTempProject, readProjectFile } from "./helpers/temp-project.js";

describe("checkAndFixPaths", () => {
  const projects: string[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) {
      cleanupTempProject(project);
    }
  });

  it("rewrites whole imports and splits partially fixable named imports", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }, null, 2),
      "src/app.ts": `
import { User, KeepDeep } from "./domain/user/models";
import { Service as Alias } from "./services/internal/impl";
import type { Shape } from "./types/internal/models";
`,
      "src/domain/index.ts": `export { User } from "./user";`,
      "src/domain/user/index.ts": `export { User } from "./models";`,
      "src/domain/user/models.ts": `
export interface User { id: string }
export interface KeepDeep { flag: boolean }
`,
      "src/services/index.ts": `export { Service } from "./internal/impl";`,
      "src/services/internal/impl.ts": `export class Service {}`,
      "src/types/index.ts": `export type { Shape } from "./internal/models";`,
      "src/types/internal/models.ts": `export interface Shape { kind: string }`,
    });
    projects.push(project);

    const result = checkAndFixPaths(["src"], { cwd: project });
    const fixedSource = readProjectFile(project, "src/app.ts");

    expect(result.checkResult.violations).toHaveLength(3);
    expect(result.fixResult).toEqual({
      filesModified: 1,
      fixesApplied: 3,
    });
    expect(fixedSource.trim()).toBe(
      [
        'import { KeepDeep } from "./domain/user/models";',
        'import { User } from "./domain";',
        'import { Service as Alias } from "./services";',
        'import type { Shape } from "./types";',
      ].join("\n"),
    );

    const reparsed = parseSourceFile(path.join(project, "src/app.ts"), fixedSource);
    expect(reparsed.ok).toBe(true);
  });

  it("does not modify files when no safe fix exists", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }, null, 2),
      "src/app.ts": `import { Conflict } from "./feature/deep/internal";`,
      "src/feature/index.ts": `
export { Conflict } from "./alpha";
export { Conflict } from "./beta";
`,
      "src/feature/alpha.ts": `export const Conflict = 1;`,
      "src/feature/beta.ts": `export const Conflict = 2;`,
      "src/feature/deep/internal.ts": `export { Conflict } from "../alpha";`,
    });
    projects.push(project);

    const before = readProjectFile(project, "src/app.ts");
    const result = checkAndFixPaths(["src"], { cwd: project });
    const after = readProjectFile(project, "src/app.ts");

    expect(result.checkResult.violations).toEqual([]);
    expect(result.fixResult).toEqual({
      filesModified: 0,
      fixesApplied: 0,
    });
    expect(after).toBe(before);
  });
});
