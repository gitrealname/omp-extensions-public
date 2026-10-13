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
	});

	it("flags deep threads", () => {
		const deep = frame("a", ["me"], "hi", { hops: 6 });
		const text = formatBundle({ from: "a", frames: [deep] }, f => f.body, s => s);
		expect(text).toContain("deep thread");
	});
});
