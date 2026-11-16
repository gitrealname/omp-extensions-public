#!/usr/bin/env bun
/**
 * secrets-obfuscator — session sweep CLI.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   bun src/cli.ts                      report what would change
 *   bun src/cli.ts --apply              mask every session file
 *   bun src/cli.ts --root <dir>         sweep another tree
 *   bun src/cli.ts --config <file>      use another mapping file
 */

import os from "node:os";
import path from "node:path";
import { configPath, describeMappings, loadConfig } from "./config";
import { sweep } from "./sweep";

function option(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	if (at === -1) return undefined;
	const value = process.argv[at + 1];
	return value && !value.startsWith("--") ? value : "";
}

const flags = new Set(process.argv.slice(2));

if (flags.has("--help") || flags.has("-h")) {
	console.log(
		[
			"Usage: bun src/cli.ts [--root <dir|file>] [--config <file>] [--apply] [--verbose]",
			"",
			"  --root     sessions root, or one session file (default: ~/.omp/agent/sessions)",
			"  --config   mapping file (default: ~/.omp/agent/secrets-obfuscator.yaml)",
			"  --apply    write changes; without it the sweep only reports",
			"  --verbose  log every file read",
		].join("\n"),
	);
	process.exit(0);
}

const explicitConfig = option("--config");
if (explicitConfig !== undefined && explicitConfig.length > 0) {
	process.env.SECRETS_OBFUSCATOR_CONFIG = explicitConfig;
}

const { config, errors, warnings } = loadConfig();
for (const error of errors) console.error(`[secrets-obfuscator] error: ${error}`);
for (const warning of warnings) console.error(`[secrets-obfuscator] warning: ${warning}`);
if (errors.length > 0 || config.mappings.length === 0) {
	console.error(`[secrets-obfuscator] no usable mappings in ${configPath()}; nothing to sweep`);
	process.exit(1);
}

const root = option("--root") || path.join(os.homedir(), ".omp", "agent", "sessions");
const apply = flags.has("--apply");
const verbose = flags.has("--verbose");

console.log(`[secrets-obfuscator] root: ${root}`);
console.log(`[secrets-obfuscator] config: ${configPath()}`);
console.log(`[secrets-obfuscator] masking ${describeMappings(config.mappings)}`);
if (!apply) console.log("[secrets-obfuscator] dry run: no file will be written");

const result = sweep({ root, mappings: config.mappings, apply, verbose });

console.log(
	`[secrets-obfuscator] ${result.files} file(s) scanned, ${result.changed} with secrets, ${result.replacements} value(s) ${apply ? "masked" : "would be masked"}, ${result.locked} locked, ${result.live} live`,
);