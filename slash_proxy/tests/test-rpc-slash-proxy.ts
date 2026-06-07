#!/usr/bin/env bun
/**
 * test-rpc-slash-proxy.ts
 *
 * Proves the full slash_proxy dispatch chain in --mode rpc.
 *
 * ── Protocol ────────────────────────────────────────────────────────────────
 * OMP RPC mode — JSONL (one JSON object per line) over stdio.
 * OMP is the child process; this script drives it as host. Transport: pipe.
 *
 * Commands (host → OMP stdin, one JSONL line each):
 *   { type: "prompt", id, message }
 *     → handleCommand "prompt" → session.prompt(message)
 *     → returns { type: "response", id, success: true } immediately
 *     → errors emitted as { type: "response", id, success: false, error }
 *
 * Events (OMP stdout → host, JSONL):
 *   { type: "ready" }                     OMP initialised, accepting commands
 *   { type: "agent_start" }               agent loop begins a turn
 *   { type: "agent_end" }                 agent loop ends a turn
 *   { type: "turn_start" / "turn_end" }   prompt lifecycle boundaries
 *   { type: "message_update",             streaming text / thinking delta
 *          assistantMessageEvent: { type: "text_delta", delta } }
 *   { type: "tool_execution_start",       tool call beginning
 *          toolName, input }
 *   { type: "tool_execution_end" }        tool call finished
 *   { type: "response", id, success,      reply to a command by id
 *          command, error? }
 *
 * Stdin injection strategy (risky.ts):
 *   Bun.stdin.stream() returns a Web API ReadableStream<Uint8Array> — distinct
 *   from Node.js process.stdin. Extension patches Bun.stdin.stream before
 *   runRpcMode() calls it (once per process), returning a controlled stream
 *   that forwards real stdin and accepts injected chunks via a saved controller.
 *   On agent_end the extension enqueues buildRpcLine(cmd) into that controller.
 *
 * ── Key source files ────────────────────────────────────────────────────────
 * src/modes/rpc/rpc-mode.ts             runRpcMode(); readJsonl(Bun.stdin.stream())
 *                                        loop; handleCommand; RpcCommand types;
 *                                        RpcExtensionUIContext
 * src/extensibility/extensions/types.ts  ExtensionContext, agent_end event,
 *                                        tool_result event shapes
 * src/main.ts (line ~905)               sessionOptions.hasUI assignment per mode;
 *                                        mode → runRpcMode dispatch
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

// ── JSONL helpers ────────────────────────────────────────────────────────────

function send(stdin: NodeJS.WritableStream, obj: Record<string, unknown>): void {
	stdin.write(JSON.stringify(obj) + "\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	console.log("=== RPC slash_proxy full chain proof ===\n");

	const proc = spawn(OMP, ["--mode", "rpc"], {
		cwd: CWD,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			OMP_EXTENSION_DEBUG: "1",
			PI_CONFIG_DIR: ".omp",
			AWS_PROFILE: "t",
		},
	});

	proc.on("error", (err: Error) => { console.error("spawn error:", err); process.exit(1); });
	proc.stderr?.on("data", (d: Buffer) => {
		const s = d.toString().trim();
		if (s) console.error(`[omp-err] ${s}`);
	});

	// Line-by-line JSON reader from stdout
	const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

	const events: Array<Record<string, unknown>> = [];
	let agentEndCount = 0;
	let agentEndResolvers: Array<() => void> = [];
	let textChunks: string[] = [];

	rl.on("line", (line: string) => {
		if (!line.trim()) return;
		let obj: Record<string, unknown>;
		try { obj = JSON.parse(line); } catch { return; } // skip non-JSON (rpc-ui TUI frames)
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
			try {
				const obj = JSON.parse(line);
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
	// The extension pushes the RPC frame on a 0ms timer after agent_end.
	// We just wait for the next agent_end — that's the /proxy-command turn.
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
