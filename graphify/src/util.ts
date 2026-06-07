// ── Shared utilities for the graphify extension ──────────────────────────────
// Pure helpers, subprocess management, and model resolution.
// No open-sdk dependency — `complete` is passed in by callers.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelRef, PiLogger, CommandContext, ToolResultEvent, CreateProxyFn } from "./types";

// ── Debug guard ─────────────────────────────────────────────────────────────
// All diagnostic output gated on OMP_EXTENSION_DEBUG=1.

export function dbg(log: PiLogger, msg: string): void {
    if (process.env.OMP_EXTENSION_DEBUG === "1") log.debug(msg);
}


// ── Env helpers ─────────────────────────────────────────────────────────────

// Respects GRAPHIFY_OUT env var — mirrors Python: os.environ.get("GRAPHIFY_OUT", "graphify-out")
export function graphifyOutDir(cwd: string): string {
    return join(cwd, process.env.GRAPHIFY_OUT ?? "graphify-out");
}


// ── Python interpreter detection ────────────────────────────────────────────
// Mirrors skill Step 1: read shebang from graphify binary, fall back to python3.
// Result cached in <graphify-out>/.graphify_python (matches skill convention).
let _pythonCache: string | null = null;

export function detectPython(cwd: string): string {
    if (_pythonCache) return _pythonCache;

    // Check if a previous graphify run already wrote the interpreter path.
    const cached = join(graphifyOutDir(cwd), ".graphify_python");
    if (existsSync(cached)) {
        const p = readFileSync(cached, "utf-8").trim();
        if (p) { _pythonCache = p; return p; }
    }

    // Find graphify binary and read its shebang.
    let python = "python3";
    const graphifyBin = Bun.which("graphify");
    if (graphifyBin) {
        try {
            const firstLine = readFileSync(graphifyBin, "utf-8").split("\n")[0];
            if (firstLine.startsWith("#!")) {
                const candidate = firstLine.slice(2).trim();
                // Only accept clean paths (no special chars except / \ . - _)
                if (/^[a-zA-Z0-9/_\\.:-]+$/.test(candidate)) {
                    python = candidate;
                }
            }
        } catch { /* fall through to default */ }
    }

    // Persist for subsequent steps (matches skill convention).
    try {
        mkdirSync(graphifyOutDir(cwd), { recursive: true });
        writeFileSync(cached, python, "utf-8");
    } catch { /* non-fatal */ }

    _pythonCache = python;
    return python;
}


// ── Types ───────────────────────────────────────────────────────────────────

export type AutocompleteItem = { label: string; value: string };


// ── shell-aware arg split ───────────────────────────────────────────────────

export function shellSplit(input: string): string[] {
    const args: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "'" && !inDouble) { inSingle = !inSingle; }
        else if (ch === '"' && !inSingle) { inDouble = !inDouble; }
        else if (ch === " " && !inSingle && !inDouble) {
            if (current) { args.push(current); current = ""; }
        } else { current += ch; }
    }
    if (current) args.push(current);
    return args;
}


// ── Model resolution ────────────────────────────────────────────────────────
// Resolves the model to use for extraction/labeling via:
//   1. GRAPHIFY_MODEL_ROLE env var (role name, default "smol")
//   2. modelRoles config lookup via pi.pi.settings
//   3. ctx.model fallback

export function resolveExtractionModel(
    pi: { pi?: { settings?: { get(key: string): unknown } } },
    ctx: CommandContext,
): ModelRef | undefined {
    const role = process.env.GRAPHIFY_MODEL_ROLE?.trim() ?? "smol";
    try {
        const settings = pi.pi?.settings;
        if (settings) {
            const modelRoles = settings.get("modelRoles") as Record<string, string> | undefined;
            if (modelRoles) {
                for (const r of [role, "smol", "default"]) {
                    const spec = modelRoles[r];
                    if (spec) {
                        const found = ctx.modelRegistry.getAvailable().find((m: ModelRef) =>
                            m.id === spec || m.id.includes(spec)
                        );
                        if (found) return found;
                    }
                }
            }
        }
    } catch { /* settings not initialized or unavailable */ }
    return ctx.model;
}


// ── helpers ─────────────────────────────────────────────────────────────────

export function graphExists(cwd: string): boolean {
    return existsSync(join(graphifyOutDir(cwd), "graph.json"));
}

export function readGraphReport(cwd: string): string {
    try {
        return readFileSync(join(graphifyOutDir(cwd), "GRAPH_REPORT.md"), "utf-8");
    } catch {
        return "";
    }
}

export function summarizeReport(report: string): string {
    const m = report.match(/^-\s+(\d+)\s+nodes\s*·\s*\d+\s+edges\s*·\s*(\d+)\s+communities/m);
    return m ? `${m[1]} nodes, ${m[2]} communities` : "";
}

export function isSearchOrFind(event: ToolResultEvent): boolean {
    const name = event.toolName ?? "";
    // OMP tool names that indicate the LLM is exploring the codebase
    if (["search", "find", "ast_grep", "lsp"].includes(name)) return true;
    if (name === "bash") {
        const cmd = event.input?.command ?? "";
        return /grep|rg|ripgrep|find |fd /.test(cmd);
    }
    return false;
}


// ── subprocess helper ───────────────────────────────────────────────────────

export async function runGraphify(
    pi: { logger: PiLogger },
    argv: string[],
    ctx: CommandContext,
    hasBackend: boolean,
    createProxy: CreateProxyFn,
    signal?: AbortSignal,
): Promise<{ output: string; chunkCount: number }> {
    const log = pi.logger;
    const env = { ...process.env, PYTHONUTF8: "1" } as Record<string, string>;
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;

    const isExtractionCmd = argv[0] === "extract";
    // --mode deep is a skill-level flag, not a graphify CLI flag — strip before spawn.
    const deepMode = argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "deep"
        || argv.includes("--mode=deep");
    const spawnBase = argv.filter((a, i) =>
        !(a === "--mode" && argv[i + 1] === "deep") &&
        !(a === "deep" && argv[i - 1] === "--mode") &&
        a !== "--mode=deep"
    );
    let proxy: { port: number; stop: () => number } | null = null;

    if (isExtractionCmd && !hasBackend) {
        if (!ctx.model) {
            dbg(log, "[graphify] no model on ctx — running AST only");
        } else {
            try {
                proxy = await createProxy(pi, ctx, deepMode);
                if (proxy) {
                    env.ANTHROPIC_BASE_URL = `http://localhost:${proxy.port}`;
                    env.ANTHROPIC_API_KEY = "omp-internal";
                    dbg(log, `[graphify] proxy active port=${proxy.port}`);
                } else {
                    dbg(log, "[graphify] proxy not available — extract runs without OMP LLM routing");
                }
            } catch (err) {
                dbg(log, `[graphify] proxy start failed: ${String(err)} — running AST only`);
            }
        }
    }

    // Smaller token budget reduces chunk size → avoids adaptive-retry bisection.
    const spawnArgv = (proxy && !spawnBase.includes("--token-budget"))
        ? [...spawnBase, "--token-budget", "20000"]
        : spawnBase;
    const python = detectPython(ctx.cwd);
    dbg(log, `[graphify] python=${python} spawn argv=${JSON.stringify(spawnArgv)} hasProxy=${!!proxy} hasBackend=${hasBackend} deepMode=${deepMode}`);

    const proc = Bun.spawn([python, "-m", "graphify", ...spawnArgv], {
        cwd: ctx.cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
    });

    // Wire ESC/abort: kill the subprocess and stop the proxy when the turn is cancelled.
    const onAbort = () => {
        dbg(log, "[graphify] aborted — killing subprocess");
        proc.kill();
        proxy?.stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    signal?.removeEventListener("abort", onAbort);

    const chunkCount = proxy?.stop() ?? 0;
    dbg(log, `[graphify] exit=${exitCode} chunks=${chunkCount} stdoutLen=${stdout.trim().length} stderrLen=${stderr.trim().length}`);

    const parts: string[] = [];
    if (stdout.trim()) parts.push(stdout.trim());
    if (exitCode !== 0 && stderr.trim()) parts.push(stderr.trim());
    return { output: parts.join("\n"), chunkCount };
}
// ── post-command helpers (gap fixes) ────────────────────────────────────────
/** Update cumulative token cost tracker after extraction. */
export function updateCostTracker(
    cwd: string,
    inputTokens: number,
    outputTokens: number,
    fileCount: number,
): void {
    try {
        const costPath = join(graphifyOutDir(cwd), "cost.json");
        let cost: { runs: Array<{ date: string; input_tokens: number; output_tokens: number; files: number }>; total_input_tokens: number; total_output_tokens: number };
        try {
            cost = JSON.parse(readFileSync(costPath, "utf-8"));
        } catch {
            cost = { runs: [], total_input_tokens: 0, total_output_tokens: 0 };
        }
        cost.runs.push({
            date: new Date().toISOString(),
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            files: fileCount,
        });
        cost.total_input_tokens += inputTokens;
        cost.total_output_tokens += outputTokens;
        writeFileSync(costPath, JSON.stringify(cost, null, 2), "utf-8");
    } catch { /* non-fatal */ }
}
/** Run graphify benchmark if corpus is large enough. */
export function runBenchmark(cwd: string): string | null {
    try {
        const reportPath = join(graphifyOutDir(cwd), "GRAPH_REPORT.md");
        if (!existsSync(reportPath)) return null;
        const report = readFileSync(reportPath, "utf-8");
        const m = report.match(/~([\d,]+)\s+words/);
        if (!m) return null;
        const words = parseInt(m[1].replace(/,/g, ""), 10);
        if (words <= 5000) return null;
        const python = detectPython(cwd);
        const proc = Bun.spawnSync([python, "-m", "graphify", "benchmark"], { cwd });
        return new TextDecoder("utf-8").decode(proc.stdout).trim() || null;
    } catch { return null; }
}
/** Save query/path/explain result back to the graph for future improvement. */
export function saveResult(
    cwd: string,
    question: string,
    answer: string,
    type: "query" | "path_query" | "explain",
    nodes: string[],
): void {
    try {
        const python = detectPython(cwd);
        const args = [
            python, "-m", "graphify", "save-result",
            "--question", question,
            "--answer", answer,
            "--type", type,
            "--nodes", ...nodes,
        ];
        Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
    } catch { /* non-fatal */ }
}
/**
 * Post-command actions: cost tracking, benchmark, save-result.
 * Encapsulates graphify-specific logic so main.ts only handles OMP concerns.
 *
 * Returns benchmark output if run, null otherwise.
 */
export function postCommandActions(
    argv: string[],
    cwd: string,
    output: string,
    chunkCount: number,
): string | null {
    const cmd = argv[0];
    const isExtractionCmd = cmd === "extract" || cmd === "update" || cmd === "add";
    if (isExtractionCmd) {
        updateCostTracker(cwd, 0, 0, 0);
        return runBenchmark(cwd);
    }
    // Save result back for query/path/explain
    const positional = argv.filter((a: string) => !a.startsWith("-")).slice(1);
    if (cmd === "query" && positional.length > 0) {
        saveResult(cwd, positional.join(" "), output, "query", []);
    } else if (cmd === "path" && positional.length >= 2) {
        saveResult(cwd, `Path from ${positional[0]} to ${positional[1]}`, output, "path_query", positional.slice(0, 2));
    } else if (cmd === "explain" && positional.length > 0) {
        saveResult(cwd, `Explain ${positional[0]}`, output, "explain", [positional[0]]);
    }
    return null;
}
