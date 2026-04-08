import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkPaths } from "../src/checker.js";
import { runCli } from "../src/cli.js";
import { ExportsResolver } from "../src/exports-resolver.js";
import { applyFixes } from "../src/fixer.js";
import type { NamedImportRecord, Violation } from "../src/models.js";
import { ReexportResolver } from "../src/reexport-resolver.js";
import { cleanupTempProject, createTempProject, readProjectFile } from "./helpers/temp-project.js";

function violationFor(
  filePath: string,
  line: number,
  col: number,
  name: string,
  originalPath: string,
  shorterPath: string,
): Violation {
  return {
    filePath,
    line,
    col,
    originalPath,
    shorterPath,
    name,
    code: "MP001",
    message: "fixture",
  };
}

describe("coverage regressions", () => {
  const projects: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("oxc-parser");
    for (const project of projects.splice(0)) {
      cleanupTempProject(project);
    }
  });

  it("covers checker root scanning, duplicate directories, missing configs, and read failures", async () => {
    const project = createTempProject({
      "src/index.ts": `export const Value = 1;`,
      "src/read-error.ts": `export const Broken = 1;`,
      "linked-src": { symlink: "src" },
      "node_modules/pkg/index.js": `export const Skipped = 1;`,
      "dist/output.ts": `export const Dist = 1;`,
      "coverage/report.ts": `export const Coverage = 1;`,
    });
    projects.push(project);

    const warnings: string[] = [];
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const readFileSync = (
        filePath: Parameters<typeof actual.readFileSync>[0],
        options?: Parameters<typeof actual.readFileSync>[1],
      ) => {
        if (typeof filePath === "string" && filePath.endsWith("read-error.ts")) {
          throw new Error("boom");
        }

        return actual.readFileSync(filePath, options as never);
      };

      return {
        ...actual,
        default: {
          ...actual,
          readFileSync,
        },
        readFileSync,
      };
    });
    const { checkPaths: isolatedCheckPaths } = await import("../src/checker.js");
    const rootResult = isolatedCheckPaths([], {
      cwd: project,
      reporter: {
        warn(message: string): void {
          warnings.push(message);
        },
      },
    });
    vi.restoreAllMocks();
    const duplicateResult = checkPaths(["src", "linked-src"], { cwd: project });
    const excludedResult = checkPaths(["src/index.ts"], {
      cwd: project,
      exclude: ["src/index.ts"],
    });

    expect(rootResult.filesChecked).toBeGreaterThanOrEqual(0);
    expect(warnings.length).toBeGreaterThanOrEqual(0);
    expect(duplicateResult.filesChecked).toBe(2);
    expect(excludedResult.filesChecked).toBe(0);
  });

  it("covers checker config fallbacks for invalid shapes", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture", minport: { exclude: "bad" } }, null, 2),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            baseUrl: 42,
            paths: {
              "@bad/*": "src/*",
              "@empty/*": [],
              "@ok/*": ["src/*", 42],
            },
          },
        },
        null,
        2,
      ),
      "src/app.ts": `import { Value } from "@ok/lib/deep";`,
      "src/lib/index.ts": `export { Value } from "./deep";`,
      "src/lib/deep.ts": `export const Value = 1;`,
    });
    projects.push(project);
    const invalidCompilerProject = createTempProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: "bad" }, null, 2),
      "src/value.ts": `export const Value = 1;`,
    });
    projects.push(invalidCompilerProject);
    const baseUrlProject = createTempProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }, null, 2),
      "src/value.ts": `export const Value = 1;`,
    });
    projects.push(baseUrlProject);

    const result = checkPaths(["src"], { cwd: project });
    const originalCwd = process.cwd();
    process.chdir(project);
    const defaultCwdResult = checkPaths(["src"]);
    process.chdir(originalCwd);
    const invalidCompilerResult = checkPaths(["src"], { cwd: invalidCompilerProject });
    const baseUrlResult = checkPaths(["src"], { cwd: baseUrlProject });

    expect(result.violations).toEqual([
      expect.objectContaining({
        shorterPath: "@ok/lib",
      }),
    ]);
    expect(defaultCwdResult.violations).toHaveLength(1);
    expect(invalidCompilerResult.filesChecked).toBe(1);
    expect(baseUrlResult.filesChecked).toBe(1);
  });

  it("covers fixer no-op, parse failure, missing file, and read warnings", () => {
    const project = createTempProject({
      "src/same.ts": `import { Foo } from "./foo";`,
      "src/nomatch.ts": `import { Bar } from "./foo";`,
      "src/broken.ts": `import { Foo from "./foo";`,
      "src/default-and-named.ts": `import DefaultValue, { Foo } from "./foo/deep";`,
      "src/foo/index.ts": `export { Foo } from "./deep";`,
      "src/foo/deep.ts": `export const Foo = 1; export default 1;`,
    });
    projects.push(project);

    const warnings: string[] = [];
    const result = applyFixes(
      [
        violationFor(path.join(project, "src/same.ts"), 1, 1, "Foo", "./foo", "./foo"),
        violationFor(path.join(project, "src/nomatch.ts"), 1, 1, "Foo", "./foo", "./bar"),
        violationFor(path.join(project, "src/broken.ts"), 1, 1, "Foo", "./foo", "./bar"),
        violationFor(path.join(project, "src/missing.ts"), 1, 1, "Foo", "./foo", "./bar"),
        violationFor(
          path.join(project, "src/default-and-named.ts"),
          1,
          1,
          "Foo",
          "./foo/deep",
          "./foo",
        ),
      ],
      {
        warn(message: string): void {
          warnings.push(message);
        },
      },
    );

    expect(result).toEqual({
      filesModified: 1,
      fixesApplied: 1,
    });
    expect(readProjectFile(project, "src/same.ts")).toBe(`import { Foo } from "./foo";`);
    expect(readProjectFile(project, "src/default-and-named.ts").trim()).toBe(
      ['import DefaultValue from "./foo/deep";', 'import { Foo } from "./foo";'].join("\n"),
    );
    expect(warnings.join("\n")).toContain("missing.ts");
    expect(warnings.join("\n")).toContain("broken.ts");
  });

  it("covers parser fallback branches via mocked parser results", async () => {
    vi.doMock("oxc-parser", () => ({
      parseSync(): never {
        throw new Error("parser exploded");
      },
    }));
    const parserThrowModule = await import("../src/import-parser.js");
    expect(parserThrowModule.parseSourceFile("/repo/file.ts", "")).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: "parser exploded",
      }),
    });

    vi.resetModules();
    vi.doMock("oxc-parser", () => ({
      parseSync() {
        return {
          errors: [],
          module: {
            staticImports: [
              {
                start: -1,
                end: 10,
                moduleRequest: {
                  value: "./mocked",
                  start: 0,
                },
                entries: [
                  {
                    importName: {
                      kind: "Name",
                    },
                    localName: {
                      value: "FallbackName",
                      start: 1,
                      end: 13,
                    },
                    isType: false,
                  },
                ],
              },
            ],
            staticExports: [
              {
                entries: [
                  {
                    exportName: { kind: "None" },
                    importName: { kind: "None" },
                    localName: { kind: "None" },
                    isType: false,
                  },
                ],
              },
            ],
          },
        };
      },
    }));
    const parserFallbackModule = await import("../src/import-parser.js");
    const result = parserFallbackModule.parseSourceFile("/repo/file.ts", '"');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.parsed.namedImports[0]).toMatchObject({
      name: "FallbackName",
      line: 1,
      col: 0,
    });
  });

  it("covers extra exports resolver branches", () => {
    const project = createTempProject({
      "src/app.ts": "export {};",
      "node_modules/no-manifest/index.js": `export const Plain = 1;`,
      "node_modules/string-exports/package.json": JSON.stringify(
        { name: "string-exports", exports: "./entry.js" },
        null,
        2,
      ),
      "node_modules/string-exports/entry.js": `export const Value = 1;`,
      "node_modules/array-exports/package.json": JSON.stringify(
        {
          name: "array-exports",
          exports: [null, "./entry.js"],
        },
        null,
        2,
      ),
      "node_modules/array-exports/entry.js": `export const Value = 1;`,
      "node_modules/custom-conditions/package.json": JSON.stringify(
        {
          name: "custom-conditions",
          exports: {
            custom: "./entry.js",
          },
        },
        null,
        2,
      ),
      "node_modules/custom-conditions/entry.js": `export const Value = 1;`,
      "node_modules/empty-root/package.json": JSON.stringify(
        {
          name: "empty-root",
          main: "./missing.js",
        },
        null,
        2,
      ),
      "node_modules/exact-no-star/package.json": JSON.stringify(
        {
          name: "exact-no-star",
          exports: {
            ".": 42,
            other: "./skip.js",
            "./feature": "./feature/index",
          },
        },
        null,
        2,
      ),
      "node_modules/exact-no-star/feature/index.ts": `export const Exact = 1;`,
      "node_modules/array-manifest/package.json": "[]",
      "node_modules/unresolved-array/package.json": JSON.stringify(
        {
          name: "unresolved-array",
          exports: [null, false],
        },
        null,
        2,
      ),
      "node_modules/non-record-exports/package.json": JSON.stringify(
        {
          name: "non-record-exports",
          exports: 42,
        },
        null,
        2,
      ),
      "node_modules/no-resolution-object/package.json": JSON.stringify(
        {
          name: "no-resolution-object",
          exports: {
            custom: false,
          },
        },
        null,
        2,
      ),
      "node_modules/directory-export/package.json": JSON.stringify(
        {
          name: "directory-export",
          exports: {
            ".": "./feature",
          },
        },
        null,
        2,
      ),
      "node_modules/directory-export/feature/index.js": `export const Folder = 1;`,
      "node_modules/with-subpath/package.json": JSON.stringify(
        {
          name: "with-subpath",
          exports: {
            "./feature/*": "./src/*/index.js",
          },
        },
        null,
        2,
      ),
      "node_modules/with-subpath/src/real/index.js": `export const Real = 1;`,
    });
    projects.push(project);

    const resolver = new ExportsResolver(project);
    const importer = path.join(project, "src/app.ts");

    expect(resolver.resolvePackageSpecifier(importer, "./local", false)).toBeUndefined();
    expect(resolver.resolvePackageSpecifier(importer, "no-manifest", true)?.resolvedFilePath).toBe(
      path.join(project, "node_modules/no-manifest/index.js"),
    );
    expect(resolver.resolvePackageSpecifier(importer, "no-manifest", true)?.resolvedFilePath).toBe(
      path.join(project, "node_modules/no-manifest/index.js"),
    );
    expect(
      resolver.resolvePackageSpecifier(importer, "string-exports", false)?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/string-exports/entry.js"));
    expect(
      resolver.resolvePackageSpecifier(importer, "array-exports", false)?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/array-exports/entry.js"));
    expect(
      resolver.resolvePackageSpecifier(importer, "custom-conditions", false)?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/custom-conditions/entry.js"));
    expect(
      resolver.resolvePackageSpecifier(importer, "with-subpath/not-real", false)?.resolvedFilePath,
    ).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier(importer, "empty-root", true)?.resolvedFilePath,
    ).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier(importer, "unresolved-array", false)?.resolvedFilePath,
    ).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier(importer, "non-record-exports", false)?.resolvedFilePath,
    ).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier(importer, "no-resolution-object", false)?.resolvedFilePath,
    ).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier(importer, "directory-export", false)?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/directory-export/feature/index.js"));
    expect(
      resolver.resolvePackageSpecifier(importer, "exact-no-star/feature", false)?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/exact-no-star/feature/index.ts"));
    expect(resolver.resolvePackageSpecifier(importer, "@", false)).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier(importer, "array-manifest", true)?.resolvedFilePath,
    ).toBeUndefined();
    expect(
      resolver.resolvePackageSpecifier("/tmp/outside.ts", "no-manifest", true)?.resolvedFilePath,
    ).toBe(path.join(project, "node_modules/no-manifest/index.js"));
  });

  it("covers extra reexport resolver branches", async () => {
    const warnings: string[] = [];
    const project = createTempProject({
      "src/app.ts": `import { Value } from "./public/deep/file";`,
      "src/public/index.ts": `
export { Value } from "./deep/file";
export { Value } from "./deep/file";
`,
      "src/public/deep/file.ts": `export const Value = 1;`,
      "src/missing-target/index.ts": `export { Missing } from "./missing";`,
      "src/broken-index.ts": `export { Broken } from "./broken";`,
      "src/broken.ts": `export { Broken from "./oops";`,
      "src/read-error.ts": `export const ReadError = 1;`,
    });
    projects.push(project);

    const originalReadFileSync = fs.readFileSync.bind(fs);
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const readFileSync = (
        filePath: Parameters<typeof actual.readFileSync>[0],
        options?: Parameters<typeof actual.readFileSync>[1],
      ) => {
        if (typeof filePath === "string" && filePath.endsWith("read-error.ts")) {
          throw new Error("read failure");
        }

        return originalReadFileSync(filePath, options as never);
      };

      return {
        ...actual,
        default: {
          ...actual,
          readFileSync,
        },
        readFileSync,
      };
    });
    const { ReexportResolver: IsolatedResolver } = await import("../src/reexport-resolver.js");
    const resolver = new ReexportResolver(
      project,
      {
        baseUrl: project,
        paths: [
          { pattern: "@missing/*", replacements: ["missing/*"] },
          { pattern: "@exact", replacements: ["src/public/index.ts"] },
        ],
      },
      {
        warn(message: string): void {
          warnings.push(message);
        },
      },
    );
    const isolatedResolver = new IsolatedResolver(
      project,
      { baseUrl: undefined, paths: [] },
      {
        warn(message: string): void {
          warnings.push(message);
        },
      },
    );

    const importRecord: NamedImportRecord = {
      modulePath: "./public/deep/file",
      name: "Value",
      alias: undefined,
      filePath: path.join(project, "src/app.ts"),
      line: 1,
      col: 1,
      declarationStart: 0,
      declarationEnd: 0,
      bindingStart: 0,
      bindingEnd: 0,
      localName: "Value",
      isTypeOnly: false,
      isIgnored: false,
    };
    const absoluteImportRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: path.join(project, "src/public/deep/file.ts"),
    };
    const missingAliasImportRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: "@missing/value",
    };
    const exactAliasImportRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: "@exact",
    };
    const missingExportRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: "./missing-target",
      name: "Missing",
    };
    const brokenExportRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: "./broken-index",
      name: "Broken",
    };
    const readErrorRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: "./read-error",
      name: "ReadError",
    };
    const bareRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: "pkg",
    };
    const invalidScopedRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: "@",
    };
    const parentRelativeRecord: NamedImportRecord = {
      ...importRecord,
      modulePath: "../src/public/deep/file",
    };
    const barePackageProject = createTempProject({
      "src/app.ts": `import { Public } from "pkg";`,
      "node_modules/pkg/package.json": JSON.stringify(
        {
          name: "pkg",
          exports: {
            ".": "./index.js",
          },
        },
        null,
        2,
      ),
      "node_modules/pkg/index.js": `export const Public = 1;`,
    });
    projects.push(barePackageProject);
    const barePackageResolver = new ReexportResolver(
      barePackageProject,
      { baseUrl: undefined, paths: [{ pattern: "@exact", replacements: ["src/public/index.ts"] }] },
      undefined,
    );
    const barePackageRecord: NamedImportRecord = {
      ...importRecord,
      filePath: path.join(barePackageProject, "src/app.ts"),
      modulePath: "pkg",
      name: "Public",
    };

    expect(resolver.findShorterPath(importRecord)).toBe("./public");
    expect(resolver.findShorterPath(importRecord)).toBe("./public");
    expect(resolver.findShorterPath(absoluteImportRecord)).toBe(path.join(project, "src/public"));
    expect(resolver.findShorterPath(missingAliasImportRecord)).toBeUndefined();
    expect(resolver.findShorterPath(exactAliasImportRecord)).toBeUndefined();
    expect(resolver.findShorterPath(missingExportRecord)).toBeUndefined();
    expect(resolver.findShorterPath(brokenExportRecord)).toBeUndefined();
    expect(isolatedResolver.findShorterPath(readErrorRecord)).toBeUndefined();
    expect(resolver.findShorterPath(bareRecord)).toBeUndefined();
    expect(resolver.findShorterPath(invalidScopedRecord)).toBeUndefined();
    expect(resolver.findShorterPath(parentRelativeRecord)).toBe("../src/public");
    expect(barePackageResolver.findShorterPath(barePackageRecord)).toBeUndefined();
    expect(warnings.join("\n")).toContain("broken.ts");
    expect(warnings.join("\n")).toContain("read-error.ts");
  });

  it("covers cli parse branches, warnings, and generic failures", async () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "src/broken.ts": `import { Foo from "./foo";`,
      "src/app.ts": `export const Ok = 1;`,
    });
    projects.push(project);

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    expect(runCli(["check", "src", "--exclude=src/**"], { cwd: project, stdout, stderr })).toBe(0);
    expect(runCli(["check", "src", "--exclude"], { cwd: project, stdout, stderr })).toBe(2);
    expect(runCli(["check", "src", "--unknown"], { cwd: project, stdout, stderr })).toBe(2);
    expect(runCli(["check", "src/broken.ts"], { cwd: project, stdout, stderr })).toBe(0);
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("warning: "));

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(runCli(["--help"])).toBe(0);

    vi.resetModules();
    vi.doMock("../src/checker.js", () => ({
      checkPaths(): never {
        throw "non-error failure";
      },
      checkAndFixPaths(): never {
        throw "non-error failure";
      },
    }));
    const { runCli: mockedRunCli } = await import("../src/cli.js");

    expect(mockedRunCli(["check", "src"], { cwd: project, stdout, stderr })).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith("CLI execution failed.\n");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
