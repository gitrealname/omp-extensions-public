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
}

const TARGETS = new Set([".jsonl", ".json", ".log"]);

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
export function maskLine(line: string, mappings: readonly Mapping[]): { text: string; replaced: number } {
	let replaced = 0;
	for (const m of mappings) replaced += countOccurrences(line, m.value);
	if (replaced === 0) return { text: line, replaced: 0 };

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { text: mask(line, mappings), replaced };
	}
	if (JSON.stringify(parsed) !== line) return { text: mask(line, mappings), replaced };

	return { text: JSON.stringify(maskJson(parsed, mappings)), replaced };
}

function collectFiles(dir: string, out: string[]): void {
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
	const result: SweepResult = { files: 0, changed: 0, replacements: 0 };
	const files: string[] = [];
	collectFiles(options.root, files);

	for (const file of files) {
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch (err) {
			if (options.verbose) log(`skip ${file}: ${(err as Error).message}`);
			continue;
		}
		result.files += 1;

		const eol = raw.endsWith("\n") ? "\n" : "";
		const body = eol ? raw.slice(0, -1) : raw;
		const lines = body.length === 0 ? [] : body.split("\n");

		let touched = 0;
		let replaced = 0;
		const masked: string[] = [];
		for (const line of lines) {
			const next = maskLine(line, options.mappings);
			if (next.replaced > 0) {
				touched += 1;
				replaced += next.replaced;
			}
			masked.push(next.text);
		}

		if (replaced === 0) continue;
		result.changed += 1;
		result.replacements += replaced;
		log(`${options.apply ? "masked" : "would mask"} ${file} (${replaced} in ${touched} line(s))`);

		if (!options.apply) continue;
		const temp = `${file}.secrets-obfuscator-${process.pid}.tmp`;
		fs.writeFileSync(temp, masked.join("\n") + eol, "utf8");
		fs.renameSync(temp, file);
	}

	return result;
}