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
		errors.push(code === "ENOENT" ? `config not found: ${file}` : `config unreadable (${(err as Error).message}): ${file}`);
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
				mappings.push({ alias, value });
			}
		}
	}

	if (errors.length === 0 && mappings.length === 0) errors.push(`no usable mappings in ${file}`);

	return { config: { mappings }, errors, warnings };
}

/** Redacted rendering for logs: never echo a real value. */
export function describeMappings(mappings: readonly Mapping[]): string {
	if (mappings.length === 0) return "(none)";
	const shown = mappings.slice(0, 8).map((m) => `${m.alias} <- ${m.value.length} chars`);
	const rest = mappings.length - shown.length;
	return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}