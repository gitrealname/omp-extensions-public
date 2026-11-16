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
 * The config file is watched. Add or rotate a value and the new set is armed
 * on the next hook; no restart.
 *
 * One label can carry several values. A rotated password keeps its label, so
 * old sessions and new sessions mask to the same label with a different tag.
 */

import { blockOutbound } from "./breaker";
import { configPath, describeMappings, loadConfig, watchConfig } from "./config";
import { maskJson, maskToolResult, restoreInPlace, type Mapping } from "./mask";

interface PiLike {
	on: (event: string, handler: (event: any, ctx: any) => unknown) => unknown;
}

export default function secretsObfuscator(pi: PiLike): void {
	const { config, errors, warnings } = loadConfig();
	for (const warning of warnings) console.error(`[secrets-obfuscator] warning: ${warning}`);

	// Circuit breaker. A guard that cannot read its own config is not a guard.
	// Stop omp here rather than start a session the model could leak into.
	if (errors.length > 0) {
		console.error("[secrets-obfuscator] FATAL: the guard is not armed, omp must not reach a model");
		for (const error of errors) console.error(`[secrets-obfuscator]   ${error}`);
		console.error(`[secrets-obfuscator] fix ${configPath()} and start again`);
		blockOutbound(errors[0] ?? "config unusable");
		console.error("[secrets-obfuscator] breaker closed: outbound model requests will fail");
		return;
	}

	let mappings: Mapping[] = config.mappings;

	// Last context any hook has seen, so a file watcher outside a hook can
	// still reach the UI.
	let uiCtx: any;

	const announce = (text: string, ctx?: any): void => {
		const source = ctx ?? uiCtx;
		const notify = source?.ui?.notify;
		if (notify) notify.call(source.ui, text, "info");
		if (process.stdout.isTTY) return;
		const fg = source?.ui?.theme?.fg;
		console.error(fg ? fg.call(source.ui.theme, "muted", text) : text);
	};

	// Hot reload. The handlers read `mappings` on every call, so a new set is
	// in force from the next hook on. A broken file is not "keep the old
	// values and hope": it closes the breaker, like a bad start.
	const reload = (): void => {
		const next = loadConfig();
		for (const warning of next.warnings) console.error(`[secrets-obfuscator] warning: ${warning}`);
		if (next.errors.length > 0) {
			console.error("[secrets-obfuscator] FATAL: config reload failed; the last good config stays armed");
			for (const error of next.errors) console.error(`[secrets-obfuscator]   ${error}`);
			uiCtx?.ui?.notify?.call(uiCtx.ui, `Config reload failed: ${next.errors[0]}`, "warning");
			blockOutbound(next.errors[0] ?? "config reload failed");
			console.error("[secrets-obfuscator] breaker closed: outbound model requests will fail");
			return;
		}
		mappings = next.config.mappings;
		announce(`Config reloaded: ${describeMappings(mappings)}`);
	};
	watchConfig(reload);

	// What the model never saw, and what the user has already been told about.
	const reported = new Set<string>();
	const caught = new Map<string, { label: string; count: number }>();
	const note = (mapping: Mapping): void => {
		const seen = caught.get(mapping.alias);
		if (seen) seen.count += 1;
		else caught.set(mapping.alias, { label: mapping.label ?? mapping.alias, count: 1 });
	};

	// Outbound, pass 1: the transcript Pi is about to serialize.
	pi.on("context", (event, ctx) => {
		if (ctx) uiCtx = ctx;
		const messages = (event as { messages?: unknown }).messages;
		if (messages === undefined) return undefined;
		return { messages: maskJson(messages, mappings, note) };
	});

	// Outbound, pass 2: provider-specific fields Pi adds after `context`
	// (system blocks, tool declarations, provider quirks).
	pi.on("before_provider_request", (event) => {
		const payload = (event as { payload?: unknown }).payload;
		if (payload === undefined) return undefined;
		return maskJson(payload, mappings, note);
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
		const patched = maskToolResult(event, mappings, note);
		const content = (patched as { content?: unknown }).content;
		if (content === undefined || content === (event as { content?: unknown }).content) return undefined;
		return { content };
	});

	// A shy note for the user, never for the model: which secrets this turn
	// replaced. Only new ones, so a long session does not repeat itself.
	pi.on("agent_end", (_event, ctx) => {
		if (ctx) uiCtx = ctx;
		if (caught.size === 0) return;
		const fresh: string[] = [];
		for (const [alias, hit] of caught) {
			if (reported.has(alias)) continue;
			reported.add(alias);
			fresh.push(`<${hit.label}> (${hit.count})`);
		}
		caught.clear();
		if (fresh.length === 0) return;
		announce(`Secrets obfuscated: ${fresh.join(", ")}`, ctx);
	});

	console.error(`[secrets-obfuscator] masking ${describeMappings(mappings)}`);
}