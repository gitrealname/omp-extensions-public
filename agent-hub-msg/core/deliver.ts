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

/** Reply chains deeper than this are delivered flagged, and agents should not auto-reply. */
export const MAX_HOPS = 6;

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

function header(frame: MailFrame, describe: (sid: string) => string): string {
	const from = frame.fromAlias ? `${frame.fromAlias} (${frame.from})` : describe(frame.from);
	const subject = frame.subject ? ` — ${frame.subject}` : "";
	const thread = frame.inReplyTo ? ` (re: ${threadOf(frame).slice(-8)})` : "";
	const hops = (frame.hops ?? 0) >= MAX_HOPS ? " [deep thread — reply only if the user asks]" : "";
	return `[mail from ${from}${subject}${thread} | id: ${frame.id}]${hops}`;
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
): string {
	const lines: string[] = [];
	for (const frame of bundle.frames) {
		lines.push(header(frame, describe));
		lines.push(resolve(frame).trimEnd());
		lines.push("");
	}
	lines.push(
		`(${bundle.frames.length === 1 ? "1 message" : `${bundle.frames.length} messages`} from ${describe(bundle.from)} — reply with msg_reply using the id shown above (all=true to reply-all), or ignore.)`,
	);
	return lines.join("\n").trim();
}
