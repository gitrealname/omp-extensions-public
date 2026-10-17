import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deliverMail, markDelivered, type MailFrame } from "../core/mailbox";
import { HubSession } from "../core/session";

// Extension root — the real instructions file is loaded from here.
const EXT_DIR = path.resolve(import.meta.dir, "..");

let root: string;

beforeEach(() => {
	root = path.join(os.tmpdir(), `agent-hub-msg-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const SID = "0197aaaaaaaa7ff1c00000000001";
const PEER = "0197aaaaaaaa7ff2c00000000002";

interface Injected {
	content: string;
	opts: { customType: string; display: boolean; triggerTurn?: boolean };
}

function makeSession(overrides: { env?: Record<string, string>; activateTools?: () => Promise<void> } = {}) {
	const injections: Injected[] = [];
	const envTable = overrides.env ?? {};
	const session = new HubSession({
		root,
		cwd: "C:/w/a",
		instructionsDir: EXT_DIR,
		env: name => envTable[name],
		inject: (content, opts) => injections.push({ content, opts }),
		activateTools: overrides.activateTools ?? (async () => {}),
	});
	session.attach(SID);
	session.register();
	return { session, injections };
}

const deliverToMe = (from: string, body: string, extra: Partial<MailFrame> = {}): MailFrame => {
	const frame: MailFrame = { id: `m${Math.random().toString(36).slice(2, 10)}`, ts: new Date().toISOString(), from, to: [SID], body, ...extra };
	deliverMail(root, SID, frame);
	markDelivered(root, SID, [frame.id]);
	return frame;
};

describe("HubSession pending reminders", () => {
	it("no pending mail → reminder is a no-op", async () => {
		const { session, injections } = makeSession();
		await session.remindPending();
		expect(injections).toHaveLength(0);
	});

	it("delivered-but-unanswered mail → reminder injected with triggerTurn", async () => {
		const { session, injections } = makeSession();
		const mail = deliverToMe(PEER, "please answer this");
		await session.remindPending();
		// First contact: instructions + reminder.
		const reminders = injections.filter(i => i.opts.customType === "agent-hub-msg-reminder");
		expect(reminders).toHaveLength(1);
		expect(reminders[0].opts.triggerTurn).toBe(true);
		expect(reminders[0].content).toContain(mail.id);
		expect(reminders[0].content).toContain("please answer this");
		expect(reminders[0].content).toContain("without an answer");
	});

	it("replyMail clears pending; ack frames never trigger reminders", async () => {
		const { session, injections } = makeSession();
		const mail = deliverToMe(PEER, "needs an answer");
		const { replyMail } = await import("../core/api");
		replyMail(root, { sid: SID }, { id: mail.id, body: "here is the answer" });
		await session.remindPending();
		expect(injections).toHaveLength(0);

		const ack = deliverToMe(PEER, "ok", { ack: true, inReplyTo: mail.id });
		await session.remindPending();
		expect(injections).toHaveLength(0);
		expect(ack.ack).toBe(true);
	});

	it("multiple pending items are capped and listed as previews", async () => {
		const { session, injections } = makeSession();
		const frames = Array.from({ length: 3 }, (_, i) => deliverToMe(PEER, `question number ${i}: ${"x".repeat(200)}`));
		await session.remindPending();
		const reminders = injections.filter(i => i.opts.customType === "agent-hub-msg-reminder");
		expect(reminders).toHaveLength(1);
		for (const f of frames) expect(reminders[0].content).toContain(f.id);
		expect(reminders[0].content).toContain("msg_read for full text");
	});

	it("MSG_REMIND=off disables reminders", async () => {
		const { session, injections } = makeSession({ env: { MSG_REMIND: "off" } });
		deliverToMe(PEER, "unanswered");
		await session.remindPending();
		expect(injections).toHaveLength(0);
	});

	it("reinjectAfterCompact re-injects instructions and reminds; dormant session no-ops", async () => {
		const dormant = makeSession();
		dormant.session.reinjectAfterCompact();
		expect(dormant.injections).toHaveLength(0);

		const { session, injections } = makeSession();
		await session.activate(false); // first contact: tools + instructions
		const instructionsCount = injections.filter(i => i.opts.customType === "agent-hub-msg-instructions").length;
		expect(instructionsCount).toBe(1);

		deliverToMe(PEER, "pending work");
		session.reinjectAfterCompact();
		await new Promise(r => setTimeout(r, 50));
		const after = injections.filter(i => i.opts.customType === "agent-hub-msg-instructions").length;
		expect(after).toBe(2); // force re-injected
		expect(injections.some(i => i.opts.customType === "agent-hub-msg-reminder")).toBe(true);

		// Registry must record the instructed flag for restore sessions.
		const reg = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf-8")) as Record<string, { instructed: boolean }>;
		expect(reg[SID].instructed).toBe(true);
	});
});

describe("review hardening", () => {
	it("deliverPending is reentrancy-safe during activation (no double injection)", async () => {
		let releaseActivate: (() => void) | undefined;
		const { session, injections } = makeSession({
			activateTools: () => new Promise<void>(r => { releaseActivate = r; }),
		});
		// Deliver WITHOUT marking read — the delivery loop's own backlog.
		const deliverOnly = (body: string): MailFrame => {
			const f: MailFrame = { id: `m${Math.random().toString(36).slice(2, 10)}`, ts: new Date().toISOString(), from: PEER, to: [SID], body };
			deliverMail(root, SID, f);
			return f;
		};
		const a = deliverOnly("one");
		const b = deliverOnly("two");
		// Two entry paths race while activation is in flight.
		const p1 = session.deliverPending();
		const p2 = session.deliverPending();
		await new Promise(r => setTimeout(r, 10));
		releaseActivate!();
		await Promise.all([p1, p2]);
		const deliveries = injections.filter(i => i.opts.customType === "agent-hub-msg");
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].content).toContain(a.id);
		expect(deliveries[0].content).toContain(b.id);
	});

	it("malformed MSG_POLL_MS/MSG_KEEPALIVE_MS fall back to defaults", () => {
		const { session } = makeSession({ env: { MSG_POLL_MS: "15s", MSG_KEEPALIVE_MS: "abc" } });
		const s = session as unknown as { pollMs: number; keepaliveEvery: number };
		expect(s.pollMs).toBe(15_000);
		expect(s.keepaliveEvery).toBe(4);
	});

	it("activation phrase requires a resolvable target", async () => {
		const { session, injections } = makeSession();
		session.maybeActivateByPhrase("check the mail server logs for errors");
		session.maybeActivateByPhrase("rename the msg handler");
		await new Promise(r => setTimeout(r, 20));
		expect(injections).toHaveLength(0);

		const { setUserAlias } = await import("../core/api");
		setUserAlias(root, SID, "helper");
		session.maybeActivateByPhrase("Mail helper ping them"); // capitalized — activation is case-insensitive
		await new Promise(r => setTimeout(r, 20));
		expect(injections.some(i => i.opts.customType === "agent-hub-msg-instructions")).toBe(true);
	});
});

describe("duplicate-delivery guard", () => {
	it("a retried send (same content, fresh id) is marked delivered silently, never injected", async () => {
		const { session, injections } = makeSession();
		const first = deliverToMe(PEER, "handoff payload");
		await session.deliverPending(); // backlog path? no — first is already marked read; force unread
		// deliverToMe marks read; simulate the retry arriving AFTER delivery.
		const retry: MailFrame = {
			id: `m${Math.random().toString(36).slice(2, 10)}`,
			ts: new Date(Date.parse(first.ts) + 2_000).toISOString(),
			from: PEER,
			to: [SID],
			body: "handoff payload",
			subject: first.subject,
			inReplyTo: first.inReplyTo,
		};
		deliverMail(root, SID, retry); // unread
		const before = injections.filter(i => i.opts.customType === "agent-hub-msg").length;
		await session.deliverPending();
		const deliveries = injections.filter(i => i.opts.customType === "agent-hub-msg");
		expect(deliveries.length).toBe(before);
		expect(deliveries.some(d => d.content.includes("handoff payload") && d.content.includes(retry.id))).toBe(false);
	});

	it("a genuinely new message with the same subject still delivers", async () => {
		const { session, injections } = makeSession();
		deliverToMe(PEER, "first message");
		const next: MailFrame = {
			id: `m${Math.random().toString(36).slice(2, 10)}`,
			ts: new Date().toISOString(),
			from: PEER,
			to: [SID],
			body: "a completely different question",
		};
		deliverMail(root, SID, next);
		await session.deliverPending();
		expect(injections.filter(i => i.opts.customType === "agent-hub-msg")).toHaveLength(1);
	});
});

describe("instruction drift refresh", () => {
	it("poll tick re-injects when the instructions file changes", async () => {
		const { session, injections } = makeSession();
		await session.activate(false);
		expect(injections.filter(i => i.opts.customType === "agent-hub-msg-instructions")).toHaveLength(1);

		// Edit the file the way a user would; private API, same as a poll tick.
		const { instructionsPath } = await import("../core/instructions");
		const file = instructionsPath(EXT_DIR);
		const original = fs.readFileSync(file, "utf-8");
		try {
			fs.writeFileSync(file, `${original}\n<!-- drift marker -->\n`, "utf-8");
			await (session as unknown as { refreshInstructionsIfChanged(): Promise<void> }).refreshInstructionsIfChanged();
			const counts = injections.filter(i => i.opts.customType === "agent-hub-msg-instructions");
			expect(counts.length).toBe(2);
			expect(counts[1].content).toContain("drift marker");
		} finally {
			fs.writeFileSync(file, original, "utf-8");
		}
	});
});

describe("roster dedupe", () => {
	it("unchanged roster text is not re-injected; change re-injects", () => {
		const { session } = makeSession();
		session.register();
		const first = session.listText();
		expect(first.changed).toBe(true);
		const second = session.listText();
		expect(second.changed).toBe(false);
		expect(second.text).toBe(first.text);

		// A new registration changes the roster → injected again.
		const { registerSession } = require("../core/registry") as typeof import("../core/registry");
		registerSession(root, "0197aaaaaaaa7ff9c00000000009", { pid: 1, cwd: "C:/w/b", machine: "m" });
		const third = session.listText();
		expect(third.changed).toBe(true);
	});
});

describe("stale-thread split", () => {
	const deliverOnly = (body: string, extra: Partial<MailFrame> = {}): MailFrame => {
		const f: MailFrame = { id: `m${Math.random().toString(36).slice(2, 10)}`, ts: new Date().toISOString(), from: PEER, to: [SID], body, ...extra };
		deliverMail(root, SID, f);
		return f;
	};
	const answeredIds = (): Set<string> => {
		const state = JSON.parse(fs.readFileSync(path.join(root, "inboxes", SID, "state.json"), "utf-8")) as { answeredIds: string[] };
		return new Set(state.answeredIds);
	};

	it("a thread with no activity in the window is delivered inert: shown, never woken, answered", async () => {
		const { session, injections } = makeSession();
		const old = deliverOnly("stale work request", { ts: new Date(Date.now() - 4 * 60 * 60_000).toISOString() });
		await session.deliverPending();
		const hot = injections.filter(i => i.opts.customType === "agent-hub-msg");
		expect(hot).toHaveLength(0); // no wake, no work
		const inert = injections.filter(i => i.opts.customType === "agent-hub-msg-stale");
		expect(inert).toHaveLength(1);
		expect(inert[0].opts.triggerTurn).toBe(false);
		expect(inert[0].content).toContain(old.id);
		expect(inert[0].content).toContain("STALE");
		expect(answeredIds()).toContain(old.id); // never resurfaces as a reminder
	});

	it("a fresh reply keeps the whole thread hot — old frame in it delivers normally", async () => {
		const { session, injections } = makeSession();
		const old = deliverOnly("old question", { ts: new Date(Date.now() - 5 * 60 * 60_000).toISOString() });
		const fresh = deliverOnly("and my follow-up", { inReplyTo: old.id }); // thread active now
		await session.deliverPending();
		const hot = injections.filter(i => i.opts.customType === "agent-hub-msg");
		expect(hot).toHaveLength(1);
		expect(hot[0].opts.triggerTurn).toBe(true);
		expect(hot[0].content).toContain(old.id);
		expect(hot[0].content).toContain(fresh.id);
		expect(injections.some(i => i.opts.customType === "agent-hub-msg-stale")).toBe(false);
	});

	it("more than 10 stale frames: newest 10 shown inert, rest collapse into a digest line", async () => {
		const { session, injections } = makeSession();
		const frames = Array.from({ length: 12 }, (_, i) =>
			deliverOnly(`stale item ${i}`, { ts: new Date(Date.now() - (5 + i) * 60 * 60_000).toISOString() }),
		);
		await session.deliverPending();
		const inert = injections.filter(i => i.opts.customType === "agent-hub-msg-stale");
		expect(inert).toHaveLength(1);
		const shown = frames.slice(0, 10); // newest first
		const hidden = frames.slice(10);
		for (const f of shown) expect(inert[0].content).toContain(f.id);
		for (const f of hidden) expect(inert[0].content).not.toContain(f.id);
		expect(inert[0].content).toContain("2 older stale messages suppressed");
		const answered = answeredIds();
		for (const f of frames) expect(answered).toContain(f.id); // suppressed too — never nag
	});

	it("MSG_STALE_ACT_MS=0 disables the split — everything delivers hot", async () => {
		const { session, injections } = makeSession({ env: { MSG_STALE_ACT_MS: "0" } });
		deliverOnly("ancient request", { ts: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString() });
		await session.deliverPending();
		expect(injections.filter(i => i.opts.customType === "agent-hub-msg")).toHaveLength(1);
		expect(injections.some(i => i.opts.customType === "agent-hub-msg-stale")).toBe(false);
	});
});
