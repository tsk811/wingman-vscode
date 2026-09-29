import * as vscode from "vscode";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface WingmanConfig {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  markerPrefix: string;
  triggerOnSave: boolean;
  excludeGlobs: string[];
  codexPath: string;
}

export function getConfig(): WingmanConfig {
  const c = vscode.workspace.getConfiguration("wingman");
  return {
    provider: c.get("provider", "codex"),
    model: c.get("model", "").trim(),
    reasoningEffort: c.get<ReasoningEffort>("reasoningEffort", "medium"),
    markerPrefix: c.get("markerPrefix", "@ai").trim() || "@ai",
    triggerOnSave: c.get("triggerOnSave", true),
    excludeGlobs: c.get<string[]>("excludeGlobs", []),
    codexPath: c.get("codexPath", "").trim(),
  };
}
