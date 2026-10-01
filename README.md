# Sidekick

You write the code. Sidekick fills in the small blocks you hand it.

Write a one-line `@ai:` comment where you want code, save, and a coding agent
(Codex CLI) replaces that comment with the implementation — usually 1–10 lines.
It sees your whole project, but it only touches the spots you marked.

```ts
export function requireAdmin(user: User): void {
  // @ai: throw an Error("forbidden") unless the user is an admin
}
```

## How it works

- **Markers.** `@ai: <instruction>` inside any comment style: `//`, `#`, `--`, `;`, `%`,
  `/* */`, `<!-- -->`. The comment must be on its own line.
- **Save to run.** Saving a file that has a marker implements **every saved marker in the
  workspace** in one request, so related markers across files come out consistent.
  Markers in unsaved files are drafts and are left alone. You can also click the
  **▶ Implement with Sidekick** CodeLens or press `Cmd+Alt+I`.
- **Read-only agent.** The agent never edits files. It returns code as JSON and Sidekick
  swaps each marker line for it. The code is highlighted briefly and the file is left
  unsaved. `Cmd+Z` undoes it.
- **Imports.** Sidekick doesn't write imports itself. After inserting code it runs your
  language extension's "add missing imports" action (e.g. TypeScript's). Languages whose
  extension doesn't offer that action get no automatic imports — add them yourself.
- **Questions.** If an instruction is unclear, the agent answers inline instead of guessing:
  ```ts
  // @ai: handle errors
  // @ai-reply: Which errors? Network failures, non-2xx responses, or both?
  ```
  Edit your `@ai:` line and save again; the reply is removed when it's implemented.
- **Sessions.** Starting a session has the agent read the project once; later runs resume
  that session, so they're faster and cheaper. Each run also tells the agent which files
  changed since its last turn. Start and end sessions yourself from the status bar item
  or the command palette (`Sidekick: Start session` / `Sidekick: End session`). The session
  survives VS Code restarts.

## Requirements

- macOS (the only platform tested so far).
- [Codex CLI](https://github.com/openai/codex), installed and logged in (`codex login`).

## Install from source

```bash
git clone https://github.com/<you>/sidekick.git
cd sidekick
npm install
npm run package          # produces sidekick-<version>.vsix
code --install-extension sidekick-*.vsix
```

To hack on it, open the folder in VS Code and press `F5`.

## Settings

| Setting | Default | |
|---|---|---|
| `sidekick.provider` | `codex` | Agent to use. Only Codex for now. |
| `sidekick.model` | *(CLI default)* | Model passed to the agent. |
| `sidekick.reasoningEffort` | `medium` | `minimal` / `low` / `medium` / `high`. Lower is faster. |
| `sidekick.markerPrefix` | `@ai` | Marker tag. Replies use `<prefix>-reply`. |
| `sidekick.triggerOnSave` | `true` | Turn off to run only via CodeLens / keybinding. |
| `sidekick.excludeGlobs` | `node_modules`, `dist`, … | Skipped when scanning for markers. `.gitignore` is respected too. |
| `sidekick.codexPath` | *(auto)* | Path to the `codex` binary if it isn't found automatically. |

`Sidekick: Show log` shows each turn's timing and token usage. Set the log level to
Trace (`Developer: Set Log Level…`) to also see the full prompts.

## License

MIT
