/**
 * msg — read-only CLI inspector over the agent-hub-msg mail root.
 *
 * The same library the extension runs on (core/ has zero harness deps), so
 * what you see here is exactly what the agents see. Troubleshooting without a
 * session: registry, inboxes, pending/unanswered queues.
 *
 * Usage:
 *   bun run cli/msg.ts who                     — registry + online/offline
 *   bun run cli/msg.ts inbox <sid|alias>       — all frames to that session (TOC)
 *   bun run cli/msg.ts read <sid|alias> <id>   — full body of one frame
 *   bun run cli/msg.ts pending <sid|alias>     — delivered-but-unanswered (reminder queue)
 *
 * Read-only by design: no send, no state writes.
 */
import * as path from "node:path";
import { allForMe, pendingFor, readMailbox, resolveBody } from "../core/mailbox";
import { listSessions, resolveAddress } from "../core/registry";
import { relativeAge } from "../core/api";

const MSG_ROOT = process.env.MSG_INBOX_ROOT?.trim() || path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".omp", "agent", "msg");

function fail(message: string): never {
	console.error(`msg: ${message}`);
	process.exit(1);
}

function target(key: string): string {
	const res = resolveAddress(MSG_ROOT, key);
	if (!res.address) fail(res.error ?? `no such agent "${key}"`);
	return res.address!.sid;
}

function header(frame: { id: string; from: string; to: string[]; subject?: string; inReplyTo?: string; ack?: boolean; ts: string; hops?: number }, me: string): string {
	const sub = frame.subject ? ` — ${frame.subject}` : "";
	const irt = frame.inReplyTo ? ` (re: ${frame.inReplyTo.slice(-8)})` : "";
	const flags = [frame.ack ? "ack" : "", (frame.hops ?? 0) >= 6 ? "deep" : ""].filter(Boolean).join(",");
	return `${frame.id}  from ${frame.from === me ? "self" : frame.from.slice(0, 12)}  ${frame.ts}${sub}${irt}${flags ? ` [${flags}]` : ""}`;
}

const [cmd, key, id] = process.argv.slice(2);

switch (cmd ?? "who") {
	case "who": {
		const now = Date.now();
		for (const { sid, entry, live } of listSessions(MSG_ROOT, now)) {
			const status = live ? "" : " (offline)";
			const aliases = entry.aliases.length > 0 ? ` [${entry.aliases.join(", ")}]` : "";
			const pending = pendingFor(MSG_ROOT, sid, sid).length;
			console.log(`${sid}  pid ${entry.pid ?? "?"}  ${relativeAge(entry.lastSeen, now)}${aliases} (${entry.cwd})${status}${pending > 0 ? `  PENDING:${pending}` : ""}`);
		}
		break;
	}
	case "inbox": {
		if (!key) fail("usage: msg inbox <sid|alias>");
		const sid = target(key);
		const frames = allForMe(MSG_ROOT, sid, sid);
		if (frames.length === 0) {
			console.log("(empty)");
			break;
		}
		for (const f of frames) console.log(header(f, sid));
		break;
	}
	case "read": {
		if (!key || !id) fail("usage: msg read <sid|alias> <id-prefix>");
		const sid = target(key);
		const { frames } = readMailbox(MSG_ROOT, sid);
		const frame = frames.find(f => f.id === id) ?? frames.find(f => f.id.startsWith(id));
		if (!frame) fail(`no frame "${id}" in ${sid}'s mailbox`);
		console.log(header(frame, sid));
		console.log("");
		console.log(resolveBody(MSG_ROOT, frame));
		break;
	}
	case "pending": {
		if (!key) fail("usage: msg pending <sid|alias>");
		const sid = target(key);
		const frames = pendingFor(MSG_ROOT, sid, sid);
		if (frames.length === 0) {
			console.log("(nothing pending)");
			break;
		}
		for (const f of frames) console.log(header(f, sid));
		break;
	}
	default:
	fail(`unknown command "${cmd}" — who | inbox | read | pending`);
}
