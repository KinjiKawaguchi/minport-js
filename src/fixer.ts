import fs from "node:fs";

import { parseSourceFile } from "./import-parser.js";
import type {
  FixResult,
  ImportBindingRecord,
  ImportDeclarationRecord,
  Violation,
  WarningReporter,
} from "./models.js";

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function applyFixes(
  violations: ReadonlyArray<Violation>,
  reporter: WarningReporter | undefined,
): FixResult {
  const violationsByFile = groupViolationsByFile(violations);
  let filesModified = 0;
  let fixesApplied = 0;

  for (const [filePath, fileViolations] of violationsByFile.entries()) {
    const sourceText = safeReadFile(filePath, reporter);
    if (sourceText === undefined) {
      continue;
    }

    const parsedResult = parseSourceFile(filePath, sourceText);
    if (!parsedResult.ok) {
      reporter?.warn(`${filePath}: ${parsedResult.error.message}`);
      continue;
    }

    const replacements = buildReplacements(parsedResult.parsed.imports, fileViolations);
    if (replacements.length === 0) {
      continue;
    }

    const fixedSource = applyReplacements(sourceText, replacements);
    if (fixedSource === sourceText) {
      continue;
    }

    fs.writeFileSync(filePath, fixedSource, "utf8");
    filesModified += 1;
    fixesApplied += countAppliedFixes(parsedResult.parsed.imports, fileViolations);
  }

  return {
    filesModified,
    fixesApplied,
  };
}

function groupViolationsByFile(
  violations: ReadonlyArray<Violation>,
): ReadonlyMap<string, ReadonlyArray<Violation>> {
  const grouped = new Map<string, Violation[]>();
  for (const violation of violations) {
    const entries = grouped.get(violation.filePath) ?? [];
    entries.push(violation);
    grouped.set(violation.filePath, entries);
  }
  return grouped;
}

function safeReadFile(filePath: string, reporter: WarningReporter | undefined): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
    /* c8 ignore next 4 */
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to read source file.";
    reporter?.warn(`${filePath}: ${message}`);
    return undefined;
  }
}

function buildReplacements(
  imports: ReadonlyArray<ImportDeclarationRecord>,
  violations: ReadonlyArray<Violation>,
): ReadonlyArray<Replacement> {
  const violationLookup = new Map(
    violations.map((violation) => [createViolationKey(violation), violation.shorterPath]),
  );
  const replacements: Replacement[] = [];

  for (const declaration of imports) {
    const movedBindings = declaration.bindings.flatMap((binding) => {
      if (binding.kind !== "named") {
        return [];
      }

      const shorterPath = violationLookup.get(createBindingKey(declaration, binding.importedName));
      return shorterPath === undefined ? [] : [{ binding, shorterPath }];
    });

    if (movedBindings.length === 0) {
      continue;
    }

    const movedStarts = new Set(movedBindings.map(({ binding }) => binding.start));
    const keptBindings = declaration.bindings.filter((binding) => !movedStarts.has(binding.start));
    const groupedBindings = groupMovedBindings(movedBindings);
    const replacementParts: string[] = [];

    if (keptBindings.length > 0) {
      replacementParts.push(
        renderImportDeclaration(declaration.modulePath, declaration.quote, keptBindings),
      );
    }

    for (const { shorterPath, bindings } of groupedBindings) {
      replacementParts.push(renderImportDeclaration(shorterPath, declaration.quote, bindings));
    }

    replacements.push({
      start: declaration.start,
      end: declaration.end,
      text: replacementParts.join("\n"),
    });
  }

  return replacements.sort((left, right) => right.start - left.start);
}

function groupMovedBindings(
  movedBindings: ReadonlyArray<{
    readonly binding: ImportBindingRecord;
    readonly shorterPath: string;
  }>,
): ReadonlyArray<{
  readonly shorterPath: string;
  readonly bindings: ReadonlyArray<ImportBindingRecord>;
}> {
  const grouped = new Map<string, ImportBindingRecord[]>();
  for (const { binding, shorterPath } of movedBindings) {
    const entries = grouped.get(shorterPath) ?? [];
    entries.push(binding);
    grouped.set(shorterPath, entries);
  }

  return Array.from(grouped.entries()).map(([shorterPath, bindings]) => ({
    shorterPath,
    bindings,
  }));
}

function renderImportDeclaration(
  modulePath: string,
  quote: '"' | "'",
  bindings: ReadonlyArray<ImportBindingRecord>,
): string {
  const defaultBinding = bindings.find((binding) => binding.kind === "default");
  const namedBindings = bindings.filter(
    (binding): binding is ImportBindingRecord & { kind: "named" } => binding.kind === "named",
  );
  const quotedModulePath = `${quote}${modulePath}${quote}`;

  if (
    defaultBinding === undefined &&
    namedBindings.length > 0 &&
    namedBindings.every((binding) => binding.isTypeOnly)
  ) {
    return `import type { ${namedBindings.map(renderNamedBindingWithoutType).join(", ")} } from ${quotedModulePath};`;
  }

  const clauseParts: string[] = [];
  if (defaultBinding !== undefined) {
    clauseParts.push(defaultBinding.localName);
  }

  if (namedBindings.length > 0) {
    clauseParts.push(`{ ${namedBindings.map(renderNamedBinding).join(", ")} }`);
  }

  return `import ${clauseParts.join(", ")} from ${quotedModulePath};`;
}

function renderNamedBinding(binding: ImportBindingRecord & { kind: "named" }): string {
  const rawBinding = renderNamedBindingWithoutType(binding);
  /* c8 ignore next */
  return binding.isTypeOnly ? `type ${rawBinding}` : rawBinding;
}

function renderNamedBindingWithoutType(binding: ImportBindingRecord & { kind: "named" }): string {
  return binding.alias === undefined
    ? binding.importedName
    : `${binding.importedName} as ${binding.alias}`;
}

function applyReplacements(sourceText: string, replacements: ReadonlyArray<Replacement>): string {
  let nextSource = sourceText;
  for (const replacement of replacements) {
    nextSource =
      nextSource.slice(0, replacement.start) + replacement.text + nextSource.slice(replacement.end);
  }
  return nextSource;
}

function countAppliedFixes(
  imports: ReadonlyArray<ImportDeclarationRecord>,
  violations: ReadonlyArray<Violation>,
): number {
  const knownBindings = new Set(
    imports.flatMap((declaration) =>
      declaration.bindings
        .filter(
          (binding): binding is ImportBindingRecord & { kind: "named" } => binding.kind === "named",
        )
        .map((binding) => createBindingKey(declaration, binding.importedName)),
    ),
  );

  return violations.filter((violation) => knownBindings.has(createViolationKey(violation))).length;
}

function createBindingKey(declaration: ImportDeclarationRecord, importedName: string): string {
  return `${declaration.filePath}:${declaration.line}:${declaration.col}:${declaration.modulePath}:${importedName}`;
}

function createViolationKey(violation: Violation): string {
  return `${violation.filePath}:${violation.line}:${violation.col}:${violation.originalPath}:${violation.name}`;
}
