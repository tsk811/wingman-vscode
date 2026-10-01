import { SidekickConfig } from "../config";

export interface MarkerResult {
  id: string;
  status: "done" | "question" | "refused";
  code: string;
  message: string;
}

export interface TurnResult {
  results: MarkerResult[];
}

/** JSON Schema for a turn's output. Strict-mode compatible: every field required, no extras. */
export const TURN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "code", "message"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["done", "question", "refused"] },
          code: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
} as const;

export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * A coding agent Sidekick can drive. Sessions are read-only: the agent explores the
 * project and returns code as JSON; only Sidekick edits files.
 */
export interface AgentProvider {
  readonly name: string;
  /** Returns a user-facing problem (not installed, not logged in), or undefined if usable. */
  check(config: SidekickConfig): Promise<string | undefined>;
  /** Starts a session primed with `prompt`; returns its id and the agent's reply. */
  startSession(opts: { cwd: string; prompt: string; config: SidekickConfig; signal: AbortSignal }): Promise<{
    sessionId: string;
    reply: string;
    usage?: TurnUsage;
  }>;
  /** Runs one turn in an existing session, returning the raw structured response. */
  runTurn(opts: {
    cwd: string;
    sessionId: string;
    prompt: string;
    config: SidekickConfig;
    signal: AbortSignal;
  }): Promise<{ output: TurnResult; usage?: TurnUsage }>;
}

export function parseTurnResult(raw: string): TurnResult {
  const text = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text) as TurnResult;
  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error("Agent response has no `results` array");
  }
  return parsed;
}
