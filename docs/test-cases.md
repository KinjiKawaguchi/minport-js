# minport — Test Cases

## P: Import 解析 (10 cases)

| ID | テストケース | 期待結果 |
|----|------------|---------|
| P-1 | `import { Name } from 'X/Y/Z'` を正しく抽出 | modulePath="X/Y/Z", name="Name" |
| P-2 | `import { Name as Alias } from 'X/Y'` を抽出 | alias="Alias" |
| P-3 | `import { A, B, C } from 'X/Y'` を個別に抽出 | 3つの ImportStatement |
| P-4 | `import X from 'Y'`（default import）は無視 | 抽出しない |
| P-5 | `import * as X from 'Y'`（namespace import）は無視 | 抽出しない |
| P-6 | `import './side-effect'`（副作用 import）は無視 | 抽出しない |
| P-7 | `import { Name } from 'X'`（1階層）は短縮余地なし | 抽出するが違反にならない |
| P-8 | 複数行に渡る import を正しく抽出 | 正しい行番号 |
| P-9 | コメント行・文字列内の import は無視 | 抽出しない |
| P-10 | `import type { Name } from 'X/Y'`（type-only import）を抽出 | 通常通り検査対象 |

## R: re-export 解析 (12 cases)

| ID | テストケース | 期待結果 |
|----|------------|---------|
| R-1 | `index.ts` に `export { Name } from './module'` がある | Name は親パスから import 可能 |
| R-2 | `index.ts` に `export { Name as Renamed } from './module'` がある | Renamed として親パスから import 可能 |
| R-3 | `index.ts` に `export { default as Name } from './module'` がある | Name として親パスから import 可能 |
| R-4 | `index.ts` に re-export がない | 短縮不可 |
| R-5 | 多段 re-export: `X/index.ts` → `X/Y/index.ts` → `X/Y/Z/module.ts` | 最短パスは `X` |
| R-6 | `index.js` での re-export も認識 | `.ts` と同様に検出 |
| R-7 | re-export 先に対象の名前がない | 短縮不可 |
| R-8 | `export * from './module'`（ワイルドカード re-export） | 検出しない（スコープ外） |
| R-9 | サードパーティの `index.js` を AST 解析 | 正しく re-export を検出 |
| R-10 | サードパーティのパッケージが見つからない | スキップ（エラーにならない） |
| R-11 | 循環 re-export がある場合 | 無限ループせずに処理完了 |
| R-12 | `export { Name } from './module'` と `export { Name } from './other'` が共存 | 両方検出 |

## X: package.json exports 解析 (10 cases)

| ID | テストケース | 期待結果 |
|----|------------|---------|
| X-1 | `"exports": { ".": "./dist/index.js" }` でルートにエクスポート | ルートパスが候補になる |
| X-2 | `"exports": { "./utils": "./dist/utils/index.js" }` でサブパス定義 | `pkg/utils` が候補になる |
| X-3 | 条件付き exports `{ "import": "...", "require": "..." }` | `import` 条件を優先解決 |
| X-4 | 条件付き exports `{ "types": "...", "import": "..." }` | `import` 条件で解決 |
| X-5 | `exports` フィールドなし | `main` / `module` にフォールバック |
| X-6 | ワイルドカード exports `"./components/*": "./dist/components/*/index.js"` | パターンマッチで候補生成 |
| X-7 | `exports` で公開されていないサブパス | 候補にならない |
| X-8 | ネストした条件付き exports | 正しく解決 |
| X-9 | `exports` の `"."` エントリのみ | ルートパスのみ候補 |
| X-10 | スコープ付きパッケージ `@scope/pkg` の exports | 正しく解決 |

## D: 違反検出 (10 cases)

| ID | コードパターン | 期待結果 |
|----|--------------|---------|
| D-1 | `import { Name } from 'X/Y/Z'` で `X/Y` に re-export あり | **検出**: `from 'X/Y'` を推奨 |
| D-2 | `import { Name } from 'X/Y/Z'` で `X` に re-export あり | **検出**: 最短の `from 'X'` を推奨 |
| D-3 | `import { Name } from 'X/Y'` で短縮余地なし | 検出しない |
| D-4 | `import { Name } from 'X'`（既に最短） | 検出しない |
| D-5 | 1ファイルに複数の短縮可能 import | **全て検出**、各行番号を正確に報告 |
| D-6 | 違反ゼロのファイル | 報告なし |
| D-7 | `import { Name as Alias } from 'X/Y/Z'` が短縮可能 | **検出**: alias を保持したまま推奨 |
| D-8 | `import { A, B } from 'X/Y'` で A のみ短縮可能 | A のみ検出、B は検出しない |
| D-9 | 同名が複数の短いパスに存在（名前衝突） | 検出しない（安全側） |
| D-10 | `import type { Name } from 'X/Y/Z'` が短縮可能 | **検出**: type-only を保持したまま推奨 |

## F: 自動修正 (8 cases)

| ID | テストケース | 期待結果 |
|----|------------|---------|
| F-1 | 単一の named import を短縮 | 行が書き換わる |
| F-2 | alias 付き import を短縮 | `import { Name as Alias } from 'X'` に書き換え |
| F-3 | 複数名 import の一部のみ短縮可能 | 短縮可能な名前だけ別行に分離して短縮 |
| F-4 | 修正後のファイルが構文的に正しい | oxc パーサーが通る |
| F-5 | `--fix` なしでは書き換えない | ファイル変更なし |
| F-6 | 修正対象がないファイル | ファイル変更なし |
| F-7 | 名前衝突がある場合は修正しない | ファイル変更なし |
| F-8 | 修正結果の FixResult が正しい件数を返す | filesModified, fixesApplied |

## S: サードパーティ解析 (8 cases)

| ID | テストケース | 期待結果 |
|----|------------|---------|
| S-1 | インストール済みパッケージの re-export を検出 | 短縮を推奨 |
| S-2 | 未インストールパッケージの import | スキップ（エラーなし） |
| S-3 | サードパーティの `index.js` を AST 解析 | re-export を正しく検出 |
| S-4 | `package.json` `exports` でサブパス定義あり | exports を優先して短縮パスを提案 |
| S-5 | ネイティブアドオン（`.node`）のみのパッケージ | スキップ |
| S-6 | `package.json` `exports` と `index.js` re-export が矛盾 | `exports` を優先 |
| S-7 | スコープ付きパッケージ `@scope/pkg` | 正しく解決 |
| S-8 | `node_modules` が見つからない環境 | スキップ（エラーなし） |

## CLI: CLI (8 cases)

| ID | テストケース | 期待結果 |
|----|------------|---------|
| CLI-1 | 違反なしのディレクトリ | exit code 0 |
| CLI-2 | 違反ありのディレクトリ | exit code 1 |
| CLI-3 | `--fix` で修正 | exit code 0、ファイルが書き換わる |
| CLI-4 | `--help` | ヘルプ表示 |
| CLI-5 | 存在しないパス | exit code 2 |
| CLI-6 | `--exclude` で除外 | 対象ファイルがスキップされる |
| CLI-7 | 対象ファイル拡張子のフィルタリング | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs` のみ処理 |
| CLI-8 | `package.json` の `"minport"` 設定読み込み | 設定反映 |

## E: エッジケース (12 cases)

| ID | テストケース | 期待結果 |
|----|------------|---------|
| E-1 | 空ファイル | エラーなし |
| E-2 | 構文エラーのあるファイル | スキップ + 警告 |
| E-3 | バイナリファイル | スキップ |
| E-4 | `import type { ... }` (type-only import) | 通常通り検査 |
| E-5 | `.tsx` ファイル内の import | 正常に抽出・検査 |
| E-6 | `.mts` ファイル内の import | 正常に抽出・検査 |
| E-7 | 1000行超のファイル | 正常動作 |
| E-8 | 同じ名前を異なるパスから import（ファイル内重複） | 各行を個別に評価 |
| E-9 | `// minport-ignore` インライン抑制 | 抑制される |
| E-10 | symlink 先のファイル | 重複検出しない |
| E-11 | パスエイリアス（`tsconfig.json` の `paths`）を含む import | エイリアスを解決してから短縮候補を探索 |
| E-12 | dynamic import `import('X/Y/Z')` | 対象外（抽出しない） |

## テスト構造

```
tests/
├── import-parser.test.ts      # P-1〜P-10
├── reexport-resolver.test.ts  # R-1〜R-12
├── exports-resolver.test.ts   # X-1〜X-10
├── detection.test.ts          # D-1〜D-10
├── fixer.test.ts              # F-1〜F-8
├── third-party.test.ts        # S-1〜S-8
├── cli.test.ts                # CLI-1〜CLI-8
├── edge-cases.test.ts         # E-1〜E-12
└── fixtures/
    ├── project/               # プロジェクト内 re-export テスト用
    ├── third-party/           # サードパーティ模擬
    └── package-exports/       # package.json exports テスト用
```

合計: 78 cases
