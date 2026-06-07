// ── Community labeling (Step 5 from graphify skill) ──────────────────────────
// Reads analysis + graph.json, generates community labels via LLM, re-clusters.
// The `complete` function is injected by main.ts (avoids duplicating open-sdk import).

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExtractionModel, detectPython, graphifyOutDir, dbg } from "./util";
import type { CompleteFn, CommandContext, PiLogger } from "./types";

// Reads analysis + graph.json, returns "cid: label1, label2, ..." lines for LLM.
const COMMUNITY_SAMPLES_PY = `
import json, os, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
out = Path(os.environ.get("GRAPHIFY_OUT", "graphify-out"))
analysis_path = out / ".graphify_analysis.json"
graph_path = out / "graph.json"
if not analysis_path.exists() or not graph_path.exists():
    sys.exit(0)
analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
graph_data = json.loads(graph_path.read_text(encoding="utf-8"))
node_labels = {n["id"]: n.get("label", n["id"]) for n in graph_data.get("nodes", [])}
communities = {int(k): v for k, v in analysis["communities"].items()}
lines = []
for cid in sorted(communities):
    nodes = communities[cid][:10]
    sample = [node_labels.get(n, n) for n in nodes]
    lines.append(f"{cid}: {', '.join(sample[:8])}")
print("\\n".join(lines))
`;

export async function labelCommunities(
    complete: CompleteFn,
    pi: { logger: PiLogger },
    ctx: CommandContext,
    targetPath: string,
): Promise<void> {
    const log = pi.logger;
    const labelModel = resolveExtractionModel(pi, ctx);
    if (!labelModel) return;

    // Write script to temp file — avoids Windows arg-length limits with -c
    const tmpScript = join(tmpdir(), "graphify_samples.py");
    writeFileSync(tmpScript, COMMUNITY_SAMPLES_PY, "utf-8");
    const sampleProc = Bun.spawnSync([detectPython(ctx.cwd), tmpScript], { cwd: ctx.cwd });
    const sampleStderr = new TextDecoder("utf-8").decode(sampleProc.stderr).trim();
    const samples = new TextDecoder("utf-8").decode(sampleProc.stdout).trim();
    dbg(log, `[graphify label] sampleProc exit=${sampleProc.exitCode} stdoutLen=${samples.length} stderr=${sampleStderr.slice(0, 200)}`);
    if (!samples) { dbg(log, "[graphify label] no communities found"); return; }

    // Load existing labels — only re-label community IDs not already present.
    const labelsPath = join(graphifyOutDir(ctx.cwd), ".graphify_labels.json");
    let existingLabels: Record<string, string> = {};
    try {
        const raw = JSON.parse(readFileSync(labelsPath, "utf-8")) as Record<string, string>;
        // exclude placeholder labels written by cluster-only (e.g. "Community 0")
        for (const [k, v] of Object.entries(raw)) {
            if (!/^Community \d+$/i.test(v)) existingLabels[k] = v;
        }
    } catch { /* no existing labels — label everything */ }

    const allLines = samples.split("\n");
    const toLabel = allLines.filter(l => !existingLabels[l.split(":")[0].trim()]);
    dbg(log, `[graphify label] ${allLines.length} total, ${toLabel.length} need labeling (${allLines.length - toLabel.length} already labeled)`);

    if (toLabel.length === 0) {
        dbg(log, "[graphify label] all communities already labeled — running cluster-only to embed labels");
    } else {

    // Batch communities — 80 per call to stay within output token budget.
    const BATCH = 80;
    const sampleLines = toLabel;
    const allLabels: Record<string, string> = { ...existingLabels };

    for (let i = 0; i < sampleLines.length; i += BATCH) {
        const batch = sampleLines.slice(i, i + BATCH).join("\n");
        const batchNum = Math.floor(i / BATCH) + 1;
        const totalBatches = Math.ceil(sampleLines.length / BATCH);
        dbg(log, `[graphify label] batch ${batchNum}/${totalBatches} (${sampleLines.slice(i, i + BATCH).length} communities)`);

        const result = await complete(labelModel, {
            systemPrompt: ["Name each community in 2-5 descriptive words based on its members. Output ONLY valid JSON: {\"0\": \"Name\", \"1\": \"Name\", ...}. No explanation, no markdown fences."],
            messages: [{ role: "user", content: [{ type: "text", text: `Communities to name:\n${batch}` }], timestamp: Date.now() }],
        }, { maxTokens: 4096 });

        const raw = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
        dbg(log, `[graphify label] batch ${batchNum} response preview=${JSON.stringify(raw.slice(0, 120))}`);

        try {
            const stripped = raw.startsWith("```") ? raw.split("```")[1].replace(/^json/, "").trim() : raw;
            const parsed = JSON.parse(stripped) as Record<string, string>;
            Object.assign(allLabels, parsed);
        } catch (err) {
            dbg(log, `[graphify label] batch ${batchNum} parse failed: ${String(err)}`);
        }
    }

    const labels = allLabels;
    if (Object.keys(labels).length === 0) {
        dbg(log, "[graphify label] all batches failed to parse, skipping");
        return;
    }

    writeFileSync(labelsPath, JSON.stringify(allLabels), "utf-8");
    dbg(log, `[graphify label] saved ${Object.keys(allLabels).length} labels (${toLabel.length} new)`);
    } // end else (new labels needed)

    // Re-run cluster-only so GRAPH_REPORT.md picks up the labels
    const clusterProc2 = Bun.spawnSync([detectPython(ctx.cwd), "-m", "graphify", "cluster-only", targetPath], { cwd: ctx.cwd });
    const clusterStderr2 = new TextDecoder("utf-8").decode(clusterProc2.stderr).trim();
    dbg(log, `[graphify label] cluster-only re-run exit=${clusterProc2.exitCode}${clusterStderr2 ? " stderr=" + clusterStderr2.slice(0, 150) : ""}`);
}
