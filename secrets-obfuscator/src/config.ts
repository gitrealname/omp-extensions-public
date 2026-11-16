/**
 * secrets-obfuscator — configuration.
 *
 * File: ~/.omp/agent/secrets-obfuscator.yaml (override with
 * SECRETS_OBFUSCATOR_CONFIG). YAML on purpose: it holds real secret values, so
 * it stays out of git and out of the model's reach, and it stays easy to edit.
 *
 * Shape:
 *   mappings:
 *     GITHUB_TOKEN: ghp_...          # one value
 *     DATABASE_PASSWORD:             # several values, one logical secret
 *       - old_password_value_123
 *       - new_password_value_456
 *
 * The key is the label. It ends up in every alias for that secret.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { aliasFor, type Mapping } from "./mask";

export interface Config {
	mappings: Mapping[];
}

export function configPath(): string {
	const override = process.env.SECRETS_OBFUSCATOR_CONFIG;
	if (override && override.trim().length > 0) return override;
	return path.join(os.homedir(), ".omp", "agent", "secrets-obfuscator.yaml");
}

/** Labels must be safe to emit into JSON strings and prose alike. */
const labelRe = /^[A-Z0-9_]{1,64}$/;

/**
 * Call onChange after the config file changes.
 *
 * Watches the directory, not the file. Editors save by writing a temp file and
 * renaming over the target, which leaves a watch on the old inode blind; the
 * directory still reports the name. Events are debounced so one save is one
 * reload.
 *
 * Falls back to fs.watchFile (poll) when no directory watch is available.
 * Returns a stop function.
 */
export function watchConfig(onChange: () => void, debounceMs = 200): () => void {
	const file = configPath();
	const dir = path.dirname(file);
	const base = path.basename(file);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const fire = (): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			onChange();
		}, debounceMs);
		timer.unref?.();
	};

	let watcher: fs.FSWatcher | undefined;
	try {
		watcher = fs.watch(dir, (_event, name) => {
			if (name && name.toString() !== base) return;
			fire();
		});
		// Never hold the process open: a short-lived run must be able to exit.
		(watcher as unknown as { unref?: () => void }).unref?.();
	} catch {
		watcher = undefined; // no directory watch: fall through to polling
	}

	if (!watcher) {
		const poll = fs.watchFile(file, { interval: 2000 }, () => fire());
		(poll as unknown as { unref?: () => void }).unref?.();
		return () => {
			if (timer) clearTimeout(timer);
			fs.unwatchFile(file);
		};
	}

	return () => {
		if (timer) clearTimeout(timer);
		watcher?.close();
	};
}

/**
 * Read the mapping file.
 *
 * Errors are fatal: the guard cannot be trusted with a partial config, so the
 * caller must stop omp instead of running unmasked. Warnings never stop omp.
 */
export function loadConfig(): { config: Config; errors: string[]; warnings: string[] } {
	const file = configPath();
	const errors: string[] = [];
	const warnings: string[] = [];
	let raw: unknown;
	try {
		raw = parseYaml(fs.readFileSync(file, "utf8"));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			errors.push(`config not found: ${file}`);
		} else {
			// Never echo the parser's code frame: it quotes the file, and that
			// file holds real secrets. First line only, plus the position.
			const first = String((err as Error).message ?? err)
				.split("\n")[0]
				.trim()
				.replace(/:$/, "");
			const pos = (err as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
			const where = pos ? ` (line ${pos.line}, column ${pos.col})` : "";
			errors.push(
				`config unreadable${where}: ${first} — quote a value that starts with @ \` % & * or contains ": "`,
			);
		}
		return { config: { mappings: [] }, errors, warnings };
	}

	const root = raw;
	if (root === null || typeof root !== "object" || Array.isArray(root)) {
		errors.push(`config root must be a map with a "mappings" key: ${file}`);
		return { config: { mappings: [] }, errors, warnings };
	}

	const mappings: Mapping[] = [];
	const byAlias = new Map<string, string>();
	const labelByValue = new Map<string, string>();
	const section = (root as Record<string, unknown>).mappings;

	if (section === undefined || section === null) {
		errors.push(`no "mappings" section in ${file}`);
	} else if (typeof section !== "object" || Array.isArray(section)) {
		errors.push(`"mappings" must be a map: label -> value or list of values`);
	} else {
		for (const [label, rawValue] of Object.entries(section as Record<string, unknown>)) {
			if (!labelRe.test(label)) {
				errors.push(`invalid label "${label}": must match ${labelRe.source}`);
				continue;
			}

			// One label can carry several values. A rotated password keeps its
			// label and gains a value, so old and new sessions both mask.
			const values: string[] = [];
			if (typeof rawValue === "string") values.push(rawValue);
			else if (Array.isArray(rawValue)) {
				for (const v of rawValue) if (typeof v === "string") values.push(v);
			}
			if (values.length === 0) {
				errors.push(`"${label}" has no value: expected a string or a list of strings`);
				continue;
			}

			for (const value of values) {
				if (!value) {
					errors.push(`"${label}" has an empty value`);
					continue;
				}
				const other = labelByValue.get(value);
				if (other !== undefined) {
					// One value cannot be two secrets. A duplicate inside the same
					// list is harmless; a second label is a config error.
					if (other === label) warnings.push(`"${label}" lists the same value twice; ignored`);
					else errors.push(`value under "${label}" is already listed under "${other}"; one value cannot carry two labels`);
					continue;
				}
				const alias = aliasFor(value, label);
				if (byAlias.has(alias)) {
					errors.push(`alias collision ${alias}: two values share one alias`);
					continue;
				}
				if (value.trim().length < 4) {
					warnings.push(`${alias}: value is only ${value.length} chars; it will also mask ordinary text`);
				}
				labelByValue.set(value, label);
				byAlias.set(alias, value);
				mappings.push({ alias, value, label });
			}
		}
	}

	if (errors.length === 0 && mappings.length === 0) errors.push(`no usable mappings in ${file}`);

	return { config: { mappings }, errors, warnings };
}

/** Redacted rendering for logs: never echo a real value. */
export function describeMappings(mappings: readonly Mapping[]): string {
	if (mappings.length === 0) return "(none)";
	const counts = new Map<string, number>();
	for (const m of mappings) {
		const label = m.label ?? m.alias;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const shown = [...counts].slice(0, 8).map(([label, n]) => (n > 1 ? `${label} x${n}` : label));
	const rest = counts.size - shown.length;
	return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}