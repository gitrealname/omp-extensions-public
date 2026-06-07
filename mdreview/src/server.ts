/**
 * mdreview HTTP server.
 *
 * AI chat is handled externally via onAiQuery — the caller (main.ts) owns
 * the session and SSE forwarding. This server only handles HTTP routing,
 * document serving, and decision callbacks.
 *
 * Tab/connection close detected via req.on("close") on the SSE endpoint.
 * Idle timer (10 min) is the backstop for cases where close isn't fired.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, watch as fsWatch } from "node:fs";

export interface MdReviewDecision {
	feedback: string;
	annotations: unknown[];
	approved?: boolean;
	exit?: boolean;
}

export interface MdReviewServerOptions {
	markdown: string;
	filePath: string;
	htmlContent: string;
	cwd: string;
	/** Called when browser sends a chat query. Caller sets up SSE forwarding. */
	onAiQuery(prompt: string, sseRes: ServerResponse): void;
	/** Called when the SSE connection closes (tab closed mid-query). */
	onActiveSseClosed(): void;
	/** Called when user submits feedback, approves, or exits. */
	onDecision(decision: MdReviewDecision): void;
	/** Called to surface notifications in the host UI (tab close, errors). */
	onNotify(message: string, type?: "info" | "warning" | "error"): void;
	/** Logging function — routes to host logger instead of stderr. */
	log(msg: string): void;
}

export interface MdReviewServer {
	url: string;
	stop(): void;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c: Buffer) => { data += c.toString(); });
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const p = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
	res.end(p);
}

export async function startMdReviewServer(options: MdReviewServerOptions): Promise<MdReviewServer> {
	const { markdown, filePath, htmlContent, cwd, onAiQuery, onActiveSseClosed, onDecision, onNotify, log } = options;

	// Mutable markdown — updated when the file changes on disk
	let currentMarkdown = markdown;

	// Watch clients — SSE connections subscribed to /api/doc-watch
	const watchClients = new Set<ServerResponse>();

	// File watcher with 150ms debounce
	let watchDebounce: ReturnType<typeof setTimeout> | null = null;
	const watcher = fsWatch(filePath, () => {
		if (watchDebounce) clearTimeout(watchDebounce);
		watchDebounce = setTimeout(() => {
			try {
				currentMarkdown = readFileSync(filePath, "utf-8");
				log(`file changed, notifying ${watchClients.size} watch client(s)`);
				const payload = `data: ${JSON.stringify({ markdown: currentMarkdown })}\n\n`;
				for (const client of watchClients) {
					try { client.write(payload); } catch { watchClients.delete(client); }
				}
			} catch (err) {
				log(`file watch read error: ${err instanceof Error ? err.message : String(err)}`);
			}
		}, 150);
	});

	let decided = false;
	function decide(d: MdReviewDecision) {
		if (decided) return;
		decided = true;
		onDecision(d);
	}

	// Idle timer — backstop for when browser closes without firing /api/exit
	const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	function resetIdleTimer() {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => decide({ feedback: "", annotations: [], exit: true }), IDLE_TIMEOUT_MS);
	}

	const contextScript = `<script>
window.__MDREVIEW_CONTEXT__ = ${JSON.stringify({ filePath, cwd, aiEnabled: true })};
</script>`;
	const injectedHtml = htmlContent.replace("</head>", `${contextScript}</head>`);

	const server = createServer(async (req, res) => {
		try {
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");
			if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

			log(`${req.method} ${req.url}`);

			resetIdleTimer();

			const url = new URL(req.url ?? "/", "http://localhost");
			const pathname = url.pathname;

			// ── AI endpoints ───────────────────────────────────────────────────
			if (pathname === "/api/ai/capabilities") {
				sendJson(res, 200, { available: true, providers: [{ id: "omp", name: "OMP", capabilities: { streaming: true } }], defaultProvider: "omp" });
				return;
			}

			if (pathname === "/api/ai/session" && req.method === "POST") {
				sendJson(res, 200, { sessionId: "main", mode: "annotate", providerId: "omp" });
				return;
			}

			if (pathname === "/api/ai/query" && req.method === "POST") {
				let body: { prompt?: string } = {};
				try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
				if (!body.prompt) { sendJson(res, 400, { error: "Missing prompt" }); return; }

				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
					"Access-Control-Allow-Origin": "*",
				});

				// Detect tab close via SSE connection drop
				req.on("close", () => {
					log("SSE connection closed — tab may have closed");
					onNotify("Review tab closed", "info");
					onActiveSseClosed();

				});

				onAiQuery(body.prompt, res);
				return;
			}

			if (pathname === "/api/ai/abort" && req.method === "POST") {
				sendJson(res, 200, { ok: true });
				return;
			}

			if (pathname === "/api/ai/sessions") {
				sendJson(res, 200, { sessions: [{ id: "main", mode: "annotate", providerId: "omp" }] });
				return;
			}

			if (pathname === "/api/ai/permission" && req.method === "POST") {
				sendJson(res, 200, { ok: true });
				return;
			}

			// ── Document endpoints ─────────────────────────────────────────────

			if (pathname === "/api/doc-watch" && req.method === "GET") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
					"Access-Control-Allow-Origin": "*",
				});
				// Push current content immediately so a reconnecting tab is up-to-date
				res.write(`data: ${JSON.stringify({ markdown: currentMarkdown })}\n\n`);
				watchClients.add(res);
				req.on("close", () => watchClients.delete(res));
				return;
			}

			if (pathname === "/api/doc-content" && req.method === "GET") {
			sendJson(res, 200, { markdown: currentMarkdown, filePath }); return;
			}

			if (pathname === "/api/diff" && req.method === "GET") {
				sendJson(res, 200, { diff: "", files: [] }); return;
			}

			if (pathname === "/api/capabilities" && req.method === "GET") {
				sendJson(res, 200, { canStageFiles: false, canSwitchDiffType: false, canSwitchBase: false }); return;
			}

			if (pathname === "/api/feedback" && req.method === "POST") {
				let body: { feedback?: string; annotations?: unknown[] } = {};
				try { body = JSON.parse(await readBody(req)); } catch { /* use defaults */ }
				sendJson(res, 200, { ok: true });
				setTimeout(() => decide({
					feedback: typeof body.feedback === "string" ? body.feedback : "",
					annotations: Array.isArray(body.annotations) ? body.annotations : [],
				}), 50);
				return;
			}

			if (pathname === "/api/approve" && req.method === "POST") {
				sendJson(res, 200, { ok: true });
				setTimeout(() => decide({ feedback: "", annotations: [], approved: true }), 50);
				return;
			}

			if (pathname === "/api/exit" && req.method === "POST") {
				sendJson(res, 200, { ok: true });
				setTimeout(() => decide({ feedback: "", annotations: [], exit: true }), 50);
				return;
			}

			if (pathname === "/api/image" && req.method === "GET") {
				const p = url.searchParams.get("path");
				if (!p || !existsSync(p)) { res.writeHead(404); res.end("Not found"); return; }
				const ext = p.split(".").pop()?.toLowerCase() ?? "";
				const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
					: ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : "application/octet-stream";
				res.writeHead(200, { "Content-Type": mime });
				res.end(readFileSync(p));
				return;
			}

			if (pathname === "/api/doc" && req.method === "GET") {
				const p = url.searchParams.get("path");
				if (!p || !existsSync(p)) { res.writeHead(404); res.end("Not found"); return; }
				res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(readFileSync(p, "utf-8"));
				return;
			}

			if (pathname === "/api/draft") { sendJson(res, 200, {}); return; }

			if (pathname === "/favicon.svg") {
				res.writeHead(200, { "Content-Type": "image/svg+xml" });
				res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">M</text></svg>`);
				return;
			}

			if (pathname.startsWith("/api/")) { sendJson(res, 404, { error: "Not found" }); return; }

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(injectedHtml);
		} catch (err) {
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end(err instanceof Error ? err.message : String(err));
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => resolve());
		server.once("error", reject);
	});

	resetIdleTimer();
	const address = server.address() as { port: number };
	const url = `http://127.0.0.1:${address.port}`;
	log(`listening on ${url}`);

	return {
		url,
		stop: () => {
			if (idleTimer) clearTimeout(idleTimer);
			if (watchDebounce) clearTimeout(watchDebounce);
			watcher.close();
			for (const c of watchClients) { try { c.end(); } catch {} }
			watchClients.clear();
			server.close();
			decide({ feedback: "", annotations: [], exit: true });
		},
	};
}
