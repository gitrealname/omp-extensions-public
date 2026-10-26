/**
 * agent-hub-msg mailbox — per-session append-only mbox.jsonl plus read state.
 *
 * Frames are one JSON object per line. Bodies longer than the inline threshold
 * are spooled verbatim to `files/<id>.md`; the frame keeps only a short
 * excerpt and a `bodyFile` reference. Consumers splice the full text back in
 * (`resolveBody`) — the LLM never needs a file read for mail.
 *
 * Delivery/reading state lives in state.json: a high-water index
 * (`deliveredUpTo`) for auto-injection and a bounded `readIds` set.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Bodies longer than this are spooled to files/<id>.md (excerpt kept in frame). */
export let INLINE_MAX = 255;
const EXCERPT_LEN = 200;

export function setInlineMax(n: number): void {
	if (Number.isFinite(n) && n >= 0) INLINE_MAX = n;
}

export interface MailFrame {
	id: string;
	ts: string;
	/** Sender session id. */
	from: string;
	/** Sender alias, informational. */
	fromAlias?: string;
	/** Recipient session ids; "all" is expanded by the sender, never stored. */
	to: string[];
	/** Full body when short; excerpt when spooled. */
	body: string;
	/** Set when the body was spooled — resolveBody() splices the full text. */
	bodyFile?: string;
	subject?: string;
	/** Message id this one replies to; absent = thread root. */
	inReplyTo?: string;
	/** Reply-chain depth for loop protection. */
	hops?: number;
	/** Bare acknowledgment — never demands a reply (pending check skips it). */
	ack?: boolean;
}

export interface MailboxState {
	deliveredUpTo: number;
	readIds: string[];
	/** Frame ids this session has replied to (or otherwise answered). */
	answeredIds: string[];
}

export const MAX_READ_IDS = 1000;

/**
 * Move-merge one session's mailbox into another (alias handover). Idempotent:
 * frames missing from the target are appended in source order (dedupe by id —
 * ids are globally unique; a collision keeps the target's copy), then state
 * merges (deliveredUpTo = max; readIds/answeredIds = ordered union capped at
 * MAX_READ_IDS). The source inbox files are removed after a clean merge;
 * spooled bodies live in the shared files/ dir and need no move.
 *
 * Callers must switch the alias in the registry FIRST and merge SECOND: the
 * merge is idempotent, so a crash between the two steps self-heals on the next
 * run, while the reverse order could strand a delivery that raced into the old
 * inbox between merge and switch.
 */
export function mergeMailbox(root: string, fromSid: string, toSid: string): { moved: number; skipped: number } {
	for (const sid of [fromSid, toSid]) {
		if (!validSid(sid)) throw new Error(`agent-hub-msg: invalid session id ${JSON.stringify(String(sid).slice(0, 80))}`);
	}
	if (fromSid === toSid) return { moved: 0, skipped: 0 };
	const { frames: src } = readMailbox(root, fromSid);
	const { indexById: dstIndex } = readMailbox(root, toSid);
	let moved = 0;
	let skipped = 0;
	for (const frame of src) {
		if (dstIndex.has(frame.id)) {
			skipped++;
			continue;
		}
		deliverMail(root, toSid, frame);   // mkdir + torn-tail safety; does not touch state
		moved++;
	}
	const a = readState(root, toSid);
	const b = readState(root, fromSid);
	const cap = (base: string[], extra: string[]): string[] => {
		const seen = new Set(base);
		const merged = [...base];
		for (const id of extra) {
			if (!seen.has(id)) {
				seen.add(id);
				merged.push(id);
			}
		}
		return merged.length > MAX_READ_IDS ? merged.slice(merged.length - MAX_READ_IDS) : merged;
	};
	writeState(root, toSid, {
		deliveredUpTo: Math.max(a.deliveredUpTo, b.deliveredUpTo),
		readIds: cap(a.readIds, b.readIds),
		answeredIds: cap(a.answeredIds, b.answeredIds),
	});
	try {
		fs.rmSync(mboxPath(root, fromSid), { force: true });
		fs.rmSync(statePath(root, fromSid), { force: true });
		fs.rmdirSync(inboxDir(root, fromSid), { recursive: true });
	} catch {}
	return { moved, skipped };
}


/** Registry sids flow into filesystem paths — and registry.json is writable by
 *  any local process. Enforce a safe shape at the boundary and defensively at
 *  every path join. */
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validSid(sid: string): boolean {
	return SID_RE.test(sid);
}

export function inboxDir(root: string, sid: string): string {
	if (!SID_RE.test(sid)) throw new Error(`agent-hub-msg: invalid session id ${JSON.stringify(sid.slice(0, 80))}`);
	return path.join(root, "inboxes", sid);
}

export function mboxPath(root: string, sid: string): string {
	return path.join(inboxDir(root, sid), "mbox.jsonl");
}

export function filesDir(root: string): string {
	return path.join(root, "files");
}

function statePath(root: string, sid: string): string {
	return path.join(inboxDir(root, sid), "state.json");
}

export function readState(root: string, sid: string): MailboxState {
	try {
		const raw = JSON.parse(fs.readFileSync(statePath(root, sid), "utf-8")) as Partial<MailboxState>;
		return { deliveredUpTo: raw.deliveredUpTo ?? 0, readIds: raw.readIds ?? [], answeredIds: raw.answeredIds ?? [] };
	} catch {
		return { deliveredUpTo: 0, readIds: [], answeredIds: [] };
	}
}

function writeState(root: string, sid: string, state: MailboxState): void {
	fs.mkdirSync(inboxDir(root, sid), { recursive: true });
	const target = statePath(root, sid);
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state) + "\n", "utf-8");
	// Windows: rename over a file another process holds open throws — retry.
	const backoff = [25, 50, 100, 200, 400];
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tmp, target);
			return;
		} catch (err) {
			const wait = backoff[attempt];
			if (wait === undefined) {
				try {
					fs.rmSync(tmp, { force: true });
				} catch {}
				throw err;
			}
			const waitUntil = Date.now() + wait;
			while (Date.now() < waitUntil) {}
		}
	}
}

/**
 * Spool an oversized body to files/<id>.md and return the frame fields:
 * short excerpt in `body`, file reference in `bodyFile`. Undersized bodies
 * pass through unchanged.
 */
export function spoolBody(root: string, id: string, body: string): { body: string; bodyFile?: string } {
	if (body.length <= INLINE_MAX) return { body };
	fs.mkdirSync(filesDir(root), { recursive: true });
	const file = path.join(filesDir(root), `${id}.md`);
	fs.writeFileSync(file, body, "utf-8");
	return {
		body: `${body.slice(0, EXCERPT_LEN).trimEnd()}… [full text: file]`,
		bodyFile: path.relative(root, file),
	};
}

/** Frames carry attacker-controllable fields — a spool reference must be a
 *  generated path under files/, never an arbitrary location. */
const SPOOL_RE = /^files[/\\][A-Za-z0-9_-]{1,64}\.md$/;
const MAX_BODY_BYTES = 1_000_000;

/**
 * Full text of a frame: the spool file's content when spooled, else the frame
 * body. Spool files are permanent (no-evict), so a backlog read days later
 * still resolves. A missing/invalid file falls back to the excerpt with a
 * note. (An unvalidated bodyFile would splice ANY local file into the agent's
 * context — e.g. bodyFile "../../…/.env".)
 */
export function resolveBody(root: string, frame: MailFrame): string {
	if (!frame.bodyFile) return frame.body;
	if (!SPOOL_RE.test(frame.bodyFile)) {
		return `${frame.body}\n[invalid body file reference: ${frame.bodyFile.slice(0, 80)}]`;
	}
	try {
		const target = path.join(root, frame.bodyFile);
		if (fs.statSync(target).size > MAX_BODY_BYTES) {
			return `${frame.body}\n[body file too large (${frame.bodyFile})]`;
		}
		return fs.readFileSync(target, "utf-8");
	} catch {
		return `${frame.body}\n[body file missing: ${frame.bodyFile}]`;
	}
}

/** Append a frame to a session's mailbox. Creates the mailbox on first use. */
export function deliverMail(root: string, sid: string, mail: MailFrame): void {
	fs.mkdirSync(inboxDir(root, sid), { recursive: true });
	// If the file ends mid-line (torn tail from a crashed writer), prefix a
	// newline so the next frame isn't welded onto the partial JSON — which
	// would turn a tolerated tail into a permanent corrupt middle line.
	let payload = JSON.stringify(mail) + "\n";
	try {
		const stat = fs.statSync(mboxPath(root, sid));
		if (stat.size > 0) {
			const fd = fs.openSync(mboxPath(root, sid), "r");
			try {
				const buf = Buffer.alloc(1);
				fs.readSync(fd, buf, 0, 1, stat.size - 1);
				if (buf.toString("utf-8") !== "\n") payload = "\n" + payload;
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch {}
	fs.appendFileSync(mboxPath(root, sid), payload, "utf-8");
}

/** Parse the whole mailbox; corrupt lines are skipped, never fatal. */
export function readMailbox(root: string, sid: string): { frames: MailFrame[]; indexById: Map<string, number> } {
	const frames: MailFrame[] = [];
	const indexById = new Map<string, number>();
	let text = "";
	try {
		text = fs.readFileSync(mboxPath(root, sid), "utf-8");
	} catch {
		return { frames, indexById };
	}
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		try {
			const frame = JSON.parse(line) as MailFrame;
			if (typeof frame?.id === "string" && typeof frame?.from === "string" && Array.isArray(frame?.to)) {
				indexById.set(frame.id, frames.length);
				frames.push(frame);
			}
		} catch {
			// Skip corrupt frames instead of throwing: a thrown readMailbox
			// bricks delivery, msg_inbox, msg_reply, and reminders for this sid
			// forever. A torn tail (crashed writer mid-append) lands here too.
			continue;
		}
	}
	return { frames, indexById };
}

/**
 * Frames addressed to `me` (or "all") that arrived after the delivery cursor.
 * Ordered oldest first, as written. `sinceMs` (epoch ms) drops older frames
 * when given — useful for a huge offline backlog.
 */
export function unreadFor(root: string, sid: string, me: string, sinceMs?: number): MailFrame[] {
	const { frames } = readMailbox(root, sid);
	const state = readState(root, sid);
	const readIds = new Set(state.readIds);
	return frames
		.slice(state.deliveredUpTo)
		.filter(
			frame =>
				frame.from !== me &&
				(frame.to.includes(me) || frame.to.includes("all")) &&
				!readIds.has(frame.id) &&
				(sinceMs === undefined || Date.parse(frame.ts) >= sinceMs),
		);
}

/**
 * All frames ever addressed to me (any read state) — for `msg_inbox({ read: true })`.
 * Newest last. `sinceMs` (epoch ms) drops older frames when given.
 */
export function allForMe(root: string, sid: string, me: string, sinceMs?: number): MailFrame[] {
	return readMailbox(root, sid).frames.filter(
		frame =>
			frame.from !== me &&
			(frame.to.includes(me) || frame.to.includes("all")) &&
			(sinceMs === undefined || Date.parse(frame.ts) >= sinceMs),
	);
}

/**
 * Window a listing for the LLM: keep only frames at/after `sinceMs`, then the
 * most recent `limit` (mailbox order preserved inside the window). Returns
 * the selection plus the total that matched, so callers can report truncation.
 */
export function windowFrames(
	frames: MailFrame[],
	sinceMs?: number,
	limit = 50,
): { selected: MailFrame[]; total: number } {
	const inWindow = sinceMs === undefined ? frames : frames.filter(f => Date.parse(f.ts) >= sinceMs);
	const selected = inWindow.length > limit ? inWindow.slice(inWindow.length - limit) : inWindow;
	return { selected, total: inWindow.length };
}

/** Advance the delivery cursor past these frame indices and record read ids. */
export function markDelivered(root: string, sid: string, ids: string[]): void {
	const { frames, indexById } = readMailbox(root, sid);
	const state = readState(root, sid);
	const readIds = new Set(state.readIds);
	for (const id of ids) readIds.add(id);
	// Advance only past frames PROVEN delivered. A max-over-bundle cursor would
	// jump past interleaved frames from other senders (A,B,A → cursor=3 skips
	// B at 1) and slice them out of unreadFor forever — silent mail loss.
	let cursor = state.deliveredUpTo;
	while (cursor < frames.length && readIds.has(frames[cursor].id)) cursor++;
	writeState(root, sid, {
		deliveredUpTo: cursor,
		readIds: trimReadIds([...readIds], cursor, indexById),
		answeredIds: state.answeredIds,
	});
}

/** Mark one message read without advancing the delivery cursor. */
export function markRead(root: string, sid: string, id: string): void {
	const { indexById } = readMailbox(root, sid);
	const state = readState(root, sid);
	if (state.readIds.includes(id)) return;
	writeState(root, sid, {
		deliveredUpTo: state.deliveredUpTo,
		readIds: trimReadIds([...state.readIds, id], state.deliveredUpTo, indexById),
		answeredIds: state.answeredIds,
	});
}

/** Record that this session answered the given message ids. Idempotent. */
export function markAnswered(root: string, sid: string, ids: string[]): void {
	const state = readState(root, sid);
	const answered = new Set(state.answeredIds);
	for (const id of ids) answered.add(id);
	// Cap like readIds — a chatty session would otherwise grow state.json
	// unboundedly. Ids are appended chronologically; the oldest drop first and
	// those threads are long closed (no reminder can be affected).
	const list = [...answered];
	writeState(root, sid, { ...state, answeredIds: list.length > MAX_READ_IDS ? list.slice(list.length - MAX_READ_IDS) : list });
}

/**
 * Delivered-but-unanswered mail addressed to me: consumed (in readIds), not
 * yet answered, and not an ack (bare acknowledgments never demand a reply).
 * FYI-subjected mail is likewise excluded — the etiquette exempts it from
 * replies, so it must never surface as a reminder.
 * This is what pending reminders are built from.
 */
export function pendingFor(root: string, sid: string, me: string): MailFrame[] {
	const { frames } = readMailbox(root, sid);
	const state = readState(root, sid);
	const readIds = new Set(state.readIds);
	const answered = new Set(state.answeredIds);
	return frames.filter(
		frame =>
			frame.from !== me &&
			(frame.to.includes(me) || frame.to.includes("all")) &&
			readIds.has(frame.id) &&
			!answered.has(frame.id) &&
			!frame.ack &&
			!isFyi(frame),
	);
}

/** FYI-subjected mail requests no reply (etiquette rule 1b). */
export function isFyi(frame: MailFrame): boolean {
	return /^fyi\b/i.test(frame.subject ?? "");
}

/**
 * Duplicate-delivery fingerprint: harness-level tool retries can re-execute a
 * send after the result was already delivered, producing identical content
 * under a FRESH snowflake id — downstream indistinguishable from a new
 * message. Duplicate handoffs re-anchor turns; a duplicate ack can re-open a
 * thread an ack already closed. Match on sender + thread + subject + body
 * prefix within the retry window; returns the earlier frame when duplicated.
 */
export function duplicateOf(root: string, sid: string, frame: MailFrame, windowMs: number): MailFrame | undefined {
	const key = dupKey(frame);
	const ts = Date.parse(frame.ts);
	const readIds = new Set(readState(root, sid).readIds);
	for (const prior of readMailbox(root, sid).frames) {
		if (prior.id === frame.id || prior.from !== frame.from) continue;
		// The original must be one the recipient actually RECEIVED (delivered):
		// when the harness retries while the recipient is offline, both copies
		// land unread in the same delivery tick — treating either as the
		// original would swallow both. Both-unread delivers both (rule 5
		// covers answering once); retry-after-delivery still suppresses.
		if (!readIds.has(prior.id)) continue;
		if (dupKey(prior) !== key) continue;
		// Prefix equality is only a cheap pre-filter — confirm full-body
		// equality so distinct spooled messages sharing a header/template
		// prefix are never suppressed as duplicates.
		try {
			if (resolveBody(root, prior) !== resolveBody(root, frame)) continue;
		} catch {
			continue;
		}
		const priorTs = Date.parse(prior.ts);
		if (!Number.isFinite(ts) || !Number.isFinite(priorTs)) continue;
		if (Math.abs(ts - priorTs) <= windowMs) return prior;
	}
	return undefined;
}

function dupKey(frame: MailFrame): string {
	return JSON.stringify([frame.from, frame.inReplyTo ?? "", frame.subject ?? "", frame.body.slice(0, 200)]);
}

/**
 * Latest-activity timestamp per frame's thread (all mailbox frames supplied).
 * A thread's hotness includes frames ALREADY delivered — an old message in a
 * thread that received a fresh reply is hot. Parents living in another
 * mailbox root the thread at their id. Cycle-safe.
 */
export function threadActivity(frames: readonly MailFrame[]): Map<string, number> {
	const byId = new Map(frames.map(f => [f.id, f]));
	const rootOf = (start: MailFrame): string => {
		let cur: MailFrame = start;
		const seen = new Set<string>();
		while (cur.inReplyTo && !seen.has(cur.inReplyTo)) {
			seen.add(cur.inReplyTo);
			const parent = byId.get(cur.inReplyTo);
			if (!parent) return cur.inReplyTo;
			cur = parent;
		}
		return cur.id;
	};
	const rootTs = new Map<string, number>();
	for (const f of frames) {
		const ts = Date.parse(f.ts);
		if (!Number.isFinite(ts)) continue;
		const root = rootOf(f);
		rootTs.set(root, Math.max(rootTs.get(root) ?? 0, ts));
	}
	const latest = new Map<string, number>();
	for (const f of frames) latest.set(f.id, rootTs.get(rootOf(f)) ?? Date.parse(f.ts));
	return latest;
}

function trimReadIds(readIds: string[], cursor: number, indexById: Map<string, number>): string[] {
	if (readIds.length <= MAX_READ_IDS) return readIds;
	// Drop the oldest read ids that are already behind the delivery cursor —
	// they can never resurface as unread.
	const keep = readIds.filter(id => {
		const idx = indexById.get(id);
		return idx === undefined || idx >= cursor;
	});
	return keep.length > MAX_READ_IDS ? keep.slice(keep.length - MAX_READ_IDS) : keep;
}
