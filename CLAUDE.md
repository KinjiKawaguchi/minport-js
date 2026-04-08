# minport — Project Instructions

JavaScript/TypeScript の `import { ... } from '...'` 文を最短パスに正規化するリンター + 自動修正ツール。
re-export チェーンと `package.json` の `exports` フィールドを辿り、より短い import パスが存在する場合に警告・修正する。

**関連ドキュメント:**
- [docs/test-cases.md](docs/test-cases.md) — テストケース全量リスト

## Project Overview

`import { Name } from 'pkg/deep/internal/module'` のように冗長な import パスを、re-export と `package.json` `exports` を辿って最短形に正規化する CLI ツール。npm (`npm install minport`) で公開。ライセンスは MIT。

### 想定ユースケース

```typescript
// Before
import { FieldInfo } from '@pydantic/fields/internal';
import { Session } from 'typeorm/connection/session';
import { User } from '@myproject/domain/user/models';

// After (minport check --fix)
import { FieldInfo } from '@pydantic';
import { Session } from 'typeorm';
import { User } from '@myproject/domain';
```

冗長な import パスは：
- 可読性を損なう
- 内部リファクタリング時に壊れやすい（re-export は公開 API、内部パスは実装詳細）
- コードベース全体で同じ名前に対して異なるパスが混在する原因になる

## Scope

### やること

- `import { Name } from 'X/Y/Z'` に対して、より短い `import { Name } from 'X'` や `import { Name } from 'X/Y'` が有効かを検証
- プロジェクト内パッケージの `index.ts` / `index.js` re-export チェーンの解析
- サードパーティパッケージの re-export 解析（`node_modules` 内の `index.js` / `index.ts` を AST 解析）
- サードパーティパッケージの `package.json` `exports` フィールドによるサブパスマッピング解析
- CLI (`minport check`, `minport check --fix`)
- `--fix` による自動書き換え
- `tsconfig.json` の `paths` エイリアスを解決した上での短縮候補探索
- `package.json` の `"minport"` 設定サポート

### やらないこと

- `import X from 'Y'`（default import）の書き換え
- `import * as X from 'Y'`（namespace import）の書き換え
- 名前衝突の自動解決（同名が複数パスに存在する場合は修正しない）
- `export * from '...'`（ワイルドカード re-export）の解析
- CJS (`require` / `module.exports`) の解析
- ランタイム import (`import()`) による検証

### Roadmap

- ESLint プラグイン化
- Biome プラグイン化

## Architecture

### コンポーネント構成

```
src/
├── index.ts                # Public API: version
├── models.ts               # データモデル（readonly interface）
├── import-parser.ts        # AST（oxc）から import 文を抽出・解析
├── reexport-resolver.ts    # re-export チェーンを辿って最短パスを算出
├── exports-resolver.ts     # package.json exports フィールドの解析
├── fixer.ts                # ソースコード書き換え（行ベース置換）
├── checker.ts              # チェッカーファサード
└── cli.ts                  # CLI エントリーポイント
```

### 設計原則

**インターフェースに依存する設計**

各コンポーネントはインターフェースで依存先を定義し、具象実装を直接 import しない。

**依存方向**

```
cli.ts → checker.ts → import-parser.ts
                     → reexport-resolver.ts
                     → exports-resolver.ts
                     → fixer.ts
```

`models.ts` は他のモジュールに依存しない（leaf module）。
`checker.ts` がファサードとして各コンポーネントを組み立てる。

## Data Model

```typescript
interface ImportStatement {
  readonly modulePath: string;       // "pkg/deep/internal"
  readonly name: string;             // "ClassName"
  readonly alias: string | undefined; // "as Alias" がある場合
  readonly filePath: string;
  readonly line: number;
  readonly col: number;
}

interface Violation {
  readonly filePath: string;
  readonly line: number;
  readonly col: number;
  readonly originalPath: string;
  readonly shorterPath: string;
  readonly name: string;
  readonly code: string;             // "MP001"
  readonly message: string;
}

interface CheckResult {
  readonly violations: readonly Violation[];
  readonly filesChecked: number;
  readonly filesSkipped: number;
}

interface FixResult {
  readonly filesModified: number;
  readonly fixesApplied: number;
}
```

## Error Code

| コード | 名前 | 説明 |
|--------|------|------|
| MP001 | shorter-import-available | より短い import パスが利用可能 |

## Algorithm

### 最短パス探索

1. 対象ファイルから `import { Name } from 'X/Y/Z'` を全て抽出
2. `X/Y/Z` のモジュールパスを分解: `["X", "X/Y", "X/Y/Z"]`
3. 短い順に各候補パスについて:
   a. 対応する `index.ts` / `index.js` またはモジュールファイルを特定
   b. そのモジュールの名前空間に `Name` が re-export されているか AST 解析で確認
   c. `package.json` の `exports` フィールドにサブパスが定義されていれば、そのマッピングも考慮
   d. 見つかればそれが最短パス → 元のパスより短ければ違反として報告
4. 名前衝突（同名が複数パスに存在）がある場合は報告しない

### re-export 検出パターン

`index.ts` / `index.js` 内の以下を認識：
- `export { Name } from './module'` — 名前付き re-export
- `export { Name as RenamedName } from './module'` — リネーム re-export
- `export { default as Name } from './module'` — default の名前付き re-export

### `package.json` `exports` 解析

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./utils": "./dist/utils/index.js"
  }
}
```

- `exports` で定義されたサブパスを正規パスとして扱う
- 条件付き exports (`"import"`, `"require"`, `"types"`) を解決
- `exports` が定義されていない場合は `main` / `module` フィールドにフォールバック

### サードパーティ解析

- Node.js のモジュール解決アルゴリズム（`node_modules` 探索）でパッケージを特定
- `package.json` の `exports` フィールドを優先的に解析
- `exports` がなければ `index.js` / `index.ts` の re-export を AST 解析
- ランタイム import は行わない

## Quality Rules

### Biome — リンター + フォーマッター

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0/schema.json",
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "formatter": {
    "enabled": true
  }
}
```

**原則:** Biome の警告はコードの設計・構造で解決する。抑制コメントは「ルールが文脈的に不適切」な場合のみ、理由コメント付きで使用。

### TypeScript — 厳格な型チェック

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

**型に関する原則:**
- 全 public 関数・メソッドに型アノテーション
- `any` 禁止 — `unknown` またはインターフェースを使う
- `as` キャスト は最小限、理由をコメントで明記
- `@ts-ignore` / `@ts-expect-error` 禁止 — 型エラーは設計で解決

## Coding Style

### 全般

- **イミュータビリティ優先**: `readonly` プロパティ、`Readonly<T>`, `ReadonlyArray<T>` でデータを表現
- **1 ファイル 200〜400 行**、上限 800 行
- **1 関数 50 行以内**、ネスト 4 段以内。早期 return
- **副作用を最小化**し、純粋関数を優先

### 命名

- 意図を明確に表現。省略より可読性
- boolean は `is`, `has`, `should`, `can` で始める
- ファイル名はケバブケース: `import-parser.ts`

### 対象ファイル拡張子

`.js`, `.mjs`, `.ts`, `.mts`, `.jsx`, `.tsx`（ESM のみ。`.cjs`, `.cts` は対象外）

### エラー処理

- 外部入力はシステム境界でバリデーション
- 内部コード間はインターフェースの型で保証（余分なバリデーション不要）
- 構文エラーファイルはスキップ + 警告（全体を止めない）

### 依存管理

- ランタイム依存: **oxc-parser** のみ
- 開発依存: `vitest`, `@vitest/coverage-v8`, `typescript`, `@biomejs/biome`, `lefthook`

## Git Conventions

- Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- コミットメッセージは目的（why）を簡潔に
- main への直接 push 禁止

## CI/CD

### CI (`.github/workflows/ci.yml`)

PR ごとに lint / typecheck / test / audit を並列実行。`all-checks-pass` をブランチ保護の required check にする。Node.js 22 + 24 マトリクステスト。開発は 24。

### CD (`.github/workflows/release.yml`)

Release Please + npm publish:
1. Conventional Commits → Release Please が CHANGELOG + バージョンバンプ PR 自動作成
2. Release PR マージ → GitHub Release + tag
3. `publish` ジョブが npm に自動公開

### pre-commit (lefthook)

biome check + tsc --noEmit をローカルでも実行。

### Versioning Policy (SemVer)

v1.0.0 未満: `feat:` → minor, `fix:` → patch, breaking change は避ける
v1.0.0 以降: breaking change は `feat!:` で major バンプ

## Development Commands

```bash
pnpm install                          # セットアップ
pnpm check                            # lint + format check
pnpm check:fix                        # lint + format fix
pnpm typecheck                        # 型チェック
pnpm test                             # テスト
pnpm test:coverage                    # テスト + カバレッジ
pnpm build                            # ビルド
```

## CLI

```bash
minport check src/                       # チェック
minport check src/ --fix                 # チェック + 自動修正
minport check src/ --exclude "tests/*"   # 除外
```

### 出力

```
src/app/service.ts:3:1: MP001 `import { FieldInfo } from '@pydantic/fields/internal'` can be shortened to `import { FieldInfo } from '@pydantic'`
Found 1 error (1 fixable with `minport check --fix`).
```

## Configuration

### package.json

```json
{
  "minport": {
    "exclude": ["tests/*"]
  }
}
```

### package.json 完全版

```json
{
  "name": "minport",
  "version": "0.0.0",
  "description": "A JavaScript/TypeScript linter that finds unnecessarily long import paths and suggests shorter alternatives",
  "type": "module",
  "bin": {
    "minport": "./dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "engines": {
    "node": ">=20"
  },
  "license": "MIT",
  "author": "KinjiKawaguchi",
  "repository": {
    "type": "git",
    "url": "https://github.com/KinjiKawaguchi/minport-js"
  },
  "keywords": ["linter", "static-analysis", "import", "refactoring", "code-quality"],
  "dependencies": {
    "oxc-parser": "^0.x"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0",
    "typescript": "^5.0",
    "vitest": "^3.0"
  }
}
```

### 安全性

- `--fix` は元ファイルを直接書き換える（git diff で確認推奨）
- 名前衝突がある場合は修正しない（安全側に倒す）
- 構文エラーファイルはスキップ

## README.md 構成仕様

1. バッジ行: npm version, Node.js versions, CI status, License
2. 1行説明
3. Problem: 冗長な import パスの実例
4. Quick Start: インストール + 最小例
5. Usage: CLI コマンド
6. Configuration: package.json 設定例
7. Rules: MP001 の説明
8. Algorithm: 最短パス探索の概要
9. Limitations: 現在の制約
10. Contributing: 開発環境セットアップ
11. License: MIT
