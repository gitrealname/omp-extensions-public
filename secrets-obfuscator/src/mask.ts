/**
 * secrets-obfuscator — value <-> alias mapping primitives.
 *
 * An alias is derived from the label and the value, and carries a short tag of
 * the value:
 *   <SECRET:GITHUB_TOKEN:3F2A91C4>
 *
 * The tag is the first 8 hex characters of sha256(label + NUL + value). Because
 * the alias is a pure function of label and value, a session file only ever
 * contains aliases and never needs a rewrite pass, and decoding is unambiguous:
 * the label names the secret, the tag names the exact value.
 */

import { createHash } from "node:crypto";

export interface Mapping {
	/** Placeholder the model is allowed to see, e.g. <SECRET:GITHUB_TOKEN:3F2A91C4>. */
	alias: string;
	/** Real value, never sent to the model. */
	value: string;
}

/** Deterministic alias for a value under a label. The label is in the hash. */
export function aliasFor(value: string, label: string): string {
	const tag = createHash("sha256").update(`${label}\u0000${value}`, "utf8").digest("hex").slice(0, 8).toUpperCase();
	return `<SECRET:${label}:${tag}>`;
}

/** Longest alias length, used to size any tail buffer. */
export function maxAliasLength(mappings: readonly Mapping[]): number {
	let max = 0;
	for (const m of mappings) if (m.alias.length > max) max = m.alias.length;
	return max;
}

/**
 * Replace every occurrence of every real value with its alias.
 * Leftmost-longest wins when values overlap.
 *
 * A value can reach the transcript in two spellings: as itself, or with JSON
 * escaping when it sits inside serialised JSON that was never parsed
 * (`pa"ss` arrives as `pa\"ss`). Both spellings map to the same alias.
 */
export function mask(text: string, mappings: readonly Mapping[]): string {
	if (mappings.length === 0 || text.length === 0) return text;

	// Bucket by first byte so each candidate start position does one lookup.
	const buckets = new Map<string, Array<{ text: string; alias: string }>>();
	for (const m of mappings) {
		if (m.value.length === 0) continue;
		const spellings = new Set([m.value]);
		const escaped = JSON.stringify(m.value).slice(1, -1);
		if (escaped !== m.value) spellings.add(escaped);
		for (const spelling of spellings) {
			if (spelling.length === 0) continue;
			const key = spelling[0]!;
			const list = buckets.get(key);
			const entry = { text: spelling, alias: m.alias };
			if (list) list.push(entry);
			else buckets.set(key, [entry]);
		}
	}

	let out = "";
	let i = 0;
	while (i < text.length) {
		const candidates = buckets.get(text[i]!);
		let hit: { text: string; alias: string } | undefined;
		if (candidates) {
			for (const candidate of candidates) {
				if (text.startsWith(candidate.text, i) && (!hit || candidate.text.length > hit.text.length)) hit = candidate;
			}
		}
		if (hit) {
			out += hit.alias;
			i += hit.text.length;
			continue;
		}
		out += text[i];
		i += 1;
	}
	return out;
}

/**
 * Replace every occurrence of every alias with its real value.
 * Longest alias first so <SECRET:A> cannot eat <SECRET:AB>.
 */
export function restore(text: string, mappings: readonly Mapping[]): string {
	if (mappings.length === 0 || text.length === 0) return text;
	const ordered = [...mappings].sort((a, b) => b.alias.length - a.alias.length);
	let out = text;
	for (const m of ordered) out = out.split(m.alias).join(m.value);
	return out;
}

/** Recursively mask every string value in a decoded JSON payload. */
export function maskJson(value: unknown, mappings: readonly Mapping[]): unknown {
	if (typeof value === "string") return mask(value, mappings);
	if (Array.isArray(value)) return value.map((v) => maskJson(v, mappings));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskJson(v, mappings);
		return out;
	}
	return value;
}

/** Recursively restore aliases inside a decoded JSON payload. */
export function restoreJson(value: unknown, mappings: readonly Mapping[]): unknown {
	if (typeof value === "string") return restore(value, mappings);
	if (Array.isArray(value)) return value.map((v) => restoreJson(v, mappings));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = restoreJson(v, mappings);
		return out;
	}
	return value;
}

/**
 * Restore aliases inside a structure the caller cannot reassign (tool_call
 * input), mutating in place and returning the same object.
 */
export function restoreInPlace<T>(target: T, mappings: readonly Mapping[]): T {
	if (typeof target === "string") return restore(target, mappings) as unknown as T;
	if (Array.isArray(target)) {
		for (let i = 0; i < target.length; i += 1) target[i] = restoreInPlace(target[i], mappings);
		return target;
	}
	if (target && typeof target === "object") {
		const record = target as Record<string, unknown>;
		for (const key of Object.keys(record)) record[key] = restoreInPlace(record[key], mappings);
		return target;
	}
	return target;
}

/** Mask the text blocks of a tool result, preserving every other field. */
export function maskToolResult<T>(result: T, mappings: readonly Mapping[]): T {
	if (!result || typeof result !== "object") return result;
	const record = result as Record<string, unknown>;
	const content = record.content;
	if (!Array.isArray(content)) return result;
	const masked = content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const b = block as Record<string, unknown>;
		if (typeof b.text !== "string") return block;
		const text = mask(b.text, mappings);
		if (text === b.text) return block;
		b.text = text;
		return b;
	});
	return { ...record, content: masked } as T;
}