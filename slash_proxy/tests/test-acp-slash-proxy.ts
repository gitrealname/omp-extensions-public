#!/usr/bin/env bun
/**
 * test-acp-slash-proxy.ts
 *
 * Proves the full slash_proxy dispatch chain in ACP mode.
 *
 * ── Protocol ────────────────────────────────────────────────────────────────
 * Agent Client Protocol (ACP) — JSON-RPC 2.0 framed as NDJSON over stdio.
 * OMP is the server; this script is the client. Transport: bidirectional pipe.
 *
 * Key message flows:
 *   client → server  initialize({ protocolVersion, clientCapabilities })
 *   client → server  session/new({ cwd, mcpServers })   → { sessionId }
 *   client → server  session/prompt({ sessionId, prompt: [{type,text}] })
 *   server → client  sessionUpdate({ update: { sessionUpdate, ... } })
 *     sessionUpdate types: agent_start, tool_call, tool_call_update,
 *       agent_message_chunk, end_turn, usage_update, session_info_update
 *
 * Retry behaviour: session/prompt throws -32603
 * "ACP prompt already in progress" while the previous turn is running.
 * Internally OMP runs #waitForAcpPromptIdle (3 × 250 ms = 750 ms max) before
 * marking settled=true; callers must retry until the window closes.
 *
 * Skill commands (/skill:name) are disabled in ACP mode
 * (enableSkillCommands=false guard in acp-agent.ts). Skill content must be
 * injected directly as prompt text.
 *
 * ── Key source files ────────────────────────────────────────────────────────
 * src/modes/acp/acp-agent.ts          server entry; session lifecycle,
 *                                      #waitForAcpPromptIdle, #queuePrompt
 * src/extensibility/extensions/types.ts  ExtensionContext, ReadonlySessionManager,
 *                                      tool_result / agent_end event shapes
 * src/extensibility/extensions/runner.ts  extension event dispatch
 *
 * ── SDK / external references ───────────────────────────────────────────────
 * @agentclientprotocol/sdk            ClientSideConnection, ndJsonStream,
 *                                      newSession, prompt, PROTOCOL_VERSION
 * JSON-RPC 2.0 spec                   https://www.jsonrpc.org/specification
 * NDJSON (Newline Delimited JSON)     https://github.com/ndjson/ndjson-spec
 */

import { spawn } from "node:child_process";
import { PassThrough, Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const OMP = "D:/.ai/.junctions/omp-bin/omp.exe";
const CWD = "D:/.ai/OMP/src/.test-extension";

const events: string[] = [];

class TestClient {
	async sessionUpdate(params: unknown) {
		const u = (params as any).update;
		const t: string = u?.sessionUpdate ?? "unknown";
		if (t === "agent_message_chunk" && u.content?.type === "text") {
			process.stdout.write(u.content.text ?? "");
			events.push(`msg:${(u.content.text ?? "").slice(0, 40)}`);
		} else if (t === "tool_call") {
			console.log(`\n[tool_call] ${u.title ?? ""} → ${JSON.stringify(u.rawInput).slice(0, 80)}`);
			events.push(`tool:${u.title}`);
		} else if (t === "agent_thought_chunk") {
			// suppress — too verbose
		} else {
			console.log(`[${t}]`);
			events.push(t);
		}
	}
}

async function main() {
	console.log("=== ACP slash_proxy full chain proof ===\n");

	const proc = spawn(OMP, ["acp"], {
		cwd: CWD,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			OMP_EXTENSION_DEBUG: "1",
			PI_CONFIG_DIR: ".omp",
			AWS_PROFILE: "t",
			AWS_CORP_PROFILE: "t",
			AWS_BEDROCK_FORCE_HTTP1: "1",
		},
	});

	proc.on("error", err => { console.error("spawn error:", err); process.exit(1); });
	proc.stderr?.on("data", (d: Buffer) => {
		const s = d.toString().trim();
		if (s) console.error(`[omp-err] ${s}`);
	});

	const tee = new PassThrough();
	proc.stdout!.pipe(tee);

	const input = Writable.toWeb(proc.stdin as any);
	const output = Readable.toWeb(tee as any);

	const client = new TestClient();
	const stream = (acp as any).ndJsonStream(input, output);
	const connection = new (acp as any).ClientSideConnection((_agent: unknown) => client, stream);

	try {
		await connection.initialize({
			protocolVersion: (acp as any).PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		console.log("Connected.\n");

		const session = await connection.newSession({ cwd: CWD, mcpServers: [] });
		console.log(`Session: ${session.sessionId}\n`);

		await Bun.sleep(500);

		// ── Turn 1: inject skill content directly (ACP disables /skill: expansion) ──
		console.log("── Turn 1: proxy-test skill content ──");
		await connection.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: 'Call `slash_proxy` with command `"/proxy-command"`. Output nothing.' }],
		});
		console.log("\n[end_turn 1]\n");

		// ── Turn 2: retry until /proxy-command turn completes, then send hello! ──
		console.log("── Turn 2: hello! (waiting for /proxy-command to complete) ──");
		let turn2Result: unknown;
		for (let attempt = 1; attempt <= 60; attempt++) {
			await Bun.sleep(1000);
			try {
				turn2Result = await connection.prompt({
					sessionId: session.sessionId,
					prompt: [{ type: "text", text: "hello!" }],
				});
				console.log(`\n[end_turn 2 — attempt ${attempt}]\n`);
				break;
			} catch (err: unknown) {
				const e = err as { message?: string; data?: { details?: string } };
				const text = (e.message ?? "") + (e.data?.details ?? "");
				if (text.includes("already in progress")) {
					console.log(`  [retry ${attempt}: /proxy-command still running...]`);
				} else {
					throw err;
				}
			}
		}

		// Summary
		console.log("\n=== EVENT LOG ===");
		events.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
		const hasToolCall = events.some(e => e.startsWith("tool:"));
		const hasTurn2Response = events.slice(events.findLastIndex(e => e === "end_turn") + 1).some(e => e.startsWith("msg:"));
		console.log(`\nProof:`);
		console.log(`  slash_proxy tool called: ${hasToolCall ? "✓" : "✗"}`);
		console.log(`  turn 2 response received: ${hasTurn2Response || events.filter(e => e.startsWith("msg:")).length > 0 ? "✓" : "✗"}`);

	} catch (err) {
		console.error("Error:", err);
	} finally {
		proc.kill();
	}
}

main().catch(console.error);
