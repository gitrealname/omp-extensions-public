/**
 * Alias handover tests: /msg alias <name> --force (forceAlias + mergeMailbox)
 * and /msg clear (clearAlias).
 *
 * Covers:
 *   - forceAlias takes the alias away from the old owner (single lock scope)
 *   - without an owner it behaves like addAlias
 *   - no-flag alias onto an owned alias still errors (the typo guard)
 *   - clearAlias empties the list; the alias becomes free for re-use
 *   - mergeMailbox moves frames id-unduped, merges state (max deliveredUpTo,
 *     union readIds/answeredIds capped at MAX_READ_IDS), removes the source
 *     inbox, and is idempotent on a second run
 *   - spooled bodies (shared files/) resolve after the move
 *   - api.setUserAlias(force=true) reports the move; setUserAlias without
 *     force reports the conflict hint
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearAlias,
	forceAlias,
	addAlias,
	listSessions,
	registerSession,
	resolveAddress,
} from "../core/registry";
import {
	deliverMail,
	mergeMailbox,
	readMailbox,
	readState,
	resolveBody,
	spoolBody,
	INLINE_MAX,
} from "../core/mailbox";
import { setUserAlias, clearUserAlias } from "../core/api";

let root: string;

beforeEach(() => {
	root = path.join(os.tmpdir(), `agent-hub-msg-alias-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const meta = (pid: number, cwd = `C:/w/${pid}`) => ({ pid, cwd, machine: "test" });
const S = (n: number) => `0197aaaaaaaa7ff${n}c0000000000${n}`;

function frame(id: string, from = S(9), to: string[] = [S(2)], body = `body ${id}`) {
	return { id, ts: "2026-10-21T12:00:00", from, to, body };
}

describe("forceAlias", () => {
	it("moves the alias off the old owner and clears their list", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		addAlias(root, S(1), "worker");

		const res = forceAlias(root, S(2), "worker");
		expect(res.movedFrom).toBe(S(1));
		expect(listSessions(root).find(r => r.sid === S(1))!.entry.aliases).toEqual([]);
		expect(listSessions(root).find(r => r.sid === S(2))!.entry.aliases).toEqual(["worker"]);
		// the alias resolves to the new owner now
		expect(resolveAddress(root, "worker", S(9)).address?.sid).toBe(S(2));
	});

	it("behaves like addAlias when nobody owns the alias", () => {
		registerSession(root, S(2), meta(200));
		const res = forceAlias(root, S(2), "fresh");
		expect(res.movedFrom).toBeUndefined();
		expect(res.aliases).toEqual(["fresh"]);
	});

	it("no-flag alias onto an owned alias still errors (typo guard)", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		addAlias(root, S(1), "worker");
		const res = addAlias(root, S(2), "worker");
		expect(res.conflict).toContain("contested");
	});

	it("clearAlias empties the list and frees the alias", () => {
		registerSession(root, S(1), meta(100));
		addAlias(root, S(1), "worker");
		clearAlias(root, S(1));
		expect(listSessions(root).find(r => r.sid === S(1))!.entry.aliases).toEqual([]);
		registerSession(root, S(2), meta(200));
		addAlias(root, S(2), "worker"); // no contest now
		expect(resolveAddress(root, "worker", S(9)).address?.sid).toBe(S(2));
	});
});

describe("mergeMailbox", () => {
	it("moves frames, merges state, removes the source inbox", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		deliverMail(root, S(1), frame("m-1"));
		deliverMail(root, S(1), frame("m-2"));
		// target already has one frame + its own state
		deliverMail(root, S(2), frame("m-0"));
		deliverMail(root, S(2), frame("m-1")); // duplicate id -> skipped
		const st1 = { deliveredUpTo: 1, readIds: ["m-1"], answeredIds: ["m-1"] };
		fs.writeFileSync(path.join(root, "inboxes", S(1), "state.json"), JSON.stringify(st1));

		const res = mergeMailbox(root, S(1), S(2));
		expect(res).toEqual({ moved: 1, skipped: 1 });

		const { frames } = readMailbox(root, S(2));
		expect(frames.map(f => f.id)).toEqual(["m-0", "m-1", "m-2"]);
		const st = readState(root, S(2));
		expect(st.deliveredUpTo).toBe(1);
		expect(st.readIds).toContain("m-1");
		expect(st.answeredIds).toContain("m-1");
		// source inbox removed (move semantics)
		expect(fs.existsSync(path.join(root, "inboxes", S(1)))).toBe(false);
	});

	it("is idempotent: a second run moves nothing", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		deliverMail(root, S(1), frame("m-1"));
		mergeMailbox(root, S(1), S(2));
		const again = mergeMailbox(root, S(1), S(2));
		expect(again).toEqual({ moved: 0, skipped: 0 });
	});

	it("spooled bodies resolve after the move (shared files/ dir)", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		const long = "x".repeat(INLINE_MAX + 10);
		const spooled = spoolBody(root, "m-big", long);
		deliverMail(root, S(1), { ...frame("m-big"), ...spooled });

		mergeMailbox(root, S(1), S(2));
		const { indexById } = readMailbox(root, S(2));
		const f = readMailbox(root, S(2)).frames[indexById.get("m-big")!];
		expect(resolveBody(root, f)).toBe(long);
	});

	it("caps merged read state at MAX_READ_IDS", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		const old = Array.from({ length: 1200 }, (_, i) => `old-${i}`);
		fs.mkdirSync(path.join(root, "inboxes", S(1)), { recursive: true });
		fs.writeFileSync(
			path.join(root, "inboxes", S(1), "state.json"),
			JSON.stringify({ deliveredUpTo: 0, readIds: old, answeredIds: [] }),
		);
		mergeMailbox(root, S(1), S(2));
		const st = readState(root, S(2));
		expect(st.readIds.length).toBe(1000);
		expect(st.readIds[st.readIds.length - 1]).toBe("old-1199"); // newest kept
	});
});

describe("api surface", () => {
	it("setUserAlias force=true reports the move and merges the mailbox", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		addAlias(root, S(1), "worker");
		deliverMail(root, S(1), frame("m-1"));

		const res = setUserAlias(root, S(2), "worker", true);
		expect(res.text).toContain("moved from");
		expect(res.text).toContain("1 frame(s) moved");
		expect(resolveAddress(root, "worker", S(9)).address?.sid).toBe(S(2));
		expect(readMailbox(root, S(2)).frames.map(f => f.id)).toContain("m-1");
	});

	it("setUserAlias without force suggests --force on conflict", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		addAlias(root, S(1), "worker");
		const res = setUserAlias(root, S(2), "worker");
		expect(res.details?.conflict).toBeTruthy();
		expect(res.text).toContain("--force");
	});

	it("clearUserAlias reports the cleared state", () => {
		registerSession(root, S(1), meta(100));
		addAlias(root, S(1), "worker");
		const res = clearUserAlias(root, S(1));
		expect(res.text).toContain("cleared");
	});
});


// ---- /msg clear <target> (other sessions) -----------------------------------

import { formatRoster, ROSTER_OFFLINE_SHOWN } from "../core/api";

describe("clearUserAlias with a target", () => {
	it("clears another session's alias by prefix", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		addAlias(root, S(1), "worker");
		const res = clearUserAlias(root, S(2), S(1).slice(0, 16));
		expect(res.text).toContain("alias cleared");
		expect(resolveAddress(root, "worker", S(9)).address).toBeUndefined();
	});

	it("clears another session's alias by alias name (dead session cleanup)", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		addAlias(root, S(1), "ghost");
		const res = clearUserAlias(root, S(2), "ghost");
		expect(res.text).toContain("alias cleared (was ghost)");
		expect(resolveAddress(root, "ghost", S(9)).address).toBeUndefined();
	});

	it("unknown target reports the resolver error", () => {
		registerSession(root, S(1), meta(100));
		const res = clearUserAlias(root, S(1), "nobody-here");
		expect(res.text).toContain("no such agent");
	});

	it("target == me clears my own alias (same as bare form)", () => {
		registerSession(root, S(1), meta(100));
		addAlias(root, S(1), "worker");
		const res = clearUserAlias(root, S(1), S(1));
		expect(res.text).toContain("cleared");
	});
});

// ---- roster rendering (shared by /msg list and msg_who) ---------------------

describe("formatRoster", () => {
	const OFFLINE_MS = 10 * 60 * 1000; // > STALE_MS (5 min) => offline

	function seed() {
		// aliased: S(3) older, S(2) newer  -> S(2) first on top
		registerSession(root, S(2), meta(200), 1000);
		addAlias(root, S(2), "worker", 2000);
		registerSession(root, S(3), meta(300), 500);
		addAlias(root, S(3), "old", 1000);
		// live bare
		registerSession(root, S(1), meta(100), Date.now());
		// offline bare: 7 sessions -> only ROSTER_OFFLINE_SHOWN visible
		for (let i = 4; i <= 10; i++) registerSession(root, S(i), meta(i * 10), Date.now() - OFFLINE_MS - i * 1000);
	}

	it("puts aliased sessions on top, most recent activity first", () => {
		seed();
		const text = formatRoster(root, { full: true });
		const lines = text.split("\n").filter(l => l.startsWith("0197"));
		expect(lines[0]).toContain("[worker]");           // S(2): newest aliased
		expect(lines[1]).toContain("[old]");              // S(3): older aliased
		expect(lines.indexOf(lines.find(l => l.includes("[worker]"))!))
			.toBeLessThan(lines.indexOf(lines.find(l => l.includes("(C:/w/100)")!)));
	});

	it("caps the dormant tail and reports the hidden count", () => {
		seed();
		const text = formatRoster(root, {});
		const lines = text.split("\n");
		const offlineRows = lines.filter(l => l.startsWith("0197") && l.includes("(offline")).length;
		expect(offlineRows).toBe(ROSTER_OFFLINE_SHOWN);
		expect(text).toContain("+ 2 dormant (offline) hidden");
	});

	it("full=true lists everything (no hidden line)", () => {
		seed();
		const text = formatRoster(root, { full: true });
		expect(text).not.toContain("dormant (offline) hidden");
	});

	it("viewer is excluded from the rows", () => {
		seed();
		const text = formatRoster(root, { viewerSid: S(2), full: true });
		expect(text).not.toContain("[worker]");
		expect(text).toContain("[old]");
	});
});
