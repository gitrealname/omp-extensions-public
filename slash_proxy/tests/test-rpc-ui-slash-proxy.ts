#!/usr/bin/env bun
/**
 * test-rpc-ui-slash-proxy.ts
 *
 * Proves the full slash_proxy dispatch chain in --mode rpc-ui.
 *
 * rpc-ui uses the same JSONL protocol as --mode rpc with two differences:
 *   - sessionOptions.hasUI = true  (src/main.ts line ~905: mode === "rpc-ui")
 *   - setToolUIContext is passed to runRpcMode, wiring RpcExtensionUIContext
 *     so ctx.hasUI returns true in extension handlers
 *   - TUI renderer is active but PI_NO_PTY=1 prevents PTY allocation;
 *     any TUI escape sequences on stdout are non-JSON and are filtered out
 *     by the test reader (lines not starting with "{" are skipped)
 *
 * ── Protocol ────────────────────────────────────────────────────────────────
 * Identical to --mode rpc. See test-rpc-slash-proxy.ts for full protocol docs.
 *
 * Commands (host → OMP stdin, JSONL):
 *   { type: "prompt", id, message }  → session.prompt(); immediate success response
 *
 * Events (OMP stdout → host, JSONL — interspersed with TUI escape sequences):
 *   ready, agent_start, agent_end, turn_start, turn_end,
 *   message_update, tool_execution_start, tool_execution_end, response
 *
 * Stdin injection strategy (risky.ts):
 *   Same Bun.stdin.stream() patch as rpc mode. MODE detected as "rpc-ui" via
 *   process.argv "--mode" + "rpc-ui". Dispatch path identical to "rpc".
 *
 * ── Key source files ────────────────────────────────────────────────────────
 * src/modes/rpc/rpc-mode.ts             runRpcMode(session, setToolUIContext);
 *                                        setToolUIContext defined only for rpc-ui
 * src/main.ts (line ~905)               hasUI = isInteractive || mode === "rpc-ui"
 * src/extensibility/extensions/types.ts  ExtensionContext.hasUI, agent_end event
 *
 * ── External references ─────────────────────────────────────────────────────
 * Bun.stdin / Bun.stdin.stream()        https://bun.sh/docs/api/file-io#reading-from-stdin
 * Web Streams API ReadableStream        https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream
 * ReadableStream controller.enqueue()  https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultController/enqueue
 * NDJSON / JSONL                        https://jsonlines.org
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const OMP = "D:/.ai/.junctions/omp-bin/omp.exe";
const CWD = "D:/.ai/OMP/src/.test-extension";
const TIMEOUT_MS = 60_000;

function send(stdin: NodeJS.WritableStream, obj: Record<string, unknown>): void {
	stdin.write(JSON.stringify(obj) + "\n");
}

async function main() {
	console.log("=== RPC-UI slash_proxy full chain proof ===\n");

	const proc = spawn(OMP, ["--mode", "rpc-ui"], {
		cwd: CWD,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			OMP_EXTENSION_DEBUG: "1",
			PI_CONFIG_DIR: ".omp",
			PI_NO_PTY: "1",       // prevent PTY allocation (also set by rpc-ui internally)
			PI_NOTIFICATIONS: "off",
			AWS_PROFILE: "t",
		},
	});

	proc.on("error", (err: Error) => { console.error("spawn error:", err); process.exit(1); });
	proc.stderr?.on("data", (d: Buffer) => {
		const s = d.toString().trim();
		if (s) console.error(`[omp-err] ${s}`);
	});

	const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

	const events: Array<Record<string, unknown>> = [];
	let agentEndCount = 0;
	let agentEndResolvers: Array<() => void> = [];
	let textChunks: string[] = [];

	rl.on("line", (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		// rpc-ui may emit TUI escape sequences on stdout; skip non-JSON lines
		if (!trimmed.startsWith("{")) return;
		let obj: Record<string, unknown>;
		try { obj = JSON.parse(trimmed); } catch { return; }
		events.push(obj);

		const type = obj.type as string | undefined;
		if (type === "agent_end") {
			agentEndCount++;
			console.log(`[agent_end #${agentEndCount}]`);
			agentEndResolvers.splice(0).forEach(r => r());
		} else if (type === "message_update") {
			const ev = obj.assistantMessageEvent as Record<string, unknown> | undefined;
			if (ev?.type === "text_delta" && typeof ev.delta === "string") {
				process.stdout.write(ev.delta);
				textChunks.push(ev.delta);
			}
		} else if (type === "tool_execution_start") {
			console.log(`\n[tool] ${obj.toolName ?? "?"} → ${JSON.stringify(obj.input ?? {}).slice(0, 80)}`);
		} else if (type === "response") {
			if (!(obj.success as boolean)) {
				console.log(`[rpc-error] ${obj.command}: ${obj.error}`);
			}
		}
	});

	function waitForAgentEnd(): Promise<void> {
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("timeout waiting for agent_end")), TIMEOUT_MS);
			agentEndResolvers.push(() => { clearTimeout(t); resolve(); });
		});
	}

	// ── 1. Wait for ready ────────────────────────────────────────────────────
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout waiting for ready")), 10_000);
		const check = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) return;
			try {
				const obj = JSON.parse(trimmed);
				if (obj.type === "ready") { clearTimeout(t); rl.off("line", check); resolve(); }
			} catch { /* skip */ }
		};
		rl.on("line", check);
	});
	console.log("Connected.\n");

	// ── Turn 1: call slash_proxy ─────────────────────────────────────────────
	console.log("── Turn 1: call slash_proxy(\"/proxy-command\") ──");
	const end1 = waitForAgentEnd();
	send(proc.stdin!, { id: "t1", type: "prompt", message: 'Call `slash_proxy` with command `"/proxy-command"`. Output nothing.' });
	await end1;
	console.log("\n[end turn 1]\n");

	// ── Turn 2: /proxy-command dispatched by extension ───────────────────────
	console.log("── Turn 2: /proxy-command (dispatched by slash_proxy extension) ──");
	const end2 = waitForAgentEnd();
	await end2;
	console.log("\n[end turn 2]\n");

	// ── Turn 3: hello! ───────────────────────────────────────────────────────
	console.log("── Turn 3: hello! ──");
	textChunks = [];
	const end3 = waitForAgentEnd();
	send(proc.stdin!, { id: "t3", type: "prompt", message: "Reply with exactly: hello! Do not use any tools." });
	await end3;
	console.log("\n[end turn 3]\n");

	// ── Results ──────────────────────────────────────────────────────────────
	const toolCalled = events.some(e => e.type === "tool_execution_start" && e.toolName === "slash_proxy");
	const gotResponse = textChunks.length > 0;

	console.log("=== RESULT ===");
	console.log(`  slash_proxy tool called:  ${toolCalled ? "✓" : "✗"}`);
	console.log(`  /proxy-command executed:  ${agentEndCount >= 2 ? "✓" : "✗"} (${agentEndCount} agent_end events)`);
	console.log(`  hello! response received: ${gotResponse ? "✓" : "✗"}`);
	console.log(`  PASS: ${toolCalled && agentEndCount >= 3 && gotResponse ? "✓" : "✗"}`);

	proc.kill();
	process.exit(toolCalled && agentEndCount >= 3 && gotResponse ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
