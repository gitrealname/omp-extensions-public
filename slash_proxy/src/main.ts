/**
 * main.ts — slash_proxy extension: mode-aware slash command dispatch.
 *
 * Mode is detected once at load time. argv is checked first (authoritative);
 * isTTY is a fallback only when no explicit mode flag is present:
 *
 *   ACP     ("acp" positional in argv): NDJSON session/prompt line
 *     → OMP's NDJSON reader → #runPromptOrCommand
 *     → executeAcpBuiltinSlashCommand
 *
 *   RPC     ("--mode rpc" in argv):    JSONL prompt command
 *   RPC-UI  ("--mode rpc-ui" in argv): JSONL prompt command (same as rpc)
 *     → rpc-mode.ts readJsonl(Bun.stdin.stream()) loop
 *     → handleCommand "prompt" → session.prompt()
 *
 *   TUI     (no mode flag, isTTY=true): raw bytes — cmd + "\r"
 *     → StdinBuffer → editor.handleInput → InputController.handleSubmit
 *     → executeBuiltinSlashCommand with real InteractiveModeContext
 *
 *   null    (no mode flag, isTTY=false): unknown non-TTY context — noop
 *
 * RPC/RPC-UI injection strategy:
 *   Bun.stdin.stream() is called exactly once by runRpcMode, after extensions
 *   load. We patch the method before that call, return a controlled
 *   ReadableStream that forwards real stdin and accepts our injections, then
 *   hold the controller for later dispatch. Patch is only installed when
 *   MODE is rpc or rpc-ui; TUI and ACP use process.stdin.push() instead.
 *
 * Replace with pi.scheduleSlashCommand() when OMP issue #1560 ships.
 */

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

type RunMode = "tui" | "acp" | "rpc" | "rpc-ui";


function detectMode(): RunMode | null {
	const argv = process.argv;
	// Explicit mode flags take priority — authoritative over isTTY
	if (argv.includes("acp")) return "acp";
	const modeIdx = argv.indexOf("--mode");
	if (modeIdx !== -1) {
		const val = argv[modeIdx + 1];
		if (val === "rpc-ui") return "rpc-ui";
		if (val === "rpc") return "rpc";
	}
	for (const arg of argv) {
		if (arg === "--mode=rpc-ui") return "rpc-ui";
		if (arg === "--mode=rpc") return "rpc";
	}
	// No explicit mode — fall back to isTTY for interactive detection
	if ((process.stdin as NodeJS.ReadStream).isTTY) return "tui";
	return null; // unknown non-TTY context (print, subagent, etc.) — noop
}


const MODE: RunMode | null = detectMode();
const enc = new TextEncoder();

// ── RPC stdin injection ───────────────────────────────────────────────────────
// Installed only in rpc/rpc-ui modes. Patches Bun.stdin.stream() once before
// runRpcMode calls it, returns a ReadableStream we control that transparently
// forwards real stdin. _rpcInject is set when the stream is first pulled.
let _rpcInject: ((chunk: Uint8Array) => void) | null = null;

if (MODE === "rpc" || MODE === "rpc-ui") {
	const originalStream = (Bun.stdin.stream as () => ReadableStream<Uint8Array>).bind(Bun.stdin);
	(Bun.stdin as unknown as { stream: () => ReadableStream<Uint8Array> }).stream = function () {
		const real = originalStream();
		const reader = real.getReader();
		let ctrl!: ReadableStreamDefaultController<Uint8Array>;

		const merged = new ReadableStream<Uint8Array>({
			start(c) { ctrl = c; },
			cancel() { reader.cancel(); },
		});

		// Pump real stdin into our controlled stream
		(async () => {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) { ctrl.close(); break; }
					ctrl.enqueue(value);
				}
			} catch (e) { ctrl.error(e); }
		})();

		_rpcInject = chunk => ctrl.enqueue(chunk);
		return merged;
	};
}

// ── Protocol helpers ──────────────────────────────────────────────────────────

function buildAcpLine(sessionId: string, cmd: string): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: crypto.randomUUID(),
		method: "session/prompt",
		params: { sessionId, prompt: [{ type: "text", text: cmd }] },
	}) + "\n";
}

function buildRpcLine(cmd: string): string {
	return JSON.stringify({ type: "prompt", message: cmd }) + "\n";
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default async function slashProxy(pi: ExtensionAPI): Promise<void> {
	const debug = (msg: string, meta?: Record<string, unknown>) => {
		const v = (typeof Bun !== "undefined" ? (Bun.env as Record<string, string | undefined>) : process.env).OMP_EXTENSION_DEBUG;
		if (v === "1" || v?.toUpperCase() === "TRUE") pi.logger.debug(`[slash-proxy] ${msg}`, { source: "slash-proxy", ...meta });
	};

	pi.logger.debug("[slash-proxy] loaded", { source: "slash-proxy", mode: MODE });

	pi.registerTool({
		name: "slash_proxy",
		label: "Slash Proxy",
		description:
			"Passthrough tool — routes a command string to the OMP runtime. " +
			"When you see this tool named in a skill or instruction: call it immediately with the exact command given, output nothing, stop. " +
			"Do not read files, investigate the command, or reason about what it does. " +
			"Your only job is to pass the command string through.",
		parameters: pi.zod.object({
			command: pi.zod.string().describe('The slash command to run, including the leading "/". e.g. "/graphify"'),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
			debug("tool execute", { toolCallId, command: params.command });
			return { content: [], details: { command: params.command } };
		},
	});

	// Command captured from tool_result, dispatched on agent_end.
	let _pending: { command: string; sessionId: string | undefined } | null = null;

	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (event.toolName !== "slash_proxy") return;
		const command = (event.input as { command?: string }).command ?? "";
		if (!command.startsWith("/")) return;
		const sm = ctx.sessionManager as unknown as { getSessionId?(): string };
		const sessionId = sm.getSessionId?.();
		debug("captured for agent_end", { command, sessionId, mode: MODE });
		_pending = { command, sessionId };
	});

	pi.on("agent_end", async () => {
		if (!_pending) return;
		const { command, sessionId } = _pending;
		_pending = null;
		// Yield once so OMP's #emitEndOfTurnUpdates can start before we push.
		setTimeout(() => {
			debug("dispatching", { command, mode: MODE, sessionId });
			switch (MODE) {
				case "tui":
					(process.stdin as NodeJS.ReadStream).push(command + "\r");
					break;
				case "acp":
					if (!sessionId) { debug("sessionId unavailable, cannot dispatch ACP"); return; }
					(process.stdin as NodeJS.ReadStream).push(buildAcpLine(sessionId, command));
					break;
				case "rpc":
				case "rpc-ui":
					if (!_rpcInject) { debug("rpcInject not ready — Bun.stdin.stream() not yet called"); return; }
					_rpcInject(enc.encode(buildRpcLine(command)));
					break;
				case null:
					debug("unknown mode — skipping dispatch");
					break;
			}
		}, 0);
	});
}
