#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkAndFixPaths, checkPaths } from "./checker.js";
import type { Violation, WarningReporter } from "./models.js";

interface WritableLike {
  write(chunk: string): void;
}

interface CliRunOptions {
  readonly cwd?: string;
  readonly stdout?: WritableLike;
  readonly stderr?: WritableLike;
}

interface ParsedCliArguments {
  readonly command: "check";
  readonly targets: ReadonlyArray<string>;
  readonly fix: boolean;
  readonly excludes: ReadonlyArray<string>;
}

export function runCli(args: ReadonlyArray<string>, options: CliRunOptions = {}): number {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    stdout.write(`${buildHelpText()}\n`);
    return 0;
  }

  const parsedArguments = parseArguments(args);
  if (parsedArguments === undefined) {
    stderr.write(`${buildHelpText()}\n`);
    return 2;
  }

  const reporter = createReporter(stderr);

  try {
    if (parsedArguments.fix) {
      const result = checkAndFixPaths(parsedArguments.targets, {
        cwd,
        exclude: parsedArguments.excludes,
        reporter,
      });
      writeViolations(stdout, cwd, result.checkResult.violations);
      stdout.write(
        `Fixed ${result.fixResult.fixesApplied} import(s) across ${result.fixResult.filesModified} file(s).\n`,
      );
      return 0;
    }

    const result = checkPaths(parsedArguments.targets, {
      cwd,
      exclude: parsedArguments.excludes,
      reporter,
    });
    writeViolations(stdout, cwd, result.violations);
    stdout.write(
      `Found ${result.violations.length} error(s) (${result.violations.length} fixable with \`minport check --fix\`).\n`,
    );
    return result.violations.length === 0 ? 0 : 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "CLI execution failed.";
    stderr.write(`${message}\n`);
    return error instanceof Error && error.name === "TargetNotFoundError" ? 2 : 1;
  }
}

function parseArguments(args: ReadonlyArray<string>): ParsedCliArguments | undefined {
  if (args[0] !== "check") {
    return undefined;
  }

  const targets: string[] = [];
  const excludes: string[] = [];
  let fix = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    /* c8 ignore next 3 */
    if (argument === undefined) {
      return undefined;
    }

    if (argument === "--fix") {
      fix = true;
      continue;
    }

    if (argument === "--exclude") {
      const excludePattern = args[index + 1];
      if (excludePattern === undefined) {
        return undefined;
      }

      excludes.push(excludePattern);
      index += 1;
      continue;
    }

    if (argument.startsWith("--exclude=")) {
      excludes.push(argument.slice("--exclude=".length));
      continue;
    }

    if (argument.startsWith("-")) {
      return undefined;
    }

    targets.push(argument);
  }

  return {
    command: "check",
    targets,
    fix,
    excludes,
  };
}

function writeViolations(
  stdout: WritableLike,
  cwd: string,
  violations: ReadonlyArray<Violation>,
): void {
  for (const violation of violations) {
    const relativePath = path.relative(cwd, violation.filePath);
    stdout.write(
      `${relativePath}:${violation.line}:${violation.col}: ${violation.code} ${violation.message}\n`,
    );
  }
}

function createReporter(stderr: WritableLike): WarningReporter {
  return {
    warn(message: string): void {
      stderr.write(`warning: ${message}\n`);
    },
  };
}

function buildHelpText(): string {
  return [
    "Usage:",
    "  minport check <path...> [--fix] [--exclude <glob>]",
    "",
    "Examples:",
    "  minport check src/",
    "  minport check src/ --fix",
    '  minport check src/ --exclude "tests/*"',
  ].join("\n");
}

/* c8 ignore next 5 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
