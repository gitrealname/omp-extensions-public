/**
 * Sweep tests: per-label reporting, apply, idempotency, locked files.
 *
 * Run: bun tests/sweep.e2e.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aliasFor, type Mapping } from "../src/mask";
import { sweep } from "../src/sweep";

let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` :: ${detail}`}`);
	if (!ok) fail += 1;
}

const SECRET = "ghp_fake_token_123456";
const mappings: Mapping[] = [{ alias: aliasFor(SECRET, "GITHUB_TOKEN"), value: SECRET, label: "GITHUB_TOKEN" }];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-sweep-"));
const hit = path.join(dir, "hit.jsonl");
const clean = path.join(dir, "clean.jsonl");
const locked = path.join(dir, "locked.jsonl");

const line = (text: string): string => JSON.stringify({ role: "user", content: text });
fs.writeFileSync(hit, `${line(`my token ${SECRET} here`)}\n`);
fs.writeFileSync(clean, `${line("nothing to see")}\n`);
fs.writeFileSync(locked, `${line(`my token ${SECRET} here`)}\n`);

// A file nobody can write stands in for a session another process holds open.
fs.chmodSync(locked, 0o444);

// Age the fixtures: a file written seconds ago is treated as live and skipped.
const old = new Date(Date.now() - 10 * 60_000);
for (const file of [hit, clean, locked]) fs.utimesSync(file, old, old);

const dry: string[] = [];
const dryResult = sweep({ root: dir, mappings, apply: false, log: (l) => dry.push(l) });

check("dry run names the label and its count", dry.some((l) => l.includes("hit.jsonl: Secrets found: <GITHUB_TOKEN> (1)")), dry.join(" | "));
check("dry run reports, does not write", fs.readFileSync(hit, "utf8").includes(SECRET));
check("clean file stays silent", !dry.some((l) => l.includes("clean.jsonl")), dry.join(" | "));
check("dry run counts files with secrets", dryResult.changed === 2, `${dryResult.changed}`);

const applied: string[] = [];
const appliedResult = sweep({ root: dir, mappings, apply: true, log: (l) => applied.push(l) });

check("apply names the label it masked", applied.some((l) => l.includes("hit.jsonl: Secrets obfuscated: <GITHUB_TOKEN> (1)")), applied.join(" | "));
check("value is gone after apply", !fs.readFileSync(hit, "utf8").includes(SECRET));
check("alias is in place", fs.readFileSync(hit, "utf8").includes("<SECRET:GITHUB_TOKEN:"));
check("locked file is flagged", applied.some((l) => l.includes("locked.jsonl: locked")), applied.join(" | "));
check("the flag names the secret", applied.some((l) => l.includes("<GITHUB_TOKEN> (1)") && l.includes("locked.jsonl")), applied.join(" | "));
check("locked file is left alone", fs.readFileSync(locked, "utf8").includes(SECRET));
check("locked count is reported", appliedResult.locked === 1, `${appliedResult.locked}`);

// Release the write lock: the next sweep can clean the file it skipped.
fs.chmodSync(locked, 0o644);
sweep({ root: dir, mappings, apply: true, log: () => {} });

const again: string[] = [];
const againResult = sweep({ root: dir, mappings, apply: true, log: (l) => again.push(l) });
check("second run is idempotent", againResult.replacements === 0, `${againResult.replacements}`);
check("nothing left to report", again.length === 0, again.join(" | "));

// A session written seconds ago may still be running: report, never rewrite.
const fresh = path.join(dir, "fresh.jsonl");
fs.writeFileSync(fresh, `${line(`my token ${SECRET} here`)}\n`);
const live: string[] = [];
const liveResult = sweep({ root: dir, mappings, apply: true, log: (l) => live.push(l) });
check("fresh file is flagged live", live.some((l) => l.includes("fresh.jsonl: live")), live.join(" | "));
check("fresh file is left alone", fs.readFileSync(fresh, "utf8").includes(SECRET));
check("live count is reported", liveResult.live === 1, `${liveResult.live}`);

fs.chmodSync(locked, 0o644);
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);