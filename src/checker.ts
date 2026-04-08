import fs, { type Dirent } from "node:fs";
import path from "node:path";

import { applyFixes } from "./fixer.js";
import { parseSourceFile } from "./import-parser.js";
import {
  type CheckAndFixResult,
  type CheckOptions,
  type CheckResult,
  type MinportConfig,
  type NamedImportRecord,
  SHORTER_IMPORT_AVAILABLE_CODE,
  SUPPORTED_SOURCE_EXTENSIONS,
  type TsConfigPaths,
  type Violation,
  type WarningReporter,
} from "./models.js";
import { ReexportResolver } from "./reexport-resolver.js";

const DEFAULT_EXCLUDES = ["node_modules/**", "dist/**", "coverage/**", ".git/**"] as const;
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "coverage", "dist", "node_modules"]);

export function checkPaths(
  targets: ReadonlyArray<string>,
  options: CheckOptions = {},
): CheckResult {
  return runCheck(targets, options);
}

export function checkAndFixPaths(
  targets: ReadonlyArray<string>,
  options: CheckOptions = {},
): CheckAndFixResult {
  const checkResult = runCheck(targets, options);
  const fixResult = applyFixes(checkResult.violations, options.reporter);
  return {
    checkResult,
    fixResult,
  };
}

function runCheck(targets: ReadonlyArray<string>, options: CheckOptions): CheckResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const reporter = options.reporter;
  const minportConfig = readMinportConfig(cwd);
  const tsConfigPaths = readTsConfigPaths(cwd);
  const excludes = [...DEFAULT_EXCLUDES, ...minportConfig.exclude, ...(options.exclude ?? [])];
  const files = collectTargetFiles(cwd, targets, excludes);
  const resolver = new ReexportResolver(cwd, tsConfigPaths, reporter);

  let filesChecked = 0;
  let filesSkipped = 0;
  const violations: Violation[] = [];

  for (const filePath of files) {
    const sourceText = safeReadFile(filePath, reporter);
    /* c8 ignore next 4 */
    if (sourceText === undefined) {
      filesSkipped += 1;
      continue;
    }

    const parsedResult = parseSourceFile(filePath, sourceText);
    if (!parsedResult.ok) {
      reporter?.warn(`${path.relative(cwd, filePath)}: ${parsedResult.error.message}`);
      filesSkipped += 1;
      continue;
    }

    filesChecked += 1;
    violations.push(...findViolations(parsedResult.parsed.namedImports, resolver));
  }

  return {
    violations: violations.sort(compareViolations),
    filesChecked,
    filesSkipped,
  };
}

function findViolations(
  imports: ReadonlyArray<NamedImportRecord>,
  resolver: ReexportResolver,
): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  for (const importRecord of imports) {
    if (importRecord.isIgnored) {
      continue;
    }

    const shorterPath = resolver.findShorterPath(importRecord);
    if (shorterPath === undefined) {
      continue;
    }

    violations.push({
      filePath: importRecord.filePath,
      line: importRecord.line,
      col: importRecord.col,
      originalPath: importRecord.modulePath,
      shorterPath,
      name: importRecord.name,
      code: SHORTER_IMPORT_AVAILABLE_CODE,
      message: buildViolationMessage(importRecord, shorterPath),
    });
  }
  return violations;
}

function collectTargetFiles(
  cwd: string,
  targets: ReadonlyArray<string>,
  excludes: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const resolvedTargets =
    targets.length === 0 ? [cwd] : targets.map((target) => path.resolve(cwd, target));
  const files: string[] = [];
  const seenRealPaths = new Set<string>();

  for (const targetPath of resolvedTargets) {
    if (!fs.existsSync(targetPath)) {
      const error = new Error(`Target does not exist: ${targetPath}`);
      error.name = "TargetNotFoundError";
      throw error;
    }

    walkTarget(targetPath, cwd, excludes, files, seenRealPaths);
  }

  return files.sort();
}

function walkTarget(
  targetPath: string,
  cwd: string,
  excludes: ReadonlyArray<string>,
  files: string[],
  seenRealPaths: Set<string>,
): void {
  const stats = fs.lstatSync(targetPath);
  const realPath = fs.realpathSync(targetPath);

  if (stats.isDirectory()) {
    if (seenRealPaths.has(realPath)) {
      return;
    }

    seenRealPaths.add(realPath);
    const relativeDirectory = normalizePath(path.relative(cwd, targetPath));
    if (shouldSkipDirectory(relativeDirectory, targetPath, excludes)) {
      return;
    }

    const entries = fs
      .readdirSync(targetPath, { withFileTypes: true })
      .sort((left: Dirent, right: Dirent) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      walkTarget(path.join(targetPath, entry.name), cwd, excludes, files, seenRealPaths);
    }
    return;
  }

  if (seenRealPaths.has(realPath)) {
    return;
  }

  seenRealPaths.add(realPath);
  const relativeFilePath = normalizePath(path.relative(cwd, targetPath));
  if (shouldExclude(relativeFilePath, excludes)) {
    return;
  }

  if (!hasSupportedExtension(targetPath)) {
    return;
  }

  files.push(targetPath);
}

function shouldSkipDirectory(
  relativeDirectory: string,
  absoluteDirectory: string,
  excludes: ReadonlyArray<string>,
): boolean {
  if (SKIPPED_DIRECTORY_NAMES.has(path.basename(absoluteDirectory))) {
    return true;
  }

  return relativeDirectory.length > 0 && shouldExclude(`${relativeDirectory}/`, excludes);
}

function shouldExclude(candidatePath: string, excludes: ReadonlyArray<string>): boolean {
  return excludes.some((pattern) => matchesGlob(candidatePath, normalizePath(pattern)));
}

function matchesGlob(patternTarget: string, pattern: string): boolean {
  const escaped = pattern.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&");
  const regexPattern = escaped
    .replaceAll("\\*\\*", "___MINPORT_DOUBLE_STAR___")
    .replaceAll("\\*", "[^/]*")
    .replaceAll("___MINPORT_DOUBLE_STAR___", ".*");

  return new RegExp(`^${regexPattern}$`).test(patternTarget);
}

function hasSupportedExtension(filePath: string): boolean {
  return SUPPORTED_SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function safeReadFile(filePath: string, reporter: WarningReporter | undefined): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
    /* c8 ignore next 5 */
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to read source file.";
    reporter?.warn(`${filePath}: ${message}`);
    return undefined;
  }
}

function readMinportConfig(cwd: string): MinportConfig {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return { exclude: [] };
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
    if (!isRecord(packageJson) || !isRecord(packageJson.minport)) {
      return { exclude: [] };
    }

    const exclude = Array.isArray(packageJson.minport.exclude)
      ? packageJson.minport.exclude.filter((value): value is string => typeof value === "string")
      : [];

    return { exclude };
  } catch {
    return { exclude: [] };
  }
}

function readTsConfigPaths(cwd: string): TsConfigPaths {
  const tsConfigPath = path.join(cwd, "tsconfig.json");
  if (!fs.existsSync(tsConfigPath)) {
    return { baseUrl: undefined, paths: [] };
  }

  try {
    const tsConfig = JSON.parse(fs.readFileSync(tsConfigPath, "utf8")) as unknown;
    /* c8 ignore next 3 */
    if (!isRecord(tsConfig) || !isRecord(tsConfig.compilerOptions)) {
      return { baseUrl: undefined, paths: [] };
    }

    /* c8 ignore next 4 */
    const baseUrlRaw =
      typeof tsConfig.compilerOptions.baseUrl === "string"
        ? tsConfig.compilerOptions.baseUrl
        : undefined;
    const baseUrl =
      baseUrlRaw === undefined ? undefined : path.resolve(path.dirname(tsConfigPath), baseUrlRaw);
    const pathEntries = isRecord(tsConfig.compilerOptions.paths)
      ? Object.entries(tsConfig.compilerOptions.paths).flatMap(([pattern, replacements]) => {
          if (!Array.isArray(replacements)) {
            return [];
          }

          const validReplacements = replacements.filter(
            (replacement): replacement is string => typeof replacement === "string",
          );
          return validReplacements.length === 0
            ? []
            : [{ pattern, replacements: validReplacements }];
        })
      : [];

    return {
      baseUrl,
      paths: pathEntries,
    };
  } catch {
    return { baseUrl: undefined, paths: [] };
  }
}

function buildViolationMessage(importRecord: NamedImportRecord, shorterPath: string): string {
  const importKeyword = importRecord.isTypeOnly ? "import type" : "import";
  const importName =
    importRecord.alias === undefined
      ? importRecord.name
      : `${importRecord.name} as ${importRecord.alias}`;

  return `\`${importKeyword} { ${importName} } from '${importRecord.modulePath}'\` can be shortened to \`${importKeyword} { ${importName} } from '${shorterPath}'\``;
}

function compareViolations(left: Violation, right: Violation): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.line - right.line ||
    left.col - right.col ||
    left.name.localeCompare(right.name)
  );
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
