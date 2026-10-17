/**
 * agent-hub-msg delivery — batching, formatting, loop protection.
 *
 * Batching rule: messages from the SAME sender that arrive together are
 * delivered in one bundle (one turn); each distinct sender gets its own
 * bundle, oldest first.
 *
 * Bodies are spliced in full (spool files resolved by the caller) — the LLM
 * never needs a file read for mail.
 */
import type { MailFrame } from "./mailbox";
import { isFyi } from "./mailbox";

/** Reply chains deeper than this are delivered flagged, and agents should not auto-reply. */
export const MAX_HOPS = 6;

/** Etiquette version, stamped on every delivered envelope. Bump when the rules text
 *  or the envelope format changes materially so operators/agents can tell which
 *  rule set a session holds. v3: anchor line (bold count+sender, italic stamp),
 *  per-frame subject line with italic metadata bracket. */
export const ETIQUETTE_VERSION = 3;

export interface Bundle {
	from: string;
	frames: MailFrame[];
}

/** Group frames into per-sender bundles, preserving mailbox order. */
export function batchBySender(frames: MailFrame[]): Bundle[] {
	const bundles: Bundle[] = [];
	for (const frame of frames) {
		const last = bundles[bundles.length - 1];
		if (last && last.from === frame.from) last.frames.push(frame);
		else bundles.push({ from: frame.from, frames: [frame] });
	}
	return bundles;
}

/** Send-side loop guard: refuse to send a frame whose hop depth exceeds the cap. */
export function nextHops(parent: MailFrame | undefined): number {
	return (parent?.hops ?? 0) + 1;
}

/**
 * Per-frame reply-duty field — ABSENT when a reply is expected (default), so
 * the header only carries metadata that deviates, like CC/BCC. One structured
 * field replaces per-case rules text; the rules reference `reply:` once.
 */
function replyField(frame: MailFrame): string {
	if (frame.ack) return "reply: none — ack closes the thread";
	if (isFyi(frame)) return "reply: none — FYI";
	if ((frame.hops ?? 0) >= MAX_HOPS) return "reply: user-only — deep thread";
	return "";
}

/** Per-frame subject line: subject (or placeholder) with the italic metadata
 *  bracket — id is the reply address, re: points at the thread root, reply:
 *  appears only when it deviates from "answer expected". */
function frameLine(frame: MailFrame): string {
	const meta = [`id: ${frame.id}`];
	if (frame.inReplyTo) meta.push(`re: ${threadOf(frame).slice(-8)}`);
	const reply = replyField(frame);
	if (reply) meta.push(reply);
	return `## ${frame.subject || "(no subject)"} *[${meta.join(" | ")}]*`;
}

function threadOf(frame: MailFrame): string {
	return frame.inReplyTo ?? frame.id;
}

/**
 * Format a bundle as one injectable prompt block. `resolve` returns the full
 * text of a frame (splicing spool bodies); `describe` renders a session id as
 * a human name (alias preferred).
 */
export function formatBundle(
	bundle: Bundle,
	resolve: (frame: MailFrame) => string,
	describe: (sid: string) => string,
	opts: { stale?: boolean } = {},
): string {
	const lines: string[] = [];
	// Anchor — the only per-bundle line: bold sender + count, then the
	// provenance stamp as italic tail (and the stale suffix for inert
	// backlog). The full rules live in the injected instructions block
	// (guaranteed present: first contact, post-compaction force re-inject,
	// drift refresh); the stamp is the per-delivery pointer, not a repeat.
	const n = bundle.frames.length;
	const sender = describe(bundle.from);
	const label =
		sender === bundle.from && bundle.frames[0]?.fromAlias
			? `${bundle.frames[0].fromAlias} (${bundle.from.slice(-6)})`
			: sender;
	lines.push(
		`# **${n} ${n === 1 ? "mail" : "mails"} from ${label}** *[agent mail v${ETIQUETTE_VERSION} — reply via msg_reply]*${opts.stale ? " *[STALE — thread inactive past the freshness window: reference only, do not act unless the user asks.]*" : ""}`,
	);
	for (const frame of bundle.frames) {
		lines.push(frameLine(frame));
		lines.push(resolve(frame).trimEnd());
		lines.push("");
	}
	// Trailer only for fan-out — the one fact the anchor and brackets don't
	// carry (count is in the anchor, stale handling in the anchor suffix).
	const recipients = bundle.frames[0]?.to.filter(t => t !== "all") ?? [];
	const broadcast = recipients.length > 1 || (bundle.frames[0]?.to.includes("all") ?? false);
	if (broadcast) {
		lines.push(`(broadcast to ${recipients.length || "several"} agents: reply to the sender only, never all=true.)`);
	}
	return lines.join("\n").trim();
}
