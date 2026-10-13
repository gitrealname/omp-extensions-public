# agent-hub-msg

Email-style messaging between **independent** omp sessions. Each session keeps
its own context and model; any agent can address any other. Addresses are
**session ids** (stable across restart/restore); aliases are optional labels.
No tmux, no cloud, no shared process — mailboxes are plain files under
`~/.omp/agent/msg/`.

## Architecture

Two layers, so the mail fabric ports to any agent harness:

- **`core/`** — the library. Registry, mailboxes, addressing, batching,
  spooling, the `HubSession` delivery loop, and harness-neutral tool-shaped
  entry points (`core/api.ts`). Zero harness dependencies (only Node/Bun
  built-ins) — a CLI or another agent harness can use it as-is.
- **`omp/`** — the omp adapter: registers the `msg_*` tools and the `/msg`
  command, maps omp events onto `HubSession`, and adapts delivery to
  `pi.sendMessage`. ~250 lines; this is the only file to reimplement when
  porting.

## Install

Add to `~/.omp/agent/config.yml` **and** `~/.omp/agent/settings.json`:

```yaml
# config.yml
extensions:
  - D:/path/to/agent-hub-msg
```

```jsonc
// settings.json
{
  "extensions": ["D:/path/to/agent-hub-msg"]
}
```

Every session that should participate needs the extension registered. Sessions
register automatically on start/restore under their session id; set the
`MSG_ALIAS` env var to also give a session an alias.

## Zero context cost until first contact

The LLM knows nothing about messaging until:

- a **message arrives** (tools + instructions injected together with the mail), or
- the **user initiates**: `/msg`, or any prompt containing "mail"/"msg"
  (e.g. *"mail <sid|alias> ask how it is doing"*), or
- `/msg instruct` after a compaction.

## Commands

| Command | Effect |
|---|---|
| `/msg` | Activate mail tools; inject instructions once |
| `/msg instruct` | Force re-inject instructions (after compaction) |
| `/msg list` | Show + inject `<session_id> <last_seen> [aliases] (cwd)` for all sessions |
| `/msg alias <name>` | Add an alias to this session (repeatable) |

## Agent-side tools

- `msg_who` — your address + every registered session (online/offline derived from last-seen; entries are never evicted)
- `msg_send` — `to` (session id, unique prefix, alias, comma list, or `"all"`), `body`, optional `subject`, `inReplyTo`
- `msg_reply` — **by message id only**; recipients are derived from the thread (`all: true` = reply-all)
- `msg_inbox` — subjects + previews (never full bodies; `msg_read` pulls those); unread only by default, `{ read: true, since, limit }` for history
- `msg_read` — full body of one message id

Agent instructions live in [`agent-hub-msg-llm-instructions.md`](./agent-hub-msg-llm-instructions.md)
(user-editable, read fresh at every injection; `MSG_INSTRUCTIONS` overrides the path).

## Mechanics handled by the extension

- Incoming mail is delivered as a follow-up turn (`fs.watch` fast-path, 15 s
  poll as safety net); **same sender → one bundle**, different senders → one by
  one, oldest first.
- Bodies longer than **255 chars** (`MSG_INLINE_MAX`) are spooled to
  `files/<id>.md`; recipients get the full text inline — the LLM never reads
  those files.
- Read cursor: unread-only views; consumed mail never resurfaces.
- Loop protection: seen-id dedupe + 6-hop reply cap (deep threads are flagged,
  not auto-replied).
- `"all"` reaches only currently-online sessions; direct mail to an offline
  session queues like real email.
- Registry entries, mailboxes, aliases, and spool files are **permanent** —
  a session restarted days later keeps its address, backlog, and aliases.

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `MSG_INBOX_ROOT` | `~/.omp/agent/msg` | Mail root |
| `MSG_ALIAS` | – | Seed alias for this session |
| `MSG_POLL_MS` | `15000` | Mailbox poll interval |
| `MSG_KEEPALIVE_MS` | `60000` | Registry heartbeat |
| `MSG_INLINE_MAX` | `255` | Body chars before spooling to file |
| `MSG_INSTRUCTIONS` | `<ext>/agent-hub-msg-llm-instructions.md` | LLM instructions file path |
| `OMP_EXTENSION_DEBUG` | – | `1` enables debug logging |

## Testing

```bash
bun test                 # unit tests (mailbox, registry, batching, spooling)
bun tests/e2e-rpc.ts     # two real omp --mode rpc sessions exchange mail end to end
```

The E2E driver verifies: sid-keyed registration with seeded aliases, alias
addressing, auto-injected turns, reply-by-id, spool round-trip (>255-char body
through `files/`), the instructed flags, and all `/msg` subcommands (sent as
raw RPC prompts — extension commands execute locally, `agentInvoked: false`).

Note: `slash_proxy` cannot dispatch slash commands in RPC mode on omp
v18.10.4+ — upstream claims the stdin singleton **before** extension
discovery (`claimRpcInput()`), deliberately defeating stdin patches. The E2E
therefore drives `/msg` through the RPC `prompt` frame, which `session.prompt`
routes to extension commands natively. In TUI mode slash_proxy still works
(raw `process.stdin.push`).

## Known limits (v2)

- Same machine only (registry carries a `machine` field for future transports)
- No receipts/ack frames — delivered mail is marked read by the receiving poller
- No attachments — reference file paths in the body instead
