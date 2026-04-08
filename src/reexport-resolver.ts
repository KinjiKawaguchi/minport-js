import fs from "node:fs";
import path from "node:path";

import { ExportsResolver } from "./exports-resolver.js";
import { parseSourceFile } from "./import-parser.js";
import type {
  NamedImportRecord,
  ParsedSourceFile,
  ResolutionOrigin,
  TsConfigPaths,
  WarningReporter,
} from "./models.js";

const LOCAL_MODULE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
  ".mts",
  ".d.ts",
  ".d.mts",
] as const;

export class ReexportResolver {
  private readonly exportsResolver: ExportsResolver;
  private readonly parsedFileCache = new Map<string, ParsedSourceFile | undefined>();
  private readonly resolvedSpecifierCache = new Map<string, string | undefined>();
  private readonly originCache = new Map<string, ReadonlyArray<ResolutionOrigin>>();

  public constructor(
    private readonly projectRoot: string,
    private readonly tsConfigPaths: TsConfigPaths,
    private readonly reporter: WarningReporter | undefined,
  ) {
    this.exportsResolver = new ExportsResolver(projectRoot);
  }

  public findShorterPath(importRecord: NamedImportRecord): string | undefined {
    const originalOrigins = this.resolveModuleOrigins(
      importRecord.filePath,
      importRecord.modulePath,
      importRecord.name,
      true,
    );
    if (originalOrigins.length !== 1) {
      return undefined;
    }

    for (const candidate of buildCandidateModulePaths(importRecord.modulePath)) {
      const candidateOrigins = this.resolveModuleOrigins(
        importRecord.filePath,
        candidate,
        importRecord.name,
        false,
      );
      if (candidateOrigins.length !== 1) {
        continue;
      }

      if (isSameOrigin(candidateOrigins[0], originalOrigins[0])) {
        return candidate;
      }
    }

    return undefined;
  }

  private resolveModuleOrigins(
    importerFilePath: string,
    specifier: string,
    exportName: string,
    allowPrivateFallback: boolean,
  ): ReadonlyArray<ResolutionOrigin> {
    const resolvedFilePath = this.resolveModuleSpecifier(
      importerFilePath,
      specifier,
      allowPrivateFallback,
    );
    if (resolvedFilePath === undefined) {
      return [];
    }

    return this.resolveFileOrigins(resolvedFilePath, exportName, new Set());
  }

  private resolveModuleSpecifier(
    importerFilePath: string,
    specifier: string,
    allowPrivateFallback: boolean,
  ): string | undefined {
    const cacheKey = `${importerFilePath}:${specifier}:${allowPrivateFallback ? "any" : "public"}`;
    if (this.resolvedSpecifierCache.has(cacheKey)) {
      return this.resolvedSpecifierCache.get(cacheKey);
    }

    const resolvedFromTsConfig = this.resolveTsConfigPath(specifier);
    if (resolvedFromTsConfig !== undefined) {
      this.resolvedSpecifierCache.set(cacheKey, resolvedFromTsConfig);
      return resolvedFromTsConfig;
    }

    let resolvedFilePath: string | undefined;
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const basePath = specifier.startsWith("/")
        ? specifier
        : path.resolve(path.dirname(importerFilePath), specifier);
      resolvedFilePath = resolveLocalModuleFile(basePath);
    } else {
      resolvedFilePath = this.exportsResolver.resolvePackageSpecifier(
        importerFilePath,
        specifier,
        allowPrivateFallback,
      )?.resolvedFilePath;
    }

    this.resolvedSpecifierCache.set(cacheKey, resolvedFilePath);
    return resolvedFilePath;
  }

  private resolveTsConfigPath(specifier: string): string | undefined {
    const baseDirectory = this.tsConfigPaths.baseUrl ?? this.projectRoot;
    for (const rule of this.tsConfigPaths.paths) {
      const match = matchPathPattern(rule.pattern, specifier);
      if (match === undefined) {
        continue;
      }

      for (const replacement of rule.replacements) {
        const expanded = replacement.replaceAll("*", match);
        const candidate = resolveLocalModuleFile(path.resolve(baseDirectory, expanded));
        if (candidate !== undefined) {
          return candidate;
        }
      }
    }

    return undefined;
  }

  private resolveFileOrigins(
    filePath: string,
    exportName: string,
    trail: Set<string>,
  ): ReadonlyArray<ResolutionOrigin> {
    const cacheKey = `${filePath}:${exportName}`;
    if (this.originCache.has(cacheKey)) {
      return this.originCache.get(cacheKey) as ReadonlyArray<ResolutionOrigin>;
    }

    if (trail.has(cacheKey)) {
      return [];
    }

    trail.add(cacheKey);
    const parsed = this.readParsedFile(filePath);
    if (parsed === undefined) {
      this.originCache.set(cacheKey, []);
      trail.delete(cacheKey);
      return [];
    }

    const collectedOrigins: ResolutionOrigin[] = [];
    for (const exportRecord of parsed.exports) {
      if (exportRecord.exportedName !== exportName) {
        continue;
      }

      if (exportRecord.sourceModule !== undefined && exportRecord.sourceExportName !== undefined) {
        const resolvedSourceFile = this.resolveModuleSpecifier(
          filePath,
          exportRecord.sourceModule,
          true,
        );
        if (resolvedSourceFile === undefined) {
          continue;
        }

        const childOrigins = this.resolveFileOrigins(
          resolvedSourceFile,
          exportRecord.sourceExportName,
          trail,
        );
        collectedOrigins.push(...childOrigins);
        continue;
      }

      collectedOrigins.push({
        filePath,
        /* c8 ignore next */
        exportName: exportRecord.localName ?? exportRecord.exportedName,
      });
    }

    const uniqueOrigins = dedupeOrigins(collectedOrigins);
    this.originCache.set(cacheKey, uniqueOrigins);
    trail.delete(cacheKey);
    return uniqueOrigins;
  }

  private readParsedFile(filePath: string): ParsedSourceFile | undefined {
    if (this.parsedFileCache.has(filePath)) {
      return this.parsedFileCache.get(filePath);
    }

    try {
      const sourceText = fs.readFileSync(filePath, "utf8");
      const result = parseSourceFile(filePath, sourceText);
      if (!result.ok) {
        /* c8 ignore next 4 */
        this.reporter?.warn(
          `${path.relative(this.projectRoot, filePath)}: ${result.error.message}`,
        );
        this.parsedFileCache.set(filePath, undefined);
        return undefined;
      }

      this.parsedFileCache.set(filePath, result.parsed);
      return result.parsed;
      /* c8 ignore next 5 */
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to read file.";
      this.reporter?.warn(`${path.relative(this.projectRoot, filePath)}: ${message}`);
      this.parsedFileCache.set(filePath, undefined);
      return undefined;
    }
  }
}

function buildCandidateModulePaths(modulePath: string): ReadonlyArray<string> {
  const packageParts = splitPackageLikeSpecifier(modulePath);
  if (packageParts !== undefined) {
    const segments = packageParts.subpath.length === 0 ? [] : packageParts.subpath.split("/");
    return segments.map((_, index) =>
      index === 0
        ? packageParts.packageName
        : `${packageParts.packageName}/${segments.slice(0, index).join("/")}`,
    );
  }

  if (modulePath.startsWith("./") || modulePath.startsWith("../")) {
    return buildRelativeCandidates(modulePath);
  }

  if (modulePath.startsWith("/")) {
    const segments = modulePath.split("/").filter((segment) => segment.length > 0);
    return segments.slice(0, -1).map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
  }

  return [];
}

function buildRelativeCandidates(modulePath: string): ReadonlyArray<string> {
  const prefix = modulePath.startsWith("../") ? "../" : "./";
  const withoutPrefix = modulePath.slice(prefix.length);
  const segments = withoutPrefix.split("/").filter((segment) => segment.length > 0);
  return segments
    .slice(0, -1)
    .map((_, index) => `${prefix}${segments.slice(0, index + 1).join("/")}`);
}

function splitPackageLikeSpecifier(
  specifier: string,
): { readonly packageName: string; readonly subpath: string } | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    return undefined;
  }

  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    const scope = segments[0];
    const packageSegment = segments[1];
    if (scope === undefined || packageSegment === undefined) {
      return undefined;
    }

    return {
      packageName: `${scope}/${packageSegment}`,
      subpath: segments.slice(2).join("/"),
    };
  }

  const packageName = segments[0];
  /* c8 ignore next 3 */
  if (packageName === undefined) {
    return undefined;
  }
  return {
    packageName,
    subpath: segments.slice(1).join("/"),
  };
}

function resolveLocalModuleFile(candidatePath: string): string | undefined {
  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    return candidatePath;
  }

  for (const extension of LOCAL_MODULE_EXTENSIONS) {
    const withExtension = `${candidatePath}${extension}`;
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) {
      return withExtension;
    }
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
    for (const extension of LOCAL_MODULE_EXTENSIONS) {
      const indexFile = path.join(candidatePath, `index${extension}`);
      if (fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()) {
        return indexFile;
      }
    }
  }

  return undefined;
}

function matchPathPattern(pattern: string, candidate: string): string | undefined {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) {
    return pattern === candidate ? "" : undefined;
  }

  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) {
    return undefined;
  }

  return candidate.slice(prefix.length, candidate.length - suffix.length);
}

function dedupeOrigins(origins: ReadonlyArray<ResolutionOrigin>): ReadonlyArray<ResolutionOrigin> {
  const seen = new Set<string>();
  const unique: ResolutionOrigin[] = [];

  for (const origin of origins) {
    const key = `${origin.filePath}:${origin.exportName}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(origin);
  }

  return unique;
}

function isSameOrigin(
  left: ResolutionOrigin | undefined,
  right: ResolutionOrigin | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.filePath === right.filePath &&
    left.exportName === right.exportName
  );
}
