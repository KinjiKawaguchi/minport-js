export const version = "0.0.0";

export { checkAndFixPaths, checkPaths } from "./checker.js";
export { ExportsResolver } from "./exports-resolver.js";
export { applyFixes } from "./fixer.js";
export { parseSourceFile } from "./import-parser.js";
export type {
  CheckAndFixResult,
  CheckOptions,
  CheckResult,
  FixResult,
  ImportBindingRecord,
  ImportDeclarationRecord,
  ImportStatement,
  MinportConfig,
  ModuleExportRecord,
  NamedImportRecord,
  ParsedSourceFile,
  PathAliasRule,
  TsConfigPaths,
  Violation,
} from "./models.js";
export {
  SHORTER_IMPORT_AVAILABLE_CODE,
  SUPPORTED_SOURCE_EXTENSIONS,
} from "./models.js";
export { ReexportResolver } from "./reexport-resolver.js";
