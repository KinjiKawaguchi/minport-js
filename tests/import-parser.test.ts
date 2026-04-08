import { describe, expect, it } from "vitest";

import { parseSourceFile } from "../src/import-parser.js";

describe("parseSourceFile", () => {
  it("extracts named imports while ignoring default, namespace, and side-effect imports", () => {
    const source = `
import DefaultValue from "./default";
import * as Namespace from "./namespace";
import "./side-effect";
import {
  Foo,
  Bar as Baz,
} from "./deep/module";
import type { TypeOnly } from './types';
import { type InlineType, Value } from "./mixed";
const text = "import { NotAnImport } from 'nope'";
`;

    const result = parseSourceFile("/repo/src/example.ts", source);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.parsed.imports).toHaveLength(6);
    expect(result.parsed.namedImports).toEqual([
      expect.objectContaining({
        modulePath: "./deep/module",
        name: "Foo",
        alias: undefined,
        line: 5,
        col: 1,
        isTypeOnly: false,
      }),
      expect.objectContaining({
        modulePath: "./deep/module",
        name: "Bar",
        alias: "Baz",
        line: 5,
        col: 1,
        isTypeOnly: false,
      }),
      expect.objectContaining({
        modulePath: "./types",
        name: "TypeOnly",
        isTypeOnly: true,
      }),
      expect.objectContaining({
        modulePath: "./mixed",
        name: "InlineType",
        isTypeOnly: true,
      }),
      expect.objectContaining({
        modulePath: "./mixed",
        name: "Value",
        isTypeOnly: false,
      }),
    ]);
  });

  it("marks inline ignore comments on import declarations", () => {
    const source = `import { Foo } from "./foo"; // minport-ignore`;
    const result = parseSourceFile("/repo/src/ignored.ts", source);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.parsed.imports[0]).toMatchObject({ isIgnored: true, quote: '"' });
    expect(result.parsed.namedImports[0]).toMatchObject({ isIgnored: true });
  });

  it("collects supported export shapes and ignores export stars", () => {
    const source = `
export { Foo } from "./foo";
export { Foo as Bar } from "./foo";
export { default as Baz } from "./foo";
export const Local = 1;
export default function Named() {}
export type { TypeOnly } from "./types";
export * from "./ignored";
`;

    const result = parseSourceFile("/repo/src/exports.ts", source);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.parsed.exports).toEqual([
      {
        filePath: "/repo/src/exports.ts",
        exportedName: "Foo",
        localName: undefined,
        sourceModule: "./foo",
        sourceExportName: "Foo",
        isTypeOnly: false,
      },
      {
        filePath: "/repo/src/exports.ts",
        exportedName: "Bar",
        localName: undefined,
        sourceModule: "./foo",
        sourceExportName: "Foo",
        isTypeOnly: false,
      },
      {
        filePath: "/repo/src/exports.ts",
        exportedName: "Baz",
        localName: undefined,
        sourceModule: "./foo",
        sourceExportName: "default",
        isTypeOnly: false,
      },
      {
        filePath: "/repo/src/exports.ts",
        exportedName: "Local",
        localName: "Local",
        sourceModule: undefined,
        sourceExportName: undefined,
        isTypeOnly: false,
      },
      {
        filePath: "/repo/src/exports.ts",
        exportedName: "default",
        localName: "Named",
        sourceModule: undefined,
        sourceExportName: undefined,
        isTypeOnly: false,
      },
      {
        filePath: "/repo/src/exports.ts",
        exportedName: "TypeOnly",
        localName: undefined,
        sourceModule: "./types",
        sourceExportName: "TypeOnly",
        isTypeOnly: true,
      },
    ]);
  });

  it("returns a parse error for invalid source", () => {
    const result = parseSourceFile("/repo/src/broken.ts", "import { Foo from './foo';");
    expect(result).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        filePath: "/repo/src/broken.ts",
      }),
    });
  });
});
