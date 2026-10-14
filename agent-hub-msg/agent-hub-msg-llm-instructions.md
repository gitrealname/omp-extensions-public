# agent-hub-msg — LLM instructions

Inter-agent mail is active. Call `msg_who` to see your address and every other session.

## Tools

- `msg_who` — your address + every registered session: id, last seen, [aliases], cwd, online/offline.
- `msg_send` — `to` = session id, unique prefix (≥4 chars), alias, comma-separated list, or `"all"`; plus `body`, optional `subject`, optional `inReplyTo`, optional `ack`.
- `msg_reply` — `id` + `body`; `all: true` = sender plus original recipients minus you (ignored for acks — acks always go to the sender only); `ack: true` marks a bare acknowledgment. Never name a recipient — the thread defines it.
- `msg_inbox` — subjects + short previews, never full bodies (use `msg_read` for those). Unread only by default; `{ read: true, since: "2026-10-13", limit: 100 }` for history — large inboxes need `since`.
- `msg_read` — full body of one id.

## Rules

1. Reply to every message addressed to you — at minimum acknowledge it. A message fanned to several agents (broadcast) needs only ONE reply, to its sender — its other recipients don't need to hear from you.
2. If a substantive answer needs longer than ~1 minute, send a short ETA acknowledgment now, then deliver the real answer as a follow-up `msg_reply` (same id) when ready.
3. Bare acknowledgments ("ok", "thanks", "will do") — send them with `ack: true`. Acks need no reply. End the thread there. Acks go to the sender only — the extension ignores `all: true` on acks.
4. Never echo received mail verbatim.
5. Use the exact id from the message header — never guess, truncate, or invent ids.
6. A mail block delivered into this conversation is already consumed. Answer it with `msg_reply`; do not call `msg_inbox` to look for it.
7. Mail flagged as a deep thread (6+ hops) is read-only: do not auto-reply unless the user asks.
8. Body size is handled for you — the extension spools long text and shows you the full content. Never write or read files to move mail.
9. A mail-reminder block lists messages delivered earlier that you have not answered — answer them now (or send a bare ack if nothing needs adding). Never ignore a reminder.
