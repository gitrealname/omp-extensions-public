/**
 * secrets-obfuscator — omp extension.
 *
 * The model never sees a real secret; the agent still uses them.
 *
 * Four hooks, no proxy, no network, no port:
 *   context                 mask the whole transcript before each LLM call
 *   before_provider_request mask the final provider payload (safety net)
 *   tool_call               restore aliases in tool arguments before execution
 *   tool_result             mask command output before the model sees it
 *
 * The session file therefore only ever holds aliases. Aliases are derived from
 * the value and carry a short tag of it, so nothing has to be rewritten later,
 * no state file is needed, and decoding is unambiguous.
 *
 * One label can carry several values. A rotated password keeps its label, so
 * old sessions and new sessions mask to the same label with a different tag.
 */

import { describeMappings, loadConfig } from "./config";
import { maskJson, maskToolResult, restoreInPlace, type Mapping } from "./mask";

interface PiLike {
	on: (event: string, handler: (event: any, ctx: any) => unknown) => unknown;
}

export default function secretsObfuscator(pi: PiLike): void {
	const { config, warnings } = loadConfig();
	for (const warning of warnings) console.error(`[secrets-obfuscator] ${warning}`);

	const mappings: Mapping[] = config.mappings;
	if (mappings.length === 0) {
		console.error("[secrets-obfuscator] no mappings configured; nothing to mask");
		return;
	}

	// Outbound, pass 1: the transcript Pi is about to serialize.
	pi.on("context", (event) => {
		const messages = (event as { messages?: unknown }).messages;
		if (messages === undefined) return undefined;
		return { messages: maskJson(messages, mappings) };
	});

	// Outbound, pass 2: provider-specific fields Pi adds after `context`
	// (system blocks, tool declarations, provider quirks).
	pi.on("before_provider_request", (event) => {
		const payload = (event as { payload?: unknown }).payload;
		if (payload === undefined) return undefined;
		return maskJson(payload, mappings);
	});

	// Inbound, tool arguments: the model writes an alias, the tool runs the
	// real value.
	pi.on("tool_call", (event) => {
		const input = (event as { input?: unknown }).input;
		if (input === undefined) return undefined;
		restoreInPlace(input, mappings);
		return undefined;
	});

	// Inbound, tool output: `printenv`, `cat .env`, `git remote -v` stay useful
	// to the agent but reach the model masked.
	pi.on("tool_result", (event) => {
		const patched = maskToolResult(event, mappings);
		const content = (patched as { content?: unknown }).content;
		if (content === undefined || content === (event as { content?: unknown }).content) return undefined;
		return { content };
	});

	console.error(`[secrets-obfuscator] masking ${describeMappings(mappings)}`);
}