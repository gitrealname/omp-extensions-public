/**
 * agent-hub-msg registry — session-id keyed address book.
 *
 * Every participating omp session registers under its session id (the
 * address). Aliases are optional labels stored on the entry; addressing
 * accepts a session id (exact or unique prefix) or an alias.
 *
 * Entries are permanent — no eviction, ever. A session may restart days later
 * and expects its mailbox backlog and aliases intact. Online/offline is a
 * derived property of `lastSeen`, never a removal criterion.
 *
 * All mutations run under a lock file (create-exclusive + spin-wait, stolen
 * when abandoned) with read-modify-write inside. Writes land through a temp
 * file + rename, with brief retries for Windows rename-over-open-file races.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { validSid } from "./mailbox";

/** lastSeen older than this ⇒ shown offline (entry kept). */
export const STALE_MS = 5 * 60 * 1000;

export interface RegistryEntry {
	sid: string;
	pid: number;
	cwd: string;
	machine: string;
	registeredAt: string;
	lastSeen: number;
	/** User-set labels; multiple allowed. */
	aliases: string[];
	/** The LLM of this session has been given the messaging instructions. */
	instructed: boolean;
	/** Hash of the instructions text actually injected — drift baseline that
	 *  survives restarts (a restored instructed session compares against THIS,
	 *  not against the current file, so offline edits still re-inject once). */
	instructionsHash?: string;
}

export interface RegistryData {
	[sid: string]: RegistryEntry;
}

export function registryPath(root: string): string {
	return path.join(root, "registry.json");
}

export function isLive(entry: RegistryEntry, now = Date.now()): boolean {
	return now - entry.lastSeen < STALE_MS;
}

// ── Locking ──────────────────────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STEAL_MS = 5000;

function lockPath(root: string): string {
	return path.join(root, "registry.json.lock");
}

/**
 * Serialize `fn` against every other process mutating the registry. The lock
 * file is created exclusively (`wx`); a lock older than LOCK_STEAL_MS is
 * considered abandoned and stolen. Always releases in `finally`.
 */
export function withRegistryLock<T>(root: string, fn: () => T): T {
	fs.mkdirSync(root, { recursive: true });
	const lockFile = lockPath(root);
	const marker = `${process.pid}`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let fd: number | undefined;
	for (;;) {
		try {
			fd = fs.openSync(lockFile, "wx");
			try {
				fs.writeFileSync(lockFile, marker, "utf-8");
			} catch (err) {
				// Don't leak the fd or strand an empty lock file (e.g. ENOSPC).
				try {
					fs.closeSync(fd);
				} catch {}
				fd = undefined;
				try {
					fs.rmSync(lockFile, { force: true });
				} catch {}
				throw err;
			}
			break;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			let age = 0;
			try {
				age = Date.now() - fs.statSync(lockFile).mtimeMs;
			} catch {
				continue; // vanished — retry immediately
			}
			if (age > LOCK_STEAL_MS) {
				try {
					fs.rmSync(lockFile, { force: true });
				} catch {}
				continue;
			}
			if (Date.now() >= deadline) throw new Error("agent-hub-msg: registry lock timed out");
			const waitUntil = Date.now() + 10;
			while (Date.now() < waitUntil) {}
		}
	}
	try {
		return fn();
	} finally {
		try {
			if (fd !== undefined) fs.closeSync(fd);
		} catch {}
		// Delete only OUR lock: if a competitor already stole it (we slept past
		// LOCK_STEAL_MS), removing unconditionally would unlock THEIR section.
		try {
			if (fs.readFileSync(lockFile, "utf-8") === marker) fs.rmSync(lockFile, { force: true });
		} catch {}
	}
}

// ── Read / write ─────────────────────────────────────────────────────────────

function readRegistry(root: string): RegistryData {
	let text: string;
	try {
		text = fs.readFileSync(registryPath(root), "utf-8");
	} catch {
		return {}; // fresh root — no registry yet
	}
	try {
		return JSON.parse(text) as RegistryData;
	} catch (err) {
		// NEVER fall back to a writable empty registry: the next mutation would
		// atomically replace the file and silently erase every entry. Quarantine
		// the corrupt file (fixed name — a fresh copy per failing call would
		// accumulate on disk) and surface the failure instead.
		const quarantine = `${registryPath(root)}.corrupt`;
		try {
			fs.copyFileSync(registryPath(root), quarantine);
		} catch {}
		throw new Error(`agent-hub-msg: corrupt ${registryPath(root)} — quarantined as ${quarantine} (${(err as Error).message})`);
	}
}

function writeRegistry(root: string, data: RegistryData): void {
	fs.mkdirSync(root, { recursive: true });
	const tmp = `${registryPath(root)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, "\t") + "\n", "utf-8");
	const backoff = [25, 50, 100, 200, 400];
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tmp, registryPath(root));
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

// ── Mutations (each takes the lock) ──────────────────────────────────────────

export interface SessionMeta {
	pid: number;
	cwd: string;
	machine: string;
}

/**
 * Register (or re-register) a session. Preserves aliases, instructed flag, and
 * the original registeredAt across reboots/restore of the same session id.
 */
export function registerSession(root: string, sid: string, meta: SessionMeta, now = Date.now()): RegistryEntry {
	// The registry is writable by any local process — a sid key like "../evil"
	// would otherwise become an inboxDir path (directory escape).
	if (!validSid(sid)) throw new Error(`agent-hub-msg: invalid session id ${JSON.stringify(sid.slice(0, 80))}`);
	return withRegistryLock(root, () => {
		const data = readRegistry(root);
		const prev = data[sid];
		const entry: RegistryEntry = {
			sid,
			pid: meta.pid,
			cwd: meta.cwd,
			machine: meta.machine,
			registeredAt: prev?.registeredAt ?? new Date(now).toISOString(),
			lastSeen: now,
			aliases: prev?.aliases ?? [],
			instructed: prev?.instructed ?? false,
			instructionsHash: prev?.instructionsHash,
		};
		data[sid] = entry;
		writeRegistry(root, data);
		return entry;
	});
}

/** Refresh lastSeen. Creates nothing; a missing entry is a bug — re-register. */
export function heartbeat(root: string, sid: string, now = Date.now()): boolean {
	return withRegistryLock(root, () => {
		const data = readRegistry(root);
		const entry = data[sid];
		if (!entry) return false;
		entry.lastSeen = now;
		writeRegistry(root, data);
		return true;
	});
}

/** Add a user-set alias to a session. Returns the resulting alias list. */
export function addAlias(root: string, sid: string, alias: string, now = Date.now()): { aliases: string[]; conflict?: string } {
	return withRegistryLock(root, () => {
		const data = readRegistry(root);
		const entry = data[sid];
		if (!entry) throw new Error(`agent-hub-msg: session ${sid} is not registered`);
		const owner = Object.entries(data).find(([other, e]) => other !== sid && e.aliases.some(a => a.toLowerCase() === alias.toLowerCase()));
		if (owner) {
			// Duplicate labels are allowed (advisory only), but a contested alias
			// no longer resolves — resolveAddress fails until the conflict is
			// removed, so mail addressed by that alias goes nowhere instead of
			// to whichever session happened to heartbeat last.
			return { aliases: entry.aliases, conflict: `${alias} is also set on ${owner[0]} — contested alias does not resolve; use session ids` };
		}
		if (!entry.aliases.some(a => a.toLowerCase() === alias.toLowerCase())) entry.aliases.push(alias);
		entry.lastSeen = now;
		writeRegistry(root, data);
		return { aliases: entry.aliases };
	});
}

/** Set/unset the instructed flag (instructions injected into the LLM context). */
export function setInstructed(root: string, sid: string, value: boolean, now = Date.now(), instructionsHash?: string): void {
	withRegistryLock(root, () => {
		const data = readRegistry(root);
		const entry = data[sid];
		if (!entry) return;
		entry.instructed = value;
		if (instructionsHash !== undefined) entry.instructionsHash = instructionsHash;
		entry.lastSeen = now;
		writeRegistry(root, data);
	});
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface Address {
	sid: string;
	entry: RegistryEntry;
	live: boolean;
}

export interface SessionRow extends Address {}

export function listSessions(root: string, now = Date.now()): SessionRow[] {
	const data = readRegistry(root);
	return Object.values(data)
		.map(entry => ({ sid: entry.sid, entry, live: isLive(entry, now) }))
		.sort((a, b) => a.sid.localeCompare(b.sid));
}

/**
 * Resolve an address key: full session id, unique session-id prefix (≥4
 * chars), or alias (case-insensitive). Ties between duplicate aliases go to
 * the most-recently-seen session.
 */
export function resolveAddress(root: string, key: string, now = Date.now()): { address?: Address; error?: string } {
	const want = key.trim();
	if (!want) return { error: "empty address" };
	const sessions = listSessions(root, now);

	const bySid = sessions.find(r => r.sid === want);
	if (bySid) return { address: bySid };

	const lower = want.toLowerCase();
	const byAlias = sessions.filter(r => r.entry.aliases.some(a => a.toLowerCase() === lower));
	if (byAlias.length === 1) return { address: byAlias[0] };
	if (byAlias.length > 1) {
		// A contested alias must NOT resolve (lastSeen-wins would let whichever
		// session heartbeated last silently receive the victim's mail).
		const sids = byAlias.map(r => r.sid).join(", ");
		return { error: `alias "${want}" is contested between ${sids} — use session ids` };
	}

	if (want.length >= 4) {
		const byPrefix = sessions.filter(r => r.sid.startsWith(want));
		if (byPrefix.length === 1) return { address: byPrefix[0] };
		if (byPrefix.length > 1) return { error: `ambiguous address "${want}" — matches ${byPrefix.length} sessions` };
	}

	return { error: `no such agent "${key}" — use msg_who to list addresses` };
}

/**
 * Expand a recipient spec: comma/space-separated keys, or "all" — which
 * resolves to every OTHER currently-online session (dormant sessions must not
 * accumulate broadcast mail). Direct keys address offline sessions too
 * (mail queues, email-style).
 */
export function expandTo(root: string, spec: string, me: string, now = Date.now()): { to: string[]; skipped: { key: string; reason: string }[] } {
	const skipped: { key: string; reason: string }[] = [];
	let keys: string[];
	if (spec.trim().toLowerCase() === "all") {
		keys = listSessions(root, now)
			.filter(r => r.sid !== me && r.live)
			.map(r => r.sid);
		if (keys.length === 0) skipped.push({ key: "all", reason: "no other agents online" });
	} else {
		keys = spec.split(/[,\s]+/).filter(Boolean);
	}
	const to: string[] = [];
	for (const key of keys) {
		const r = resolveAddress(root, key, now);
		if (r.address && r.address.sid !== me) to.push(r.address.sid);
		else skipped.push({ key, reason: r.error ?? (r.address ? "that is you" : "unknown") });
	}
	return { to: [...new Set(to)], skipped };
}
