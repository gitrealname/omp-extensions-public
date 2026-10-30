/**
 * Reply-addressing hardening tests:
 *   - replyMail follows the sender alias's CURRENT holder (fork handover) —
 *     a frame from a stale sid routes to the new owner, with a rerouted note
 *   - reply-all keeps other thread members literal; only the sender slot reroutes
 *   - liveness notice: replying to / sending to a registered-but-offline sid
 *     appends "registered but offline 5m+" instead of failing silently
 *   - anchor names the reply parameter (deliver.formatBundle v5)
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addAlias, listSessions, registerSession, heartbeat } from "../core/registry";
import { deliverMail, readMailbox, markDelivered, readState } from "../core/mailbox";
import { replyMail, sendMail } from "../core/api";
import { formatBundle, ETIQUETTE_VERSION, type Bundle } from "../core/deliver";
import type { MailFrame } from "../core/mailbox";

let root: string;

beforeEach(() => {
	root = path.join(os.tmpdir(), `agent-hub-msg-replyroute-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const meta = (pid: number, cwd = `C:/w/${pid}`) => ({ pid, cwd, machine: "test" });
// Distinct 36-char ULID-shaped sids (all hex chars, tail digits vary).
const S = (n: number) => `0197aaaaaaaa7ff${n}c0000000000${n}`;

function frame(id: string, from: string, to: string[], body = `body ${id}`, extra: Partial<MailFrame> = {}): MailFrame {
	return { id, ts: new Date().toISOString(), from, to, body, ...extra };
}

const OLD = S(1);
const NEW = S(2);
const ME = S(3);
const OFFLINE = S(4);

function questionFrom(oldSender: string, alias: string | undefined): MailFrame {
	const f = frame(`q-${oldSender.slice(-2)}`, oldSender, [ME], "what did you set up?");
	if (alias) f.fromAlias = alias;
	deliverMail(root, ME, f);
	markDelivered(root, ME, [f.id]);
	return f;
}

describe("replyMail alias-first addressing", () => {
	it("reroutes a stale-sid sender to the alias's current holder", () => {
		// Registry: both sessions registered; alias currently on NEW (post-handover).
		registerSession(root, OLD, meta(101));
		registerSession(root, NEW, meta(102));
		registerSession(root, ME, meta(103));
		addAlias(root, NEW, "researcher");

		const q = questionFrom(OLD, "researcher");
		const res = replyMail(root, { sid: ME }, { id: q.id, body: "answer" });

		// Delivered to the NEW holder, not the stale sid.
		expect(readMailbox(root, NEW).frames.some(f => f.body === "answer")).toBe(true);
		expect(readMailbox(root, OLD).frames.some(f => f.body === "answer")).toBe(false);
		// The result names the reroute.
		expect(res.text).toContain("rerouted:");
		expect(res.text).toContain("current holder of alias \"researcher\"");
		expect(res.details?.rerouted).toBeDefined();
		// Thread metadata preserved: re: points at the original id.
		const reply = readMailbox(root, NEW).frames.find(f => f.body === "answer")!;
		expect(reply.inReplyTo).toBe(q.id);
	});

	it("keeps a fresh-sid sender as-is (no reroute note)", () => {
		registerSession(root, NEW, meta(102));
		registerSession(root, ME, meta(103));
		addAlias(root, NEW, "researcher");

		const q = questionFrom(NEW, "researcher");
		const res = replyMail(root, { sid: ME }, { id: q.id, body: "answer" });

		expect(readMailbox(root, NEW).frames.some(f => f.body === "answer")).toBe(true);
		expect(res.text).not.toContain("rerouted:");
		expect(res.details?.rerouted).toBeUndefined();
	});

	it("reroute with no holder change falls back to the frame's from", () => {
		registerSession(root, OLD, meta(101));
		registerSession(root, ME, meta(103));
		// Alias was registered on OLD, then cleared — no current holder.
		registerSession(root, OLD, meta(101));
		addAlias(root, OLD, "researcher");
		addAlias(root, OLD, ""); // no-op guard; alias still on OLD
		// Simulate handover loss: force-own the alias on a third, unregistered sid is impossible;
		// instead remove the alias entirely to model "holder vanished".
		const { clearAlias } = require("../core/registry") as typeof import("../core/registry");
		clearAlias(root, OLD);

		const q = questionFrom(OLD, "researcher");
		const res = replyMail(root, { sid: ME }, { id: q.id, body: "answer" });

		// No holder → the frame's from is the best available address.
		expect(readMailbox(root, OLD).frames.some(f => f.body === "answer")).toBe(true);
		expect(res.text).not.toContain("rerouted:");
	});

	it("reply-all reroutes only the sender slot; other members stay literal", () => {
		const OTHER = S(5);
		registerSession(root, OLD, meta(101));
		registerSession(root, NEW, meta(102));
		registerSession(root, ME, meta(103));
		registerSession(root, OTHER, meta(105));
		addAlias(root, NEW, "researcher");

		// Broadcast question from OLD to ME + OTHER.
		const bc = frame("q-bc", OLD, [ME, OTHER], "broadcast question");
		bc.fromAlias = "researcher";
		deliverMail(root, ME, bc);
		markDelivered(root, ME, [bc.id]);
		deliverMail(root, OTHER, bc);

		const res = replyMail(root, { sid: ME }, { id: bc.id, body: "answer to all", all: true });

		// Sender slot → NEW; other member → OTHER untouched.
		expect(readMailbox(root, NEW).frames.some(f => f.body === "answer to all")).toBe(true);
		expect(readMailbox(root, OTHER).frames.some(f => f.body === "answer to all")).toBe(true);
		expect(readMailbox(root, OLD).frames.some(f => f.body === "answer to all")).toBe(false);
		expect(res.text).toContain("rerouted:");
	});
});

describe("liveness notices", () => {
	it("reply to an offline-but-registered sender appends the offline note", () => {
		registerSession(root, OFFLINE, meta(104));
		registerSession(root, ME, meta(103));
		// Age the heartbeat past the liveness window.
		heartbeat(root, OFFLINE, Date.now() - 10 * 60 * 1000);

		const q = questionFrom(OFFLINE, undefined);
		const res = replyMail(root, { sid: ME }, { id: q.id, body: "answer" });

		expect(res.text).toContain("registered but offline 5m+");
		// Mail still queues — email-style.
		expect(readMailbox(root, OFFLINE).frames.some(f => f.body === "answer")).toBe(true);
	});

	it("fresh send to an offline sid appends the offline note", () => {
		registerSession(root, OFFLINE, meta(104));
		registerSession(root, ME, meta(103));
		heartbeat(root, OFFLINE, Date.now() - 10 * 60 * 1000);

		const res = sendMail(root, { sid: ME }, { to: OFFLINE, body: "ping" });
		expect(res.text).toContain("registered but offline 5m+");
	});

	it("live recipients produce no offline note", () => {
		registerSession(root, NEW, meta(102));
		registerSession(root, ME, meta(103));

		const res = sendMail(root, { sid: ME }, { to: NEW, body: "ping" });
		expect(res.text).not.toContain("offline");
	});
});

describe("envelope anchor names the reply parameter", () => {
	it("v5 anchor says msg_reply(id: <the id>)", () => {
		expect(ETIQUETTE_VERSION).toBe(5);
		const b: Bundle = { from: S(9), frames: [frame("m1", S(9), [ME], "hello")] };
		const text = formatBundle(b, f => f.body, sid => sid);
		expect(text).toContain(`[agent mail v5 — reply via msg_reply(id: <the id>)]`);
	});
});
