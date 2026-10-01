import { execFile } from "child_process";
import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import { Codex, ThreadOptions, Usage } from "@openai/codex-sdk";
import { SidekickConfig } from "../config";
import { AgentProvider, parseTurnResult, TURN_OUTPUT_SCHEMA, TurnUsage } from "./types";

// macOS only for now. VS Code launched from the Dock/Finder doesn't get the shell's
// PATH, so also look in the usual install locations.
const EXTRA_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".npm-global", "bin"),
  path.join(os.homedir(), ".volta", "bin"),
  path.join(os.homedir(), ".bun", "bin"),
];

function findCodex(config: SidekickConfig): string | undefined {
  if (config.codexPath) {
    return existsSync(config.codexPath) ? config.codexPath : undefined;
  }
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...EXTRA_DIRS].filter(Boolean);
  return dirs.map((dir) => path.join(dir, "codex")).find((p) => existsSync(p));
}

function toUsage(u: Usage | null): TurnUsage | undefined {
  return u
    ? { inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens, outputTokens: u.output_tokens }
    : undefined;
}

export class CodexProvider implements AgentProvider {
  readonly name = "Codex";

  async check(config: SidekickConfig): Promise<string | undefined> {
    const bin = findCodex(config);
    if (!bin) {
      return config.codexPath
        ? `Codex CLI not found at sidekick.codexPath (${config.codexPath}).`
        : "Codex CLI not found. Install it (npm i -g @openai/codex or brew install codex) or set sidekick.codexPath.";
    }
    const loggedIn = await new Promise<boolean>((resolve) =>
      execFile(bin, ["login", "status"], { timeout: 15_000 }, (err) => resolve(!err)),
    );
    return loggedIn ? undefined : "Codex CLI is not logged in. Run `codex login` in a terminal.";
  }

  private client(config: SidekickConfig): Codex {
    return new Codex({ codexPathOverride: findCodex(config) });
  }

  private threadOptions(cwd: string, config: SidekickConfig): ThreadOptions {
    return {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: config.reasoningEffort,
      model: config.model || undefined,
    };
  }

  async startSession({ cwd, prompt, config, signal }: Parameters<AgentProvider["startSession"]>[0]) {
    const thread = this.client(config).startThread(this.threadOptions(cwd, config));
    const turn = await thread.run(prompt, { signal });
    if (!thread.id) {
      throw new Error("Codex did not report a session id");
    }
    return { sessionId: thread.id, reply: turn.finalResponse, usage: toUsage(turn.usage) };
  }

  async runTurn({ cwd, sessionId, prompt, config, signal }: Parameters<AgentProvider["runTurn"]>[0]) {
    const thread = this.client(config).resumeThread(sessionId, this.threadOptions(cwd, config));
    const turn = await thread.run(prompt, { outputSchema: TURN_OUTPUT_SCHEMA, signal });
    return { output: parseTurnResult(turn.finalResponse), usage: toUsage(turn.usage) };
  }
}
