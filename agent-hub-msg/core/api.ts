/**
 * agent-hub-msg core — harness-neutral API surface.
 *
 * Tool-shaped entry points shared by every adapter (omp today, other agents
 * later) and by a future CLI. Each function returns a `{ text, details? }`
 * result meant to surface verbatim to the calling LLM (or CLI stdout) and
 * throws on user-visible errors. No harness imports here.
 */
import { MAX_HOPS, nextHops } from "./deliver";
import { loadInstructions } from "./instructions";
import {
	allForMe,
	deliverMail,
	INLINE_MAX,
	markAnswered,
	markRead,
	pendingFor,
	readMailbox,
	readState,
	resolveBody,
	spoolBody,
	unreadFor,
	windowFrames,
	type MailFrame,
} from "./mailbox";
import { addAlias, clearAlias, expandTo, forceAlias, listSessions, REGISTRY_STALE_AFTER_MS, resolveAddress, setInstructed } from "./registry";
import { mergeMailbox } from "./mailbox";
import { Snowflake } from "./id";

/** The calling session's identity. */
export interface Me {
	sid: string;
	alias?: string;
}

export interface ToolResult {
	text: string;
	details?: Record<string, unknown>;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

export function relativeAge(ts: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/** Render a session id as a human name: alias preferred, self as "you". */
export function describe(root: string, sid: string, me: string): string {
	if (sid === me) return "you";
	const row = listSessions(root).find(r => r.sid === sid);
	return row && row.entry.aliases.length > 0 ? `${row.entry.aliases[0]} (${sid.slice(-6)})` : sid;
}

function describeList(root: string, sids: string[], me: string): string {
	return sids.map(s => describe(root, s, me)).join(", ");
}

/** Registry view of a session's aliases + instructed flag. */
export function myself(root: string, sid: string): { aliases: string[]; instructed: boolean; instructionsHash?: string } {
	const row = listSessions(root).find(r => r.sid === sid);
	return {
		aliases: row?.entry.aliases ?? [],
		instructed: row?.entry.instructed ?? false,
		instructionsHash: row?.entry.instructionsHash,
	};
}

function findFrame(root: string, sid: string, id: string): MailFrame | undefined {
	return readMailbox(root, sid).frames.find(f => f.id === id);
}

function buildFrame(
	root: string,
	me: Me,
	to: string[],
	body: string,
	subject: string | undefined,
	inReplyTo: string | undefined,
	ack: boolean | undefined,
): MailFrame {
	const parent = inReplyTo ? findFrame(root, me.sid, inReplyTo) : undefined;
	if (inReplyTo && !parent) throw new Error(`message ${inReplyTo} not in this mailbox — reply only to mail you received`);
	if (parent?.ack) {
		throw new Error(
			`message ${inReplyTo} is a bare ack — acks close the thread on both sides; never reply to an ack. To add a verdict or follow-up, reply to the ORIGINAL message of that thread instead (siblings of an ack are fine), or start a new thread`,
		);
	}
	const hops = nextHops(parent);
	// Acks bypass the cap: terminal BY CONSTRUCTION (the ack-of-ack refusal
	// above is checked FIRST, so an ack can never extend a chain at any depth),
	// but thread closure must always be reachable. MAX_HOPS bounds conversation
	// depth, not closing signals.
	if (!ack && hops > MAX_HOPS) throw new Error(`thread depth ${hops} exceeds the ${MAX_HOPS}-hop reply cap — answer via a new thread (msg_send with a fresh subject), then send a bare ack to this message id so it closes`);
	const id = Snowflake.next();
	const spooled = spoolBody(root, id, body);
	return {
		id,
		ts: new Date().toISOString(),
		from: me.sid,
		...(me.alias ? { fromAlias: me.alias } : {}),
		to,
		body: spooled.body,
		...(spooled.bodyFile ? { bodyFile: spooled.bodyFile } : {}),
		...(subject ? { subject } : {}),
		...(inReplyTo ? { inReplyTo } : {}),
		...(ack ? { ack: true } : {}),
		hops,
	};
}

// ── Tool-shaped entry points ─────────────────────────────────────────────────

export function sendMail(
	root: string,
	me: Me,
	params: { to: string; body: string; subject?: string; inReplyTo?: string; ack?: boolean },
): ToolResult {
	const { to, skipped } = expandTo(root, params.to, me.sid);
	const delivered: string[] = [];
	if (to.length > 0) {
		const frame = buildFrame(root, me, to, params.body, params.subject, params.inReplyTo, params.ack);
		for (const rcpt of to) deliverMail(root, rcpt, frame);
		delivered.push(...to);
		// A fresh send referencing an id counts as answering that message.
		if (params.inReplyTo) markAnswered(root, me.sid, [params.inReplyTo]);
	}
	const parts = [
		delivered.length > 0 ? `sent to: ${describeList(root, delivered, me.sid)}` : "not delivered",
		...skipped.map(s => `skipped ${s.key}: ${s.reason}`),
	];
	return { text: parts.join("; "), details: { delivered, skipped } };
}

export function replyMail(
	root: string,
	me: Me,
	params: { id: string; body: string; all?: boolean; ack?: boolean },
): ToolResult {
	const original = findFrame(root, me.sid, params.id);
	if (!original || original.from === me.sid) {
		return { text: `message ${params.id} not found in this mailbox` };
	}
	// Acks are private: they go to the sender only, never to the other thread
	// members — even with all=true — or broadcast ack cycles storm everyone.
	const to = params.all && !params.ack
		? [...new Set([original.from, ...original.to])].filter(a => a !== me.sid && a !== "all")
		: [original.from];
	if (to.length === 0) return { text: "no recipients left to reply to" };
	const frame = buildFrame(root, me, to, params.body, original.subject, params.id, params.ack);
	for (const rcpt of to) deliverMail(root, rcpt, frame);
	markAnswered(root, me.sid, [params.id]);
	return {
		text: `replied to ${describe(root, original.from, me.sid)}${params.all ? ` (all: ${describeList(root, to, me.sid)})` : ""}`,
		details: { to },
	};
}

export function listInbox(
	root: string,
	sid: string,
	params: { read?: boolean; since?: string | number; limit?: number },
): ToolResult {
	let sinceMs: number | undefined;
	if (params.since !== undefined) {
		sinceMs = typeof params.since === "number" ? params.since : Date.parse(params.since);
		if (!Number.isFinite(sinceMs)) {
			return { text: `invalid since "${params.since}" — use an ISO date or epoch ms` };
		}
	}
	const limit = Math.min(Math.max(1, Math.round(params.limit ?? 50)), 500);
	const readIds = new Set(readState(root, sid).readIds);
	const frames = params.read ? allForMe(root, sid, sid, sinceMs) : unreadFor(root, sid, sid, sinceMs);
	const shown = params.read ? frames : frames.filter(f => !readIds.has(f.id));
	const { selected, total } = windowFrames(shown, undefined, limit);
	if (selected.length === 0) {
		const readCount = frames.length - shown.length;
		return {
			text:
				readCount > 0
					? `no unread mail — ${readCount} message(s) already delivered into this conversation; call msg_inbox with read:true to list them`
					: "inbox empty",
		};
	}
	const lines = selected.map(f => {
		const preview = f.body.length > 80 ? `${f.body.slice(0, 80)}…` : f.body;
		return `${f.id} ${f.ts} from=${describe(root, f.from, sid)}${f.inReplyTo ? ` re=${f.inReplyTo.slice(-8)}` : ""} | ${f.subject ?? ""} | ${preview.replace(/\n/g, " ")}`;
	});
	if (total > selected.length) {
		lines.push(`(${total - selected.length} older message(s) not shown — narrow with since, or raise limit up to 500)`);
	}
	return { text: lines.join("\n"), details: { count: selected.length, total } };
}

export function readMail(root: string, sid: string, id: string): ToolResult {
	const frame = findFrame(root, sid, id);
	if (!frame || frame.from === sid) return { text: `message ${id} not found in this mailbox` };
	markRead(root, sid, frame.id);
	return { text: `[from ${describe(root, frame.from, sid)}]\n${resolveBody(root, frame)}` };
}


// ── Roster rendering (shared by /msg list and msg_who) ─────────────────────

/** Offline entries shown before the "+N dormant hidden" summary line. */
export const ROSTER_OFFLINE_SHOWN = 5;

/**
 * One compact, scannable roster:
 *   aliased sessions FIRST (most recent activity first),
 *   then non-aliased live (most recent first),
 *   then offline — capped at ROSTER_OFFLINE_SHOWN, the rest collapses into a
 *   single "+N dormant hidden" line. `full=true` lists everything (escape
 *   hatch: /msg list all).
 */
export function formatRoster(
	root: string,
	opts: { viewerSid?: string; full?: boolean; showPid?: boolean; header?: string } = {},
): string {
	const now = Date.now();
	const sessions = listSessions(root, now).filter(r => !opts.viewerSid || r.sid !== opts.viewerSid);
	const row = (r: (typeof sessions)[number]): string => {
		const { entry, live } = r;
		const status = live
			? ""
			: now - entry.lastSeen > REGISTRY_STALE_AFTER_MS
				? " (stale — offline 30d+)"
				: " (offline — mail will wait)";
		const aliases = entry.aliases.length > 0 ? ` [${entry.aliases.join(", ")}]` : "";
		const pid = opts.showPid && entry.pid !== undefined ? ` pid ${entry.pid}` : "";
		return `${r.sid}${pid} ${relativeAge(entry.lastSeen, now)}${aliases} (${entry.cwd})${status}`;
	};
	const byRecency = (a: (typeof sessions)[number], b: (typeof sessions)[number]) => b.entry.lastSeen - a.entry.lastSeen;
	const aliased = sessions.filter(r => r.entry.aliases.length > 0).sort(byRecency);
	const liveBare = sessions.filter(r => r.entry.aliases.length === 0 && r.live).sort(byRecency);
	const offline = sessions.filter(r => r.entry.aliases.length === 0 && !r.live).sort(byRecency);
	const rows: string[] = [...aliased, ...liveBare].map(row);
	const shownOffline = opts.full ? offline : offline.slice(0, ROSTER_OFFLINE_SHOWN);
	for (const r of shownOffline) rows.push(row(r));
	const hidden = offline.length - shownOffline.length;
	if (hidden > 0) rows.push(`+ ${hidden} dormant (offline) hidden — /msg list all to see every session`);
	const header = opts.header ?? "registered agent sessions:";
	return `${header}\n${rows.join("\n") || "(none)"}`;
}

export function whoami(root: string, sid: string): ToolResult {
	const mine = myself(root, sid);
	const myAliases = mine.aliases.length > 0 ? ` [${mine.aliases.join(", ")}]` : "";
	return { text: `you are: ${sid}${myAliases}\n${formatRoster(root, { viewerSid: sid })}` };
}

/** /msg alias <name> — set a user alias on this session. With force=true, take
 *  the alias away from another session and move+merge that mailbox here. */
export function setUserAlias(root: string, sid: string, name: string, force = false): ToolResult {
	if (force) {
		const moved = forceAlias(root, sid, name);
		let text = `aliases: ${moved.aliases.join(", ")}`;
		if (moved.movedFrom) {
			const r = mergeMailbox(root, moved.movedFrom, sid);
			text += ` — moved from ${moved.movedFrom} (${r.moved} frame(s) moved, ${r.skipped} duplicate(s) skipped); its pending mail is now yours`;
		}
		return { text, details: { movedFrom: moved.movedFrom } };
	}
	const res = addAlias(root, sid, name);
	return {
		text: res.conflict
			? `${res.conflict} — your aliases: ${res.aliases.join(", ")} (use /msg alias ${name} --force to take it over)`
			: `aliases: ${res.aliases.join(", ")}`,
		details: { conflict: res.conflict },
	};
}

/** /msg clear [<session-id|prefix|alias>] — drop a session's alias. Bare form
 *  clears MY alias; with a target it clears ANOTHER session's — old/dead
 *  sessions must be cleanable without booting them. */
export function clearUserAlias(root: string, sid: string, target?: string): ToolResult {
	if (!target || target.trim() === sid) return clearMine(root, sid);
	const res = resolveAddress(root, target, Date.now());
	if (res.error || !res.address) return { text: res.error ?? `no such agent "${target}"` };
	const other = res.address.sid;
	if (other === sid) return clearMine(root, sid);
	const before = res.address.entry.aliases;
	const out = clearAlias(root, other);
	return {
		text: out.aliases.length
			? `${other}: aliases now ${out.aliases.join(", ")}`
			: `${other}: alias cleared (was ${before.join(", ") || "none"}) — addressed by session id only`,
		details: { cleared: other },
	};
}

function clearMine(root: string, sid: string): ToolResult {
	const res = clearAlias(root, sid);
	return { text: res.aliases.length ? `aliases: ${res.aliases.join(", ")}` : "alias cleared — addressed by session id only" };
}

/** Instructions text for a session (fresh read; leading H1 stripped). */
export function instructionsText(extensionDir: string): string {
	return loadInstructions(extensionDir);
}

/** Record that instructions were injected into this session's context. */
export function markInstructed(root: string, sid: string, instructionsHash?: string): void {
	setInstructed(root, sid, true, Date.now(), instructionsHash);
}

/**
 * Reminder block for delivered-but-unanswered mail, oldest first. Single
 * item → full body spliced; several → headers + previews (msg_read for full
 * text). Returns null when nothing is pending.
 */
/** Default reminder age floor: 30 min of silence = nothing to report. */
export const REMIND_AGE_MS_DEFAULT = 1800000;

export function pendingReminder(root: string, sid: string, max = 5, minAgeMs = 1800000): ToolResult | null {
	const pending = pendingFor(root, sid, sid)
		// Silence-by-default etiquette: a fresh unanswered message may simply
		// need no answer — only nag after the age floor, so short-lived
		// silence is never interrupted, but genuinely dropped/forgotten mail
		// still resurfaces. 0 disables the floor.
		.filter(f => minAgeMs <= 0 || Date.now() - Date.parse(f.ts) >= minAgeMs);
	if (pending.length === 0) return null;
	const selected = pending.slice(0, max);
	const lines: string[] = [
		`Mail reminder — ${pending.length === 1 ? "1 message" : `${pending.length} messages`} delivered earlier ${pending.length > selected.length ? `(showing ${selected.length} oldest) ` : ""}without an answer:`,
		"",
	];
	for (const frame of selected) {
		const from = describe(root, frame.from, sid);
		const subject = frame.subject ? ` — ${frame.subject}` : "";
		lines.push(`[mail from ${from}${subject} | id: ${frame.id}]`);
		if (selected.length === 1) lines.push(resolveBody(root, frame).trimEnd());
		else lines.push(`  ${frame.body.replace(/\n/g, " ").slice(0, 120)}${frame.body.length > 120 ? "…" : ""} (msg_read for full text)`);
		lines.push("");
	}
	lines.push(
		"These were delivered into this conversation before but appear unanswered — reply with msg_reply (use ack:true if nothing needs adding). Nothing pending can simply be dropped.",
	);
	return { text: lines.join("\n").trim(), details: { count: pending.length } };
}

export { INLINE_MAX };
