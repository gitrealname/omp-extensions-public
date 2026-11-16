/**
 * secrets-obfuscator — session sweep.
 *
 * Walks a sessions tree and replaces every configured secret value with its
 * alias, in place. Use it to clean sessions recorded before the extension was
 * installed, or after a new secret was added to the config.
 *
 * The sweep is idempotent: a file that only contains aliases is left untouched.
 */

import fs from "node:fs";
import path from "node:path";
import { mask, maskJson, type Mapping } from "./mask";

export interface SweepOptions {
	/** Sessions root, e.g. ~/.omp/agent/sessions. */
	root: string;
	mappings: Mapping[];
	/** Write changes. When false the sweep only reports. */
	apply: boolean;
	verbose?: boolean;
	log?: (line: string) => void;
}

export interface SweepResult {
	/** Files inspected. */
	files: number;
	/** Files whose content changed. */
	changed: number;
	/** Secret values replaced across all files. */
	replacements: number;
	/** Files that hold secrets but could not be written. */
	locked: number;
	/** Files left alone because they were written seconds ago. */
	live: number;
}

const TARGETS = new Set([".jsonl", ".json", ".log"]);

/** A file written this recently may belong to a session that is still running. */
const LIVE_MS = 60_000;

function countOccurrences(text: string, value: string): number {
	if (value.length === 0) return 0;
	let count = 0;
	let at = text.indexOf(value);
	while (at !== -1) {
		count += 1;
		at = text.indexOf(value, at + value.length);
	}
	return count;
}

/**
 * Mask one line. Structured lines (JSON) are masked field by field so the
 * surrounding data keeps its meaning. Lines that do not round-trip through
 * JSON are masked as plain text so the original formatting survives.
 */
export interface LineMask {
	text: string;
	replaced: number;
	/** Alias -> occurrences found in the source line. Empty when nothing hit. */
	hits: Map<string, number>;
}

const NO_HITS: Map<string, number> = new Map();

function hitsOf(line: string, mappings: readonly Mapping[]): Map<string, number> {
	const hits = new Map<string, number>();
	for (const m of mappings) {
		const found = countOccurrences(line, m.value);
		if (found > 0) hits.set(m.alias, found);
	}
	return hits;
}

export function maskLine(line: string, mappings: readonly Mapping[]): LineMask {
	let replaced = 0;
	for (const m of mappings) replaced += countOccurrences(line, m.value);
	if (replaced === 0) return { text: line, replaced: 0, hits: NO_HITS };

	const hits = hitsOf(line, mappings);
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { text: mask(line, mappings), replaced, hits };
	}
	if (JSON.stringify(parsed) !== line) return { text: mask(line, mappings), replaced, hits };

	return { text: JSON.stringify(maskJson(parsed, mappings)), replaced, hits };
}

/**
 * Why a file cannot be rewritten, or null when it can. omp keeps a live
 * session file open; on Windows a write open then fails with EBUSY.
 */
function lockReason(file: string): string | null {
	try {
		fs.closeSync(fs.openSync(file, "r+"));
		return null;
	} catch (err) {
		const code = (err as { code?: string }).code;
		return code ?? (err as Error).message;
	}
}

function collectFiles(dir: string, out: string[]): void {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(dir);
	} catch {
		return;
	}
	if (stat.isFile()) {
		if (TARGETS.has(path.extname(dir).toLowerCase())) out.push(dir);
		return;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectFiles(full, out);
			continue;
		}
		if (!entry.isFile()) continue;
		if (TARGETS.has(path.extname(entry.name).toLowerCase())) out.push(full);
	}
}

export function sweep(options: SweepOptions): SweepResult {
	const log = options.log ?? ((line: string) => console.log(line));
	const result: SweepResult = { files: 0, changed: 0, replacements: 0, locked: 0, live: 0 };
	const files: string[] = [];
	collectFiles(options.root, files);

	const labelOf = new Map<string, string>();
	for (const m of options.mappings) labelOf.set(m.alias, m.label ?? m.alias);

	for (const file of files) {
		let raw: string;
		let writtenAt = 0;
		try {
			writtenAt = fs.statSync(file).mtimeMs;
			raw = fs.readFileSync(file, "utf8");
		} catch (err) {
			if (options.verbose) log(`skip ${file}: ${(err as Error).message}`);
			continue;
		}
		result.files += 1;

		const eol = raw.endsWith("\n") ? "\n" : "";
		const body = eol ? raw.slice(0, -1) : raw;
		const lines = body.length === 0 ? [] : body.split("\n");

		const hits = new Map<string, number>();
		let replaced = 0;
		const masked: string[] = [];
		for (const line of lines) {
			const next = maskLine(line, options.mappings);
			if (next.replaced > 0) {
				replaced += next.replaced;
				for (const [alias, count] of next.hits) {
					const label = labelOf.get(alias) ?? alias;
					hits.set(label, (hits.get(label) ?? 0) + count);
				}
			}
			masked.push(next.text);
		}

		// No secret, no report: a clean session stays silent.
		if (replaced === 0) continue;

		result.changed += 1;
		result.replacements += replaced;
		const detail = [...hits].map(([label, count]) => `<${label}> (${count})`).join(", ");

		// A live session writes as it works: rewriting it under the agent would
		// drop its later lines. Leave a file touched in the last minute alone.
		if (Date.now() - writtenAt < LIVE_MS) {
			result.live += 1;
			log(`${file}: live, ${detail} not ${options.apply ? "masked" : "maskable"} (written seconds ago)`);
			continue;
		}

		// Cannot be written at all: read-only, or held with an exclusive lock.
		const lock = lockReason(file);
		if (lock) {
			result.locked += 1;
			log(`${file}: locked, ${detail} not ${options.apply ? "masked" : "maskable"} (${lock})`);
			continue;
		}

		log(`${file}: ${options.apply ? "Secrets obfuscated" : "Secrets found"}: ${detail}`);
		if (!options.apply) continue;

		const temp = `${file}.secrets-obfuscator-${process.pid}.tmp`;
		fs.writeFileSync(temp, masked.join("\n") + eol, "utf8");
		fs.renameSync(temp, file);
	}

	return result;
}