import fs from "node:fs";
import path from "node:path";

import type { PackageResolution } from "./models.js";

const ANALYZABLE_MODULE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
  ".mts",
  ".d.ts",
  ".d.mts",
] as const;

interface PackageManifest {
  readonly exports: unknown;
  readonly main: string | undefined;
  readonly module: string | undefined;
  readonly types: string | undefined;
}

interface ExportMapping {
  readonly key: string;
  readonly target: string;
}

export class ExportsResolver {
  private readonly manifestCache = new Map<string, PackageManifest | undefined>();

  public constructor(private readonly projectRoot: string) {}

  public resolvePackageSpecifier(
    importerFilePath: string,
    specifier: string,
    allowPrivateFallback: boolean,
  ): PackageResolution | undefined {
    const packageParts = splitBareSpecifier(specifier);
    if (packageParts === undefined) {
      return undefined;
    }

    const packageRoot = findPackageRoot(
      path.dirname(importerFilePath),
      packageParts.packageName,
      this.projectRoot,
    );
    if (packageRoot === undefined) {
      return undefined;
    }

    const manifest = this.readManifest(packageRoot);
    const publicSubpath = packageParts.subpath.length === 0 ? "." : `./${packageParts.subpath}`;

    let resolvedFilePath = resolvePublicTarget(packageRoot, manifest, publicSubpath);
    if (resolvedFilePath === undefined && allowPrivateFallback) {
      resolvedFilePath =
        packageParts.subpath.length === 0
          ? resolveRootFallback(packageRoot, manifest)
          : resolveExistingModuleFile(path.join(packageRoot, packageParts.subpath));
    }

    return {
      packageRoot,
      packageName: packageParts.packageName,
      subpath: packageParts.subpath,
      resolvedFilePath,
    };
  }

  private readManifest(packageRoot: string): PackageManifest | undefined {
    if (this.manifestCache.has(packageRoot)) {
      return this.manifestCache.get(packageRoot);
    }

    const manifestPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(manifestPath)) {
      this.manifestCache.set(packageRoot, undefined);
      return undefined;
    }

    try {
      const manifestRaw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
      const manifest = parseManifest(manifestRaw);
      this.manifestCache.set(packageRoot, manifest);
      return manifest;
    } catch {
      this.manifestCache.set(packageRoot, undefined);
      return undefined;
    }
  }
}

function resolvePublicTarget(
  packageRoot: string,
  manifest: PackageManifest | undefined,
  publicSubpath: string,
): string | undefined {
  if (manifest?.exports === undefined) {
    if (publicSubpath !== ".") {
      return undefined;
    }
    return resolveRootFallback(packageRoot, manifest);
  }

  const target = resolveExportsTarget(manifest.exports, publicSubpath);
  return target === undefined
    ? undefined
    : resolveExistingModuleFile(path.resolve(packageRoot, target));
}

function resolveRootFallback(
  packageRoot: string,
  manifest: PackageManifest | undefined,
): string | undefined {
  const candidates = [manifest?.module, manifest?.main, manifest?.types, "index"];
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }

    const resolved = resolveExistingModuleFile(path.resolve(packageRoot, candidate));
    if (resolved !== undefined) {
      return resolved;
    }
  }

  return undefined;
}

function parseManifest(value: unknown): PackageManifest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    exports: value.exports,
    main: toOptionalString(value.main),
    module: toOptionalString(value.module),
    types: toOptionalString(value.types),
  };
}

function resolveExportsTarget(exportsField: unknown, publicSubpath: string): string | undefined {
  const mappings = flattenExportMappings(exportsField);
  const exactMatch = mappings.find((mapping) => mapping.key === publicSubpath);
  if (exactMatch !== undefined) {
    return exactMatch.target;
  }

  for (const mapping of mappings) {
    const wildcardReplacement = matchWildcardSubpath(mapping.key, publicSubpath);
    if (wildcardReplacement === undefined) {
      continue;
    }

    return mapping.target.replaceAll("*", wildcardReplacement);
  }

  return undefined;
}

function flattenExportMappings(exportsField: unknown): ReadonlyArray<ExportMapping> {
  if (
    typeof exportsField === "string" ||
    Array.isArray(exportsField) ||
    isConditionalExports(exportsField)
  ) {
    const target = resolveConditionalTarget(exportsField);
    return target === undefined ? [] : [{ key: ".", target }];
  }

  if (!isRecord(exportsField)) {
    return [];
  }

  return Object.entries(exportsField).flatMap(([key, value]) => {
    if (!key.startsWith(".")) {
      return [];
    }

    const target = resolveConditionalTarget(value);
    return target === undefined ? [] : [{ key, target }];
  });
}

function isConditionalExports(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return Object.keys(value).every((key) => !key.startsWith("."));
}

function resolveConditionalTarget(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolveConditionalTarget(item);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const preferredKeys = [
    "import",
    "default",
    "types",
    "module",
    "node",
    "browser",
    "development",
    "production",
    "require",
  ];

  for (const key of preferredKeys) {
    if (!(key in value)) {
      continue;
    }

    const resolved = resolveConditionalTarget(value[key]);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const resolved = resolveConditionalTarget(nestedValue);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  /* c8 ignore next */
  return undefined;
}

function matchWildcardSubpath(pattern: string, target: string): string | undefined {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) {
    return undefined;
  }

  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!target.startsWith(prefix) || !target.endsWith(suffix)) {
    return undefined;
  }

  return target.slice(prefix.length, target.length - suffix.length);
}

function findPackageRoot(
  startDirectory: string,
  packageName: string,
  projectRoot: string,
): string | undefined {
  let currentDirectory = startDirectory;

  while (true) {
    const candidate = path.join(currentDirectory, "node_modules", packageName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  const projectCandidate = path.join(projectRoot, "node_modules", packageName);
  if (fs.existsSync(projectCandidate) && fs.statSync(projectCandidate).isDirectory()) {
    return projectCandidate;
  }

  return undefined;
}

function splitBareSpecifier(
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

function resolveExistingModuleFile(candidatePath: string): string | undefined {
  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    return candidatePath;
  }

  for (const extension of ANALYZABLE_MODULE_EXTENSIONS) {
    const withExtension = `${candidatePath}${extension}`;
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) {
      return withExtension;
    }
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
    /* c8 ignore next 7 */
    for (const extension of ANALYZABLE_MODULE_EXTENSIONS) {
      const indexFile = path.join(candidatePath, `index${extension}`);
      if (fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()) {
        return indexFile;
      }
    }
  }

  return undefined;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
