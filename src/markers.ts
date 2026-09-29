// Finding `@ai:` command markers and the `@ai-reply:` lines Wingman leaves under them.

export interface Marker {
  id: string;
  /** Workspace-relative path with forward slashes. */
  relPath: string;
  absPath: string;
  /** 0-based line of the marker when the file was scanned. */
  line: number;
  /** The full marker line, used to find it again after the user keeps editing. */
  lineText: string;
  indent: string;
  /** Comment opener/closer the marker used, reused when writing replies. */
  open: string;
  close: string;
  instruction: string;
  /** `@ai-reply:` lines directly below the marker (messages from a previous turn). */
  replyLines: string[];
}

// Line-comment and block-comment openers across common languages.
const OPENERS = String.raw`\/\/+|#+|--|;+|%+|\/\*+|<!--`;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function markerRegexes(prefix: string) {
  const p = escape(prefix);
  const line = (tag: string) =>
    new RegExp(String.raw`^(\s*)(${OPENERS})\s*${p}${tag}:\s?(.*?)\s*(\*+\/|-->)?\s*$`);
  return { marker: line(""), reply: line("-reply") };
}

export function containsMarker(text: string, prefix: string): boolean {
  if (!text.includes(prefix + ":")) {
    return false;
  }
  const { marker } = markerRegexes(prefix);
  return text.split(/\r?\n/).some((l) => marker.test(l));
}

/** Parses markers out of one file's text. Ids are assigned by the caller. */
export function parseMarkers(
  text: string,
  prefix: string,
  relPath: string,
  absPath: string,
): Omit<Marker, "id">[] {
  if (!text.includes(prefix + ":")) {
    return [];
  }
  const { marker, reply } = markerRegexes(prefix);
  const lines = text.split(/\r?\n/);
  const found: Omit<Marker, "id">[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = marker.exec(lines[i]);
    if (!m || !m[3].trim()) {
      continue;
    }
    const replyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const r = reply.exec(lines[j]);
      if (!r) {
        break;
      }
      replyLines.push(r[3]);
    }
    found.push({
      relPath,
      absPath,
      line: i,
      lineText: lines[i],
      indent: m[1],
      open: m[2],
      close: m[4] ?? closerFor(m[2]),
      instruction: m[3].trim(),
      replyLines,
    });
  }
  return found;
}

function closerFor(open: string): string {
  if (open.startsWith("/*")) {
    return "*/";
  }
  if (open === "<!--") {
    return "-->";
  }
  return "";
}

/** Number of `@ai-reply:` lines directly below `line` in `lines`. */
export function countReplyLines(lines: string[], line: number, prefix: string): number {
  const { reply } = markerRegexes(prefix);
  let n = 0;
  while (line + 1 + n < lines.length && reply.test(lines[line + 1 + n])) {
    n++;
  }
  return n;
}

export function formatReply(m: Marker, prefix: string, message: string): string[] {
  const close = m.close ? ` ${m.close}` : "";
  return message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `${m.indent}${m.open} ${prefix}-reply: ${l}${close}`);
}

/** Identity of a marker plus its reply: unchanged means the user hasn't responded yet. */
export function waitingSignature(m: Pick<Marker, "relPath" | "lineText" | "replyLines">): string {
  return [m.relPath, m.lineText.trim(), ...m.replyLines].join("\n");
}
