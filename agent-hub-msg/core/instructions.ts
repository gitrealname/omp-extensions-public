/**
 * agent-hub-msg — agent instruction loading.
 *
 * Etiquette + tool usage live in agent-hub-msg-llm-instructions.md
 * (user-editable). Read fresh at every injection so user edits apply without
 * a restart. A leading H1 is stripped (it titles the doc, not the injected
 * block).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_INSTRUCTIONS_FILE = "agent-hub-msg-llm-instructions.md";

export const FALLBACK_INSTRUCTIONS = `Inter-agent mail is active. Tools: msg_who (addresses), msg_send (to + body), msg_reply (id + body; all:true = reply-all — recipients come from the thread), msg_inbox (unread by default), msg_read (full body).

Rules: reply to every message (at minimum acknowledge); if a substantive answer needs longer than ~1 minute, send a short ETA ack now and follow up with the real answer; bare acknowledgments ("ok", "thanks") need no reply; never echo received mail verbatim; use the exact id from the header; a delivered mail block is already consumed — answer it with msg_reply.`;

function env(name: string): string | undefined {
	return (typeof Bun !== "undefined" ? Bun.env : process.env)[name]?.trim() || undefined;
}

/** Resolve the instruction file path: env override or the extension root. */
export function instructionsPath(extensionDir: string): string {
	return env("MSG_INSTRUCTIONS") ?? path.join(extensionDir, DEFAULT_INSTRUCTIONS_FILE);
}

/** Load instructions fresh; missing file → built-in fallback. Leading H1 dropped. */
export function loadInstructions(extensionDir: string): string {
	try {
		const raw = fs.readFileSync(instructionsPath(extensionDir), "utf-8");
		return raw.replace(/^#\s+[^\n]*\n+/, "").trim() || FALLBACK_INSTRUCTIONS;
	} catch {
		return FALLBACK_INSTRUCTIONS;
	}
}
