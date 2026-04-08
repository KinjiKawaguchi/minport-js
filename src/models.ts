export const SHORTER_IMPORT_AVAILABLE_CODE = "MP001";
export const SUPPORTED_SOURCE_EXTENSIONS = [".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts"] as const;

export type ImportBindingKind = "default" | "named" | "namespace";

export interface ImportStatement {
  readonly modulePath: string;
  readonly name: string;
  readonly alias: string | undefined;
  readonly filePath: string;
  readonly line: number;
  readonly col: number;
}

export interface NamedImportRecord extends ImportStatement {
  readonly declarationStart: number;
  readonly declarationEnd: number;
  readonly bindingStart: number;
  readonly bindingEnd: number;
  readonly localName: string;
  readonly isTypeOnly: boolean;
  readonly isIgnored: boolean;
}

export interface ImportBindingRecord {
  readonly kind: ImportBindingKind;
  readonly importedName: string;
  readonly localName: string;
  readonly alias: string | undefined;
  readonly isTypeOnly: boolean;
  readonly start: number;
  readonly end: number;
}

export interface ImportDeclarationRecord {
  readonly filePath: string;
  readonly modulePath: string;
  readonly quote: '"' | "'";
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly col: number;
  readonly text: string;
  readonly isIgnored: boolean;
  readonly bindings: ReadonlyArray<ImportBindingRecord>;
}

export interface ModuleExportRecord {
  readonly filePath: string;
  readonly exportedName: string;
  readonly localName: string | undefined;
  readonly sourceModule: string | undefined;
  readonly sourceExportName: string | undefined;
  readonly isTypeOnly: boolean;
}

export interface ParsedSourceFile {
  readonly filePath: string;
  readonly imports: ReadonlyArray<ImportDeclarationRecord>;
  readonly namedImports: ReadonlyArray<NamedImportRecord>;
  readonly exports: ReadonlyArray<ModuleExportRecord>;
}

export interface ParseFailure {
  readonly filePath: string;
  readonly message: string;
}

export interface ParseSuccess {
  readonly ok: true;
  readonly parsed: ParsedSourceFile;
}

export interface ParseError {
  readonly ok: false;
  readonly error: ParseFailure;
}

export type ParseSourceResult = ParseSuccess | ParseError;

export interface Violation {
  readonly filePath: string;
  readonly line: number;
  readonly col: number;
  readonly originalPath: string;
  readonly shorterPath: string;
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

export interface CheckResult {
  readonly violations: ReadonlyArray<Violation>;
  readonly filesChecked: number;
  readonly filesSkipped: number;
}

export interface FixResult {
  readonly filesModified: number;
  readonly fixesApplied: number;
}

export interface WarningReporter {
  warn(message: string): void;
}

export interface PathAliasRule {
  readonly pattern: string;
  readonly replacements: ReadonlyArray<string>;
}

export interface TsConfigPaths {
  readonly baseUrl: string | undefined;
  readonly paths: ReadonlyArray<PathAliasRule>;
}

export interface MinportConfig {
  readonly exclude: ReadonlyArray<string>;
}

export interface CheckOptions {
  readonly cwd?: string;
  readonly exclude?: ReadonlyArray<string>;
  readonly reporter?: WarningReporter;
}

export interface CheckAndFixResult {
  readonly checkResult: CheckResult;
  readonly fixResult: FixResult;
}

export interface ResolutionOrigin {
  readonly filePath: string;
  readonly exportName: string;
}

export interface PackageResolution {
  readonly packageRoot: string;
  readonly packageName: string;
  readonly subpath: string;
  readonly resolvedFilePath: string | undefined;
}
