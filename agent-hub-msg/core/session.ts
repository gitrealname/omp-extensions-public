/**
 * agent-hub-msg core — HubSession.
 *
 * The harness-neutral session layer: identity, registration, the delivery
 * loop (poll + fs.watch fast-path + fast-follow), activation, and instruction
 * injection. Knows nothing about any agent harness — adapters supply an
 * `inject` callback and an optional `activateTools` hook; a CLI can drive the
 * same class headlessly.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { batchBySender, formatBundle, type Bundle } from "./deliver";
import { instructionsText, markInstructed, myself, pendingReminder, relativeAge, setUserAlias } from "./api";
import { listSessions, registerSession, resolveAddress, setInstructed, heartbeat as registryHeartbeat } from "./registry";
import { duplicateOf, markAnswered, markDelivered, readMailbox, resolveBody, setInlineMax, threadActivity, unreadFor } from "./mailbox";

/** Phrases in user input that activate the mail tools ("email" does not match).
 *  The keyword alone is not enough — the following token must RESOLVE to a
 *  registered session (alias or ≥4-char sid prefix) at activation time, so
 *  "check the mail server logs" never injects mail instructions, while
 *  "mail researcher ping them" does. */
export const ACTIVATE_RE = /\b(?:mail|msg)\b[,: ]+([A-Za-z0-9_.-]+)/i;

/** Max stale frames shown inert per delivery tick; older ones collapse into a digest line. */
export const MSG_STALE_SHOW = 10;

export interface InjectOptions {
	customType: string;
	display: boolean;
	triggerTurn?: boolean;
}

export interface HubSessionConfig {
	/** Mail root (e.g. ~/.omp/agent/msg). */
	root: string;
	cwd: string;
	machine?: string;
	pid?: number;
	/** Seed alias registered for this session (env MSG_ALIAS). */
	seedAlias?: string;
	/** Directory holding agent-hub-msg-llm-instructions.md. */
	instructionsDir: string;
	/** Environment lookup for the MSG_* knobs. */
	env: (name: string) => string | undefined;
	log?: (msg: string) => void;
	/** Deliver content into the agent's conversation (harness-specific). */
	inject: (content: string, opts: InjectOptions) => void;
	/** Bring the harness's mail tools into the active set. Called at most once. */
	activateTools?: () => Promise<void> | void;
}

export class HubSession {
	private readonly config: HubSessionConfig;
	private readonly pollMs: number;
	private readonly keepaliveEvery: number;
	private readonly fastFollowDelays: number[];

	private sid: string | undefined;
	private activated = false;
	private delivering = false;
	private stopped = false;
	private watcher: fs.FSWatcher | undefined;
	private watchDebounce: ReturnType<typeof setTimeout> | undefined;
	private readonly fastFollowTimers: ReturnType<typeof setTimeout>[] = [];
	private tickCount = 0;
	/** Hash of the instructions text at last injection — a changed file (user edit,
	 *  etiquette amendment) re-injects without waiting for compaction. */
	private lastInstructionsHash: string | undefined;
	/** Hash of the last injected roster — identical /msg list output is not re-injected. */
	private lastRosterHash: string | undefined;

	constructor(config: HubSessionConfig) {
		this.config = config;
		const env = config.env;
		// Malformed values must fall back to defaults: Number("15s") is NaN and
		// setTimeout(fn, NaN) fires immediately → hot poll loop, and a NaN
		// keepalive divisor means heartbeats never fire (session shows offline).
		const poll = Number(env("MSG_POLL_MS") ?? 15_000);
		this.pollMs = Number.isFinite(poll) && poll >= 1_000 ? poll : 15_000;
		const keepalive = Number(env("MSG_KEEPALIVE_MS") ?? 60_000);
		this.keepaliveEvery =
			Number.isFinite(keepalive) && keepalive >= 1_000 ? Math.max(1, Math.round(keepalive / this.pollMs)) : 4;
		const ff = (env("MSG_FAST_FOLLOW_MS") ?? "3000,6000,10000")
			.split(",")
			.map(s => Number(s.trim()))
			.filter(n => Number.isFinite(n) && n > 0);
		this.fastFollowDelays = ff;
		const inline = Number(env("MSG_INLINE_MAX"));
		if (Number.isFinite(inline)) setInlineMax(inline);
	}

	// ── Identity & registration ──────────────────────────────────────────────

	private get me(): { sid: string } {
		if (!this.sid) throw new Error("agent-hub-msg: session not registered yet (no session id)");
		return { sid: this.sid };
	}

	/** Attach a session id (from the harness's session context). Idempotent. */
	attach(sid: string): void {
		this.sid ??= sid;
	}

	get sessionId(): string | undefined {
		return this.sid;
	}

	/** Register (or re-register) this session; seeds the configured alias.
	 *  Never throws: event handlers call this synchronously, and a corrupt
	 *  registry must not crash the session start path. */
	register(): void {
		if (!this.sid) return;
		try {
			registerSession(this.config.root, this.sid, {
				pid: this.config.pid ?? process.pid,
				cwd: this.config.cwd,
				machine: this.config.machine ?? os.hostname(),
			});
			// Seed the env-configured alias only while the session has none:
			// setUserAlias REPLACES (one alias per session), so re-applying the
			// seed on every register() would silently clobber an alias the user
			// set later via /msg alias (surfaced by v18.12.2's settle-time
			// re-registration). Seeding is a fallback, not a policy.
			if (this.config.seedAlias && myself(this.config.root, this.sid).aliases.length === 0) {
				setUserAlias(this.config.root, this.sid, this.config.seedAlias);
			}
			this.config.log?.(`registered session ${this.sid} (root ${this.config.root})`);
		} catch (err) {
			this.config.log?.(`registration failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── Activation & instructions ────────────────────────────────────────────

	/** First-contact activation: tools on, instructions injected once. */
	async activate(force = false): Promise<void> {
		if (!this.activated) {
			await this.config.activateTools?.();
			this.activated = true;
		}
		await this.injectInstructions(force);
	}

	/** Inject the instructions file unless already instructed (force overrides). */
	async injectInstructions(force = false): Promise<void> {
		const { sid } = this.me;
		const me = myself(this.config.root, sid);
		const text = instructionsText(this.config.instructionsDir);
		const hash = hashOf(text);
		if (me.instructed && !force) {
			// Restored instructed session: its context already holds A rules
			// version — drift is measured against what was INJECTED (the
			// persisted hash), not against this boot's file. Restoring with an
			// unchanged file injects nothing; a file edited while offline
			// re-injects exactly once. Legacy entries without a persisted hash
			// adopt the current file as baseline (no duplicate injection).
			if (!this.lastInstructionsHash) this.lastInstructionsHash = me.instructionsHash ?? hash;
			return;
		}
		this.lastInstructionsHash = hash;
		this.config.inject(text, {
			customType: "agent-hub-msg-instructions",
			display: false,
		});
		markInstructed(this.config.root, sid, hash);
		this.config.log?.("instructions injected");
	}

	/**
	 * Re-inject when the instructions file changed since the last injection —
	 * amendments reach long-lived sessions without waiting for compaction.
	 * Amnesia cases (instructed=true but context lost the block) are covered by
	 * reinjectAfterCompact; this covers EDIT drift, the complement.
	 */
	private async refreshInstructionsIfChanged(): Promise<void> {
		if (!this.activated || !this.sid) return;
		try {
			const text = instructionsText(this.config.instructionsDir);
			const hash = hashOf(text);
			if (hash === this.lastInstructionsHash) return;
			await this.injectInstructions(true);
			this.config.log?.("instructions re-injected (file changed)");
		} catch (err) {
			this.config.log?.(`instruction refresh failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** User-input hook: activate on phrases ("mail <target> …"); failure is silent. */
	maybeActivateByPhrase(text: string): void {
		if (this.activated || !this.sid) return;
		const match = ACTIVATE_RE.exec(text ?? "");
		if (!match) return;
		// The token after the keyword must resolve to a real session — bare
		// "mail"/"msg" words in ordinary prose must not inject instructions.
		// Registry reads can throw (corrupt registry.json) — never crash the
		// input event handler for that.
		const target = match[1];
		let hit: ReturnType<typeof resolveAddress>["address"];
		try {
			hit = resolveAddress(this.config.root, target).address;
		} catch (err) {
			this.config.log?.(`activation address check failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (hit) {
			void this.activate(false).catch(err =>
				this.config.log?.(`activation failed: ${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	/** Post-compaction hook: re-inject instructions, then remind of pending mail. */
	reinjectAfterCompact(): void {
		if (!this.activated || !this.sid) return;
		void this.injectInstructions(true)
			.then(() => this.remindPending())
			.catch(() => {});
	}

	/**
	 * Delivered-but-unanswered mail: inject a reminder that wakes the agent up.
	 * No-op when nothing is pending or reminders are disabled (MSG_REMIND=off).
	 */
	async remindPending(): Promise<void> {
		if (this.stopped || !this.sid || this.config.env("MSG_REMIND")?.toLowerCase() === "off") return;
		const max = Number(this.config.env("MSG_REMIND_MAX") ?? 5);
		const reminder = pendingReminder(this.config.root, this.sid, Number.isFinite(max) ? max : 5);
		if (!reminder) return;
		// The agent needs the tools to answer — activate silently.
		if (!this.activated) await this.activate(false).catch(() => {});
		this.config.inject(reminder.text, { customType: "agent-hub-msg-reminder", display: true, triggerTurn: true });
		this.config.log?.(`reminder injected (${reminder.details?.count} pending)`);
	}

	// ── Delivery ─────────────────────────────────────────────────────────────

	/** Deliver pending unread mail as bundled turns; activates on first contact. */
	async deliverPending(): Promise<void> {
		if (this.delivering || this.stopped) return;
		const { sid } = this.me;
		const fresh = unreadFor(this.config.root, sid, sid);
		if (fresh.length === 0) return;
		// Duration knobs: malformed values fall back to the DEFAULT (guard-on),
		// matching the constructor's malformed-values philosophy. 0 disables.
		const parseMs = (name: string, fallback: number): number => {
			const raw = this.config.env(name);
			const n = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
			return Number.isFinite(n) ? Math.max(0, n) : fallback;
		};
		// Duplicate-send guard: harness-level tool retries re-execute sends with a
		// fresh id — identical content must not re-anchor a turn or re-open a
		// thread an ack already closed. Marked delivered silently.
		const windowMs = parseMs("MSG_DEDUPE_MS", 120_000);
		const pending: typeof fresh = [];
		for (const frame of fresh) {
			if (windowMs > 0 && duplicateOf(this.config.root, sid, frame, windowMs)) {
				// Answered, not just delivered — a suppressed duplicate must never
				// resurface as a pending reminder for mail the agent never saw.
				markDelivered(this.config.root, sid, [frame.id]);
				markAnswered(this.config.root, sid, [frame.id]);
				this.config.log?.(`duplicate delivery skipped (${frame.id})`);
				continue;
			}
			pending.push(frame);
		}
		if (pending.length === 0) return;
		// Stale-thread split: mail in a thread whose LATEST activity (including
		// frames already delivered) is older than MSG_STALE_ACT_MS is reference
		// material — delivered without waking the agent and marked answered, so
		// old work never auto-starts but stays readable. Hot threads deliver
		// and wake as usual.
		const staleMs = parseMs("MSG_STALE_ACT_MS", 3 * 60 * 60_000);
		let hot = pending;
		let stale: typeof pending = [];
		if (staleMs > 0) {
			const activity = threadActivity(readMailbox(this.config.root, sid).frames);
			const now = Date.now();
			hot = [];
			stale = [];
			for (const f of pending) {
				(now - (activity.get(f.id) ?? Date.parse(f.ts)) > staleMs ? stale : hot).push(f);
			}
		}
		if (hot.length === 0 && stale.length === 0) return;
		// Guard BEFORE activation: activate awaits a real harness round-trip,
		// during which watch/poll/fast-follow ticks could otherwise each enter
		// and inject the same bundle multiple times.
		this.delivering = true;
		// The agent needs the tools + instructions to reply — activate silently.
		// Stale-only delivery never wakes anyone, so it must not force activation.
		if (hot.length > 0 && !this.activated) await this.activate(false).catch(() => {});
		try {
			if (hot.length > 0) {
				const bundles = batchBySender(hot);
				const bundle: Bundle = bundles[0];
				this.config.inject(
					formatBundle(bundle, frame => resolveBody(this.config.root, frame), s => this.describe(s)),
					{ customType: "agent-hub-msg", display: true, triggerTurn: true },
				);
				markDelivered(this.config.root, sid, bundle.frames.map(f => f.id));
				this.config.log?.(`delivered bundle from ${bundle.from} (${bundle.frames.length})`);
			}
			if (stale.length > 0) {
				const ordered = [...stale].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
				const shown = ordered.slice(0, MSG_STALE_SHOW);
				const suppressed = ordered.slice(MSG_STALE_SHOW);
				const blocks = batchBySender(shown).map(b =>
					formatBundle(b, frame => resolveBody(this.config.root, frame), s => this.describe(s), { stale: true }),
				);
				if (suppressed.length > 0) {
					blocks.push(`(${suppressed.length} older stale messages suppressed — msg_inbox({read:true}) to review.)`);
				}
				this.config.inject(blocks.join("\n\n"), {
					customType: "agent-hub-msg-stale",
					display: true,
					triggerTurn: false,
				});
				// Read-and-don't-act: consumed AND answered — stale mail must never
				// resurface as a pending reminder demanding work on an old thread.
				markDelivered(this.config.root, sid, stale.map(f => f.id));
				markAnswered(this.config.root, sid, stale.map(f => f.id));
				this.config.log?.(`delivered ${shown.length} stale frames inert (${suppressed.length} suppressed)`);
			}
		} catch (err) {
			this.config.log?.(`delivery failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.delivering = false;
		}
	}

	/** Track a timer and drop it from the list once it fires (no unbounded growth). */
	private trackTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
		const t = setTimeout(() => {
			const i = this.fastFollowTimers.indexOf(t);
			if (i >= 0) this.fastFollowTimers.splice(i, 1);
			callback();
		}, delay);
		t.unref?.();
		this.fastFollowTimers.push(t);
		return t;
	}

	/** A reply to our send often lands within seconds — check a few times fast. */
	scheduleFastFollow(): void {
		for (const delay of this.fastFollowDelays) {
			this.trackTimer(() => void this.deliverPending().catch(() => {}), delay);
		}
	}

	/** Called by the adapter when an agent turn ends. */
	clearDelivering(): void {
		this.delivering = false;
	}

	// ── Polling & watching ───────────────────────────────────────────────────

	private watchInboxes(): void {
		if (this.watcher || this.stopped) return;
		const dir = path.join(this.config.root, "inboxes");
		try {
			fs.mkdirSync(dir, { recursive: true });
			this.watcher = fs.watch(dir, () => {
				if (this.watchDebounce) clearTimeout(this.watchDebounce);
				this.watchDebounce = setTimeout(() => void this.deliverPending().catch(() => {}), 250);
				this.watchDebounce.unref?.();
			});
			this.watcher.unref?.();
		} catch (err) {
			this.config.log?.(`fs.watch unavailable, poll-only: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async poll(): Promise<void> {
		if (this.stopped) return;
		try {
			if (!this.sid) return; // wait for attach()
			if (this.tickCount % this.keepaliveEvery === 0) registryHeartbeat(this.config.root, this.sid);
			this.tickCount++;
			await this.refreshInstructionsIfChanged();
			await this.deliverPending();
		} catch (err) {
			this.config.log?.(`poll error: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (!this.stopped) setTimeout(() => void this.poll(), this.pollMs).unref?.();
		}
	}

	/** Start registration + watcher + poll loop. No-op without a session id. */
	start(): void {
		if (this.stopped || !this.sid) return;
		this.register();
		this.watchInboxes();
		void this.poll();
		// Restore case: remind of mail delivered in a previous life but never
		// answered. Deferred so registration/backlog delivery settles first;
		// pending excludes undelivered backlog, so no double-injection.
		this.trackTimer(() => void this.remindPending().catch(() => {}), 2000);
	}

	/** Stop everything. Registry entry, mailbox, and aliases persist (no-evict). */
	stop(): void {
		this.stopped = true;
		this.watcher?.close();
		for (const t of this.fastFollowTimers) clearTimeout(t);
	}

	// ── Addressing helpers ───────────────────────────────────────────────────

	describe(sid: string): string {
		const { sid: me } = this.me;
		if (sid === me) return "you";
		const row = listSessions(this.config.root).find(r => r.sid === sid);
		return row && row.entry.aliases.length > 0 ? `${row.entry.aliases[0]} (${sid.slice(-6)})` : sid;
	}

	/**
	 * The /msg list: shown to the user and injected for the LLM. Roster noise
	 * guard: unchanged output is reported but not re-injected — registration
	 * churn mid-turn must not re-anchor the agent's attention. `changed` is
	 * false when the identical text was injected since this boot.
	 */
	listText(): { text: string; changed: boolean } {
		const now = Date.now();
		const rows = listSessions(this.config.root, now).map(({ sid, entry, live }) => {
			const status = live ? "" : " (offline)";
			const aliases = entry.aliases.length > 0 ? ` [${entry.aliases.join(", ")}]` : "";
			// pid: live processes continue sessions via `-c`, so two frontends can
			// share one sid — the registry keeps only the last registrant's pid,
			// which makes a flickering pid the visible symptom of sharing.
			const pid = entry.pid !== undefined ? ` pid ${entry.pid}` : "";
			return `${sid}${pid} ${relativeAge(entry.lastSeen, now)}${aliases} (${entry.cwd})${status}`;
		});
		const text = `registered agent sessions:\n${rows.join("\n") || "(none)"}`;
		const hash = hashOf(text);
		const changed = hash !== this.lastRosterHash;
		this.lastRosterHash = hash;
		return { text, changed };
	}

	/** Force-set the instructed flag (adapter-driven flows). */
	markInstructed(): void {
		if (this.sid) setInstructed(this.config.root, this.sid, true);
	}
}

/** Cheap content hash for drift detection (roster/instructions). Not crypto. */
function hashOf(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}
