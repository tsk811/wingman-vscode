import * as vscode from "vscode";
import { addMissingImports, applyResults } from "./apply";
import { ChangeTracker } from "./changes";
import { getConfig, WingmanConfig } from "./config";
import { Marker, parseMarkers, waitingSignature } from "./markers";
import { primingPrompt, turnPrompt } from "./prompt";
import { CodexProvider } from "./providers/codex";
import { AgentProvider, TurnUsage } from "./providers/types";
import { listFiles, readText } from "./workspaceFiles";

const SESSION_KEY = "wingman.sessionId";
const LAST_TURN_KEY = "wingman.lastTurnAt";
const WAITING_KEY = "wingman.waiting";
const HIGHLIGHT_MS = 4000;

type Busy = { kind: "starting" } | { kind: "running"; markers: number };

export class Wingman implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  });
  private readonly changes = new ChangeTracker();
  private busy?: Busy;
  private abort?: AbortController;
  /** A run requested while busy; manual if any of the requests was (so a Retry isn't downgraded). */
  private queued?: { manual: boolean };

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.status.command = "wingman.sessionMenu";
    this.updateStatus();
    this.status.show();
  }

  dispose(): void {
    this.abort?.abort();
    this.status.dispose();
    this.highlight.dispose();
  }

  get sessionId(): string | undefined {
    return this.ctx.workspaceState.get<string>(SESSION_KEY);
  }

  get isBusy(): boolean {
    return this.busy !== undefined;
  }

  private root(): vscode.WorkspaceFolder | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      void vscode.window.showWarningMessage("Wingman needs an open folder.");
    }
    return root;
  }

  private provider(config: WingmanConfig): AgentProvider {
    switch (config.provider) {
      case "codex":
      default:
        return new CodexProvider();
    }
  }

  // ---- sessions ----

  async startSession(): Promise<boolean> {
    if (this.busy) {
      void vscode.window.showInformationMessage("Wingman is busy. Wait for the current run to finish or cancel it.");
      return false;
    }
    const root = this.root();
    if (!root) {
      return false;
    }
    // Reserve busy before the first await so a second start can't slip past the guard.
    this.busy = { kind: "starting" };
    this.abort = new AbortController();
    this.updateStatus();
    const config = getConfig();
    const provider = this.provider(config);
    const startedAt = Date.now();
    try {
      const problem = await provider.check(config);
      if (problem) {
        this.queued = undefined;
        void vscode.window.showErrorMessage(`Wingman: ${problem}`);
        return false;
      }
      this.log.info(`Starting ${provider.name} session in ${root.uri.fsPath} (effort: ${config.reasoningEffort})`);
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Wingman: reading the project" },
        () =>
          provider.startSession({
            cwd: root.uri.fsPath,
            prompt: primingPrompt(config.markerPrefix),
            config,
            signal: this.abort!.signal,
          }),
      );
      await this.ctx.workspaceState.update(SESSION_KEY, res.sessionId);
      await this.ctx.workspaceState.update(LAST_TURN_KEY, startedAt);
      this.changes.reset();
      this.log.info(`Session ${res.sessionId} ready ${this.usageText(res.usage, startedAt)}\n${res.reply}`);
      void vscode.window.setStatusBarMessage("Wingman: session ready", 4000);
      return true;
    } catch (err) {
      this.queued = undefined;
      this.reportError("Couldn't start a session", err);
      return false;
    } finally {
      this.finishBusy();
    }
  }

  async endSession(): Promise<void> {
    this.abort?.abort();
    await this.ctx.workspaceState.update(SESSION_KEY, undefined);
    await this.ctx.workspaceState.update(LAST_TURN_KEY, undefined);
    this.changes.reset();
    this.log.info("Session ended");
    this.updateStatus();
  }

  cancel(): void {
    this.abort?.abort();
  }

  // ---- runs ----

  /**
   * Implements every saved marker in the workspace in one turn. `manual` also retries
   * markers that are waiting on the user after a question.
   */
  async implement(manual: boolean): Promise<void> {
    if (this.busy) {
      this.queued = { manual: manual || (this.queued?.manual ?? false) };
      return;
    }
    const root = this.root();
    if (!root) {
      return;
    }
    if (!this.sessionId) {
      const pick = await vscode.window.showInformationMessage(
        "Wingman has no active session. Start one? (The agent reads the project first, which takes a moment.)",
        "Start session",
      );
      if (pick === "Start session") {
        // Runs from finishBusy() once the session is ready.
        this.queued = { manual };
        await this.startSession();
      }
      return;
    }

    const config = getConfig();
    const sessionId = this.sessionId!;
    this.busy = { kind: "running", markers: 0 };
    this.abort = new AbortController();
    this.updateStatus();
    try {
      const files = await listFiles(root, config.excludeGlobs);
      const { markers, fileTexts, waitingSkipped } = await this.collectMarkers(files, config.markerPrefix, manual);
      if (markers.length === 0) {
        this.log.info(`No markers to implement${waitingSkipped ? ` (${waitingSkipped} waiting on your reply)` : ""}`);
        if (manual) {
          void vscode.window.showInformationMessage(
            waitingSkipped
              ? `Wingman: no new markers (${waitingSkipped} waiting on your reply).`
              : `Wingman: no saved ${config.markerPrefix}: markers found.`,
          );
        }
        return;
      }

      this.busy = { kind: "running", markers: markers.length };
      this.updateStatus();
      const since = this.ctx.workspaceState.get<number>(LAST_TURN_KEY) ?? 0;
      const changes = await this.changes.describe(files, since);
      const prompt = turnPrompt({ prefix: config.markerPrefix, markers, fileTexts, changes });
      const turnStartedAt = Date.now();
      this.log.info(`Turn: ${markers.length} marker(s) in ${new Set(markers.map((m) => m.relPath)).size} file(s)`);
      this.log.trace(prompt);

      const { output, usage } = await this.provider(config).runTurn({
        cwd: root.uri.fsPath,
        sessionId,
        prompt,
        config,
        signal: this.abort.signal,
      });
      this.changes.commit();
      await this.ctx.workspaceState.update(LAST_TURN_KEY, turnStartedAt);
      this.log.info(`Turn finished ${this.usageText(usage, turnStartedAt)}`);
      this.log.debug(JSON.stringify(output, null, 2));

      const outcome = await applyResults(markers, output.results, config.markerPrefix);
      await this.updateWaiting(markers, outcome.waiting);
      this.flash(outcome.inserted);
      // Highlights track later edits, so flash first; import fixes may shift lines.
      const codeFiles = [...new Map(outcome.inserted.map((i) => [i.uri.toString(), i.uri])).values()];
      await addMissingImports(codeFiles, this.log);

      const summary = [
        outcome.done && `${outcome.done} done`,
        outcome.questions && `${outcome.questions} question${outcome.questions > 1 ? "s" : ""}`,
        outcome.refused && `${outcome.refused} refused`,
      ]
        .filter(Boolean)
        .join(", ");
      void vscode.window.setStatusBarMessage(`Wingman: ${summary || "nothing applied"}`, 6000);
      if (outcome.skipped.length) {
        outcome.skipped.forEach((s) => this.log.warn(`Skipped ${s}`));
        void vscode.window.showWarningMessage(`Wingman skipped ${outcome.skipped.length} marker(s): ${outcome.skipped.join("; ")}`);
      }
    } catch (err) {
      this.reportError("Run failed", err);
    } finally {
      this.finishBusy();
    }
  }

  /**
   * A marker counts once it's saved to disk. If the file is open, the buffer is the source
   * of truth: a marker already replaced there (but not yet saved) must not run again.
   */
  private async collectMarkers(files: { relPath: string; absPath: string }[], prefix: string, includeWaiting: boolean) {
    const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.fsPath, d]));
    const waiting = new Set(this.ctx.workspaceState.get<string[]>(WAITING_KEY, []));
    const markers: Marker[] = [];
    const fileTexts = new Map<string, string>();
    let waitingSkipped = 0;

    for (const f of files) {
      const disk = await readText(f.absPath);
      if (!disk || !disk.includes(prefix + ":")) {
        continue;
      }
      const doc = openDocs.get(f.absPath);
      const text = doc ? doc.getText() : disk;
      const diskLines = doc ? new Set(disk.split(/\r?\n/)) : undefined;
      for (const m of parseMarkers(text, prefix, f.relPath, f.absPath)) {
        if (diskLines && !diskLines.has(m.lineText)) {
          continue;
        }
        if (!includeWaiting && m.replyLines.length && waiting.has(waitingSignature(m))) {
          waitingSkipped++;
          continue;
        }
        markers.push({ ...m, id: `M${markers.length + 1}` });
        fileTexts.set(f.relPath, text);
      }
    }
    return { markers, fileTexts, waitingSkipped };
  }

  private async updateWaiting(ran: Marker[], nowWaiting: string[]): Promise<void> {
    const ranSigs = new Set(ran.map(waitingSignature));
    const kept = this.ctx.workspaceState.get<string[]>(WAITING_KEY, []).filter((s) => !ranSigs.has(s));
    await this.ctx.workspaceState.update(WAITING_KEY, [...kept, ...nowWaiting].slice(-500));
  }

  // ---- UI ----

  private finishBusy(): void {
    this.busy = undefined;
    this.abort = undefined;
    this.updateStatus();
    const queued = this.queued;
    if (queued) {
      this.queued = undefined;
      void this.implement(queued.manual);
    }
  }

  private flash(inserted: { uri: vscode.Uri; range: vscode.Range }[]): void {
    const editors = vscode.window.visibleTextEditors;
    const touched = new Set<vscode.TextEditor>();
    for (const e of editors) {
      const ranges = inserted.filter((i) => i.uri.toString() === e.document.uri.toString()).map((i) => i.range);
      if (ranges.length) {
        e.setDecorations(this.highlight, ranges);
        touched.add(e);
      }
    }
    if (touched.size) {
      setTimeout(() => touched.forEach((e) => e.setDecorations(this.highlight, [])), HIGHLIGHT_MS);
    }
  }

  private updateStatus(): void {
    const s = this.status;
    if (this.busy?.kind === "starting") {
      s.text = "$(sync~spin) Wingman: reading project…";
      s.tooltip = "Starting a session. Click to cancel or manage.";
    } else if (this.busy?.kind === "running") {
      s.text = `$(sync~spin) Wingman${this.busy.markers ? `: ${this.busy.markers} marker${this.busy.markers > 1 ? "s" : ""}…` : "…"}`;
      s.tooltip = "Implementing markers. Click to cancel or manage.";
    } else if (this.sessionId) {
      s.text = "$(pass-filled) Wingman";
      s.tooltip = `Session active (${this.sessionId}). Click to manage.`;
    } else {
      s.text = "$(circle-slash) Wingman";
      s.tooltip = "No session. Click to start one.";
    }
  }

  private usageText(usage: TurnUsage | undefined, startedAt: number): string {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!usage) {
      return `in ${secs}s`;
    }
    return `in ${secs}s (input ${usage.inputTokens} tokens, ${usage.cachedInputTokens} cached; output ${usage.outputTokens})`;
  }

  private reportError(what: string, err: unknown): void {
    if (this.abort?.signal.aborted) {
      this.log.info(`${what}: cancelled`);
      void vscode.window.setStatusBarMessage("Wingman: cancelled", 4000);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    this.log.error(`${what}: ${msg}`);
    void vscode.window.showErrorMessage(`Wingman: ${what}. ${firstLine(msg)}`, "Show log").then((pick) => {
      if (pick) {
        this.log.show();
      }
    });
  }
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim()) ?? s;
  return line.length > 300 ? line.slice(0, 300) + "…" : line;
}
