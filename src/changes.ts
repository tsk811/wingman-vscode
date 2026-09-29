import { createPatch } from "diff";
import { FileEntry, readText } from "./workspaceFiles";

const FULL_CONTENT_MAX_LINES = 400;
const TOTAL_BUDGET_CHARS = 60_000;

/**
 * Tells the agent what changed on disk since its last turn, so it doesn't write code
 * against its stale memory of the project. Keeps the last content it reported per file
 * so later reports can be diffs instead of whole files.
 */
export class ChangeTracker {
  private baselines = new Map<string, string>();
  private pending = new Map<string, string>();

  reset(): void {
    this.baselines.clear();
    this.pending.clear();
  }

  async describe(files: FileEntry[], since: number): Promise<string> {
    this.pending.clear();
    const changed = files.filter((f) => f.mtimeMs > since).sort((a, b) => a.relPath.localeCompare(b.relPath));
    if (changed.length === 0) {
      return "";
    }

    const parts: string[] = [];
    const skipped: string[] = [];
    let budget = TOTAL_BUDGET_CHARS;
    for (const f of changed) {
      const text = await readText(f.absPath);
      if (text === undefined) {
        continue;
      }
      this.pending.set(f.relPath, text);

      const before = this.baselines.get(f.relPath);
      let section: string | undefined;
      if (before !== undefined) {
        if (before === text) {
          continue;
        }
        section = "```diff\n" + createPatch(f.relPath, before, text, "", "", { context: 3 }) + "```";
      } else if (text.split("\n").length <= FULL_CONTENT_MAX_LINES) {
        section = `${f.relPath} (current content):\n\`\`\`\n${text}\n\`\`\``;
      }

      if (section && section.length <= budget) {
        parts.push(section);
        budget -= section.length;
      } else {
        skipped.push(f.relPath);
      }
    }
    if (skipped.length) {
      parts.push(`Also changed (not shown; re-read if relevant): ${skipped.join(", ")}`);
    }
    return parts.join("\n\n");
  }

  /** Call once the agent has actually seen the last description. */
  commit(): void {
    for (const [k, v] of this.pending) {
      this.baselines.set(k, v);
    }
    this.pending.clear();
  }
}
