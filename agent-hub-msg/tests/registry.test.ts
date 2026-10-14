import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addAlias,
	expandTo,
	heartbeat,
	isLive,
	listSessions,
	registerSession,
	resolveAddress,
	setInstructed,
	STALE_MS,
	withRegistryLock,
} from "../core/registry";

let root: string;

beforeEach(() => {
	root = path.join(os.tmpdir(), `agent-hub-msg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const meta = (pid: number, cwd = `C:/w/${pid}`) => ({ pid, cwd, machine: "test" });
const S = (n: number) => `0197aaaaaaaa7ff${n}c0000000000${n}`;

describe("registerSession", () => {
	it("registers and re-registration preserves aliases and registeredAt", () => {
		registerSession(root, S(1), meta(100));
		addAlias(root, S(1), "reviewer");
		const first = listSessions(root)[0];
		registerSession(root, S(1), meta(200));
		const again = listSessions(root)[0];
		expect(again.entry.aliases).toEqual(["reviewer"]);
		expect(again.entry.registeredAt).toBe(first.entry.registeredAt);
		expect(again.entry.pid).toBe(200);
	});

	it("never evicts: a stale entry stays listed, shown offline", () => {
		registerSession(root, S(1), meta(100));
		const stale = listSessions(root)[0];
		// Rewind lastSeen beyond the stale threshold.
		const raw = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf-8"));
		raw[S(1)].lastSeen = Date.now() - STALE_MS - 1000;
		fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify(raw));
		const rows = listSessions(root);
		expect(rows).toHaveLength(1);
		expect(rows[0].live).toBe(false);
		expect(isLive(stale.entry)).toBe(true); // fresh entry is live
	});
});

describe("heartbeat", () => {
	it("refreshes lastSeen; unknown session reports false", () => {
		registerSession(root, S(1), meta(100));
		const before = listSessions(root)[0].entry.lastSeen;
		expect(heartbeat(root, S(2))).toBe(false);
		const ok = heartbeat(root, S(1));
		expect(ok).toBe(true);
		expect(listSessions(root)[0].entry.lastSeen).toBeGreaterThanOrEqual(before);
	});
});

describe("addAlias", () => {
	it("adds multiple aliases, case-insensitive dedupe", () => {
		registerSession(root, S(1), meta(100));
		addAlias(root, S(1), "reviewer");
		const again = addAlias(root, S(1), "REVIEWER");
		expect(again.aliases).toEqual(["reviewer"]);
		expect(addAlias(root, S(1), "architect").aliases).toEqual(["reviewer", "architect"]);
	});

	it("warns on a duplicate label owned by another session", () => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		addAlias(root, S(1), "reviewer");
		const res = addAlias(root, S(2), "reviewer");
		expect(res.conflict).toContain(S(1));
	});
});

describe("setInstructed", () => {
	it("persists the instructed flag", () => {
		registerSession(root, S(1), meta(100));
		expect(listSessions(root)[0].entry.instructed).toBe(false);
		setInstructed(root, S(1), true);
		expect(listSessions(root)[0].entry.instructed).toBe(true);
	});
});

describe("resolveAddress", () => {
	beforeEach(() => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		addAlias(root, S(2), "reviewer");
	});

	it("resolves full sid, unique prefix, and alias", () => {
		expect(resolveAddress(root, S(1)).address?.sid).toBe(S(1));
		expect(resolveAddress(root, S(1).slice(0, 16)).address?.sid).toBe(S(1));
		expect(resolveAddress(root, "REVIEWER").address?.sid).toBe(S(2));
	});

	it("rejects unknown, empty, and ambiguous prefixes", () => {
		expect(resolveAddress(root, "nope").error).toBeDefined();
		expect(resolveAddress(root, "").error).toBeDefined();
		// S(1) and S(2) share long prefixes — make an ambiguous case:
		registerSession(root, `${S(1)}0`, meta(300));
		expect(resolveAddress(root, S(1).slice(0, 12)).error).toContain("ambiguous");
	});
});

describe("expandTo", () => {
	beforeEach(() => {
		registerSession(root, S(1), meta(100));
		registerSession(root, S(2), meta(200));
		registerSession(root, S(3), meta(300));
		addAlias(root, S(2), "reviewer");
	});

	it('"all" reaches only online sessions, never self', () => {
		// Make S(3) stale.
		const file = path.join(root, "registry.json");
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		raw[S(3)].lastSeen = Date.now() - STALE_MS - 1000;
		fs.writeFileSync(file, JSON.stringify(raw));
		const { to, skipped } = expandTo(root, "all", S(1));
		expect(to).toEqual([S(2)]);
		expect(skipped).toHaveLength(0);
	});

	it('"all" with nobody online reports skipped', () => {
		const file = path.join(root, "registry.json");
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		for (const sid of [S(2), S(3)]) raw[sid].lastSeen = Date.now() - STALE_MS - 1000;
		fs.writeFileSync(file, JSON.stringify(raw));
		const { to, skipped } = expandTo(root, "all", S(1));
		expect(to).toHaveLength(0);
		expect(skipped[0].reason).toContain("no other agents online");
	});

	it("direct keys address offline sessions; unknown keys are skipped", () => {
		const file = path.join(root, "registry.json");
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		raw[S(2)].lastSeen = Date.now() - STALE_MS - 1000; // dormant
		fs.writeFileSync(file, JSON.stringify(raw));
		const { to, skipped } = expandTo(root, `${S(2)}, ghost`, S(1));
		expect(to).toEqual([S(2)]); // dormant recipient still addressed
		expect(skipped).toEqual([{ key: "ghost", reason: expect.any(String) }]);
	});
});

describe("withRegistryLock", () => {
	it("runs the body and releases", () => {
		expect(withRegistryLock(root, () => 42)).toBe(42);
		expect(fs.existsSync(path.join(root, "registry.json.lock"))).toBe(false);
	});

	it("steals an abandoned (old) lock", () => {
		const lock = path.join(root, "registry.json.lock");
		fs.writeFileSync(lock, "");
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(lock, old, old);
		expect(withRegistryLock(root, () => "ok")).toBe("ok");
	});

	it("times out against a fresh foreign lock", () => {
		fs.writeFileSync(path.join(root, "registry.json.lock"), "");
		expect(() => withRegistryLock(root, () => "x")).toThrow(/timed out/);
	});
});

describe("registry hardening", () => {
	it("corrupt registry.json throws and is quarantined — never wiped", () => {
		registerSession(root, "0197aaaaaaaaaaaa0000000000aa", { cwd: "C:/w/a", pid: process.pid, machine: "test" });
		fs.writeFileSync(path.join(root, "registry.json"), "{not json", "utf-8");
		expect(() => registerSession(root, "0197aaaaaaaaaaaa0000000000bb", { cwd: "C:/w/a", pid: process.pid, machine: "test" })).toThrow(/corrupt/);
		const quarantined = fs.readdirSync(root).filter(f => f.includes(".corrupt"));
		expect(quarantined).toHaveLength(1);
		// Original corrupt file still present (not replaced by a 1-entry registry).
		expect(fs.readFileSync(path.join(root, "registry.json"), "utf-8")).toBe("{not json");
	});

	it("contested alias fails resolution instead of lastSeen-wins", () => {
		const cc = "0197aaaaaaaaaaaa0000000000cc";
		const dd = "0197aaaaaaaaaaaa0000000000dd";
		registerSession(root, cc, { cwd: "C:/w/a", pid: process.pid, machine: "test" });
		registerSession(root, dd, { cwd: "C:/w/a", pid: process.pid, machine: "test" });
		const dup = addAlias(root, dd, "shared"); // cc doesn't have it yet — succeeds
		expect(dup.conflict).toBeUndefined();
		addAlias(root, cc, "shared"); // second claim → conflict advisory
		// Simulate contention as it can actually exist (legacy data / tampered
		// registry): both entries carry the same alias.
		const regPath = path.join(root, "registry.json");
		const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
		reg[cc].aliases.push("shared");
		fs.writeFileSync(regPath, JSON.stringify(reg), "utf-8");
		const res = resolveAddress(root, "shared");
		expect(res.address).toBeUndefined();
		expect(res.error).toContain("contested");
	});

	it("lock file carries the owner pid; release deletes only the own marker", () => {
		registerSession(root, "0197aaaaaaaaaaaa0000000000ee", { cwd: "C:/w/a", pid: process.pid, machine: "test" });
		withRegistryLock(root, () => {
			const content = fs.readFileSync(path.join(root, "registry.json.lock"), "utf-8");
			expect(content).toBe(String(process.pid));
		});
		expect(fs.existsSync(path.join(root, "registry.json.lock"))).toBe(false);
	});
});
