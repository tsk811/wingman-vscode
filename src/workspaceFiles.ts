import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";

const MAX_FILE_BYTES = 512 * 1024;

export interface FileEntry {
  relPath: string;
  absPath: string;
  mtimeMs: number;
}

/**
 * Lists workspace files that Wingman should look at: everything not matched by
 * `excludeGlobs`, and (in a git repo) not ignored by .gitignore.
 */
export async function listFiles(root: vscode.WorkspaceFolder, excludeGlobs: string[]): Promise<FileEntry[]> {
  const exclude = excludeGlobs.length ? `{${excludeGlobs.join(",")}}` : undefined;
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*"), exclude);
  const gitFiles = await gitVisibleFiles(root.uri.fsPath);

  const entries: FileEntry[] = [];
  await Promise.all(
    uris.map(async (uri) => {
      const relPath = path.relative(root.uri.fsPath, uri.fsPath).split(path.sep).join("/");
      if (gitFiles && !gitFiles.has(relPath)) {
        return;
      }
      try {
        const st = await fs.stat(uri.fsPath);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) {
          entries.push({ relPath, absPath: uri.fsPath, mtimeMs: st.mtimeMs });
        }
      } catch {
        // Deleted between listing and stat.
      }
    }),
  );
  return entries;
}

/** Tracked + untracked-but-not-ignored files, or undefined outside a git repo. */
function gitVisibleFiles(cwd: string): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : new Set(stdout.split("\0").filter(Boolean))),
    );
  });
}

/** Reads a text file from disk, or undefined if it looks binary or vanished. */
export async function readText(absPath: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(absPath);
    if (buf.subarray(0, 8000).includes(0)) {
      return undefined;
    }
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}
