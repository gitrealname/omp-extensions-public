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
		session.maybeActivateByPhrase("mail helper ping them");
		await new Promise(r => setTimeout(r, 20));
		expect(injections.some(i => i.opts.customType === "agent-hub-msg-instructions")).toBe(true);
	});
});
