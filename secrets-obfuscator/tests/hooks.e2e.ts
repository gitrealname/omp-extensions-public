/**
 * Hook-level test: no network, no model. Drives the four handlers with the
 * payloads Pi hands them.
 *
 * Run: bun tests/hooks.e2e.ts
 */

import { aliasFor, mask, maskJson, restore, restoreJson, type Mapping } from "../src/mask";
import secretsObfuscator from "../src/main";

const SECRET = "ghp_realtokenvalue123456789";
const ALIAS = aliasFor(SECRET, "GITHUB_TOKEN");
const OLD = "old_password_value_123";
const NEW = "new_password_value_456";
const OLD_ALIAS = aliasFor(OLD, "DATABASE_PASSWORD");
const NEW_ALIAS = aliasFor(NEW, "DATABASE_PASSWORD");
const mappings: Mapping[] = [
	{ alias: ALIAS, value: SECRET },
	{ alias: OLD_ALIAS, value: OLD },
	{ alias: NEW_ALIAS, value: NEW },
];

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

// 7. Secrets are rarely space delimited. Quotes, '=', ':', cookies, JSON.
const SURROUNDINGS: Array<[string, string]> = [
	["double quotes", `"${SECRET}"`],
	["single quotes", `'${SECRET}'`],
	["assignment", `TOKEN=${SECRET}`],
	["curl header", `-H "Authorization: Bearer ${SECRET}"`],
	["url userinfo", `https://user:${SECRET}@example.com/db`],
	["cookie", `session=${SECRET}; Path=/; HttpOnly`],
	["yaml line", `password: ${SECRET}`],
	["brackets", `<<${SECRET}>>`],
	["no delimiter", `x${SECRET}y`],
	["multiline", `line1\n  token="${SECRET}"\nline3`],
];
for (const [name, text] of SURROUNDINGS) {
	const masked = mask(text, mappings);
	check(`mask keeps surroundings (${name})`, masked.includes(ALIAS) && !masked.includes(SECRET) && masked.length > ALIAS.length, masked);
	check(`restore round trip (${name})`, restore(masked, mappings) === text);
}

// JSON strings arrive quoted and escaped; masking runs on the decoded value.
for (const [name, value] of [
	["json string", { password: SECRET }],
	["json nested", { a: [{ b: SECRET }] }],
	["json array", [SECRET, `x${SECRET}y`]],
] as Array<[string, unknown]>) {
	const masked = maskJson(value, mappings) as any;
	const dumped = JSON.stringify(masked);
	check(`maskJson keeps shape (${name})`, !dumped.includes(SECRET) && dumped.includes(ALIAS), dumped);
	check(`restoreJson round trip (${name})`, JSON.stringify(restoreJson(masked, mappings)) === JSON.stringify(value));
}

// Characters that would break a regex-based matcher must be literal here.
const META = 'p@ss."w0rd\\x[1]{2}';
const metaAlias = aliasFor(META, "META_SECRET");
const metaMappings = [...mappings, { alias: metaAlias, value: META }];
const metaText = `url="https://u:${META}@h/p?a=1&b=2" note='${META}'`;
const metaMasked = mask(metaText, metaMappings);
check("regex metacharacters masked literally", !metaMasked.includes(META) && metaMasked.includes(metaAlias), metaMasked);
check("regex metacharacters restore exactly", restore(metaMasked, metaMappings) === metaText);

// A value inside serialised JSON that was never parsed arrives escaped.
const QUOTE = 'pa"ss\\w0rd';
const quoteAlias = aliasFor(QUOTE, "QUOTED_SECRET");
const quotedMap: Mapping[] = [...mappings, { alias: quoteAlias, value: QUOTE }];
const escapedForm = JSON.stringify(QUOTE).slice(1, -1);
const both = `raw=${QUOTE} escaped={"p":"${escapedForm}"}`;
const bothMasked = mask(both, quotedMap);
check("escaped spelling masked too", !bothMasked.includes(escapedForm) && !bothMasked.includes(QUOTE), bothMasked);
check("both spellings share one alias", bothMasked.split(quoteAlias).length - 1 === 2, bothMasked);

// 8. Partial values: a fragment protects every occurrence around it.
const DOMAIN_ALIAS = aliasFor("@example.com", "EMAIL_DOMAIN");
const partial: Mapping[] = [...mappings, { alias: DOMAIN_ALIAS, value: "@example.com" }];
const mail = "mail alice@example.com or bob@example.com, skip carol@other.org";
const mailMasked = mask(mail, partial);
check("domain fragment masked in addresses", !mailMasked.includes("@example.com") && mailMasked.includes(`alice${DOMAIN_ALIAS}`), mailMasked);
check("other domain untouched", mailMasked.includes("carol@other.org"), mailMasked);
check("domain fragment restores", restore(mailMasked, partial) === mail);

const HOST_ALIAS = aliasFor("api.example.com", "API_HOST");
const hostMap: Mapping[] = [...mappings, { alias: HOST_ALIAS, value: "api.example.com" }];
const url = "curl https://api.example.com/v1/items?a=1";
const urlMasked = mask(url, hostMap);
check("host fragment masked in url", urlMasked.includes(`https://${HOST_ALIAS}/v1`) && !urlMasked.includes("api.example.com"), urlMasked);
check("host fragment restores", restore(urlMasked, hostMap) === url);

// A longer value wins over a shorter one that starts at the same offset.
const overlap: Mapping[] = [...hostMap, { alias: DOMAIN_ALIAS, value: "example.com" }];
const both2 = mask("https://api.example.com/x", overlap);
check("longest value wins on overlap", both2.includes(`https://${HOST_ALIAS}/x`), both2);

// 9. Values that contain spaces: passphrases, sentences, padded values.
const PASS = "correct horse battery staple";
const passAlias = aliasFor(PASS, "PASSPHRASE");
const passMap: Mapping[] = [...mappings, { alias: passAlias, value: PASS }];
const passText = `ssh-keygen -N '${PASS}' -f ./key && echo done`;
const passMasked = mask(passText, passMap);
check("passphrase with spaces masked", passMasked.includes(`'${passAlias}'`) && !passMasked.includes(PASS), passMasked);
check("passphrase restores", restore(passMasked, passMap) === passText);
check("passphrase survives json", JSON.stringify(maskJson({ p: PASS }, passMap)).includes(passAlias));

const PAD = "  pad  ";
const padAlias = aliasFor(PAD, "PADDED");
const padMap: Mapping[] = [...mappings, { alias: padAlias, value: PAD }];
const padMasked = mask(`x${PAD}y`, padMap);
check("leading and trailing spaces kept out of the text", padMasked === `x${padAlias}y`, padMasked);
check("padded value restores byte for byte", restore(padMasked, padMap) === `x${PAD}y`);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);