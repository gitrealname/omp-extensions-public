# slash_proxy — OMP Slash Command Bridge
> **Experimental.** This extension injects commands via stdin patching, which depends on OMP internals and load order. A first-class `pi.commands.dispatch()` API is proposed upstream ([#1560](https://github.com/can1357/oh-my-pi/issues/1560)) — once available, this extension will be simplified or replaced.

External OMP extension that lets the model invoke any registered slash command
by calling a single tool. One line in a skill is enough to delegate complex,
self-contained operations to a command — no large prompts, no model orchestration.

---

## Why this exists

Slash commands in OMP execute **entirely outside the LLM loop** — they are
deterministic, self-contained, and produce no unnecessary tokens. The model
can trigger them, but only if something bridges the tool layer to the command
layer. This extension is that bridge.

**Without `slash_proxy`:** coaching the model through a complex operation
requires a large system prompt, verbose model output, and multiple tool calls.

**With `slash_proxy`:** a two-line skill maps intent to command. The model
makes one call and stops. The command does all the work.

```
Model calls: slash_proxy({ command: "/review path/to/file.md" })
  → tool_result hook captures command into _pending
  → agent_end fires
  → setTimeout(0) dispatches via mode-specific path
  → /review runs natively, opens UI, reports back
  Model sees: result arrives as follow-up message
```

---

## How it works

### Two-phase dispatch

The extension uses a two-phase pattern to avoid re-entrant issues:

1. **Capture phase (`tool_result`)** — when the model calls `slash_proxy`, the
   `tool_result` event handler extracts the command string and stores it in a
   `_pending` slot. No dispatch happens yet.

2. **Dispatch phase (`agent_end`)** — when the agent turn ends, the `agent_end`
   handler reads `_pending`, clears it, and dispatches via `setTimeout(0)`. The
   0ms deferral ensures OMP's `#emitEndOfTurnUpdates` has started before the
   injected command arrives.

### Mode detection

Mode is detected once at load time from `process.argv`. Explicit mode flags
take priority over terminal detection:

- **`"acp"` positional in argv** → ACP mode
- **`--mode rpc`** → RPC mode
- **`--mode rpc-ui`** → RPC-UI mode
- **No flag, `isTTY=true`** → TUI mode
- **No flag, `isTTY=false`** → null (unknown non-TTY context — dispatch is a no-op)

### Mode-specific dispatch paths

Each mode injects the command into a different input stream:

- **TUI** — `process.stdin.push(command + "\r")` sends raw bytes into the
  TUI's StdinBuffer → editor.handleInput → InputController.handleSubmit →
  executeBuiltinSlashCommand with a real InteractiveModeContext.

- **ACP** — `process.stdin.push(buildAcpLine(sessionId, command))` injects a
  JSON-RPC 2.0 `session/prompt` frame into the NDJSON reader. OMP's
  `#runPromptOrCommand` → `executeAcpBuiltinSlashCommand` handles it.

- **RPC / RPC-UI** — `Bun.stdin.stream()` is patched at load time (before
  `runRpcMode` calls it) to return a controlled `ReadableStream` that
  transparently forwards real stdin and accepts injected chunks. On dispatch,
  `_rpcInject(enc.encode(buildRpcLine(command)))` enqueues a JSONL
  `{ type: "prompt", message }` frame into that stream.
  RPC-UI uses the same injection path as RPC; the only difference is
  `sessionOptions.hasUI = true` and the TUI renderer being active.

- **null** — no dispatch. The command is silently skipped.

```
Extension registers:
  slash_proxy tool     ← model calls this with a command string
  tool_result hook     ← captures command into _pending
  agent_end hook       ← dispatches _pending via mode-specific path
  /proxy-command       ← test command (see Testing section)

On tool call:
  1. Model calls slash_proxy({ command: "/some-command args" })
  2. tool_result fires, stores { command, sessionId } in _pending
  3. agent_end fires, reads _pending, defers via setTimeout(0)
  4. Mode-specific dispatch injects command into the correct input stream
  5. OMP dispatches the slash command as if the user typed it
  6. Command output arrives as a follow-up message next turn
```

The model never generates orchestration steps — it calls the tool and stops.

---

## Setup

### `~/.omp/agent/config.yml`

```yaml
extensions:
  - /absolute/path/to/omp-extensions-public/slash_proxy
```

### `~/.omp/agent/settings.json`

```json
{
  "extensions": [
    "/absolute/path/to/omp-extensions-public/slash_proxy"
  ]
}
```

> **Why both files?**
> `config.yml extensions:` loads the extension module (tool + event hook).
> `settings.json extensions:` drives `omp-plugins` sub-discovery which scans
> the `skills/` directory under each extension path. Both must list the same
> paths until [OMP issue #1569](https://github.com/can1357/oh-my-pi/issues/1569)
> is resolved.

---

## Writing skills

A skill that uses `slash_proxy` has three parts:

1. **Trigger** — when to activate
2. **Command** — what to call (model fills in arguments from context)
3. **Stop instruction** — model must not generate a follow-up

```markdown
---
name: review
description: "Interactive markdown file review."
---

# review

When user asks to review a file, call:

    slash_proxy({ command: "/review /absolute/path/to/file.md" })

Infer the file path from context. Stay silent after calling — the review
UI opens automatically.
```

The model deduces parameters (file path, query, topic) from the conversation.
The command handles everything else.

---

## Examples

### File review
```
slash_proxy({ command: "/review /home/user/project/NOTES.md" })
```

### Memory recall
```
slash_proxy({ command: "/memory recall authentication flow" })
```
The model infers the query from the conversation if not stated explicitly.

### Knowledge graph
```
slash_proxy({ command: "/graphify" })
```
No arguments needed — the command scans the current project autonomously.

### Session control
```
slash_proxy({ command: "/session spawn --cmd 'omp --headless'" })
slash_proxy({ command: "/session prompt write a haiku" })
slash_proxy({ command: "/session stop" })
```
One `slash_proxy` call per turn. The follow-up message from each command
triggers the next turn.

### Any registered command
```
slash_proxy({ command: "/plan refactor the auth module" })
slash_proxy({ command: "/switch" })
slash_proxy({ command: "/compact" })
```

---

## Testing

### Manual test harness

The test harness is included but **disabled by default** so the extension ships
clean. It consists of two dormant files — rename them to activate:

```bash
# Enable
mv commands/proxy-command.md.disabled  commands/proxy-command.md
mv skills/proxy-test/SKILL.md.disabled skills/proxy-test/SKILL.md

# Disable again
mv commands/proxy-command.md           commands/proxy-command.md.disabled
mv skills/proxy-test/SKILL.md          skills/proxy-test/SKILL.md.disabled
```

Restart OMP after toggling, then run:

```
skill://proxy-test
```

Expected: `/proxy-command was called — slash_proxy wiring confirmed.` appears in
the session, followed by a brief LLM acknowledgment. The acknowledgment is normal —
file-based `.md` commands inject their content as a prompt, which triggers an LLM
turn. Real slash commands (`/graphify`, `/plan`, etc.) execute outside the LLM
loop and produce no such follow-up.

If the confirmation appears, the full chain is verified:
`slash_proxy tool` → `tool_result hook` → `agent_end hook` → `dispatch` → `slash command execution`

### Automated integration tests

The `tests/` directory contains three automated integration tests that prove the
full dispatch chain in each mode. Each test spawns OMP as a child process in the
target mode, sends a prompt that instructs the model to call `slash_proxy`, and
verifies:

- The `slash_proxy` tool was called
- The `/proxy-command` dispatch produced an `agent_end` event (confirming the
  injected command was received and executed)
- A subsequent prompt receives a response (confirming the session is still
  functional after dispatch)

Tests require the extension and test command/skill to be active (see manual test
harness above). Dependencies are in `tests/package.json`
(`@agentclientprotocol/sdk` for the ACP test).

- **`test-rpc-slash-proxy.ts`** — spawns OMP with `--mode rpc`, drives JSONL
  commands over stdin, reads JSONL events from stdout. Three turns:
  call slash_proxy, wait for /proxy-command agent_end, send hello.

- **`test-rpc-ui-slash-proxy.ts`** — spawns OMP with `--mode rpc-ui`, same
  JSONL protocol as RPC. Filters out TUI escape sequences on stdout
  (non-JSON lines are skipped). Three turns identical to the RPC test.

- **`test-acp-slash-proxy.ts`** — spawns OMP with `acp` positional arg,
  uses the `@agentclientprotocol/sdk` to establish an ACP session over
  JSON-RPC 2.0 framed NDJSON. Injects skill content directly as prompt text
  (ACP disables `/skill:` expansion). Retries on "ACP prompt already in
  progress" errors until the /proxy-command turn completes.

Run all three:
```bash
cd tests
bun install
bun test-rpc-slash-proxy.ts
bun test-acp-slash-proxy.ts
bun test-rpc-ui-slash-proxy.ts
```

---

## Environment variables

- **`OMP_EXTENSION_DEBUG`** — set to `1` or `TRUE` (case-insensitive) to write
  debug events to the OMP log file (`~/.omp/logs/omp.YYYY-MM-DD.log`). Search
  for `[slash-proxy]`.

---

## File structure

```
omp-extensions-public/slash_proxy/
  src/
    main.ts                          Core: slash_proxy tool + two-phase dispatch
  commands/
    proxy-command.md.disabled        Test command — rename to .md to activate
  skills/
    proxy-test/
      SKILL.md.disabled              Test skill — rename to SKILL.md to activate
  tests/
    test-rpc-slash-proxy.ts          Integration test: RPC mode dispatch
    test-acp-slash-proxy.ts          Integration test: ACP mode dispatch
    test-rpc-ui-slash-proxy.ts       Integration test: RPC-UI mode dispatch
    package.json                     Test dependencies (@agentclientprotocol/sdk)
  package.json
  README.md
```
