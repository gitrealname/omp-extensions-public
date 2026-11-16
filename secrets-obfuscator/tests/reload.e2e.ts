/**
 * Hot reload test: a real config file, a real directory watch, no restart.
 *
 * Run: bun tests/reload.e2e.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { breakerActive } from "../src/breaker";
import secretsObfuscator from "../src/main";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-reload-"));
const file = path.join(dir, "secrets-obfuscator.yaml");

let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` :: ${detail}`}`);
	if (!ok) fail += 1;
}

/** Editors save like this: temp file, then rename over the target. */
function save(text: string): void {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

async function until(ok: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (ok()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return ok();
}

process.env.SECRETS_OBFUSCATOR_CONFIG = file;
save("mappings:\n  TOKEN_A: alpha_value_1\n");

type Handler = (event: any, ctx: any) => unknown;
const handlers = new Map<string, Handler>();
secretsObfuscator({
	on: (event: string, handler: Handler) => {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
} as any);

const context = handlers.get("context")!;
const noted: string[] = [];
const ctx = { ui: { notify: (text: string) => noted.push(text) } };
const mentions = (text: string, marker: string): boolean => {
	const out = context({ messages: [{ role: "user", content: text }] }, ctx) as { messages: any[] };
	return JSON.stringify(out).includes(marker);
};

check("first config is armed", mentions("alpha_value_1", "<SECRET:TOKEN_A:"));

save("mappings:\n  TOKEN_A: alpha_value_1\n  TOKEN_B: beta_value_2\n");
const loaded = await until(() => mentions("beta_value_2", "<SECRET:TOKEN_B:"), 8000);
check("new value masks without a restart", loaded);
check("earlier value still masks", mentions("alpha_value_1", "<SECRET:TOKEN_A:"));
check(
	"the user is told the config changed",
	noted.some((text) => text.startsWith("Config reloaded:") && text.includes("TOKEN_B")),
	noted.join(" | "),
);

// A value that leaves the config stops being masked.
save("mappings:\n  TOKEN_B: beta_value_2\n");
const dropped = await until(() => !mentions("alpha_value_1", "<SECRET:TOKEN_A:"), 8000);
check("removed value stops being masked", dropped);

// A broken file must not leave the guard half armed.
save("mappings: [oops\n");
const stopped = await until(() => breakerActive(), 8000);
check("broken reload closes the breaker", stopped);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);