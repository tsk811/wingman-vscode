import * as vscode from "vscode";
import { getConfig } from "./config";
import { containsMarker, parseMarkers } from "./markers";
import { Wingman } from "./wingman";

// "Save All" fires one save event per file; coalesce them into a single run.
const SAVE_DEBOUNCE_MS = 400;

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Wingman", { log: true });
  const wingman = new Wingman(ctx, log);
  let saveTimer: NodeJS.Timeout | undefined;
  let ignoreSavesUntil = 0;

  ctx.subscriptions.push(
    log,
    wingman,
    vscode.commands.registerCommand("wingman.startSession", async () => {
      if (wingman.sessionId) {
        const pick = await vscode.window.showWarningMessage(
          "Replace the current Wingman session with a new one?",
          { modal: true },
          "Start new session",
        );
        if (!pick) {
          return;
        }
      }
      await wingman.startSession();
    }),
    vscode.commands.registerCommand("wingman.endSession", () => wingman.endSession()),
    vscode.commands.registerCommand("wingman.showLog", () => log.show()),
    vscode.commands.registerCommand("wingman.implement", async (uri?: vscode.Uri) => {
      // Markers only count once saved, so save the file the user is pointing at first.
      const doc = uri
        ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
        : vscode.window.activeTextEditor?.document;
      if (doc?.isDirty) {
        ignoreSavesUntil = Date.now() + 1000;
        await doc.save();
      }
      await wingman.implement(true);
    }),
    vscode.commands.registerCommand("wingman.sessionMenu", async () => {
      type Item = vscode.QuickPickItem & { run: () => unknown };
      const items: Item[] = [];
      if (wingman.isBusy) {
        items.push({ label: "$(debug-stop) Cancel", run: () => wingman.cancel() });
      }
      items.push({ label: "$(play) Implement markers now", run: () => vscode.commands.executeCommand("wingman.implement") });
      if (wingman.sessionId) {
        items.push(
          { label: "$(refresh) Start a new session", run: () => vscode.commands.executeCommand("wingman.startSession") },
          { label: "$(close) End session", run: () => wingman.endSession() },
        );
      } else {
        items.push({ label: "$(rocket) Start session", run: () => wingman.startSession() });
      }
      items.push({ label: "$(output) Show log", run: () => log.show() });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Wingman" });
      await pick?.run();
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      const config = getConfig();
      if (!config.triggerOnSave || Date.now() < ignoreSavesUntil || doc.uri.scheme !== "file") {
        return;
      }
      if (!vscode.workspace.getWorkspaceFolder(doc.uri) || !containsMarker(doc.getText(), config.markerPrefix)) {
        return;
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void wingman.implement(false), SAVE_DEBOUNCE_MS);
    }),

    vscode.languages.registerCodeLensProvider({ scheme: "file" }, new MarkerLenses()),
  );
}

class MarkerLenses implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const prefix = getConfig().markerPrefix;
    return parseMarkers(doc.getText(), prefix, "", doc.uri.fsPath).map(
      (m) =>
        new vscode.CodeLens(new vscode.Range(m.line, 0, m.line, 0), {
          title: m.replyLines.length ? "$(sync) Retry with Wingman" : "$(play) Implement with Wingman",
          command: "wingman.implement",
          arguments: [doc.uri],
        }),
    );
  }
}

export function deactivate(): void {}
