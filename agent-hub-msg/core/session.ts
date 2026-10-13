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
import { instructionsText, markInstructed, myself, relativeAge, setUserAlias } from "./api";
import { listSessions, registerSession, setInstructed, heartbeat as registryHeartbeat } from "./registry";
import { markDelivered, resolveBody, setInlineMax, unreadFor } from "./mailbox";

/** Phrases in user input that activate the mail tools ("email" does not match). */
export const ACTIVATE_RE = /\b(?:mail|msg)\b/;

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

	constructor(config: HubSessionConfig) {
		this.config = config;
		const env = config.env;
		this.pollMs = Number(env("MSG_POLL_MS") ?? 15_000);
		this.keepaliveEvery = Math.max(1, Math.round(Number(env("MSG_KEEPALIVE_MS") ?? 60_000) / this.pollMs));
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

	/** Register (or re-register) this session; seeds the configured alias. */
	register(): void {
		if (!this.sid) return;
		registerSession(this.config.root, this.sid, {
			pid: this.config.pid ?? process.pid,
			cwd: this.config.cwd,
			machine: this.config.machine ?? os.hostname(),
		});
		if (this.config.seedAlias) {
			setUserAlias(this.config.root, this.sid, this.config.seedAlias);
		}
		this.config.log?.(`registered session ${this.sid} (root ${this.config.root})`);
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
		if (myself(this.config.root, sid).instructed && !force) return;
		this.config.inject(instructionsText(this.config.instructionsDir), {
			customType: "agent-hub-msg-instructions",
			display: false,
		});
		markInstructed(this.config.root, sid);
		this.config.log?.("instructions injected");
	}

	/** User-input hook: activate on phrases ("mail"/"msg"); failure is silent. */
	maybeActivateByPhrase(text: string): void {
		if (this.activated) return;
		if (ACTIVATE_RE.test(text ?? "")) {
			void this.activate(false).catch(err =>
				this.config.log?.(`activation failed: ${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	/** Post-compaction hook: re-inject instructions unconditionally. */
	reinjectAfterCompact(): void {
		if (this.activated && this.sid) void this.injectInstructions(true).catch(() => {});
	}

	// ── Delivery ─────────────────────────────────────────────────────────────

	/** Deliver pending unread mail as bundled turns; activates on first contact. */
	async deliverPending(): Promise<void> {
		if (this.delivering || this.stopped) return;
		const { sid } = this.me;
		const pending = unreadFor(this.config.root, sid, sid);
		if (pending.length === 0) return;
		const bundles = batchBySender(pending);
		const bundle: Bundle = bundles[0];
		// The agent needs the tools + instructions to reply — activate silently.
		if (!this.activated) await this.activate(false).catch(() => {});
		this.delivering = true;
		try {
			this.config.inject(
				formatBundle(bundle, frame => resolveBody(this.config.root, frame), s => this.describe(s)),
				{ customType: "agent-hub-msg", display: true, triggerTurn: true },
			);
			markDelivered(this.config.root, sid, bundle.frames.map(f => f.id));
			this.config.log?.(`delivered bundle from ${bundle.from} (${bundle.frames.length})`);
		} catch (err) {
			this.config.log?.(`delivery failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.delivering = false;
		}
	}

	/** A reply to our send often lands within seconds — check a few times fast. */
	scheduleFastFollow(): void {
		for (const delay of this.fastFollowDelays) {
			const t = setTimeout(() => void this.deliverPending().catch(() => {}), delay);
			t.unref?.();
			this.fastFollowTimers.push(t);
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

	/** The /msg list: shown to the user and injected for the LLM. */
	listText(): string {
		const now = Date.now();
		const rows = listSessions(this.config.root, now).map(({ sid, entry, live }) => {
			const status = live ? "" : " (offline)";
			const aliases = entry.aliases.length > 0 ? ` [${entry.aliases.join(", ")}]` : "";
			return `${sid} ${relativeAge(entry.lastSeen, now)}${aliases} (${entry.cwd})${status}`;
		});
		return `registered agent sessions:\n${rows.join("\n") || "(none)"}`;
	}

	/** Force-set the instructed flag (adapter-driven flows). */
	markInstructed(): void {
		if (this.sid) setInstructed(this.config.root, this.sid, true);
	}
}
