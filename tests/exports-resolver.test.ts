import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExportsResolver } from "../src/exports-resolver.js";
import { cleanupTempProject, createTempProject } from "./helpers/temp-project.js";

describe("ExportsResolver", () => {
  const projects: string[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) {
      cleanupTempProject(project);
    }
  });

  it("resolves root, subpath, conditional, wildcard, and scoped package exports", () => {
    const project = createTempProject({
      "src/app.ts": "export {};",
      "node_modules/pkg/package.json": JSON.stringify(
        {
          name: "pkg",
          exports: {
            ".": {
              types: "./types/index.d.ts",
              import: "./dist/index.js",
            },
            "./utils": "./dist/utils/index.js",
            "./components/*": {
              import: "./dist/components/*/index.js",
            },
          },
        },
        null,
        2,
      ),
      "node_modules/pkg/dist/index.js": "export { Foo } from './internal.js';",
      "node_modules/pkg/dist/internal.js": "export const Foo = 1;",
      "node_modules/pkg/dist/utils/index.js": "export const Utils = 1;",
      "node_modules/pkg/dist/components/button/index.js": "export const Button = 1;",
      "node_modules/pkg/types/index.d.ts": "export interface Foo {}",
      "node_modules/@scope/pkg/package.json": JSON.stringify(
        {
          name: "@scope/pkg",
          exports: {
            ".": "./index.js",
          },
        },
        null,
        2,
      ),
      "node_modules/@scope/pkg/index.js": "export const Scoped = 1;",
    });
    projects.push(project);

    const resolver = new ExportsResolver(project);
    const importer = path.join(project, "src/app.ts");

    expect(resolver.resolvePackageSpecifier(importer, "pkg", false)?.resolvedFilePath).toBe(
      path.join(project, "node_modules/pkg/dist/index.js"),
    );
    expect(resolver.resolvePackageSpecifier(importer, "pkg/utils", false)?.resolvedFilePath).toBe(
      path.join(project, "node_modules/pkg/dist/utils/index.js"),
    );
    expect(
      resolver.resolvePackageSpecifier(importer, "pkg/components/button", false)?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/pkg/dist/components/button/index.js"));
    expect(resolver.resolvePackageSpecifier(importer, "@scope/pkg", false)?.resolvedFilePath).toBe(
      path.join(project, "node_modules/@scope/pkg/index.js"),
    );
  });

  it("falls back to package roots and private subpaths only when allowed", () => {
    const project = createTempProject({
      "src/app.ts": "export {};",
      "node_modules/no-exports/package.json": JSON.stringify(
        {
          name: "no-exports",
          module: "./esm/index.js",
          main: "./cjs/index.js",
        },
        null,
        2,
      ),
      "node_modules/no-exports/esm/index.js": "export const Root = 1;",
      "node_modules/no-exports/internal/file.js": "export const Hidden = 1;",
      "node_modules/with-exports/package.json": JSON.stringify(
        {
          name: "with-exports",
          exports: {
            ".": "./dist/index.js",
          },
        },
        null,
        2,
      ),
      "node_modules/with-exports/dist/index.js": "export const Public = 1;",
      "node_modules/with-exports/private.js": "export const Private = 1;",
    });
    projects.push(project);

    const resolver = new ExportsResolver(project);
    const importer = path.join(project, "src/app.ts");

    expect(resolver.resolvePackageSpecifier(importer, "no-exports", false)?.resolvedFilePath).toBe(
      path.join(project, "node_modules/no-exports/esm/index.js"),
    );
    expect(
      resolver.resolvePackageSpecifier(importer, "no-exports/internal/file", false)
        ?.resolvedFilePath,
    ).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier(importer, "no-exports/internal/file", true)
        ?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/no-exports/internal/file.js"));

    expect(
      resolver.resolvePackageSpecifier(importer, "with-exports/private", false)?.resolvedFilePath,
    ).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier(importer, "with-exports/private", true)?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/with-exports/private.js"));
  });

  it("returns undefined for missing packages and malformed manifests", () => {
    const project = createTempProject({
      "src/app.ts": "export {};",
      "node_modules/bad-package/package.json": "{not-valid-json",
      "node_modules/bad-package/index.js": "export const Bad = 1;",
    });
    projects.push(project);

    const resolver = new ExportsResolver(project);
    const importer = path.join(project, "src/app.ts");

    expect(resolver.resolvePackageSpecifier(importer, "missing-package", false)).toBeUndefined();
    expect(resolver.resolvePackageSpecifier(importer, "bad-package", false)?.resolvedFilePath).toBe(
      path.join(project, "node_modules/bad-package/index.js"),
    );
  });
});
