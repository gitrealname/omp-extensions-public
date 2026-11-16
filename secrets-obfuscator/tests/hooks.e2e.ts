/**
 * Hook-level test: no network, no model. Drives the four handlers with the
 * payloads Pi hands them.
 *
 * Run: bun tests/hooks.e2e.ts
 */

import { aliasFor } from "../src/mask";
import secretsObfuscator from "../src/main";

const SECRET = "ghp_realtokenvalue123456789";
const ALIAS = aliasFor(SECRET, "GITHUB_TOKEN");

// Isolated config for this run.
process.env.SECRETS_OBFUSCATOR_CONFIG = "D:/.ai/OMP/src/omp-extensions-public/secrets-obfuscator/tests/hooks.config.yaml";

type Handler = (event: any, ctx: any) => unknown;
const handlers = new Map<string, Handler>();
const pi = {
	on: (event: string, handler: Handler) => {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
};

let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` :: ${detail}`}`);
	if (!ok) fail += 1;
}

secretsObfuscator(pi as any);

check("context handler registered", handlers.has("context"));
check("tool_call handler registered", handlers.has("tool_call"));
check("tool_result handler registered", handlers.has("tool_result"));
check("before_provider_request registered", handlers.has("before_provider_request"));

// 1. Outbound: the transcript is masked before the LLM call.
const contextEvent = {
	messages: [
		{ role: "user", content: `my token is ${SECRET}` },
		{ role: "assistant", content: [{ type: "text", text: `stored ${SECRET} for later` }] },
	],
};
const maskedContext = handlers.get("context")!(contextEvent, {}) as { messages: any[] };
const dumped = JSON.stringify(maskedContext);
check("context masks user message", maskedContext.messages[0].content.includes(ALIAS), maskedContext.messages[0].content);
check("context masks assistant parts", maskedContext.messages[1].content[0].text.includes(ALIAS));
check("context leaves no real value", !dumped.includes(SECRET));

// 2. Provider payload safety net.
const payload = handlers.get("before_provider_request")!({ payload: { messages: [{ content: SECRET }] } }, {});
check("payload masked", !JSON.stringify(payload).includes(SECRET), JSON.stringify(payload));

// 3. Inbound: a tool call carrying an alias runs the real value.
const toolEvent = { toolName: "bash", input: { command: `curl -H "Authorization: Bearer ${ALIAS}"` } };
handlers.get("tool_call")!(toolEvent, {});
check("tool_call restores input", toolEvent.input.command.includes(SECRET), toolEvent.input.command);

// 4. Inbound: tool output is masked before the model sees it.
const resultEvent = { toolName: "bash", content: [{ type: "text", text: `GITHUB_TOKEN=${SECRET}` }] };
const patch = handlers.get("tool_result")!(resultEvent, {}) as { content?: any[] };
check("tool_result masks output", !!patch?.content?.[0]?.text.includes(ALIAS), JSON.stringify(patch));
check("tool_result hides real value", !JSON.stringify(patch).includes(SECRET));

// 5. Idempotence: masking a masked transcript changes nothing.
const twice = handlers.get("context")!(maskedContext, {}) as { messages: any[] };
check("masking is idempotent", JSON.stringify(twice) === JSON.stringify(maskedContext));

// 6. One label, several values: each value carries its own tag.
const OLD = "old_password_value_123";
const NEW = "new_password_value_456";
const OLD_ALIAS = aliasFor(OLD, "DATABASE_PASSWORD");
const NEW_ALIAS = aliasFor(NEW, "DATABASE_PASSWORD");
check("rotated values get different aliases", OLD_ALIAS !== NEW_ALIAS, `${OLD_ALIAS} vs ${NEW_ALIAS}`);
check("both aliases carry the label", OLD_ALIAS.startsWith("<SECRET:DATABASE_PASSWORD:") && NEW_ALIAS.startsWith("<SECRET:DATABASE_PASSWORD:"));
const ctxOld = handlers.get("context")!({ messages: [{ role: "user", content: `password ${OLD}` }] }, {}) as { messages: any[] };
check("old value masks to its own alias", JSON.stringify(ctxOld).includes(OLD_ALIAS) && !JSON.stringify(ctxOld).includes(OLD));
const ctxNew = handlers.get("context")!({ messages: [{ role: "user", content: `password ${NEW}` }] }, {}) as { messages: any[] };
check("new value masks to its own alias", JSON.stringify(ctxNew).includes(NEW_ALIAS) && !JSON.stringify(ctxNew).includes(NEW));
const callOld = { toolName: "bash", input: { command: `echo ${OLD_ALIAS}` } };
handlers.get("tool_call")!(callOld, {});
check("old alias restores the old value", callOld.input.command.includes(OLD), callOld.input.command);
const callNew = { toolName: "bash", input: { command: `echo ${NEW_ALIAS}` } };
handlers.get("tool_call")!(callNew, {});
check("new alias restores the new value", callNew.input.command.includes(NEW), callNew.input.command);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);