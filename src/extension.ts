import * as vscode from "vscode";
import { getConfig } from "./config";
import { containsMarker, parseMarkers } from "./markers";
import { Sidekick } from "./sidekick";

// "Save All" fires one save event per file; coalesce them into a single run.
const SAVE_DEBOUNCE_MS = 400;

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Sidekick", { log: true });
  const sidekick = new Sidekick(ctx, log);
  let saveTimer: NodeJS.Timeout | undefined;
  let ignoreSavesUntil = 0;

  ctx.subscriptions.push(
    log,
    sidekick,
    vscode.commands.registerCommand("sidekick.startSession", async () => {
      if (sidekick.sessionId) {
        const pick = await vscode.window.showWarningMessage(
          "Replace the current Sidekick session with a new one?",
          { modal: true },
          "Start new session",
        );
        if (!pick) {
          return;
        }
      }
      await sidekick.startSession();
    }),
    vscode.commands.registerCommand("sidekick.endSession", () => sidekick.endSession()),
    vscode.commands.registerCommand("sidekick.showLog", () => log.show()),
    vscode.commands.registerCommand("sidekick.implement", async (uri?: vscode.Uri) => {
      // Markers only count once saved, so save the file the user is pointing at first.
      const doc = uri
        ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
        : vscode.window.activeTextEditor?.document;
      if (doc?.isDirty) {
        ignoreSavesUntil = Date.now() + 1000;
        await doc.save();
      }
      await sidekick.implement(true);
    }),
    vscode.commands.registerCommand("sidekick.sessionMenu", async () => {
      type Item = vscode.QuickPickItem & { run: () => unknown };
      const items: Item[] = [];
      if (sidekick.isBusy) {
        items.push({ label: "$(debug-stop) Cancel", run: () => sidekick.cancel() });
      }
      items.push({ label: "$(play) Implement markers now", run: () => vscode.commands.executeCommand("sidekick.implement") });
      if (sidekick.sessionId) {
        items.push(
          { label: "$(refresh) Start a new session", run: () => vscode.commands.executeCommand("sidekick.startSession") },
          { label: "$(close) End session", run: () => sidekick.endSession() },
        );
      } else {
        items.push({ label: "$(rocket) Start session", run: () => sidekick.startSession() });
      }
      items.push({ label: "$(output) Show log", run: () => log.show() });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Sidekick" });
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
      saveTimer = setTimeout(() => void sidekick.implement(false), SAVE_DEBOUNCE_MS);
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
          title: m.replyLines.length ? "$(sync) Retry with Sidekick" : "$(play) Implement with Sidekick",
          command: "sidekick.implement",
          arguments: [doc.uri],
        }),
    );
  }
}

export function deactivate(): void {}
