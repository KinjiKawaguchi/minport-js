import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SymlinkFile {
  readonly symlink: string;
}

export type ProjectFile = string | Uint8Array | SymlinkFile;

export function createTempProject(files: Readonly<Record<string, ProjectFile>>): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minport-"));

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (isSymlinkFile(content)) {
      fs.symlinkSync(content.symlink, targetPath);
      continue;
    }

    if (typeof content === "string") {
      fs.writeFileSync(targetPath, content, "utf8");
      continue;
    }

    fs.writeFileSync(targetPath, content);
  }

  return projectRoot;
}

export function cleanupTempProject(projectRoot: string): void {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

export function readProjectFile(projectRoot: string, relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function isSymlinkFile(value: ProjectFile): value is SymlinkFile {
  return typeof value === "object" && !(value instanceof Uint8Array) && "symlink" in value;
}
