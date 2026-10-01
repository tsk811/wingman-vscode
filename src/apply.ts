import * as vscode from "vscode";
import { countReplyLines, formatReply, Marker, markerRegexes, waitingSignature } from "./markers";
import { contextWindow } from "./prompt";
import { MarkerEdit, MarkerResult } from "./providers/types";

export interface ApplyOutcome {
  done: number;
  questions: number;
  refused: number;
  /** Markers whose result couldn't be applied, with a reason. */
  skipped: string[];
  /** Signatures of markers now waiting on the user (see `waitingSignature`). */
  waiting: string[];
  /** Newly inserted code, for highlighting. */
  inserted: { uri: vscode.Uri; range: vscode.Range }[];
}

interface Planned {
  startLine: number;
  /** Lines replaced, starting at startLine. */
  oldCount: number;
  newLines: string[];
  isCode: boolean;
}

export async function applyResults(markers: Marker[], results: MarkerResult[], prefix: string): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { done: 0, questions: 0, refused: 0, skipped: [], waiting: [], inserted: [] };
  const byId = new Map<string, MarkerResult>();
  for (const r of results) {
    if (!byId.has(r.id)) {
      byId.set(r.id, r);
    }
  }

  const byFile = new Map<string, Marker[]>();
  for (const m of markers) {
    byFile.set(m.absPath, [...(byFile.get(m.absPath) ?? []), m]);
  }

  const edit = new vscode.WorkspaceEdit();
  const plannedByUri: { uri: vscode.Uri; planned: Planned[] }[] = [];

  for (const [absPath, fileMarkers] of byFile) {
    const uri = vscode.Uri.file(absPath);
    // The open buffer, including anything the user typed while the agent was working.
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = doc.getText().split(/\r?\n/);
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const planned: Planned[] = [];
    const usedLines = new Set<number>();

    // Find every marker first, so one marker's edits can't overwrite another marker.
    const located: { m: Marker; r: MarkerResult; at: number; oldCount: number }[] = [];
    for (const m of fileMarkers) {
      const r = byId.get(m.id);
      if (!r) {
        outcome.skipped.push(`${label(m)}: the agent returned no result`);
        continue;
      }
      const at = locate(lines, m, usedLines);
      if (at === undefined) {
        outcome.skipped.push(`${label(m)}: marker was edited or removed during the run`);
        continue;
      }
      usedLines.add(at);
      located.push({ m, r, at, oldCount: 1 + countReplyLines(lines, at, prefix) });
    }
    const taken = located.map(({ at, oldCount }) => ({ startLine: at, oldCount }));

    for (const { m, r, at, oldCount } of located) {
      if (r.status === "done") {
        const edits = planEdits(lines, m, at, r.edits, taken);
        if (typeof edits === "string") {
          outcome.skipped.push(`${label(m)}: ${edits}`);
          continue;
        }
        planned.push({ startLine: at, oldCount, newLines: reindent(r.code, m.indent), isCode: true }, ...edits);
        taken.push(...edits);
        outcome.done++;
      } else {
        const reply = formatReply(m, prefix, r.message || (r.status === "question" ? "Need more detail." : "Can't do this one."));
        planned.push({ startLine: at, oldCount, newLines: [lines[at], ...reply], isCode: false });
        outcome.waiting.push(
          waitingSignature({
            relPath: m.relPath,
            lineText: lines[at],
            replyLines: reply.map((l) => markerRegexes(prefix).reply.exec(l)?.[3] ?? ""),
          }),
        );
        if (r.status === "question") {
          outcome.questions++;
        } else {
          outcome.refused++;
        }
      }
    }

    planned.sort((a, b) => a.startLine - b.startLine);
    for (const p of planned) {
      edit.replace(uri, replaceRange(lines, p), p.newLines.map((l) => l + eol).join(""));
    }
    plannedByUri.push({ uri, planned });
  }

  if (edit.size > 0 && !(await vscode.workspace.applyEdit(edit))) {
    throw new Error("VS Code rejected the edit (the file may have changed at the same moment). Try again.");
  }

  // Where the new code landed, after earlier edits in the same file shifted lines.
  for (const { uri, planned } of plannedByUri) {
    let shift = 0;
    for (const p of planned) {
      if (p.isCode && p.newLines.length) {
        const start = p.startLine + shift;
        outcome.inserted.push({ uri, range: new vscode.Range(start, 0, start + p.newLines.length - 1, 0) });
      }
      shift += p.newLines.length - p.oldCount;
    }
  }
  return outcome;
}

function label(m: Marker): string {
  return `${m.relPath}:${m.line + 1} "${m.instruction}"`;
}

/**
 * Resolves a marker's edits to line ranges in the current text, or returns why it can't.
 * Each edit's `original` must still be at `startLine` (shifted by however far the marker
 * moved while the agent worked), or else appear exactly once in the marker's context
 * window. Edits may not overlap markers, their replies, or each other.
 */
function planEdits(lines: string[], m: Marker, at: number, edits: MarkerEdit[], taken: Pick<Planned, "startLine" | "oldCount">[]): Planned[] | string {
  const drift = at - m.line;
  const win = contextWindow(m, lines.length - drift);
  const lo = Math.max(0, win.from + drift);
  const hi = Math.min(lines.length, win.to + drift);
  const plans: Planned[] = [];

  for (const e of edits) {
    const original = toLines(e.original);
    if (!original.length) {
      return `an edit at line ${e.startLine} quoted no original lines`;
    }
    const fits = (i: number) =>
      i >= lo && i + original.length <= hi && original.every((l, k) => lines[i + k].trimEnd() === l.trimEnd());
    let start = e.startLine - 1 + drift;
    if (!fits(start)) {
      const found: number[] = [];
      for (let i = lo; i < hi; i++) {
        if (fits(i)) {
          found.push(i);
        }
      }
      if (found.length !== 1) {
        return found.length
          ? `the code an edit replaces appears more than once near the marker`
          : `an edit at line ${e.startLine} no longer matches the file`;
      }
      start = found[0];
    }
    const end = start + original.length;
    if ([...taken, ...plans].some((p) => start < p.startLine + p.oldCount && p.startLine < end)) {
      return `an edit at line ${e.startLine} overlaps a marker or another edit`;
    }
    plans.push({ startLine: start, oldCount: original.length, newLines: toLines(e.replacement), isCode: true });
  }
  return plans;
}

/** Splits into lines, ignoring one trailing line break; "" is no lines. */
function toLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Finds the marker line by its exact text, nearest to where it was when scanned. */
function locate(lines: string[], m: Marker, used: Set<number>): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === m.lineText && !used.has(i) && (best === undefined || Math.abs(i - m.line) < Math.abs(best - m.line))) {
      best = i;
    }
  }
  return best;
}

/** Whole lines [startLine, startLine+oldCount), including their line breaks. */
function replaceRange(lines: string[], p: Planned): vscode.Range {
  const end = p.startLine + p.oldCount;
  if (end < lines.length) {
    return new vscode.Range(p.startLine, 0, end, 0);
  }
  // Replacing through the last line, which has no trailing line break.
  const last = lines.length - 1;
  if (p.oldCount === 0) {
    return new vscode.Range(last, lines[last].length, last, lines[last].length);
  }
  return new vscode.Range(p.startLine, 0, last, lines[last].length);
}

function reindent(code: string, indent: string): string[] {
  const lines = code.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) {
    lines.shift();
  }
  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop();
  }
  const common = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length),
  );
  return lines.map((l) => (l.trim() ? indent + l.slice(Number.isFinite(common) ? common : 0) : ""));
}

const ADD_MISSING_IMPORTS = vscode.CodeActionKind.Source.append("addMissingImports");
const IMPORT_ATTEMPTS = 5;
const IMPORT_RETRY_MS = 400;

/**
 * Asks each file's language extension to add imports for names the new code uses
 * (e.g. TypeScript's "Add all missing imports"). Sidekick never places imports itself.
 *
 * The language server may not have analysed the new code yet, so an offered action
 * with no edits is retried a few times before giving up; after a fix is applied it's
 * asked again until it has nothing left.
 */
export async function addMissingImports(uris: vscode.Uri[], log: vscode.LogOutputChannel): Promise<void> {
  for (const uri of uris) {
    const rel = vscode.workspace.asRelativePath(uri);
    let summary = "none offered";
    let applied = 0;
    for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, IMPORT_RETRY_MS));
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const actions =
        (await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider",
          uri,
          new vscode.Range(0, 0, doc.lineCount, 0),
          ADD_MISSING_IMPORTS.value,
          10,
        )) ?? [];
      const matching = actions.filter((a) => a.kind && ADD_MISSING_IMPORTS.contains(a.kind));
      summary = matching.map((a) => `"${a.title}" (${a.edit?.size ?? 0} edit(s)${a.command ? " + command" : ""})`).join(", ") || "none offered";
      const useful = matching.filter((a) => (a.edit?.size ?? 0) > 0 || a.command);
      if (useful.length) {
        for (const action of useful) {
          if (action.edit) {
            await vscode.workspace.applyEdit(action.edit);
          }
          if (action.command) {
            await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
          }
        }
        applied++;
        continue; // one pass doesn't always fix every name (seen with TypeScript); ask again
      }
      if (matching.length === 0 || applied > 0) {
        break; // not offered by this language, or nothing left to fix
      }
    }
    log.info(`Import fixes for ${rel}: ${applied ? `applied ${applied} pass(es)` : summary}`);
  }
}
