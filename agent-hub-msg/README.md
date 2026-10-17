# agent-hub-msg

Email-style messaging between **independent** omp sessions. Each session keeps
its own context and model; any agent can address any other. Addresses are
**session ids** (stable across restart/restore); aliases are optional labels.
No tmux, no cloud, no shared process — mailboxes are plain files under
`~/.omp/agent/msg/`.

## Architecture

Two layers, so the mail fabric ports to any agent harness:

- **`core/`** — the library. Registry, mailboxes, addressing, batching,
  spooling, unanswered-mail tracking, the `HubSession` delivery loop,
  slash-command completions (`core/commands.ts`), and harness-neutral
  tool-shaped entry points (`core/api.ts`). Zero harness dependencies (only
  Node/Bun built-ins) — a CLI or another agent harness can use it as-is.
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
- the **user initiates**: `/msg` (or any of its subcommands), or any prompt
  containing "mail"/"msg" (e.g. *"mail <sid|alias> ask how it is doing"*), or
- a **reminder fires**: unanswered delivered mail is re-injected after
  compaction or on restore.
- Restored sessions that were instructed in a previous boot reactivate
  automatically (`instructed` flag).

## Commands

| Command | Effect |
|---|---|
| `/msg` | Activate mail tools; inject instructions once |
| `/msg instruct` | Force re-inject instructions (after compaction) |
| `/msg list` | Show + inject `<session_id> pid <n> <last_seen> [aliases] (cwd)` for all sessions |
| `/msg alias <name>` | Add an alias to this session (repeatable) |

Every `/msg` command guarantees activation (tools + instructions on first
contact); a doubled prefix (`/msg /msg list`) is tolerated. A flickering `pid`
in `/msg list` between snapshots means two frontends share one session id
(e.g. concurrent `-c`).

## Agent-side tools

- `msg_who` — your address + every registered session (online/offline derived from last-seen; offline 30d+ shows `stale`; entries are never evicted)
- `msg_send` — `to` (session id, unique prefix, alias, comma list, or `"all"`), `body`, optional `subject`, `inReplyTo`, `ack`
- `msg_reply` — **by message id only**; recipients are derived from the thread (`all: true` = reply-all, ignored for acks)
- `msg_inbox` — subjects + previews (never full bodies; `msg_read` pulls those); unread only by default, `{ read: true, since, limit }` for history
- `msg_read` — full body of one message id

**Acknowledgments & etiquette (extension-enforced):** bare acks are sent with
`ack: true` and need no reply; acks always go to the sender only — `all` is
ignored. An ack closes the thread on both sides: the tool layer **refuses any
reply whose `inReplyTo` targets an ack frame** (ack-of-ack guard), so acks
also bypass the 6-hop reply cap — terminal by construction, they can never
extend a chain, and thread closure stays reachable at any depth. Broadcast
frames (multiple recipients) deliver with a "reply to the sender only" suffix
so N×N ack storms cannot form. Mail with subject starting `FYI:` requests no
reply and is exempt from unanswered-mail reminders.

**Unanswered-mail reminders:** mail delivered but never answered
(`answeredIds` in `state.json`) is re-injected after compaction and on
restore (`triggerTurn`) so an agent that forgot — e.g. context compacted
mid-task — wakes and answers. `ack: true` and `FYI:`-subjected frames are
exempt.

**Duplicate-send guard:** harness-level tool retries can re-execute a send
with a fresh id. Identical content (same sender, thread, subject, body
prefix) within `MSG_DEDUPE_MS` (default 120 s) is marked delivered+answered
silently — it never re-anchors a turn and cannot re-open a thread an ack
closed. `MSG_DEDUPE_MS=0` disables.

**Instruction drift:** the instructions file is hashed at every injection; a
changed file is re-injected on the next poll tick (no restart, no compaction
needed). Every delivered envelope carries an `[etiquette vN]` stamp.

**Stale threads are read, never acted on:** a thread whose latest activity
(including frames already delivered) is older than `MSG_STALE_ACT_MS`
(default 3 h) delivers **inert** — it lands in the transcript without
triggering a turn, the envelope marks it `STALE — reference only, do not act
unless the user asks`, and it is marked answered so it never resurfaces as a
reminder. The user's explicit ask ("act on the backlog") overrides. More
than 10 stale frames per tick collapse into one digest line. `0` disables.

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
- Loop protection: seen-id dedupe + 6-hop reply cap (deep threads deliver with
  `reply: user-only — deep thread` in the header; acks are exempt and always
  close threads).
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
| `MSG_REMIND` | on | `off` disables unanswered-mail reminders |
| `MSG_REMIND_MAX` | `5` | Max pending items in one reminder block |
| `MSG_DEDUPE_MS` | `120000` | Duplicate-send suppression window (0 = off) |
| `MSG_STALE_ACT_MS` | `10800000` | Thread-inactivity age before inert delivery (0 = off) |
| `MSG_INSTRUCTIONS` | `<ext>/agent-hub-msg-llm-instructions.md` | LLM instructions file path |
| `OMP_EXTENSION_DEBUG` | – | `1` enables debug logging |

## Testing

```bash
bun test                 # unit tests (mailbox, registry, batching, spooling,
                         # completions, reminder flow, ack suppression)
bun tests/e2e-rpc.ts     # two real omp --mode rpc sessions exchange mail end to end
```

The E2E driver verifies: sid-keyed registration with seeded aliases, alias
addressing, auto-injected turns, reply-by-id, spool round-trip (>255-char body
through `files/`), the instructed flags, all `/msg` subcommands (sent as raw
RPC prompts — extension commands execute locally, `agentInvoked: false`), the
doubled-prefix tolerance, and real compaction (project settings shrink
`compaction.keepRecentTokens`) proving the `session_compact` hook re-injects
instructions on a live session.

Note: `slash_proxy` cannot dispatch slash commands in RPC mode on omp
v18.10.4+ — upstream claims the stdin singleton **before** extension
discovery (`claimRpcInput()`), deliberately defeating stdin patches. The E2E
therefore drives `/msg` through the RPC `prompt` frame, which `session.prompt`
routes to extension commands natively. In TUI mode slash_proxy still works
(raw `process.stdin.push`).

## Inspecting without a session (CLI)

Read-only CLI over the same mail root — what you see is what agents see:

```bash
bun run cli/msg.ts who                    # registry: sid, pid, age, aliases, PENDING count
bun run cli/msg.ts inbox <sid|alias>      # every frame to that session (TOC)
bun run cli/msg.ts read <sid|alias> <id>  # full body of one frame
bun run cli/msg.ts pending <sid|alias>    # the reminder queue for that session
```

## Known limits (v2)

- Same machine only (registry carries a `machine` field for future transports)
- Answered/read flags are per-session (`state.json`); no read-receipts across sessions
- No attachments — reference file paths in the body instead
- **The mail root is same-user writable**: sender identity is not authenticated, and
  message bodies are spliced verbatim (a body can forge header-like lines). Mitigations:
  bodies validated against a strict spool-path allowlist, sids/aliases format-checked,
  delivery attributed to "agent" (never "user"), untrusted-data wrapper + rule 10, ack
  clamp. Residual prompt-injection surface is inherent to plain-file mail between LLMs.
  Posture: single machine, single user — these controls target *confused* agents
  (prompt-injected repos) and accidents, not external attackers; no crypto.
- **Alias policy**: a contested alias (two sessions claim it) **fails resolution** —
  mail to it goes nowhere until the conflict is removed. There is deliberately no
  steal/`--force`: reassignment means remove the alias from the old session and re-add
  it on the new one (explicit act, inspectable in the registry).
- **Backlog drain**: cold threads (no activity past `MSG_STALE_ACT_MS`, default 3 h)
  deliver inert without waking the agent; >10 stale frames per tick collapse into one
  digest line. A weeks-old backlog costs one silent block, not a flood.
- **Sender identity is provenance, not authorship**: a frame's `from` field is
  unverified — a phantom frame once pre-empted a review gate here (an ack nobody
  intended closed the thread mid-review). Gates read the verdict message, never a
  receipt; treat content on merit regardless of provenance.
