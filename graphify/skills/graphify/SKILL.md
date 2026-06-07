---
name: graphify
description: "Knowledge graph for this project. Use when asked about codebase architecture, component relationships, or file structure — especially if graphify-out/ exists. Provides persistent graph with BFS/DFS query, shortest-path, and node-explanation tools."
---

# graphify

A persistent knowledge graph over the project. Relationships survive across sessions; every edge is tagged `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`.

## When to use

- User asks about architecture, module relationships, or "what connects to X"
- `graphify-out/graph.json` exists (graph already built — query it)
- User explicitly invokes `/graphify` with any subcommand

## How to invoke

Call `slash_proxy` with the command and stop. Do not run bash, do not read files.

```ts
slash_proxy({ command: "/graphify <subcommand> [args]" })
```

## Query commands (use when graph exists)

| Command | Purpose |
|---|---|
| `/graphify query "<question>"` | Broad BFS traversal — best for open questions |
| `/graphify query "<question>" --dfs` | Deep DFS — best for tracing a specific dependency |
| `/graphify path "A" "B"` | Shortest path between two concepts |
| `/graphify explain "NodeName"` | Plain-language explanation of a node and its connections |

Default path argument is `.` when omitted.

## Other commands

Pass any other `/graphify` invocation from the user directly through `slash_proxy` unchanged. You do not need to understand the subcommand.
