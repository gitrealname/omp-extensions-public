/**
 * End-to-end driver: two omp instances in RPC mode exchange mail through
 * agent-hub-msg (v2: session-id addressing, aliases, body spooling).
 * Verifies:
 *
 *   1. both sessions register (registry is sid-keyed; aliases from MSG_ALIAS)
 *   2. A → B delivery, B's poller injects a turn, B replies BY ID → A
 *   3. A's poller consumes B's reply
 *   4. spool round-trip: a >255-char body lands in files/, recipient gets
 *      full text inline, and a reply to the spooled message resolves
 *   5. instructed flag set for both sessions
 *
 * Usage: bun tests/e2e-rpc.ts [ompPath]
 * Requires a configured default model (the agents make real LLM calls).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const OMP = process.argv[2] ?? "omp";
const ROOT = path.join(os.tmpdir(), `agent-hub-msg-e2e-${Date.now()}`);
const DIR_A = path.join(ROOT, "alpha");
const DIR_B = path.join(ROOT, "beta");
const MAIL_ROOT = path.join(ROOT, "mail-root");

for (const d of [DIR_A, DIR_B]) {
	fs.mkdirSync(d, { recursive: true });
	// Project-local settings: shrink the compaction keep-recent tail so the
	// driver can trigger real compaction without first generating 20k tokens.
	fs.mkdirSync(path.join(d, ".omp"), { recursive: true });
	fs.writeFileSync(path.join(d, ".omp", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 500 } }));
}

const env = (extra: Record<string, string>): Record<string, string> => ({
	...(process.env as Record<string, string>),
	MSG_INBOX_ROOT: MAIL_ROOT,
	MSG_POLL_MS: "500",
	OMP_EXTENSION_DEBUG: "1",
	...extra,
});

type WaiterKind = "response" | "prompt_result";
interface Waiter {
	resolve: (frame: any) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class RpcClient {
	readonly stderrLog: string[] = [];
	private readonly waiters = new Map<string, Waiter>();
	readonly ready: Promise<void>;

	constructor(
		readonly alias: string,
		readonly proc: Bun.Subprocess,
	) {
		this.ready = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`[${alias}] no ready frame within 30s`)), 30_000);
			timeout.unref?.();
			void this.readLoop(resolve, timeout);
		});
		void (async () => {
			const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = decoder.decode(value, { stream: true });
					this.stderrLog.push(chunk);
					for (const line of chunk.split("\n")) if (line.trim()) console.error(`[${alias} stderr] ${line}`);
				}
			} catch {}
		})();
	}

	private async readLoop(onReady: () => void, readyTimeout: ReturnType<typeof setTimeout>): Promise<void> {
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buf = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, idx).trim();
					buf = buf.slice(idx + 1);
					if (!line) continue;
					let frame: any;
					try {
						frame = JSON.parse(line);
					} catch {
						continue;
					}
					if (frame.type === "ready") {
						clearTimeout(readyTimeout);
						onReady();
					} else {
						const key = `${frame.id}:${frame.type}`;
						const waiter = this.waiters.get(key);
						if (waiter) {
							this.waiters.delete(key);
							clearTimeout(waiter.timer);
							waiter.resolve(frame);
						}
					}
				}
			}
		} catch {
			/* process died — waiters reject via their timers */
		}
	}

	private wait(kind: WaiterKind, id: string, timeoutMs: number): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(`${id}:${kind}`);
				reject(new Error(`[${this.alias}] timeout waiting for ${kind} of ${id}`));
			}, timeoutMs);
			timer.unref?.();
			this.waiters.set(`${id}:${kind}`, { resolve, reject, timer });
		});
	}

	/**
	 * Send a prompt; resolves when admitted and again when the turn settles.
	 * An injected mail turn may still be running — "already processing"
	 * rejections are retried until the agent goes idle.
	 */
	async prompt(text: string, timeoutMs = 180_000): Promise<{ response: any; result: any }> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const id = `drv-${Math.random().toString(36).slice(2)}`;
			const responseP = this.wait("response", id, Math.max(1000, deadline - Date.now()));
			const resultP = this.wait("prompt_result", id, Math.max(1000, deadline - Date.now()));
			(this.proc.stdin as unknown as { write(data: string): number }).write(`${JSON.stringify({ id, type: "prompt", message: text })}\n`);
			const response = await responseP;
			if (response && response.success === false) {
				const busy = /already processing/i.test(String(response.error ?? ""));
				if (busy && Date.now() < deadline - 5000) {
					await Bun.sleep(3000);
					continue;
				}
				throw new Error(`[${this.alias}] prompt failed: ${JSON.stringify(response).slice(0, 500)}`);
			}
			const result = await resultP;
			return { response, result };
		}
	}

	/**
	 * Send a slash command as a raw RPC prompt. Extension commands execute
	 * locally (agentInvoked: false) — no LLM turn involved.
	 */
	async command(text: string, timeoutMs = 60_000): Promise<void> {
		const id = `cmd-${Math.random().toString(36).slice(2)}`;
		const responseP = this.wait("response", id, timeoutMs);
		const resultP = this.wait("prompt_result", id, timeoutMs);
		(this.proc.stdin as unknown as { write(data: string): number }).write(`${JSON.stringify({ id, type: "prompt", message: text })}\n`);
		const response = await responseP;
		if (response && response.success === false) {
			throw new Error(`[${this.alias}] command ${text} failed: ${JSON.stringify(response).slice(0, 400)}`);
		}
		const result = await resultP;
		if (result.agentInvoked !== false) {
			throw new Error(`[${this.alias}] ${text} was not handled as a command (agentInvoked: ${result.agentInvoked})`);
		}
	}

	/** Send a raw RPC command frame (no prompt_result); resolves on response. */
	async rawCommand(type: string, timeoutMs = 180_000): Promise<any> {
		const id = `raw-${Math.random().toString(36).slice(2)}`;
		const responseP = this.wait("response", id, timeoutMs);
		(this.proc.stdin as unknown as { write(data: string): number }).write(`${JSON.stringify({ id, type })}\n`);
		const response = await responseP;
		if (response && response.success === false) {
			throw new Error(`[${this.alias}] ${type} failed: ${JSON.stringify(response).slice(0, 400)}`);
		}
		return response;
	}

	close(): void {
		try {
			(this.proc.stdin as unknown as { end(): number }).end();
		} catch {
			/* already gone */
		}
	}
}

function spawnOmp(cwd: string, alias: string): RpcClient {
	const proc = Bun.spawn([OMP, "--mode", "rpc"], {
		cwd,
		env: env({ MSG_ALIAS: alias }),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	return new RpcClient(alias, proc);
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 120_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${what}`);
		await Bun.sleep(300);
	}
}

const readRegistry = (): Record<string, any> => {
	try {
		return JSON.parse(fs.readFileSync(path.join(MAIL_ROOT, "registry.json"), "utf-8"));
	} catch {
		return {};
	}
};

const sidFor = (alias: string): string | undefined =>
	Object.entries(readRegistry()).find(([, e]) => (e as any).aliases?.includes(alias))?.[0];

const readMbox = (sid: string): any[] => {
	if (!sid) return [];
	try {
		return fs
			.readFileSync(path.join(MAIL_ROOT, "inboxes", sid, "mbox.jsonl"), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
	} catch {
		return [];
	}
};

const stateOf = (sid: string): any => {
	try {
		return JSON.parse(fs.readFileSync(path.join(MAIL_ROOT, "inboxes", sid, "state.json"), "utf-8"));
	} catch {
		return {};
	}
};

function dumpDiagnostics(a: RpcClient, b: RpcClient): void {
	console.error("=== stderr alpha-agent ===\n" + a.stderrLog.join("").slice(-4000));
	console.error("=== stderr beta-agent ===\n" + b.stderrLog.join("").slice(-4000));
	console.error(`=== registry ===\n${(() => {
		try {
			return fs.readFileSync(path.join(MAIL_ROOT, "registry.json"), "utf-8");
		} catch {
			return "(missing)";
		}
	})()}`);
	const sidA = sidFor("alpha-agent");
	const sidB = sidFor("beta-agent");
	console.error("=== alpha mbox ===\n" + JSON.stringify(readMbox(sidA ?? ""), null, 1));
	console.error("=== beta mbox ===\n" + JSON.stringify(readMbox(sidB ?? ""), null, 1));
	try {
		console.error("=== spool files ===\n" + fs.readdirSync(path.join(MAIL_ROOT, "files")).join("\n"));
	} catch {}
	console.error(`artifacts kept at: ${ROOT}`);
}

async function main(): Promise<void> {
	console.log(`e2e root: ${ROOT}`);
	// Stagger: B first, fully ready and claimed, then A — avoids concurrent
		// first-boot registry writes.
	const b = spawnOmp(DIR_B, "beta-agent");
	await b.ready;
	const a = spawnOmp(DIR_A, "alpha-agent");
	await a.ready;
	try {
		await waitFor(() => Object.keys(readRegistry()).length === 2, "both sessions registered", 20_000);
		const sidA = sidFor("alpha-agent");
		const sidB = sidFor("beta-agent");
		if (!sidA || !sidB) throw new Error("aliases not seeded into registry entries");
		console.log(`✓ both agents registered (alpha=${sidA.slice(-6)}, beta=${sidB.slice(-6)})`);

		// ── Slash-command surface (before any mail traffic — no injected-mail interference) via slash_proxy (dispatches /msg through
		// A's own stdin as a user command). ────────────────────────────────
		const e2eStamp = path.basename(ROOT).split("-").pop() ?? "";
		const sessionJsonl = (side: "alpha" | "beta"): string | undefined => {
			const base = "C:/Users/common/.omp/agent/sessions";
			const dirs = fs
				.readdirSync(base, { withFileTypes: true })
				.filter(d => d.isDirectory() && d.name.includes(e2eStamp) && d.name.endsWith(side))
				.map(d => path.join(base, d.name));
			const files = dirs.flatMap(d => fs.readdirSync(d).filter(x => x.endsWith(".jsonl")).map(x => path.join(d, x)));
			return files.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0];
		};
		const sessionText = (side: "alpha" | "beta"): string => {
			const file = sessionJsonl(side);
			return file ? fs.readFileSync(file, "utf-8") : "";
		};

		// 8. /msg alias <name> → registry entry gains the alias.
		// Sent as a raw RPC prompt: extension commands execute locally
		// (agentInvoked: false). (slash_proxy's RPC dispatch is dead on
		// v18.10.4 — upstream claims stdin before extensions load.)
		console.log("A: RPC prompt → /msg alias alpha-team");
		await a.command("/msg alias alpha-team");
		await waitFor(() => (readRegistry()[sidA]?.aliases ?? []).includes("alpha-team"), "/msg alias in registry", 30_000);
		console.log("✓ /msg alias alpha-team → registry updated");


		// 1. A activates mail tools and sends a hello to the beta alias.
		console.log("A: prompt → activate mail, msg_who, msg_send hello to beta-agent");
		const first = await a.prompt(
			"Use email. First call msg_who to see the registered agents. Then use msg_send to send the agent aliased 'beta-agent' a short hello: 'hello from alpha — testing inter-agent mail'. Then briefly report what you did.",
		);
		console.log("A first-turn response:", JSON.stringify(first.response)?.slice(0, 1500));

		// 2. B's mailbox must contain A's message.
		await waitFor(() => readMbox(sidB).some(f => f.from === sidA), "A→B delivery");
		console.log("✓ A→B delivered (addressed by alias, delivered to session id)");

		// 3. B's poller injects the mail and its agent replies via msg_reply.
		await waitFor(() => readMbox(sidA).some(f => f.from === sidB), "B→A reply (auto-injected turn)", 180_000);
		console.log("✓ B replied (auto-injected turn → msg_reply) → delivered to A");

		// 4. A's poller must have delivered B's reply into A's session (marked read).
		const replyFrame = readMbox(sidA).find(f => f.from === sidB);
		if (!replyFrame) throw new Error("no reply frame in alpha mailbox");
		if (!replyFrame.inReplyTo) throw new Error("B's reply does not reference the original message id");
		await waitFor(() => stateOf(sidA).readIds?.includes(replyFrame.id), "A's poller consuming B's reply", 20_000);
		console.log("✓ B replied by id (inReplyTo set) → A's poller consumed it");

		// 5. Spool round-trip: A sends a long body; it must land in files/ and
		// B's reply to it (by id) must resolve back to A.
		console.log("A: prompt → send a long (300+ char) message to beta-agent");
		await a.prompt(
			"Use email. Use msg_send to send the agent aliased 'beta-agent' a message whose body is a single paragraph of at least 350 characters describing what inter-agent mail is good for (write it yourself, no lists). Report only 'done'.",
		);
		await waitFor(() => readMbox(sidB).some(f => f.from === sidA && f.bodyFile), "spooled A→B delivery");
		const spooled = readMbox(sidB).find(f => f.from === sidA && f.bodyFile);
		const spoolText = fs.readFileSync(path.join(MAIL_ROOT, spooled.bodyFile), "utf-8");
		if (spoolText.length < 255) throw new Error(`spool file too small: ${spoolText.length}`);
		console.log(`✓ long body spooled to ${spooled.bodyFile} (${spoolText.length} chars)`);

		// 6. B consumes the spooled message (full text injected) and replies by id.
		await waitFor(() => readMbox(sidA).some(f => f.from === sidB && f.inReplyTo === spooled.id), "B→A reply to spooled message", 180_000);
		await waitFor(() => stateOf(sidB).readIds?.includes(spooled.id), "B's poller consuming spooled message", 20_000);
		console.log("✓ B consumed the spooled message (full text) and replied by id");

		// 7. instructed flags set for both sessions.
		for (const [name, sid] of [["alpha", sidA], ["beta", sidB]] as const) {
			if (!readRegistry()[sid].instructed) throw new Error(`${name} not marked instructed`);
		}
		console.log("✓ instructed flag set for both sessions");

		// 9. /msg list → the list is injected into A's conversation.
		console.log("A: RPC prompt → /msg list");
		await a.command("/msg list");
		await waitFor(
			() => sessionText("alpha").includes("registered agent sessions:"),
			"/msg list injection into A's session",
			30_000,
		);
		console.log("✓ /msg list injected into A's conversation");

		// 10. /msg instruct → instructions force re-injected (≥2 in session).
		console.log("A: RPC prompt → /msg instruct");
		await a.command("/msg instruct");
		await waitFor(() => sessionText("alpha").split("Rules").length >= 3, "/msg instruct re-injection", 30_000);
		console.log("✓ /msg instruct force re-injected instructions");


		// 11. compaction survival: force-compact A; the session_compact hook must
		// re-inject instructions (count grows) without breaking anything.
		console.log("A: RPC → compact (compaction survival check)");
		const before = sessionText("alpha").split("Rules").length - 1;
		await a.rawCommand("compact");
		await waitFor(() => sessionText("alpha").split("Rules").length - 1 >= before + 1, "instructions re-injected after compaction", 180_000);
		console.log("✓ compaction re-injected instructions (hook fired on live session)");

		console.log("\nE2E PASS — full mail loop (sid addressing, aliases, spooling, reply-by-id, slash commands, compaction).");
	} catch (err) {
		console.error("E2E FAILED:", err instanceof Error ? err.message : err);
		dumpDiagnostics(a, b);
		process.exitCode = 1;
	} finally {
		a.close();
		b.close();
		await Bun.sleep(1500);
		if (process.exitCode !== 1) {
			try {
				fs.rmSync(ROOT, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}
}

await main();
