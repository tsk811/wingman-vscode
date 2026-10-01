import { Marker } from "./markers";

const CONTEXT_LINES = 25;

export function primingPrompt(prefix: string): string {
  return `You are Sidekick, a pair-programming assistant inside the user's editor. The user writes the code themselves; they only hand you small blocks to fill in by writing "${prefix}: <instruction>" comments. You are read-only and never edit files. In later turns I will send you those markers and you will answer with code as JSON, which the editor inserts.

Right now, get familiar with this project so later requests are fast and accurate:
- Look at the directory layout and the build/manifest files.
- Read the main source files to learn the architecture, key types and functions, and conventions (naming, error handling, formatting, indentation, test style).
- Skip generated, vendored and dependency folders. Don't modify anything.

When done, reply with a short summary (at most 8 lines) of the project and its conventions.`;
}

const RULES = (prefix: string) => `Rules:
- Each marker is a comment line "${prefix}: <instruction>". Your code REPLACES that comment line. Implement only what the instruction asks, usually 1-10 lines. Do not rewrite, reformat or extend surrounding code, and do not implement anything that wasn't asked.
- Markers in one request may be related, even across files. Make them consistent with each other.
- Write "code" with indentation relative to the marker line (its first level at column 0); the editor adds the marker's indentation. Use the file's indentation style shown per marker. Don't include the marker comment itself.
- Follow the project's conventions and reuse existing helpers and types. Read whatever files you need; if the change summary says a file changed, trust it over your memory.
- Never write import/include/use lines. Just use the names you need; the editor adds missing imports automatically.
- If the instruction is ambiguous or needs a decision from the user, answer status "question" with one concise question in "message". If it can't or shouldn't be done as a small block (needs far more code, refers to things that don't exist), answer "refused" with the reason in "message". For "question"/"refused", "code" is "". For "done", "message" is "" or a very short note.
- Return exactly one result per marker id.`;

export function turnPrompt(opts: {
  prefix: string;
  markers: Marker[];
  fileTexts: Map<string, string>;
  changes: string;
}): string {
  const sections: string[] = ["Sidekick request: implement the markers below.", RULES(opts.prefix)];

  sections.push(
    opts.changes
      ? `Files changed since your last turn:\n\n${opts.changes}`
      : "No files changed since your last turn.",
  );

  const blocks = opts.markers.map((m) => {
    const lines = (opts.fileTexts.get(m.relPath) ?? "").split(/\r?\n/);
    const from = Math.max(0, m.line - CONTEXT_LINES);
    const to = Math.min(lines.length, m.line + 1 + m.replyLines.length + CONTEXT_LINES);
    const width = String(to).length;
    const context = lines
      .slice(from, to)
      .map((l, i) => {
        const n = from + i;
        return `${n === m.line ? ">>" : "  "} ${String(n + 1).padStart(width)} | ${l}`;
      })
      .join("\n");

    let block = `### ${m.id}: ${m.relPath}:${m.line + 1}
Instruction: ${m.instruction}
Indentation style: ${indentStyle(lines)}`;
    if (m.replyLines.length) {
      block += `\nYour previous reply on this marker (the user may have updated the instruction in response): ${m.replyLines.join(" ")}`;
    }
    return `${block}\nContext (">>" marks the marker line):\n\`\`\`\n${context}\n\`\`\``;
  });
  sections.push(`Markers:\n\n${blocks.join("\n\n")}`);

  return sections.join("\n\n");
}

function indentStyle(lines: string[]): string {
  if (lines.some((l) => /^\t+\S/.test(l))) {
    return "tabs";
  }
  let min = Infinity;
  for (const l of lines) {
    const m = /^( +)\S/.exec(l);
    if (m) {
      min = Math.min(min, m[1].length);
    }
  }
  return Number.isFinite(min) ? `${min} spaces` : "unknown";
}
