# graphify OMP Extension
> **Requires the [gitrealname/oh-my-pi](https://github.com/gitrealname/oh-my-pi) fork.**
> This extension uses `pi.pi.complete` and other open-sdk exports that are not available in upstream OMP.
> The fork adds thin re-exports of internal APIs (LLM calls) that extensions
> can access at runtime via `ExtensionAPI.pi` — see [OPEN-SDK.md](https://github.com/gitrealname/oh-my-pi/blob/main/OPEN-SDK.md).

Integrates the [graphify](https://pypi.org/project/graphifyy/) knowledge-graph tool into OMP as a first-class slash command. On session start (or after the first `search`/`find` tool result) the extension injects a steering hint when a graph is present. The `/graphify` command delegates to the Python `graphify` subprocess for all sub-commands. For LLM-powered extraction calls the extension optionally spins up a local HTTP proxy that intercepts Anthropic API requests from the Python process and routes them through OMP's in-process model, giving extraction jobs access to the session's credentials and model configuration without extra API keys.

---

## Prerequisites

Install the `graphifyy` Python package. Full installation instructions, platform requirements, and optional extras (PDF, video, Neo4j, etc.) are at:

**https://github.com/safishamsi/graphify**

Quick install:

```sh
uv tool install graphifyy       # recommended — puts graphify on PATH automatically
# or:
pipx install graphifyy
pip install graphifyy
```

**Optional dependencies for export commands:**

- `matplotlib` (`pip install matplotlib`) — required for `export svg`

> **Skill registration:** The upstream installation guide includes a step `graphify install --platform pi` which writes a skill file into your OMP config. **Skip that step.** This extension ships its own `skills/graphify/SKILL.md` which is loaded automatically — it replaces the upstream skill and is kept in sync with the extension's command handling.

---

## Configuration

- **`GRAPHIFY_MODEL_ROLE`** (default: `smol`) — Role name from `modelRoles.*` in OMP settings used for LLM extraction calls. Falls back to the session's active model when the role is unresolvable.
- **`GRAPHIFY_OUT`** (default: `graphify-out`) — Output directory where `graph.json`, `analysis.md`, and related files are written (relative to the working directory).
- **`GRAPHIFY_ON_DEMAND`** (default: unset) — Set to `1` to suppress the automatic session-start and post-search hints. The `/graphify` command still works normally.

---

## Registration

Add the extension directory to your OMP config. The graphify extension has no shared-bootstrap dependency, so no ordering constraint applies.

**`~/.omp/agent/settings.json`**

```json
{
  "extensions": [
    "/absolute/path/to/omp-extensions-public/graphify"
  ]
}
```

**`~/.omp/agent/config.yml`**

```yaml
extensions:
  - /absolute/path/to/omp-extensions-public/graphify
```

---

## Usage

**Core queries:**

- `/graphify query <term>` — semantic node search
- `/graphify path <A> <B>` — shortest path between two nodes
- `/graphify explain <node>` — explain a node with graph context
- `/graphify save-result` — save query/path/explain answers back to graph

**Build / extract:**

- `/graphify extract [path]` — build or refresh the graph (runs in background)
- `/graphify update` — alias for `extract`
- `/graphify cluster-only` — re-cluster without re-extracting
- `/graphify add [path]` — add files to existing graph

**Export:**

- `/graphify export html` — interactive HTML viewer
- `/graphify export wiki` — wiki markdown
- `/graphify export svg` — SVG visualization (requires `matplotlib`)
- `/graphify export graphml` — GraphML format
- `/graphify export neo4j` — Neo4j Cypher file
- `/graphify export obsidian` — Obsidian vault
- `/graphify export callflow-html` — call flow HTML viewer

**Watch / hooks:**

- `/graphify watch` — watch for file changes and auto-update
- `/graphify hook install` / `hook uninstall` / `hook status` — git hooks

**Global graph:**

- `/graphify global list` / `global add` / `global remove` / `global path` — manage cross-project graphs

**Multi-repo / PR:**

- `/graphify clone` — clone a remote graph
- `/graphify merge-graphs` — merge multiple graphs
- `/graphify merge-driver` — git merge driver for graph.json
- `/graphify prs` — extract PR metadata

**Utility:**

- `/graphify benchmark` — token reduction benchmark
- `/graphify check-update` — check for graphify updates
- `/graphify tree` — display graph as tree
- `/graphify kill` — kill running background extraction
- `/graphify --help` / `--version` — reference

---

## Architecture

1. **Slash command** — `/graphify <args>` is registered via `pi.registerCommand`. Arguments are shell-split (quote-aware) before being forwarded.
2. **Python subprocess** — the extension locates the Python interpreter by reading the shebang of the `graphify` binary (falling back to `python3`), then spawns `python -m graphify <args>` with `cwd` set to the workspace root. The resolved interpreter is cached in `<GRAPHIFY_OUT>/.graphify_python`.
3. **In-process Anthropic proxy** — for `extract` commands the extension starts a local HTTP server before launching the subprocess. The server intercepts Anthropic `/v1/messages` requests from the Python process, routes them through the session model selected via `GRAPHIFY_MODEL_ROLE`, and returns the response. The subprocess is pointed at this proxy via `ANTHROPIC_BASE_URL`. Up to five concurrent requests are served (`MAX_CONCURRENT = 5`). The proxy is torn down automatically when the subprocess exits or the session shuts down.
4. **Community labeling** — after extraction completes, the extension runs `cluster-only` synchronously and calls the LLM in batches (up to 80 communities per call) to assign human-readable labels to the detected communities, writing results back into the graph.
5. **Background extraction** — `extract` and `add` run the subprocess in the background and post progress/completion hints between agent turns via `pi.sendMessage({ deliverAs: "nextTurn" })`.
6. **Post-command actions** — after each command, the extension saves query/path/explain results, tracks cumulative token costs in `cost.json`, and runs a benchmark for large corpora (> 5000 words).
