import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { batchBySender, formatBundle, nextHops, type Bundle } from "../core/deliver";
import { resolveBody, spoolBody, type MailFrame } from "../core/mailbox";

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

describe("batchBySender", () => {
	it("groups consecutive same-sender frames; distinct senders separate", () => {
		const bundles = batchBySender([frame("a", ["me"]), frame("a", ["me"]), frame("b", ["me"]), frame("a", ["me"])]);
		expect(bundles.map(b => [b.from, b.frames.length])).toEqual([
			["a", 2],
			["b", 1],
			["a", 1],
		]);
	});

	it("empty input → no bundles", () => {
		expect(batchBySender([])).toEqual([]);
	});
});

describe("nextHops", () => {
	it("increments from parent; root starts at 1", () => {
		expect(nextHops(undefined)).toBe(1);
		expect(nextHops({ ...frame("a", ["b"]), hops: 3 })).toBe(4);
	});
});

describe("formatBundle", () => {
	it("splices full spooled bodies and labels the sender by alias", () => {
		const spooled = spoolBody(root, "spool1", "x".repeat(400));
		const f1 = frame("sid-alpha", ["me"], spooled.body, { fromAlias: "alpha", ...(spooled.bodyFile ? { bodyFile: spooled.bodyFile } : {}) });
		const f2 = frame("sid-alpha", ["me"], "short one", { fromAlias: "alpha", inReplyTo: f1.id });
		const bundle: Bundle = { from: "sid-alpha", frames: [f1, f2] };
		const text = formatBundle(
			bundle,
			f => resolveBody(root, f),
			sid => (sid === "sid-alpha" ? "alpha" : sid),
		);
		expect(text).toContain("x".repeat(400)); // full body spliced in
		expect(text).toContain("short one");
		expect(text).toContain("mail from alpha (sid-alpha)");
		expect(text).toContain("from alpha");
		expect(text).toContain(`id: ${f1.id}`);
		expect(text).toContain("(re:");
		expect(text).toContain("reply with msg_reply using the id");
		expect(text).toMatch(/\[etiquette v\d+\]/); // envelope stamps the etiquette version
	});

	it("reply: field — ack and FYI flag none, deep threads flag user-only, plain mail omits it", () => {
		const ack = frame("a", ["me"], "ack", { ack: true });
		const ackText = formatBundle({ from: "a", frames: [ack] }, f => f.body, s => s);
		expect(ackText).toContain("reply: none — ack closes the thread");

		const fyi = frame("a", ["me"], "the numbers", { subject: "FYI: census" });
		const fyiText = formatBundle({ from: "a", frames: [fyi] }, f => f.body, s => s);
		expect(fyiText).toContain("reply: none — FYI");

		const deep = frame("a", ["me"], "hi", { hops: 6 });
		const deepText = formatBundle({ from: "a", frames: [deep] }, f => f.body, s => s);
		expect(deepText).toContain("reply: user-only — deep thread");

		const plain = frame("a", ["me"], "a question");
		const plainText = formatBundle({ from: "a", frames: [plain] }, f => f.body, s => s);
		expect(plainText).not.toContain("reply:");
		expect(plainText).toContain("reply with msg_reply"); // trailer still teaches the default
	});

	it("subject renders as its own bold line between header and body; absent subject skips it", () => {
		const f = frame("a", ["me"], "the body text", { subject: "merge check", inReplyTo: "mRoot99" });
		const text = formatBundle({ from: "a", frames: [f] }, fr => fr.body, s => s);
		expect(text).toContain(`[mail from a (re: mRoot99) | id: ${f.id}]`); // threading stays in the header
		expect(text).toContain("**merge check**");
		expect(text.indexOf(`id: ${f.id}`)).toBeLessThan(text.indexOf("**merge check**"));
		expect(text.indexOf("**merge check**")).toBeLessThan(text.indexOf("the body text"));

		const plain = frame("a", ["me"], "no subject body");
		const plainText = formatBundle({ from: "a", frames: [plain] }, fr => fr.body, s => s);
		expect(plainText).not.toContain("**");
		expect(plainText).toContain("no subject body");
	});

	it("broadcast frames get a reply-to-sender-only suffix; direct frames do not advertise all=true", () => {
		const direct = frame("a", ["me"], "just you");
		const directText = formatBundle({ from: "a", frames: [direct] }, f => f.body, s => s);
		expect(directText).not.toContain("all=true");
		expect(directText).toContain("reply with msg_reply");

		const fanout = frame("a", ["me", "other1", "other2"], "to everyone");
		const broadcastText = formatBundle({ from: "a", frames: [fanout] }, f => f.body, s => s);
		expect(broadcastText).toContain("broadcast to 3 agents");
		expect(broadcastText).toContain("reply to the sender only, never all=true");

		const all = frame("a", ["all"], "to all");
		const allText = formatBundle({ from: "a", frames: [all] }, f => f.body, s => s);
		expect(allText).toContain("reply to the sender only");
	});
});
