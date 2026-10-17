import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	allForMe,
	deliverMail,
	duplicateOf,
	isFyi,
	markAnswered,
	markDelivered,
	markRead,
	pendingFor,
	readMailbox,
	readState,
	resolveBody,
	spoolBody,
	unreadFor,
	windowFrames,
	type MailFrame,
} from "../core/mailbox";

let root: string;

beforeEach(() => {
	root = path.join(os.tmpdir(), `agent-hub-msg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;
const frame = (from: string, to: string[], body = "hi", extra: Partial<MailFrame> = {}): MailFrame => ({
	id: `m${++seq}`,
	ts: new Date().toISOString(),
	from,
	to,
	body,
	...extra,
});

describe("mailbox", () => {
	it("appends and reads frames; tolerates a torn tail", () => {
		deliverMail(root, "a", frame("b", ["a"], "one"));
		const second = frame("b", ["a"], "two");
		deliverMail(root, "a", second);
		// Simulate a concurrent append torn mid-line.
		fs.appendFileSync(path.join(root, "inboxes", "a", "mbox.jsonl"), '{"id":"torn","from":"b"');
		const { frames, indexById } = readMailbox(root, "a");
		expect(frames.map(f => f.body)).toEqual(["one", "two"]);
		expect(indexById.get(second.id)).toBe(1);
	});

	it("unreadFor filters by recipient, excludes self-mail, honors cursor", () => {
		const forA = frame("b", ["a"], "for-a");
		deliverMail(root, "a", forA);
		deliverMail(root, "a", frame("b", ["c"], "for-c"));
		deliverMail(root, "a", frame("a", ["a"], "self")); // echoed self-mail ignored
		deliverMail(root, "a", frame("b", ["a", "c"], "broadcast"));
		deliverMail(root, "a", frame("b", ["all"], "to-all"));

		expect(unreadFor(root, "a", "a").map(f => f.body)).toEqual(["for-a", "broadcast", "to-all"]);

		markDelivered(root, "a", [forA.id]);
		expect(unreadFor(root, "a", "a").map(f => f.body)).toEqual(["broadcast", "to-all"]);
	});

	it("read state round-trips and readIds prune behind the cursor", () => {
		const first = frame("b", ["a"]);
		deliverMail(root, "a", first);
		markRead(root, "a", first.id);
		expect(readState(root, "a").readIds).toContain(first.id);
		expect(unreadFor(root, "a", "a")).toHaveLength(0);
		// Marking read twice is idempotent.
		markRead(root, "a", first.id);
		expect(readState(root, "a").readIds.filter(x => x === first.id)).toHaveLength(1);
	});

	it("allForMe returns everything addressed to me regardless of read state", () => {
		const one = frame("b", ["a"], "one");
		deliverMail(root, "a", one);
		deliverMail(root, "a", frame("c", ["a"], "two"));
		deliverMail(root, "a", frame("b", ["c"], "not-mine"));
		markDelivered(root, "a", [one.id]);
		expect(allForMe(root, "a", "a").map(f => f.body)).toEqual(["one", "two"]);
	});
});

describe("inbox windowing", () => {
	const deliverAt = (sid: string, from: string, iso: string, body: string) => {
		const f = frame(from, [sid], body);
		f.ts = iso;
		deliverMail(root, sid, f);
		return f;
	};

	it("since filters both views by timestamp", () => {
		deliverAt("a", "b", "2026-10-01T10:00:00Z", "old");
		const recent = deliverAt("a", "b", "2026-10-13T10:00:00Z", "new");
		const sinceMs = Date.parse("2026-10-10T00:00:00Z");
		expect(unreadFor(root, "a", "a", sinceMs).map(f => f.body)).toEqual(["new"]);
		expect(allForMe(root, "a", "a", sinceMs).map(f => f.body)).toEqual(["new"]);
		expect(allForMe(root, "a", "a").map(f => f.body)).toEqual(["old", "new"]);
		expect(recent.ts).toBe("2026-10-13T10:00:00Z");
	});

	it("windowFrames keeps the most recent N and reports the total", () => {
		const frames = Array.from({ length: 7 }, (_, i) => {
			const f = frame("b", ["a"], `m${i}`);
			f.ts = new Date(Date.UTC(2026, 9, 13, 10, 0, i)).toISOString();
			return f;
		});
		const { selected, total } = windowFrames(frames, undefined, 3);
		expect(total).toBe(7);
		expect(selected.map(f => f.body)).toEqual(["m4", "m5", "m6"]); // most recent, order preserved
		const empty = windowFrames(frames, Date.parse("2027-01-01T00:00:00Z"), 50);
		expect(empty.selected).toHaveLength(0);
		expect(empty.total).toBe(0);
	});
});

describe("answered flags and pending", () => {
	it("markAnswered is idempotent and independent of read state", () => {
		const m = frame("b", ["a"], "hello");
		deliverMail(root, "a", m);
		markDelivered(root, "a", [m.id]);
		markAnswered(root, "a", [m.id]);
		markAnswered(root, "a", [m.id]);
		const state = readState(root, "a");
		expect(state.answeredIds.filter(x => x === m.id)).toHaveLength(1);
		// A later read-state write must not wipe the answered flag.
		markRead(root, "a", "other-id");
		expect(readState(root, "a").answeredIds).toContain(m.id);
	});

	it("pendingFor: delivered-not-answered is pending; answered and ack are not", () => {
		const unanswered = frame("b", ["a"], "needs answer");
		deliverMail(root, "a", unanswered);
		markDelivered(root, "a", [unanswered.id]);
		expect(pendingFor(root, "a", "a").map(f => f.id)).toEqual([unanswered.id]);

		// Not yet delivered (still unread) is NOT pending — the delivery loop owns it.
		const undelivered = frame("b", ["a"], "backlog");
		deliverMail(root, "a", undelivered);
		expect(pendingFor(root, "a", "a").map(f => f.id)).toEqual([unanswered.id]);

		// A reply marks the original answered.
		markAnswered(root, "a", [unanswered.id]);
		expect(pendingFor(root, "a", "a")).toHaveLength(0);

		// An ack frame never becomes pending.
		const ack = frame("b", ["a"], "ok");
		ack.ack = true;
		deliverMail(root, "a", ack);
		markDelivered(root, "a", [ack.id]);
		expect(pendingFor(root, "a", "a")).toHaveLength(0);

		// Self-mail never counts.
		const self = frame("a", ["a"], "self");
		deliverMail(root, "a", self);
		markDelivered(root, "a", [self.id]);
		expect(pendingFor(root, "a", "a")).toHaveLength(0);
	});
});

describe("ack fan-out suppression", () => {
	it("ack replies go to the sender only even with all=true; non-ack replies fan out", () => {
		const me = "0197aaaaaaaa7ff3c00000000003";
		const peer = "0197aaaaaaaa7ff4c00000000004";
		const other = "0197aaaaaaaa7ff5c00000000005";
		// peer broadcast to me + other; both must receive the original.
		const bc = frame(peer, [me, other], "broadcast hello");
		deliverMail(root, me, bc);
		deliverMail(root, other, bc);

		// ack + all=true → suppression: only the sender hears the ack.
		const { replyMail } = require("../core/api") as typeof import("../core/api");
		replyMail(root, { sid: me }, { id: bc.id, body: "ok", ack: true, all: true });
		expect(readMailbox(root, peer).frames.some(f => f.body === "ok")).toBe(true);
		expect(readMailbox(root, other).frames.some(f => f.body === "ok")).toBe(false);

		// non-ack + all=true → fan-out as usual.
		replyMail(root, { sid: me }, { id: bc.id, body: "answer to everyone", all: true });
		expect(readMailbox(root, peer).frames.some(f => f.body === "answer to everyone")).toBe(true);
		expect(readMailbox(root, other).frames.some(f => f.body === "answer to everyone")).toBe(true);
	});

	it("tool layer refuses replies to ack frames (ack-of-ack guard)", () => {
		const me = "0197aaaaaaaa7ff3c00000000003";
		const peer = "0197aaaaaaaa7ff4c00000000004";
		const original = frame(peer, [me], "question");
		deliverMail(root, me, original);
		// expandTo resolves recipients against the registry — register both sids
		// so the sendMail path reaches buildFrame (where the ack guard lives).
		const { registerSession } = require("../core/registry") as typeof import("../core/registry");
		registerSession(root, me, { pid: 1, cwd: ".", machine: "t" });
		registerSession(root, peer, { pid: 2, cwd: ".", machine: "t" });
		const { replyMail, sendMail } = require("../core/api") as typeof import("../core/api");
		const ackReply = replyMail(root, { sid: me }, { id: original.id, body: "ok", ack: true });
		expect(ackReply.text).toContain("replied to");
		// The ack was delivered to the ORIGINAL SENDER's mailbox (peer's) —
		// from there it is an incoming ack that must refuse all replies.
		const ackFrame = readMailbox(root, peer).frames.find(f => f.ack)!;
		expect(ackFrame.from).toBe(me);

		expect(() => replyMail(root, { sid: peer }, { id: ackFrame.id, body: "thanks" })).toThrow(/bare ack/);
		// Same guard on fresh sends threading off an ack.
		expect(() => sendMail(root, { sid: peer }, { to: me, body: "follow-up", inReplyTo: ackFrame.id })).toThrow(/bare ack/);
		// And even an ack-to-ack is refused — threads close, full stop.
		expect(() => replyMail(root, { sid: peer }, { id: ackFrame.id, body: "ok", ack: true })).toThrow(/bare ack/);
	});

	it("a bare ack bypasses the hop cap — thread closure is always reachable", () => {
		const me = "0197aaaaaaaa7ff3c00000000003";
		const peer = "0197aaaaaaaa7ff4c00000000004";
		const { replyMail } = require("../core/api") as typeof import("../core/api");
		// A deep-thread frame lands in my mailbox (hops already at the cap).
		const deep = frame(peer, [me], "six hops deep");
		deep.hops = 6;
		deliverMail(root, me, deep);

		// Substantive reply: refused at the cap.
		expect(() => replyMail(root, { sid: me }, { id: deep.id, body: "still working" })).toThrow(/reply cap/);
		// Bare ack: allowed at ANY depth — it closes the thread.
		const closing = replyMail(root, { sid: me }, { id: deep.id, body: "ack", ack: true });
		expect(closing.text).toContain("replied to");
		// And the ack it produced can never be answered (refusal is checked first).
		const ackFrame = readMailbox(root, peer).frames.find(f => f.ack)!;
		expect(() => replyMail(root, { sid: peer }, { id: ackFrame.id, body: "ok", ack: true })).toThrow(/bare ack/);
	});
});

describe("body spooling", () => {
	it("short bodies pass through without a file", () => {
		const r = spoolBody(root, "id1", "short");
		expect(r).toEqual({ body: "short" });
	});

	it("long bodies are spooled verbatim to files/<id>.md with an excerpt in the frame", () => {
		const long = "A".repeat(1000);
		const r = spoolBody(root, "id2", long);
		expect(r.bodyFile).toBe(path.join("files", "id2.md"));
		expect(fs.readFileSync(path.join(root, "files", "id2.md"), "utf-8")).toBe(long);
		expect(r.body.length).toBeLessThan(300);
		expect(r.body.endsWith("… [full text: file]")).toBe(true);
	});

	it("resolveBody returns the spooled full text; missing file falls back", () => {
		const long = "B".repeat(500);
		const spooled = spoolBody(root, "id3", long);
		const spooledFrame = frame("b", ["a"], spooled.body, { bodyFile: spooled.bodyFile });
		expect(resolveBody(root, spooledFrame)).toBe(long);
		const missing = frame("b", ["a"], "excerpt…", { bodyFile: "files/nope.md" });
		expect(resolveBody(root, missing)).toContain("[body file missing");
		const plain = frame("b", ["a"], "inline");
		expect(resolveBody(root, plain)).toBe("inline");
	});
});

describe("delivery cursor with interleaved senders", () => {
	it("advances only past delivered frames — no silent loss", () => {
		const a1 = frame("peerA", ["me"], "a one");
		const b1 = frame("peerB", ["me"], "b one");
		const a2 = frame("peerA", ["me"], "a two");
		for (const f of [a1, b1, a2]) deliverMail(root, "me", f);
		// Bundle from peerA delivers first (frames a1, a2 non-adjacent).
		markDelivered(root, "me", [a1.id, a2.id]);
		const stillPending = unreadFor(root, "me", "me");
		expect(stillPending.map(f => f.id)).toEqual([b1.id]); // B survived the cursor jump
		markDelivered(root, "me", [b1.id]);
		expect(unreadFor(root, "me", "me")).toHaveLength(0);
	});
});

describe("mailbox robustness", () => {
	it("skips corrupt non-final lines instead of throwing", () => {
		const good1 = frame("p", ["me"], "one");
		const good2 = frame("p", ["me"], "two");
		fs.mkdirSync(path.join(root, "inboxes", "me"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "inboxes", "me", "mbox.jsonl"),
			`${JSON.stringify(good1)}\n{corrupt garbage line\n${JSON.stringify(good2)}\n`,
			"utf-8",
		);
		const { frames } = readMailbox(root, "me");
		expect(frames.map(f => f.id)).toEqual([good1.id, good2.id]);
	});

	it("appending onto a torn tail keeps both frames parseable", () => {
		fs.mkdirSync(path.join(root, "inboxes", "me"), { recursive: true });
		fs.writeFileSync(path.join(root, "inboxes", "me", "mbox.jsonl"), '{"id":"torn","from":"p"', "utf-8"); // crashed writer
		const next = frame("p", ["me"], "after crash");
		deliverMail(root, "me", next); // must not weld onto the partial JSON
		const { frames } = readMailbox(root, "me");
		expect(frames.map(f => f.id)).toEqual([next.id]);
	});
});

describe("bodyFile validation", () => {
	it("refuses traversal and absolute paths — no arbitrary file read", () => {
		for (const bodyFile of ["../../../.env", "C:/secrets/x.md", "files/../../escape.md", "files/sub/dir.md"]) {
			const out = resolveBody(root, frame("p", ["me"], "excerpt", { bodyFile }));
			expect(out).toContain("[invalid body file reference");
		}
	});

	it("accepts generated spool names", () => {
		const spooled = spoolBody(root, "0123abcdef456789", "y".repeat(400));
		expect(resolveBody(root, { ...frame("p", ["me"], ""), ...spooled })).toBe("y".repeat(400));
	});
});

describe("FYI reminder exemption", () => {
	it("pendingFor skips FYI-subjected frames; subject match is case-insensitive", () => {
		const answered = frame("b", ["a"], "fyi body", { subject: "FYI: for your information" });
		deliverMail(root, "a", answered);
		markDelivered(root, "a", [answered.id]);
		expect(isFyi(answered)).toBe(true);
		expect(pendingFor(root, "a", "a")).toHaveLength(0);

		// normal subject still pending
		const normal = frame("b", ["a"], "needs an answer", { subject: "question" });
		deliverMail(root, "a", normal);
		markDelivered(root, "a", [normal.id]);
		expect(pendingFor(root, "a", "a").map(f => f.id)).toEqual([normal.id]);
	});

	it("fyi must be at the start of the subject; fyi inside the body does not count", () => {
		expect(isFyi(frame("b", ["a"], "x", { subject: "fyi: lowercase" }))).toBe(true);
		expect(isFyi(frame("b", ["a"], "x", { subject: "FYISH: not quite" }))).toBe(false);
		expect(isFyi(frame("b", ["a"], "please fyi this", { subject: "real question" }))).toBe(false);
	});
});

describe("duplicate-delivery detection", () => {
	it("same sender/thread/subject/body under a fresh id matches within the window", () => {
		const prior = frame("b", ["a"], "identical payload", { inReplyTo: "root-1", subject: "S" });
		const dupe = frame("b", ["a"], "identical payload", { inReplyTo: "root-1", subject: "S" });
		dupe.ts = new Date(Date.parse(prior.ts) + 5_000).toISOString(); // 5s later
		deliverMail(root, "a", prior);
		expect(duplicateOf(root, "a", dupe, 120_000)?.id).toBe(prior.id);
	});

	it("no match outside the window, for a different body, or from a different sender", () => {
		const prior = frame("b", ["a"], "payload one");
		deliverMail(root, "a", prior);

		const late = frame("b", ["a"], "payload one");
		late.ts = new Date(Date.parse(prior.ts) + 10 * 60_000).toISOString();
		expect(duplicateOf(root, "a", late, 120_000)).toBeUndefined();

		const other = frame("b", ["a"], "different body");
		expect(duplicateOf(root, "a", other, 120_000)).toBeUndefined();

		const otherFrom = frame("c", ["a"], "payload one");
		expect(duplicateOf(root, "a", otherFrom, 120_000)).toBeUndefined();
	});

	it("suppressed duplicates are marked answered by the delivery layer, never pending", () => {
		const prior = frame("b", ["a"], "please answer");
		deliverMail(root, "a", prior);
		markDelivered(root, "a", [prior.id]);
		const dupe = frame("b", ["a"], "please answer");
		dupe.ts = new Date(Date.parse(prior.ts) + 3_000).toISOString();
		deliverMail(root, "a", dupe);
		markDelivered(root, "a", [dupe.id]);
		// Session-layer dedupe: the dupe never reaches the agent, so the delivery
		// layer marks it answered (see deliverPending) — otherwise a suppressed
		// retry would resurface as a pending reminder for unseen mail.
		markAnswered(root, "a", [prior.id, dupe.id]);
		expect(pendingFor(root, "a", "a")).toHaveLength(0);
	});
});
