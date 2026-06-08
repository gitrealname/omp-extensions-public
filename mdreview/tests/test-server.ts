/**
 * Smoke test for mdreview server security fixes.
 * Tests: token validation, path confinement, HTML sanitization.
 * Run: cd mdreview && bun tests/test-server.ts
 */

import { startMdReviewServer } from "../src/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TOKEN = "test-token-12345";
const filePath = resolve(import.meta.dir, "../README.md");
const markdown = readFileSync(filePath, "utf-8");
const htmlContent = readFileSync(resolve(import.meta.dir, "../assets/mdreview-ui.html"), "utf-8");

const server = await startMdReviewServer({
	markdown,
	filePath,
	htmlContent,
	cwd: resolve(import.meta.dir, ".."),
	token: TOKEN,
	onAiQuery: () => {},
	onActiveSseClosed: () => {},
	onDecision: () => {},
	onNotify: () => {},
	log: () => {},
});

const baseUrl = `http://127.0.0.1:${new URL(server.url).port}`;
const tokenParam = `t=${TOKEN}`;

console.log(`Server started: ${server.url}`);

const tests: [string, boolean][] = [];

// Test 1: Valid token should succeed
const r1 = await fetch(`${baseUrl}/api/doc-content?${tokenParam}`);
tests.push(["valid token", r1.status === 200]);

// Test 2: No token should get 403
const r2 = await fetch(`${baseUrl}/api/doc-content`);
tests.push(["no token → 403", r2.status === 403]);

// Test 3: Wrong token should get 403
const r3 = await fetch(`${baseUrl}/api/doc-content?t=wrong-token`);
tests.push(["wrong token → 403", r3.status === 403]);

// Test 4: Path traversal should get 404
const r4 = await fetch(`${baseUrl}/api/doc?${tokenParam}&path=../../etc/passwd`);
tests.push(["path traversal → 404", r4.status === 404]);

// Test 5: Valid path within allowed dir should succeed
const r5 = await fetch(`${baseUrl}/api/doc?${tokenParam}&path=${encodeURIComponent(filePath)}`);
tests.push(["valid path → 200", r5.status === 200]);

// Test 6: HTML page should contain token in context
const r6 = await fetch(`${baseUrl}/?${tokenParam}`);
const html = await r6.text();
tests.push(["token in HTML", html.includes(TOKEN)]);

// Test 7: HTML should contain sanitize function
tests.push(["sanitize function", html.includes("function sanitize")]);

// Test 8: HTML should contain tokenUrl function
tests.push(["tokenUrl function", html.includes("function tokenUrl")]);

server.stop();

let passed = 0;
for (const [name, ok] of tests) {
	console.log(`  ${ok ? "✓" : "✗"} ${name}`);
	if (ok) passed++;
}
console.log(`\n${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
