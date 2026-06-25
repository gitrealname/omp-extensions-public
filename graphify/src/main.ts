// ── Graphify extension entry point ───────────────────────────────────────────
// OMP external extension: knowledge graph extraction, querying, and community labeling.
//
// Modules:
//   proxy.ts   — Anthropic proxy server (translates API → complete())
//   labeling.ts — community labeling via LLM
//   util.ts    — shared utilities, subprocess management
//   types.ts   — shared interfaces

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { anthropicProxyServer } from "./proxy";
import { labelCommunities } from "./labeling";
import {
    dbg, graphifyOutDir, detectPython, shellSplit, runGraphify,
    graphExists, readGraphReport, summarizeReport, isSearchOrFind,
    postCommandActions,
} from "./util";
import type {
    CompleteFn, CommandContext, PiLogger, ProxyHandle,
    ToolResultEvent, AutocompleteItem,
} from "./types";

// `complete` from open-sdk — set from pi.pi inside the factory.
let complete: CompleteFn;


// ── Extension-local state ────────────────────────────────────────────────────

interface ExtractionState {
    proc: ReturnType<typeof Bun.spawn>;
    pid: number;
    stage: "ast" | "semantic" | "clustering" | "labeling" | "done" | "failed";
    target: string;
    startedAt: number;
    proxy: ProxyHandle | null;
}

let _running: ExtractionState | null = null;

function _elapsed(startedAt: number): string {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function _fmtHint(title: string, body?: string): string {
    return body ? `## ${title}\n${body}` : `## ${title}`;
}

function _progressHint(): string {
    if (!_running) return "";
    const cnt = _running.proxy?.getCount() ?? { total: 0, active: 0 };
    const active = cnt.active > 0 ? ` (${cnt.active} active)` : "";
    const stageLabel: Record<ExtractionState["stage"], string> = {
        ast: "indexing (AST)", semantic: "extracting", clustering: "clustering",
        labeling: "labeling", done: "done", failed: "failed",
    };
    // derive actual stage: if proxy exists but no chunks yet, still in AST phase
    const displayStage = (_running.stage === "semantic" && cnt.total === 0) ? "ast" : _running.stage;
    const title = `⚙  ${stageLabel[displayStage]} (PID: ${_running.pid})`;
    const body = `chunks \`${cnt.total}\`${active} · elapsed \`${_elapsed(_running.startedAt)}\` · target \`${_running.target}\``;
    return _fmtHint(title, body);
}

// Bound proxy factory — `complete` captured once from open-sdk.
function createProxy(
    pi: { logger: PiLogger },
    ctx: CommandContext,
    deepMode: boolean,
    onFirstChunk?: () => void,
): Promise<ProxyHandle | null> {
    return anthropicProxyServer(complete, pi, ctx, deepMode, onFirstChunk);
}

// Bound labeler — `complete` captured once from open-sdk.
function label(pi: { logger: PiLogger }, ctx: CommandContext, targetPath: string): Promise<void> {
    return labelCommunities(complete, pi, ctx, targetPath);
}


// ── extension factory ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
    // Get complete from pi.openSdk — clean namespace for open-sdk exports.
    complete = pi.openSdk.complete as CompleteFn;
    const log = pi.logger;
    const onDemand = process.env.GRAPHIFY_ON_DEMAND === "1";
    let remindedThisSession = false;
    log.debug(`[graphify] loaded onDemand=${onDemand}`);
    if (!onDemand) {
        pi.on("session_start", (_event, ctx) => {
            if (remindedThisSession) return;  // guard against duplicate session_start
            dbg(log, `[graphify] #1 session_start cwd=${ctx.cwd} graphExists=${graphExists(ctx.cwd)}`);
            if (graphExists(ctx.cwd)) {
                const summary = summarizeReport(readGraphReport(ctx.cwd) ?? "");
                const body = summary
                    ? `${summary}\ninvoke \`/skill:graphify\`, then use \`/graphify query\`, \`path\`, or \`explain\``
                    : `invoke \`/skill:graphify\`, then use \`/graphify query\`, \`path\`, or \`explain\``;
                dbg(log, `[graphify] #1 sending graph-ready from session_start`);
                pi.sendMessage(
                    { customType: "graphify", content: [{ type: "text", text: _fmtHint("🔍 graph ready", body) }], display: true },
                    { deliverAs: "nextTurn" },
                );
                remindedThisSession = true;
            }
        });

        pi.on("tool_result", (event: ToolResultEvent, ctx): void => {
            if (remindedThisSession) return;
            if (!isSearchOrFind(event)) return;
            if (!graphExists(ctx.cwd)) return;
            remindedThisSession = true;
            const summary = summarizeReport(readGraphReport(ctx.cwd) ?? "");
            const body = summary ?? "use `/graphify query`, `path`, or `explain`";
            dbg(log, `[graphify] #2 sending graph-ready from tool_result`);
            pi.sendMessage(
                { customType: "graphify", content: [{ type: "text", text: _fmtHint("🔍 graph ready", body) }], display: true },
                { deliverAs: "nextTurn" },
            );
        });
    }

    // Report background extraction progress after each agent turn
    pi.on("agent_end", (): void => {
        if (!_running) return;
        pi.sendMessage(
            { customType: "graphify", content: [{ type: "text", text: _progressHint() }], display: true },
            { deliverAs: "nextTurn" },
        );
    });

    // Kill background process on session shutdown
    pi.on("session_shutdown", (): void => {
        if (!_running) return;
        _running.proc.kill();
        _running.proxy?.stop();
        _running = null;
    });

    pi.registerCommand("graphify", {
        description:
            "Knowledge graph for this project. Usage: /graphify [query|path|explain|extract|update|...] [args]",
        getArgumentCompletions(prefix: string): AutocompleteItem[] {
            const TOP = [
                // Core queries
                "query", "path", "explain", "save-result",
                // Build / extract
                "extract", "update", "cluster-only", "add",
                // Watch / hooks
                "watch", "hook install", "hook uninstall", "hook status",
                // Export subcommands
                "export callflow-html", "export wiki", "export svg",
                "export graphml", "export neo4j", "export obsidian", "export html",
                // Global graph subcommands
                "global list", "global add", "global remove", "global path",
                // Multi-repo / PR
                "clone", "merge-graphs", "merge-driver", "prs",
                // Utility
                "benchmark", "check-update", "tree",
                "kill",
                "--help", "--version",
            ];
            return TOP.filter((s) => s.startsWith(prefix)).map((s) => ({ label: s, value: s }));
        },
        handler: async (args: string, ctx: CommandContext): Promise<void> => {
            dbg(log, `[graphify] handler args="${args}" cwd=${ctx.cwd} graphExists=${graphExists(ctx.cwd)}`);
            // Notify on first command if graph exists and haven't reminded yet
            if (!remindedThisSession && graphExists(ctx.cwd)) {
                const summary = summarizeReport(readGraphReport(ctx.cwd) ?? "");
                const body = summary ?? "use `/graphify query`, `path`, or `explain`";
                dbg(log, `[graphify] #3 sending graph-ready from command handler`);
                pi.sendMessage(
                    { customType: "graphify", content: [{ type: "text", text: _fmtHint("🔍 graph ready", body) }], display: true },
                    { deliverAs: "nextTurn" },
                );
                remindedThisSession = true;
            }
            // update → extract: extract is fully incremental, same cost, always complete.
            const argv = (() => {
                const raw = args.trim() ? shellSplit(args.trim()) : [];
                const cmd = raw[0] === "update" ? "extract" : raw[0];
                const rest = raw.slice(1);
                const flags = rest.filter((a: string) => a.startsWith("-"));
                const positional = rest.filter((a: string) => !a.startsWith("-"));

                const needsPath = ["extract", "update", "cluster-only", "query", "path", "explain"].includes(cmd);
                const hasPath = positional.length > 0;
                const baseRest = needsPath && !hasPath ? [".", ...rest] : rest;

                // explain / query: join all positional args as one search string — no quoting required
                if ((cmd === "explain" || cmd === "query" || cmd === "save-result") && positional.length > 1) {
                    return [cmd, positional.join(" "), ...flags];
                }
                // path needs exactly two quoted args — can't auto-fix multi-word without knowing split point

                return cmd ? [cmd, ...baseRest] : raw;
            })();
            const hasBackend = argv.some((a: string) => a === "--backend" || a.startsWith("--backend="));

            dbg(log, `[graphify cmd] argv=${JSON.stringify(argv)} hasBackend=${hasBackend} hasModel=${!!ctx.model}`);

            // ── /graphify (no args) → status hint if running ─────────────────
            if (argv.length === 0 && _running) {
                pi.sendMessage(
                    { customType: "graphify", content: [{ type: "text", text: _progressHint() }], display: true },
                    { deliverAs: "nextTurn" },
                );
                return;
            }

            // ── /graphify kill ────────────────────────────────────────────────
            if (argv[0] === "kill") {
                if (!_running) {
                    pi.sendMessage(
                        { customType: "graphify", content: [{ type: "text", text: _fmtHint("graphify", "no extraction running") }], display: true },
                        { deliverAs: "nextTurn" },
                    );
                    return;
                }
                const pid = _running.pid;
                _running.proc.kill();
                _running.proxy?.stop();
                _running = null;
                dbg(log, `[graphify] killed background process pid=${pid}`);
                pi.sendMessage(
                    { customType: "graphify", content: [{ type: "text", text: _fmtHint(`🛑 stopped (PID: ${pid})`) }], display: true },
                    { deliverAs: "nextTurn" },
                );
                return;
            }

            // ── no-op guard for background-blocked commands ───────────────────
            const BG_BLOCKED = ["extract", "add", "cluster-only"];
            if (_running && BG_BLOCKED.includes(argv[0])) {
                pi.sendMessage(
                    { customType: "graphify", content: [{ type: "text", text: `${_progressHint()}\nuse \`/graphify kill\` to stop` }], display: true },
                    { deliverAs: "nextTurn" },
                );
                return;
            }

            // ── background extract helper ─────────────────────────────────────
            const startBackgroundExtract = async (target: string): Promise<void> => {
                let proxy: ProxyHandle | null = null;
                if (ctx.model) {
                    try {
                        proxy = await createProxy(pi, ctx, false, () => {
                            if (!_running) return;
                            _running.stage = "semantic";
                            pi.sendMessage(
                                { customType: "graphify", content: [{ type: "text", text: _fmtHint(`⚙  extracting (PID: ${_running.pid})`, `elapsed \`${_elapsed(_running.startedAt)}\` · target \`${target}\``) }], display: true },
                                { deliverAs: "nextTurn" },
                            );
                        });
                        if (proxy) dbg(log, `[graphify bg] proxy active port=${proxy.port}`);
                    } catch (err) {
                        dbg(log, `[graphify bg] proxy start failed: ${err}`);
                        pi.sendMessage(
                            { customType: "graphify", content: [{ type: "text", text: _fmtHint("⚠ proxy failed", `semantic extraction unavailable · running AST-only\n\`${err}\``) }], display: true },
                            { deliverAs: "nextTurn" },
                        );
                    }
                }

                const env = { ...process.env, PYTHONUTF8: "1" } as Record<string, string>;
                delete env.GEMINI_API_KEY;
                if (proxy) { env.ANTHROPIC_BASE_URL = `http://localhost:${proxy.port}`; env.ANTHROPIC_API_KEY = "omp-internal"; }
                const spawnArgv = proxy ? ["extract", target, "--token-budget", "20000"] : ["extract", target];
                dbg(log, `[graphify bg] spawning argv=${JSON.stringify(spawnArgv)}`);

                let proc: ReturnType<typeof Bun.spawn>;
                try {
                    proc = Bun.spawn([detectPython(ctx.cwd), "-m", "graphify", ...spawnArgv], {
                        cwd: ctx.cwd, env, stdout: "pipe", stderr: "pipe",
                    });
                } catch (err) {
                    proxy?.stop();
                    _running = null;
                    pi.sendMessage(
                        { customType: "graphify", content: [{ type: "text", text: _fmtHint("❌ spawn failed", `\`${err}\``) }], display: true },
                        { deliverAs: "nextTurn" },
                    );
                    return;
                }

                _running = { proc, pid: proc.pid, stage: "ast", target, startedAt: Date.now(), proxy };
                dbg(log, `[graphify bg] started pid=${proc.pid}`);
                pi.sendMessage(
                    { customType: "graphify", content: [{ type: "text", text: _fmtHint(`⚙  indexing AST (PID: ${proc.pid})`, `target \`${target}\``) }], display: true },
                    { deliverAs: "nextTurn" },
                );

                proc.exited.then(async (exitCode: number) => {
                    if (_running?.proc !== proc) return;
                    const chunksDone = proxy?.stop() ?? 0;
                    dbg(log, `[graphify bg] exit=${exitCode} chunks=${chunksDone}`);

                    if (exitCode === 0) {
                        try {
                            _running.stage = "clustering";
                            pi.sendMessage(
                                { customType: "graphify", content: [{ type: "text", text: _fmtHint(`⚙  clustering (PID: ${_running.pid})`, `elapsed \`${_elapsed(_running.startedAt)}\` · target \`${target}\``) }], display: true },
                                { deliverAs: "nextTurn" },
                            );
                            const clusterProc = Bun.spawnSync([detectPython(ctx.cwd), "-m", "graphify", "cluster-only", target], { cwd: ctx.cwd });
                            if (clusterProc.exitCode !== 0) throw new Error(`cluster-only exit=${clusterProc.exitCode}`);
                            dbg(log, "[graphify bg] cluster-only done");

                            _running.stage = "labeling";
                            pi.sendMessage(
                                { customType: "graphify", content: [{ type: "text", text: _fmtHint(`⚙  labeling (PID: ${_running.pid})`, `elapsed \`${_elapsed(_running.startedAt)}\` · target \`${target}\``) }], display: true },
                                { deliverAs: "nextTurn" },
                            );
                            await label(pi, ctx, target);
                            _running.stage = "done";
                        } catch (err) {
                            dbg(log, `[graphify bg] post-process error: ${err}`);
                            _running.stage = "failed";
                            const elapsed = _elapsed(_running.startedAt);
                            _running = null;
                            pi.sendMessage(
                                { customType: "graphify", content: [{ type: "text", text: _fmtHint("❌ post-process failed", `\`${err}\` · elapsed \`${elapsed}\``) }], display: true },
                                { deliverAs: "nextTurn" },
                            );
                            return;
                        }
                    } else {
                        _running.stage = "failed";
                    }

                    const elapsed = _elapsed(_running.startedAt);
                    if (_running.stage === "done") {
                        const summary = summarizeReport(readGraphReport(ctx.cwd) ?? "");
                        _running = null;
                        pi.sendMessage(
                            { customType: "graphify", content: [{ type: "text", text: _fmtHint("✅ done", `${summary ?? "graph updated"} · chunks \`${chunksDone}\` · elapsed \`${elapsed}\``) }], display: true },
                            { deliverAs: "nextTurn" },
                        );
                    } else {
                        _running = null;
                        pi.sendMessage(
                            { customType: "graphify", content: [{ type: "text", text: _fmtHint("❌ failed", `exit \`${exitCode}\` · elapsed \`${elapsed}\``) }], display: true },
                            { deliverAs: "nextTurn" },
                        );
                    }
                }).catch((err: unknown) => {
                    dbg(log, `[graphify bg] unhandled exit error: ${err}`);
                    proxy?.stop();
                    _running = null;
                    pi.sendMessage(
                        { customType: "graphify", content: [{ type: "text", text: _fmtHint("❌ process error", `\`${err}\``) }], display: true },
                        { deliverAs: "nextTurn" },
                    );
                });
            };

            // ── extract: fire background ──────────────────────────────────────
            if (argv[0] === "extract" && !hasBackend) {
                await startBackgroundExtract(argv[1] ?? ".");
                return;
            }

            // ── add: fetch synchronously, then fire background extract ─────────
            if (argv[0] === "add" && !hasBackend) {
                const target = argv[1] ?? ".";
                let addOut = "";
                try {
                    ({ output: addOut } = await runGraphify(pi, argv, ctx, hasBackend, createProxy, ctx.signal));
                } catch (err) {
                    addOut = String(err);
                }
                if (addOut.startsWith("error")) {
                    pi.sendMessage(
                        { customType: "graphify", content: [{ type: "text", text: _fmtHint("❌ add failed", `\`${addOut}\``) }], display: true },
                        { deliverAs: "nextTurn" },
                    );
                    return;
                }
                await startBackgroundExtract(target);
                return;
            }

            let out = "";
            let chunkCount = 0;
            try {
                ({ output: out, chunkCount } = await runGraphify(pi, argv, ctx, hasBackend, createProxy, ctx.signal));
                // add: chain extract so the new file is immediately indexed.
                if (argv[0] === "add" && !out.startsWith("error")) {
                    dbg(log, "[graphify] add complete — chaining extract .");
                    const extractResult = await runGraphify(pi, ["extract", "."], ctx, hasBackend, createProxy, ctx.signal);
                    chunkCount += extractResult.chunkCount;
                    out = extractResult.output || out;
                }
            } catch (err) {
                out = String(err);
            }

            // extract/add: run cluster-only, label, re-run cluster-only.
            // cluster-only: label and re-run cluster-only.
            if (argv[0] === "extract" || argv[0] === "add") {
                const proc = Bun.spawnSync([detectPython(ctx.cwd), "-m", "graphify", "cluster-only", argv[1] ?? "."], { cwd: ctx.cwd });
                const clusterStderr = new TextDecoder("utf-8").decode(proc.stderr).trim();
                dbg(log, `[graphify] cluster-only exit=${proc.exitCode}${clusterStderr ? " stderr=" + clusterStderr.slice(0, 150) : ""}`);
                await label(pi, ctx, argv[1] ?? ".");
            } else if (argv[0] === "cluster-only") {
                await label(pi, ctx, argv[1] ?? ".");
            }

            const isExtractionCmd = argv[0] === "extract" || argv[0] === "update" || argv[0] === "add";
            // Graphify-specific post-command actions (cost tracking, benchmark, save-result)
            const benchmarkResult = postCommandActions(argv, ctx.cwd, out, chunkCount);
            if (isExtractionCmd) {
                const summary = summarizeReport(readGraphReport(ctx.cwd) ?? "");
                if (summary) {
                    const benchLine = benchmarkResult ? `\n${benchmarkResult}` : "";
                    pi.sendMessage(
                        { customType: "graphify", content: [{ type: "text", text: _fmtHint("✅ done", `${summary} · chunks \`${chunkCount}\`${benchLine}`) }], display: true },
                        { deliverAs: "nextTurn" },
                    );
                }
            } else if (out.trim()) {
                pi.sendMessage(
                    { customType: "graphify", content: [{ type: "text", text: out }], display: true },
                    { deliverAs: "steer", triggerTurn: true },
                );
            } else {
                // Command ran but produced no output — tell the user
                const fallback = `[graphify] no output for: graphify ${argv.join(" ")}`;
                pi.sendMessage(
                    { customType: "graphify", content: [{ type: "text", text: fallback }], display: true },
                    { deliverAs: "steer" },
                );
            }
        },
    });
}
