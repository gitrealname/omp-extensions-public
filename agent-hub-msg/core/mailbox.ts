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
			!frame.ack,
	);
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
