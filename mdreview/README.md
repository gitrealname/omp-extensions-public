# mdreview — Browser-Based Markdown Review

OMP external extension. Opens any markdown file in a browser UI with inline annotation tools and an AI chat sidebar.

Rendering patterns and CSS borrowed from [Plannotator](https://github.com/backnotprop/plannotator) by backnotprop (MIT / Apache-2.0).

---

## Overview

`/mdreview <file.md>` opens a file in a local browser UI with:

- **Left panel**: Rendered markdown with inline annotation tools
- **Right panel**: AI chat sidebar — dedicated OMP subprocess (`--mode rpc`) seeded with the document content; does **not** share conversation history with the main agent session

## Usage

Say `.mdreview` or ask to review a file. The model invokes `/mdreview <absolute-path>` directly.

Or run the command directly in TUI:

```
/mdreview D:/path/to/file.md
```

Always use absolute paths.

## Workflow

1. Say `.mdreview` or `/mdreview <file>` — browser opens automatically
2. Read the rendered markdown; select text to add inline comments
3. Use the AI chat panel to discuss the document
4. Click **Submit** to send annotations back to the agent
5. Click **Close** to exit without sending
6. Return to terminal — agent receives structured feedback and responds

## Inline Annotations

- Select text → comment box opens immediately
- Choose a label: **suggestion**, **nit**, **question**, **issue**
- Type comment, press Enter to save
- Click **Send** on any annotation card to discuss with the AI
- Click **×** to delete; **Esc** closes an open comment box

## Feedback Format

Annotations submitted to the agent:

```markdown
# Review: filename.md

### Line N (chars X-Y) — "selected text..."
**label:** your comment
```

Labels follow the [Conventional Comments](https://conventionalcomments.org) format.

## UI Controls

| Control | Location | Purpose |
|---|---|---|
| `A-` / `A+` | Header | Adjust font size (8–48px), persisted in localStorage |
| Sun/moon icon | Header | Toggle light/dark theme |
| Submit | Header | Send all annotations to agent and close |
| Close | Header | Close without sending |

## Enable in OMP
### `settings.json` (required — extension discovery)
Add the extension path to `~/.omp/agent/settings.json`:
```json
{
  "extensions": [
    "D:/path/to/omp-extensions-public/mdreview"
  ]
}
```
### `config.yml` (optional — model roles and custom settings)


No mdreview-specific config is required. To set a custom browser for the review UI:

```yaml
env:
  MDREVIEW_BROWSER: "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

If `MDREVIEW_BROWSER` is unset, the OS default browser is used.

## Architecture
- `/mdreview` command registered directly by this extension (no `slash_proxy` dependency)
- `node:http` server on a random localhost port, shut down on decision or 10 min idle
- AI chat routes through the **main agent session** — `pi.sendMessage({ triggerTurn: true })` drives inference; `message_update` and `agent_end` events stream responses to the browser via SSE. No subprocess, no new agent.
- Document content injected into agent context before browser opens (silent, not displayed)
- Feedback injected via `pi.sendMessage({ triggerTurn: true })` — triggers a new agent turn

## Files

| File | Purpose |
|---|---|
| `src/main.ts` | Extension entry — registers `/mdreview` command, AI chat streaming |
| `src/server.ts` | HTTP server, document serving, AI SSE forwarding, decision callbacks |
| `assets/mdreview-ui.html` | Review UI SPA (edit without rebuild) |
| `skills/mdreview/SKILL.md` | Skill — tells model when and how to invoke |