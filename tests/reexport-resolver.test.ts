import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSourceFile } from "../src/import-parser.js";
import { ReexportResolver } from "../src/reexport-resolver.js";
import { cleanupTempProject, createTempProject, readProjectFile } from "./helpers/temp-project.js";

describe("ReexportResolver", () => {
  const projects: string[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) {
      cleanupTempProject(project);
    }
  });

  it("finds the shortest project re-export chain", () => {
    const project = createTempProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "src/app.ts": `import { Thing } from "./lib/deep/internal";`,
      "src/lib/index.ts": `export { Thing } from "./deep";`,
      "src/lib/deep/index.ts": `export { Thing } from "./internal";`,
      "src/lib/deep/internal.ts": `export const Thing = 1;`,
    });
    projects.push(project);

    const source = readProjectFile(project, "src/app.ts");
    const parsed = parseSourceFile(path.join(project, "src/app.ts"), source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const resolver = new ReexportResolver(project, { baseUrl: undefined, paths: [] }, undefined);

    expect(resolver.findShorterPath(parsed.parsed.namedImports[0])).toBe("./lib");
  });

  it("supports renamed and default re-exports", () => {
    const project = createTempProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "src/app.ts": `
import { Alias } from "./lib/internal";
import { DefaultThing } from "./components/button";
`,
      "src/lib/index.ts": `export { Alias } from "./internal";`,
      "src/lib/internal.ts": `export { Original as Alias } from "./deep";`,
      "src/lib/deep.ts": `export const Original = 1;`,
      "src/components/index.ts": `export { DefaultThing } from "./button";`,
      "src/components/button.ts": `export { default as DefaultThing } from "./button/impl";`,
      "src/components/button/impl.ts": `export default class DefaultThing {}`,
    });
    projects.push(project);

    const parsed = parseSourceFile(
      path.join(project, "src/app.ts"),
      readProjectFile(project, "src/app.ts"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const resolver = new ReexportResolver(project, { baseUrl: undefined, paths: [] }, undefined);

    expect(resolver.findShorterPath(parsed.parsed.namedImports[0])).toBe("./lib");
    expect(resolver.findShorterPath(parsed.parsed.namedImports[1])).toBe("./components");
  });

  it("resolves tsconfig path aliases and skips ambiguous exports", () => {
    const project = createTempProject({
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@app/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "src/app.ts": `
import { User } from "@app/domain/user/models";
import { Conflict } from "@app/feature/deep/internal";
`,
      "src/domain/index.ts": `export { User } from "./user";`,
      "src/domain/user/index.ts": `export { User } from "./models";`,
      "src/domain/user/models.ts": `export interface User { id: string }`,
      "src/feature/index.ts": `
export { Conflict } from "./alpha";
export { Conflict } from "./beta";
`,
      "src/feature/alpha.ts": `export const Conflict = 1;`,
      "src/feature/beta.ts": `export const Conflict = 2;`,
      "src/feature/deep/internal.ts": `export { Conflict } from "../alpha";`,
    });
    projects.push(project);

    const parsed = parseSourceFile(
      path.join(project, "src/app.ts"),
      readProjectFile(project, "src/app.ts"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const resolver = new ReexportResolver(
      project,
      { baseUrl: project, paths: [{ pattern: "@app/*", replacements: ["src/*"] }] },
      undefined,
    );

    expect(resolver.findShorterPath(parsed.parsed.namedImports[0])).toBe("@app/domain");
    expect(resolver.findShorterPath(parsed.parsed.namedImports[1])).toBeUndefined();
  });

  it("avoids infinite loops and can resolve third-party package exports", () => {
    const warnings: string[] = [];
    const project = createTempProject({
      "src/app.ts": `
import { Loop } from "./loop/deep";
import { PublicThing } from "third-party/deep/internal";
`,
      "src/loop/index.ts": `export { Loop } from "./deep";`,
      "src/loop/deep.ts": `export { Loop } from "./index";`,
      "node_modules/third-party/package.json": JSON.stringify(
        {
          name: "third-party",
          exports: {
            ".": "./dist/index.js",
          },
        },
        null,
        2,
      ),
      "node_modules/third-party/dist/index.js": `export { PublicThing } from "./internal.js";`,
      "node_modules/third-party/dist/internal.js": `export const PublicThing = 1;`,
      "node_modules/third-party/deep/internal.js": `export { PublicThing } from "../dist/internal.js";`,
    });
    projects.push(project);

    const parsed = parseSourceFile(
      path.join(project, "src/app.ts"),
      readProjectFile(project, "src/app.ts"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const resolver = new ReexportResolver(
      project,
      { baseUrl: undefined, paths: [] },
      {
        warn(message: string): void {
          warnings.push(message);
        },
      },
    );

    expect(resolver.findShorterPath(parsed.parsed.namedImports[0])).toBeUndefined();
    expect(resolver.findShorterPath(parsed.parsed.namedImports[1])).toBe("third-party");
    expect(warnings).toEqual([]);
  });
});
