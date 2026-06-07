// ── Anthropic proxy server ───────────────────────────────────────────────────
// Local Bun.serve that translates Anthropic Messages API → OMP complete().
// The `complete` function is injected by main.ts (avoids duplicating open-sdk import).

import { resolveExtractionModel, dbg } from "./util";
import type { CompleteFn, CommandContext, PiLogger, ProxyHandle } from "./types";

const MAX_CONCURRENT = 5;

// Enhanced extraction system prompt — matches the graphify skill's Step B2 rules.
// deepMode=true adds aggressive INFERRED edges (--mode deep flag).
function buildExtractionSystem(deepMode: boolean): string {
    return `You are a graphify semantic extraction agent. Extract a knowledge graph fragment from the files provided.
Output ONLY valid JSON — no explanation, no markdown fences, no preamble.

Files are separated by === path === markers. Process each file section independently, then merge all results into the single JSON output.

Rules:
- EXTRACTED: relationship explicit in source (import, call, citation, reference)
- INFERRED: reasonable inference (shared structure, implied dependency)
- AMBIGUOUS: uncertain — flag it, do not omit
- confidence_score REQUIRED on every edge: EXTRACTED=1.0, INFERRED=0.6-0.9 (reason individually), AMBIGUOUS=0.1-0.3

Code files: extract semantic edges AST cannot find. Do NOT re-extract imports or calls already captured by AST.
Doc/paper files: extract named concepts, entities, citations. Use file_type "rationale" for concept-like nodes (ideas, principles, decisions). Store WHY decisions were made as a rationale_for edge, not a separate node.
Semantic similarity: if two concepts across files solve the same problem without a structural link, add a semantically_similar_to INFERRED edge (confidence 0.6-0.95). Non-obvious cross-file connections only.
Hyperedges: if 3+ nodes share a concept or flow not captured by pairwise edges, add a hyperedge. Max 3 per file.${deepMode ? `

DEEP MODE: be aggressive with INFERRED edges. Pursue every reasonable inference. Add semantically_similar_to edges for concepts that solve the same problem even if only loosely related. Prefer more edges over fewer.` : ""}

Node ID format: lowercase, only [a-z0-9_]. Format: {stem}_{entity} where stem = filename stem, entity = symbol name (both normalised).
IMPORTANT: file_type must be exactly one of: code, document, paper, image, rationale. Never use a file path as file_type.

Output exactly this schema:
{"nodes":[{"id":"stem_entity","label":"Human Readable Name","file_type":"code|document|paper|image|rationale","source_file":"relative/path","source_location":null,"source_url":null,"captured_at":null,"author":null,"contributor":null}],"edges":[{"source":"node_id","target":"node_id","relation":"calls|implements|references|cites|conceptually_related_to|shares_data_with|semantically_similar_to|rationale_for","confidence":"EXTRACTED|INFERRED|AMBIGUOUS","confidence_score":1.0,"source_file":"relative/path","source_location":null,"weight":1.0}],"hyperedges":[{"id":"snake_case_id","label":"Human Readable Label","nodes":["node_id1","node_id2","node_id3"],"relation":"participate_in|implement|form","confidence":"EXTRACTED|INFERRED","confidence_score":0.75,"source_file":"relative/path"}],"input_tokens":0,"output_tokens":0}`;
}

export async function anthropicProxyServer(
    complete: CompleteFn,
    pi: { logger: PiLogger },
    ctx: CommandContext,
    deepMode: boolean,
    onFirstChunk?: () => void,
): Promise<ProxyHandle | null> {
    const log = pi.logger;
    const model = resolveExtractionModel(pi, ctx);

    if (!model) {
        dbg(log, "[graphify proxy] no model available — proxy disabled");
        return null;
    }

    dbg(log, `[graphify proxy] starting model=${model?.id ?? "none"}`);

    let activeCount = 0;
    let chunkCount = 0;
    let firstChunkFired = false;
    const queue: Array<() => void> = [];

    function acquireSlot(): Promise<void> {
        if (activeCount < MAX_CONCURRENT) { activeCount++; return Promise.resolve(); }
        const { promise, resolve } = Promise.withResolvers<void>();
        queue.push(resolve);
        return promise;
    }

    function releaseSlot(): void {
        activeCount--;
        if (queue.length > 0) { activeCount++; queue.shift()!(); }
    }

    // Single LLM call through the imported complete() function.
    // graphify sends: system=buildExtractionSystem, messages=[{role:user,content:files}]
    // Response must be pure JSON — _parse_llm_json returns empty nodes on failure.
    async function callLLM(system: string, userText: string, maxTokens: number): Promise<string> {
        const result = await complete(model, {
            systemPrompt: system ? [system] : undefined,
            messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
        }, { maxTokens });
        return (result.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("")
            .trim();
    }

    const server = Bun.serve({
        port: 0,
        async fetch(req: Request) {
            const url = new URL(req.url);
            if (req.method !== "POST" || !url.pathname.endsWith("/messages")) {
                return new Response("not found", { status: 404 });
            }
            try {
                const body = await req.json() as Record<string, unknown>;

                // Build system prompt — deepMode adds aggressive INFERRED instructions.
                const system: string = buildExtractionSystem(deepMode);

                const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
                const lastUser = [...messages].reverse().find((m) => m.role === "user");
                const userText: string = Array.isArray(lastUser?.content)
                    ? (lastUser.content as Array<{ type?: string; text?: string } | string>)
                        .map((b) => (typeof b === "string" ? b : (b.text ?? ""))).join("\n")
                    : typeof lastUser?.content === "string" ? lastUser.content : "";

                const maxTokens: number = typeof body.max_tokens === "number" ? body.max_tokens : 4096;

                await acquireSlot();
                const n = ++chunkCount;
                if (n === 1 && !firstChunkFired) { firstChunkFired = true; onFirstChunk?.(); }
                dbg(log, `[graphify proxy] chunk ${n} active=${activeCount} systemLen=${system.length} msgLen=${userText.length}`);

                let text = "";
                try {
                    text = await callLLM(system, userText, maxTokens);
                    dbg(log, `[graphify proxy] chunk ${n} done responseLen=${text.length} preview=${JSON.stringify(text.slice(0, 120))}`);
                } finally {
                    releaseSlot();
                }

                return new Response(JSON.stringify({
                    id: `msg_omp_${n}`,
                    type: "message",
                    role: "assistant",
                    content: [{ type: "text", text }],
                    model: body.model ?? "claude-omp-proxy",
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                }), { headers: { "Content-Type": "application/json" } });

            } catch (err) {
                dbg(log, `[graphify proxy] error: ${String(err)}`);
                return new Response(JSON.stringify({
                    type: "error",
                    error: { type: "api_error", message: String(err) },
                }), { status: 500, headers: { "Content-Type": "application/json" } });
            }
        },
    });

    dbg(log, `[graphify proxy] server ready port=${server.port}`);
    return {
        port: server.port,
        stop: () => { server.stop(true); return chunkCount; },
        getCount: () => ({ total: chunkCount, active: activeCount }),
    };
}
