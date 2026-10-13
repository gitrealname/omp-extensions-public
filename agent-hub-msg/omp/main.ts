/**
 * agent-hub-msg — omp extension adapter.
 *
 * Deliberately the ONLY omp-coupled module: registers the five mail tools and
 * the /msg command, maps omp events onto the harness-neutral HubSession, and
 * adapts injection to pi.sendMessage. All mechanics live in core/ — porting
 * to another agent harness means writing an adapter like this one against
 * core/ + core/api.ts. See .PLAN.md.
 */
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { HubSession } from "../core/session";
import * as api from "../core/api";

// ── Configuration (env — no core settings changes) ───────────────────────────

function env(name: string): string | undefined {
	return (typeof Bun !== "undefined" ? Bun.env : process.env)[name]?.trim() || undefined;
}

const MSG_ROOT = env("MSG_INBOX_ROOT") ?? path.join(os.homedir(), ".omp", "agent", "msg");
// This file is <pkg>/omp/main.ts; the instructions file sits at the package root.
const EXTENSION_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

const TOOL_NAMES = ["msg_send", "msg_reply", "msg_inbox", "msg_read", "msg_who"];

type SessionManagerLike = { getSessionId?: () => string } | undefined;

function sessionIdFrom(raw: unknown): string | undefined {
	if (!raw) return undefined;
	const holder = raw as { sessionManager?: SessionManagerLike };
	const sm = holder.sessionManager ?? (raw as SessionManagerLike);
	try {
		return typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
	} catch {
		return undefined;
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function agentHubMsgExtension(pi: ExtensionAPI): void {
	const debug = (msg: string) => {
		if (env("OMP_EXTENSION_DEBUG")) pi.logger.debug(`[agent-hub-msg] ${msg}`);
	};

	const session = new HubSession({
		root: MSG_ROOT,
		cwd: process.cwd(),
		instructionsDir: EXTENSION_DIR,
		seedAlias: env("MSG_ALIAS"),
		env,
		log: debug,
		inject: (content, opts) => {
			pi.sendMessage(
				{ customType: opts.customType, content, display: opts.display, attribution: "user" },
				...(opts.triggerTurn ? [{ triggerTurn: true }] : []),
			);
		},
		activateTools: async () => {
			// Union, not replace — activation must not strip other active tools.
			await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...TOOL_NAMES])]);
		},
	});

	const rememberSessionId = (ctx: unknown): void => {
		const sid = sessionIdFrom(ctx);
		if (sid) session.attach(sid);
	};

	const me = () => {
		const sid = session.sessionId;
		if (!sid) throw new Error("agent-hub-msg: session not registered yet (no session id)");
		return { sid, alias: api.myself(MSG_ROOT, sid).aliases[0] };
	};

	// ── Tool surface (one-liner descriptions by design) ──────────────────────

	pi.registerTool({
		name: "msg_send",
		label: "Send mail",
		description: 'Send a message to another agent session (to: sid, prefix, alias, comma list, or "all")',
		approval: "write",
		defaultInactive: true,
		parameters: Type.Object({
			to: Type.String({ description: 'recipient session id, unique prefix, alias, comma-separated list, or "all"' }),
			body: Type.String(),
			subject: Type.Optional(Type.String()),
			inReplyTo: Type.Optional(Type.String({ description: "message id being replied to" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			rememberSessionId(ctx);
			const res = api.sendMail(MSG_ROOT, me(), params);
			if ((res.details?.delivered as string[] | undefined)?.length) session.scheduleFastFollow();
			return { content: [{ type: "text", text: res.text }], details: res.details };
		},
	});

	pi.registerTool({
		name: "msg_reply",
		label: "Reply to mail",
		description: "Reply to a received message by id — recipients derived from the thread (all=true = reply-all)",
		approval: "write",
		defaultInactive: true,
		parameters: Type.Object({
			id: Type.String({ description: "message id being replied to" }),
			body: Type.String(),
			all: Type.Optional(Type.Boolean({ description: "reply-all instead of sender-only" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			rememberSessionId(ctx);
			const res = api.replyMail(MSG_ROOT, me(), params);
			if (res.details?.to) session.scheduleFastFollow();
			return { content: [{ type: "text", text: res.text }], details: res.details };
		},
	});

	pi.registerTool({
		name: "msg_inbox",
		label: "List mail",
		description:
			"List received mail (subjects + previews, never full bodies — use msg_read for those). Unread only by default; read:true + since for history",
		approval: "read",
		defaultInactive: true,
		parameters: Type.Object({
			read: Type.Optional(Type.Boolean({ description: "include already-read mail" })),
			since: Type.Optional(
				Type.Union([Type.String(), Type.Number()], {
					description: 'only messages at/after this time (ISO date like "2026-10-13" or epoch ms)',
				}),
			),
			limit: Type.Optional(Type.Number({ description: "max messages listed (default 50, cap 500 — most recent kept)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			rememberSessionId(ctx);
			const res = api.listInbox(MSG_ROOT, me().sid, params);
			return { content: [{ type: "text", text: res.text }], details: res.details };
		},
	});

	pi.registerTool({
		name: "msg_read",
		label: "Read mail",
		description: "Read the full body of one message by id",
		approval: "read",
		defaultInactive: true,
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			rememberSessionId(ctx);
			const res = api.readMail(MSG_ROOT, me().sid, params.id);
			return { content: [{ type: "text", text: res.text }] };
		},
	});

	pi.registerTool({
		name: "msg_who",
		label: "Agent addresses",
		description: "List your address and every registered agent session",
		approval: "read",
		defaultInactive: true,
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			rememberSessionId(ctx);
			const res = api.whoami(MSG_ROOT, me().sid);
			return { content: [{ type: "text", text: res.text }] };
		},
	});

	// ── /msg commands ────────────────────────────────────────────────────────

	pi.registerCommand("msg", {
		description: "Inter-agent mail: /msg | /msg instruct | /msg list | /msg alias <name>",
		getArgumentCompletions: prefix => {
			const options = ["", "instruct", "list", "alias "];
			return options
				.filter(o => o.startsWith(prefix))
				.map(o => ({ value: `/msg ${o}`.trim(), label: `/msg ${o}`.trim(), description: o ? "" : "activate mail tools" }));
		},
		handler: async (args, ctx) => {
			rememberSessionId(ctx);
			const [sub, ...rest] = args.trim().split(/\s+/);
			switch (sub ?? "") {
				case "": {
					await session.activate(false).catch(() => {});
					ctx.ui.notify("agent-hub-msg: mail tools active", "info");
					break;
				}
				case "instruct": {
					await session.activate(true);
					ctx.ui.notify("agent-hub-msg: instructions re-injected", "info");
					break;
				}
				case "list": {
					await session.activate(false).catch(() => {});
					const text = session.listText();
					ctx.ui.notify(text, "info");
					pi.sendMessage({ customType: "agent-hub-msg-list", content: text, display: true, attribution: "user" });
					break;
				}
				case "alias": {
					const name = rest.join(" ").trim();
					if (!name) {
						ctx.ui.notify("usage: /msg alias <name>", "warning");
						return;
					}
					const res = api.setUserAlias(MSG_ROOT, me().sid, name);
					session.register(); // refresh lastSeen while we hold a valid session
					ctx.ui.notify(res.text, res.details?.conflict ? "warning" : "info");
					break;
				}
				default:
					ctx.ui.notify(`unknown subcommand "${sub}" — /msg | instruct | list | alias <name>`, "warning");
			}
		},
	});

	// ── Activation phrases + lifecycle ───────────────────────────────────────

	pi.on("input", event => {
		session.maybeActivateByPhrase(event.text ?? "");
		return;
	});

	pi.on("session_start", (_event, ctx) => {
		rememberSessionId(ctx);
		session.start();
	});

	// Resume/restore of an existing session file — same sid, possibly new pid.
	pi.on("session_switch", (_event, ctx) => {
		rememberSessionId(ctx);
		session.register();
	});

	// After compaction the instructions may be gone from context — re-inject.
	pi.on("session_compact", () => {
		session.reinjectAfterCompact();
	});

	pi.on("agent_end", () => {
		session.clearDelivering();
	});

	pi.on("session_shutdown", () => {
		session.stop();
		// No eviction — the registry entry, mailbox, and aliases persist for
		// the next boot. lastSeen goes stale naturally (offline within 5 min).
	});
}
