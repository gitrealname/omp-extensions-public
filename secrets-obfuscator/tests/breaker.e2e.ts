/**
 * Circuit breaker test: a config the guard cannot trust must stop omp from
 * reaching a model, not merely print a warning.
 *
 * omp swallows extension failures — process.exit is reported and unloaded, a
 * throwing hook is logged and the request still goes out — so the breaker is
 * the outbound fetch. These cases run in subprocesses to observe both.
 *
 * Run: bun tests/breaker.e2e.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dir;
const CFG_URL = pathToFileURL(path.join(HERE, "..", "src", "config.ts")).href;
const MAIN_URL = pathToFileURL(path.join(HERE, "..", "src", "main.ts")).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "so-breaker-"));

let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` :: ${detail}`}`);
	if (!ok) fail += 1;
}

interface Run {
	code: number;
	out: string;
}

function runCase(content: string | null, mode: "config" | "main"): Run {
	const file = path.join(tmp, `case-${Math.random().toString(36).slice(2)}.yaml`);
	if (content !== null) fs.writeFileSync(file, content);

	const script =
		mode === "config"
			? `const m = await import(${JSON.stringify(CFG_URL)});
const r = m.loadConfig();
console.log("errors=" + r.errors.length + " warnings=" + r.warnings.length);`
			: `const before = globalThis.fetch;
const events = [];
const m = await import(${JSON.stringify(MAIN_URL)});
m.default({ on: (event) => { events.push(event); return () => {}; } });
const patched = globalThis.fetch !== before;
let blocked = "no";
if (patched) {
  try { await globalThis.fetch("https://example.invalid/probe"); blocked = "no"; }
  catch (err) { blocked = String(err && err.message ? err.message : err).includes("guard not armed") ? "yes" : "other"; }
}
console.log("hooks=" + events.join(",") + " patched=" + patched + " blocked=" + blocked);`;

	const proc = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: path.join(HERE, ".."),
		env: { ...process.env, SECRETS_OBFUSCATOR_CONFIG: file },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

const FATAL: Array<[string, string | null]> = [
	["missing config file", null],
	["malformed yaml", "mappings:\n  A: [unclosed\n"],
	["root is a list", "- mappings\n"],
	["mappings is a list", "mappings:\n  - A\n"],
	["no mappings key", "other: 1\n"],
	["invalid label", "mappings:\n  gith-ub: x\n"],
	["empty value", "mappings:\n  A:\n"],
	["value under two labels", "mappings:\n  A: same-value\n  B: same-value\n"],
	["empty file", ""],
];

for (const [name, content] of FATAL) {
	const config = runCase(content, "config");
	check(`config reports an error: ${name}`, config.code === 0 && !config.out.includes("errors=0"), config.out.trim());
	const main = runCase(content, "main");
	check(`breaker closes, no hooks: ${name}`, main.out.includes("patched=true") && main.out.includes("blocked=yes") && main.out.includes("hooks="), `code=${main.code} ${main.out.trim()}`);
}

const OK: Array<[string, string]> = [
	["valid config", "mappings:\n  A: secret-value\n"],
	["short value only warns", "mappings:\n  A: abc\n"],
	["list value", "mappings:\n  A:\n    - one-value\n    - two-value\n"],
];

for (const [name, content] of OK) {
	const config = runCase(content, "config");
	check(`config accepted: ${name}`, config.code === 0 && config.out.includes("errors=0"), config.out.trim());
	const main = runCase(content, "main");
	check(`guard armed, hooks active: ${name}`, main.out.includes("patched=false") && main.out.includes("hooks=context,before_provider_request,tool_call,tool_result"), main.out.trim());
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);