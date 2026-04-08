import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { cleanupTempProject, createTempProject, readProjectFile } from "./helpers/temp-project.js";

function createBuffer(): { readonly output: string[]; readonly write: (chunk: string) => void } {
  const output: string[] = [];
  return {
    output,
    write(chunk: string): void {
      output.push(chunk);
    },
  };
}

describe("runCli", () => {
  const projects: string[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) {
      cleanupTempProject(project);
    }
  });

  it("prints help for empty input and unknown commands", () => {
    const stdout = createBuffer();
    const stderr = createBuffer();

    expect(runCli([], { stdout, stderr })).toBe(0);
    expect(stdout.output.join("")).toContain("Usage:");

    stdout.output.length = 0;
    expect(runCli(["unknown"], { stdout, stderr })).toBe(2);
    expect(stderr.output.join("")).toContain("Usage:");
  });

  it("returns exit code 1 when violations are found and 0 when none are found", () => {
    const project = createTempProject({
      "package.json": JSON.stringify({ name: "fixture" }, null, 2),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }, null, 2),
      "src/app.ts": `import { User } from "./domain/user/models";`,
      "src/domain/index.ts": `export { User } from "./user";`,
      "src/domain/user/index.ts": `export { User } from "./models";`,
      "src/domain/user/models.ts": `export interface User { id: string }`,
      "src/clean.ts": `export const Clean = 1;`,
    });
    projects.push(project);

    const stdout = createBuffer();
    const stderr = createBuffer();
    expect(runCli(["check", "src/app.ts"], { cwd: project, stdout, stderr })).toBe(1);
    expect(stdout.output.join("")).toContain("MP001");

    stdout.output.length = 0;
    stderr.output.length = 0;
    expect(runCli(["check", "src/clean.ts"], { cwd: project, stdout, stderr })).toBe(0);
    expect(stdout.output.join("")).toContain("Found 0 error(s)");
  });

  it("fixes files, honors excludes, and returns exit code 2 for missing paths", () => {
    const project = createTempProject({
      "package.json": JSON.stringify(
        {
          name: "fixture",
          minport: {
            exclude: ["src/ignored/**"],
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }, null, 2),
      "src/app.ts": `import { User } from "./domain/user/models";`,
      "src/domain/index.ts": `export { User } from "./user";`,
      "src/domain/user/index.ts": `export { User } from "./models";`,
      "src/domain/user/models.ts": `export interface User { id: string }`,
      "src/ignored/file.ts": `import { User } from "../domain/user/models";`,
    });
    projects.push(project);

    const stdout = createBuffer();
    const stderr = createBuffer();

    expect(
      runCli(["check", "src", "--fix", "--exclude", "src/ignored/**"], {
        cwd: project,
        stdout,
        stderr,
      }),
    ).toBe(0);
    expect(readProjectFile(project, "src/app.ts").trim()).toBe('import { User } from "./domain";');
    expect(readProjectFile(project, "src/ignored/file.ts").trim()).toBe(
      'import { User } from "../domain/user/models";',
    );

    expect(runCli(["check", "missing"], { cwd: project, stdout, stderr })).toBe(2);
    expect(stderr.output.join("")).toContain("Target does not exist");
  });
});
