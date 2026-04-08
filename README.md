[![npm version](https://img.shields.io/npm/v/minport)](https://www.npmjs.com/package/minport)
[![Node.js](https://img.shields.io/node/v/minport)](https://www.npmjs.com/package/minport)
[![CI](https://img.shields.io/github/actions/workflow/status/KinjiKawaguchi/minport-js/ci.yml?branch=main&label=ci)](https://github.com/KinjiKawaguchi/minport-js/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/minport)](./LICENSE)

A JavaScript/TypeScript linter that finds unnecessarily long import paths and suggests shorter alternatives.

## Problem

Deep imports make code harder to read and easier to break when internals move.

```ts
// Before
import { FieldInfo } from "@pydantic/fields/internal";
import { Session } from "typeorm/connection/session";
import { User } from "@myproject/domain/user/models";

// After
import { FieldInfo } from "@pydantic";
import { Session } from "typeorm";
import { User } from "@myproject/domain";
```

`minport` follows re-export chains and `package.json` `exports` to find the shortest safe import path for each named import.

## Quick Start

```bash
pnpm add -D minport
pnpm exec minport check src
pnpm exec minport check src --fix
```

## Usage

```bash
minport check src/
minport check src/ --fix
minport check src/ --exclude "tests/*"
```

Example output:

```text
src/app/service.ts:3:1: MP001 `import { FieldInfo } from '@pydantic/fields/internal'` can be shortened to `import { FieldInfo } from '@pydantic'`
Found 1 error(s) (1 fixable with `minport check --fix`).
```

## Configuration

Configure excludes in `package.json`:

```json
{
  "minport": {
    "exclude": ["tests/*"]
  }
}
```

`tsconfig.json` `paths` aliases are also supported.

## Rules

### MP001 `shorter-import-available`

Reported when a named import can be replaced with a shorter path that resolves to the same exported symbol.

The rule applies to:

- `import { Name } from "pkg/deep/module"`
- `import { Name as Alias } from "pkg/deep/module"`
- `import type { Name } from "pkg/deep/module"`

The rule does not rewrite:

- default imports
- namespace imports
- `export *` chains
- CommonJS imports

## Algorithm

For each named import, `minport`:

1. Resolves the original import target.
2. Walks candidate parent paths from shortest to longest.
3. Parses re-exports and `package.json` `exports`.
4. Compares terminal symbol origins.
5. Reports only when the shorter path resolves to the same symbol without ambiguity.

## Limitations

- `export * from "..."` is intentionally ignored.
- CommonJS (`require`, `module.exports`) is out of scope.
- Name conflicts across shorter public paths are skipped instead of auto-fixed.
- Dynamic `import()` calls are ignored.

## Contributing

```bash
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

Pre-commit uses `lefthook` to run Biome and TypeScript checks locally.

## License

[MIT](./LICENSE)
