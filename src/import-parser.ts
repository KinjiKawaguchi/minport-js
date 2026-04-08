import {
  parseSync,
  type StaticExport,
  type StaticExportEntry,
  type StaticImport,
  type StaticImportEntry,
} from "oxc-parser";

import type {
  ImportBindingRecord,
  ImportDeclarationRecord,
  ModuleExportRecord,
  NamedImportRecord,
  ParsedSourceFile,
  ParseSourceResult,
} from "./models.js";

export function parseSourceFile(filePath: string, sourceText: string): ParseSourceResult {
  try {
    const result = parseSync(filePath, sourceText, { sourceType: "module" });
    if (result.errors.length > 0) {
      const [firstError] = result.errors;
      return {
        ok: false,
        error: {
          filePath,
          /* c8 ignore next */
          message: firstError?.message ?? "Failed to parse source file.",
        },
      };
    }

    const lineStarts = buildLineStarts(sourceText);
    const imports = parseImports(filePath, sourceText, lineStarts, result.module.staticImports);
    const namedImports = flattenNamedImports(imports);
    const exports = parseExports(filePath, result.module.staticExports);

    const parsed: ParsedSourceFile = {
      filePath,
      imports,
      namedImports,
      exports,
    };
    return { ok: true, parsed };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        filePath,
        /* c8 ignore next */
        message: error instanceof Error ? error.message : "Unknown parser failure.",
      },
    };
  }
}

function parseImports(
  filePath: string,
  sourceText: string,
  lineStarts: ReadonlyArray<number>,
  staticImports: ReadonlyArray<StaticImport>,
): ReadonlyArray<ImportDeclarationRecord> {
  return staticImports.map((entry) => {
    const location = offsetToLineCol(entry.start, lineStarts);
    const bindings = entry.entries
      .map((binding) => parseImportBinding(binding))
      .filter((binding): binding is ImportBindingRecord => binding !== undefined);

    return {
      filePath,
      modulePath: entry.moduleRequest.value,
      quote: detectQuote(sourceText, entry.moduleRequest.start),
      start: entry.start,
      end: entry.end,
      line: location.line,
      col: location.col,
      text: sourceText.slice(entry.start, entry.end),
      isIgnored: hasInlineIgnoreComment(sourceText, lineStarts, entry.start),
      bindings,
    };
  });
}

function parseImportBinding(binding: StaticImportEntry): ImportBindingRecord | undefined {
  const kind = binding.importName.kind;
  if (kind === "Default") {
    return {
      kind: "default",
      importedName: "default",
      localName: binding.localName.value,
      alias: undefined,
      isTypeOnly: binding.isType,
      start: binding.localName.start,
      end: binding.localName.end,
    };
  }

  if (kind === "NamespaceObject") {
    return {
      kind: "namespace",
      importedName: "*",
      localName: binding.localName.value,
      alias: undefined,
      isTypeOnly: binding.isType,
      start: binding.localName.start,
      end: binding.localName.end,
    };
  }

  const importedName = binding.importName.name ?? binding.localName.value;
  const localName = binding.localName.value;

  return {
    kind: "named",
    importedName,
    localName,
    alias: importedName === localName ? undefined : localName,
    isTypeOnly: binding.isType,
    start: binding.importName.start ?? binding.localName.start,
    end: binding.localName.end,
  };
}

function flattenNamedImports(
  declarations: ReadonlyArray<ImportDeclarationRecord>,
): ReadonlyArray<NamedImportRecord> {
  return declarations.flatMap((declaration) =>
    declaration.bindings
      .filter(
        (binding): binding is ImportBindingRecord & { kind: "named" } => binding.kind === "named",
      )
      .map((binding) => ({
        modulePath: declaration.modulePath,
        name: binding.importedName,
        alias: binding.alias,
        filePath: declaration.filePath,
        line: declaration.line,
        col: declaration.col,
        declarationStart: declaration.start,
        declarationEnd: declaration.end,
        bindingStart: binding.start,
        bindingEnd: binding.end,
        localName: binding.localName,
        isTypeOnly: binding.isTypeOnly,
        isIgnored: declaration.isIgnored,
      })),
  );
}

function parseExports(
  filePath: string,
  staticExports: ReadonlyArray<StaticExport>,
): ReadonlyArray<ModuleExportRecord> {
  return staticExports.flatMap((entry) =>
    entry.entries
      .map((binding) => parseExportBinding(filePath, binding))
      .filter((record): record is ModuleExportRecord => record !== undefined),
  );
}

function parseExportBinding(
  filePath: string,
  binding: StaticExportEntry,
): ModuleExportRecord | undefined {
  const exportedName = toExportedName(binding);
  if (exportedName === undefined) {
    return undefined;
  }

  return {
    filePath,
    exportedName,
    localName: binding.localName.kind === "Name" ? binding.localName.name : undefined,
    sourceModule: binding.moduleRequest?.value,
    sourceExportName: toSourceExportName(binding),
    isTypeOnly: binding.isType,
  };
}

function toExportedName(binding: StaticExportEntry): string | undefined {
  if (binding.exportName.kind === "Name") {
    return binding.exportName.name;
  }

  if (binding.exportName.kind === "Default") {
    return "default";
  }

  return undefined;
}

function toSourceExportName(binding: StaticExportEntry): string | undefined {
  if (binding.importName.kind === "Name") {
    return binding.importName.name;
  }

  return undefined;
}

function buildLineStarts(sourceText: string): ReadonlyArray<number> {
  const starts = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetToLineCol(
  offset: number,
  lineStarts: ReadonlyArray<number>,
): { readonly line: number; readonly col: number } {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    /* c8 ignore next */
    const lineStart = lineStarts[middle] ?? 0;
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
      continue;
    }

    if (offset >= nextLineStart) {
      low = middle + 1;
      continue;
    }

    return {
      line: middle + 1,
      col: offset - lineStart + 1,
    };
  }

  /* c8 ignore next */
  return { line: 1, col: offset + 1 };
}

function detectQuote(sourceText: string, start: number): '"' | "'" {
  return sourceText[start] === '"' ? '"' : "'";
}

function hasInlineIgnoreComment(
  sourceText: string,
  lineStarts: ReadonlyArray<number>,
  offset: number,
): boolean {
  const { line } = offsetToLineCol(offset, lineStarts);
  /* c8 ignore next */
  const lineStart = lineStarts[line - 1] ?? 0;
  const lineEnd = sourceText.indexOf("\n", lineStart);
  const rawLine = sourceText.slice(lineStart, lineEnd === -1 ? sourceText.length : lineEnd);
  return rawLine.includes("minport-ignore");
}
