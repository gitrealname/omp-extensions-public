/**
 * mdreview extension — interactive markdown review with annotation and AI chat.
 *
 * Registers the /mdreview slash command. Dispatch via slash_proxy.
 *
 * AI chat routes through the main session (no subprocess, no new agent):
 *   - pi.on("message_update") / pi.on("agent_end") registered at load time
 *   - activeSse holds the current browser SSE response when a chat query is in flight
 *   - pi.sendMessage({ triggerTurn: true }) drives inference from the HTTP handler
 *
 * Command handler is non-blocking — returns as soon as the browser opens.
 * Feedback injected via pi.sendMessage({ triggerTurn: true }) from the onDecision callback.
 */

import { resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { startMdReviewServer, type MdReviewDecision } from "./server";

// ── HTML asset ────────────────────────────────────────────────────────────────

function loadHtml(): string {
	const candidates = [
		resolvePath(import.meta.dir ?? __dirname, "../assets/mdreview-ui.html"),
		resolvePath(process.cwd(), "extensions/mdreview/assets/mdreview-ui.html"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return readFileSync(p, "utf-8");
	}
	throw new Error("mdreview: UI asset not found (mdreview-ui.html)");
}

// ── Open browser ──────────────────────────────────────────────────────────────

function openInBrowser(url: string, browserPath?: string): void {
	const { execFile } = require("node:child_process") as typeof import("node:child_process");
	if (browserPath) { execFile(browserPath, [url]); return; }
	const platform = process.platform;
	if (platform === "win32") execFile("cmd", ["/c", "start", "", url]);
	else if (platform === "darwin") execFile("open", [url]);
	else execFile("xdg-open", [url]);
}

// ── Format decision as feedback ───────────────────────────────────────────────

function formatDecision(decision: MdReviewDecision, filePath: string): string {
	// Normalize to forward slashes for LLM readability
	const normalizedPath = filePath.replace(/\\/g, "/");

	if (decision.approved) return `The user approved: ${normalizedPath}`;
	if (!decision.feedback && (!decision.annotations || decision.annotations.length === 0)) {
		return `The user closed the review of ${normalizedPath} without providing feedback.`;
	}

	const rawFeedback = (typeof decision.feedback === "string" ? decision.feedback : "").trim();

	const lines: string[] = [`# Review: ${normalizedPath}`, ""];

	if (rawFeedback) lines.push(rawFeedback);

	lines.push("", "Please address the annotation feedback above.");
	return lines.join("\n");
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function mdreviewExtension(pi: ExtensionAPI): void {
	const debug = (msg: string, meta?: Record<string, unknown>) => {
		const v = (typeof Bun !== "undefined" ? (Bun.env as Record<string, string | undefined>) : process.env).OMP_EXTENSION_DEBUG;
		if (v === "1" || v?.toUpperCase() === "TRUE") pi.logger.debug(`[mdreview] ${msg}`, { source: "mdreview", ...meta });
	};

	debug("loaded");

	// ── AI chat streaming ──────────────────────────────────────────────────────
	// activeSse is set when the browser has an open /api/ai/query SSE connection.
	// isBrowserTurn gates forwarding so normal TUI turns are not sent to the browser.
	let activeSse: ServerResponse | null = null;
	let isBrowserTurn = false;

	pi.on("message_update", (event: Record<string, unknown>) => {
		if (!activeSse || !isBrowserTurn) return;
		const ev = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
		if (ev?.type === "text_delta" && typeof ev.delta === "string") {
			try { activeSse.write(`data: ${JSON.stringify({ type: "text_delta", delta: ev.delta })}\n\n`); } catch { /* connection dropped */ }
		}
	});

	pi.on("agent_end", () => {
		if (!activeSse || !isBrowserTurn) return;
		isBrowserTurn = false;
		try { activeSse.write("data: [DONE]\n\n"); activeSse.end(); } catch { /* already closed */ }
		activeSse = null;
	});

	// ── Active server reference ────────────────────────────────────────────────
	let activeServer: Awaited<ReturnType<typeof startMdReviewServer>> | null = null;

	pi.on("session_shutdown", async () => {
		activeServer?.stop();
		activeServer = null;
	});

	// ── /mdreview command ──────────────────────────────────────────────────────
	pi.registerCommand("mdreview", {
		description: "Open a markdown file for interactive review with annotation and AI chat",
		argumentHint: "<file-path>",
		inlineHint: "<file-path>",
		handler: async (args, ctx) => {
			const filePath = args.trim();
			if (!filePath) { ctx.ui.notify("Usage: /mdreview <path-to-file.md>", "error"); return; }

			const resolvedPath = resolvePath(ctx.cwd, filePath);
			if (!existsSync(resolvedPath)) { ctx.ui.notify(`mdreview: file not found: ${resolvedPath}`, "error"); return; }

			let markdown: string;
			try { markdown = readFileSync(resolvedPath, "utf-8"); }
			catch (err) { ctx.ui.notify(`mdreview: cannot read file: ${err instanceof Error ? err.message : String(err)}`, "error"); return; }

			let htmlContent: string;
			try { htmlContent = loadHtml(); }
			catch (err) { ctx.ui.notify(`mdreview: ${err instanceof Error ? err.message : String(err)}`, "error"); return; }

			// Stop any existing review session
			activeServer?.stop();
			activeSse = null;
			isBrowserTurn = false;

			// Security: per-session auth token for the local HTTP server
			const token = randomUUID();

			// Start server — non-blocking
			try {
				activeServer = await startMdReviewServer({
					markdown,
					filePath: resolvedPath,
					htmlContent,
					cwd: ctx.cwd,
					token,
					onAiQuery: (prompt, sseRes) => {
						activeSse = sseRes;
						isBrowserTurn = true;
						debug("AI chat query", { promptLen: prompt.length });
						pi.sendMessage(
							{ customType: "mdreview-chat", content: prompt, display: true, attribution: "user" },
							{ triggerTurn: true },
						);
					},
					onActiveSseClosed: () => {
						activeSse = null;
						isBrowserTurn = false;
					},
					onDecision: (decision) => {
						debug("decision received", { approved: decision.approved, exit: decision.exit });
						activeServer?.stop();
						activeServer = null;
						activeSse = null;
						isBrowserTurn = false;
						ctx.ui.setStatus("mdreview", "");
						if (decision.exit) {
							ctx.ui.notify("Review session closed without feedback", "info");
							return;
						}
						pi.sendMessage(
							{ customType: "mdreview-feedback", content: formatDecision(decision, resolvedPath), display: true, attribution: "user" },
							{ triggerTurn: true },
						);
					},
					onNotify: (msg, type) => ctx.ui.notify(msg, type),
					log: (msg) => debug(msg),
				});
			} catch (err) {
				ctx.ui.notify(`mdreview: server failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			// Inject document into session context (silent — no turn triggered)
			pi.sendMessage({
				customType: "mdreview-context",
				content: `Reviewing: ${resolvedPath}\n\n${markdown}`,
				display: false,
				attribution: "system",
			});

			debug("server started", { url: activeServer.url });
			ctx.ui.setStatus("mdreview", `Review open — ${activeServer.url}`);
			openInBrowser(activeServer.url, (process.env.MDREVIEW_BROWSER ?? "").trim() || undefined);

			// Return immediately — TUI is free
		},
	});
}
