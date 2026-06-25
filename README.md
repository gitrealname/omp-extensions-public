# omp-extensions-public

Community extensions for the [Oh My Pi](https://github.com/can1357/oh-my-pi) coding agent.

> **Requires the [open-sdk fork](https://github.com/gitrealname/oh-my-pi)** of oh-my-pi. The open-sdk exposes OMP internals (`settings`, `complete`, model registry, etc.) via the `ExtensionAPI.openSdk` namespace. Stock OMP does not expose these APIs — extensions that depend on open-sdk will not load without it. See [OPEN-SDK.md](https://github.com/gitrealname/oh-my-pi/blob/main/OPEN-SDK.md).

## Extensions

| Extension | Description |
|---|---|
| [**config-overlay**](config-overlay/README.md) | Per-invocation settings overlay via `--config-overlay` CLI flag |
| [**graphify**](graphify/README.md) | Knowledge graph extraction, querying, and community labeling |
| [**mdreview**](mdreview/README.md) | Interactive markdown file review with annotation and AI chat |
| [**slash_proxy**](slash_proxy/README.md) | Custom slash command proxy for OMP ⚠️ *experimental* |

## How OMP extensions work

OMP extensions are opt-in. They are loaded at startup from paths listed in your `config.yml` (typically `~/.omp/agent/config.yml`). Each extension is a directory containing a `package.json` with an `omp.extensions` field pointing to the entry point.

There is no registry, no install command, and no auto-discovery. You clone an extension, add its path to `config.yml`, and restart OMP. That's it.

## Configuring extensions

Add the extension directory path to the `extensions` list in your `config.yml`:

```yaml
# ~/.omp/agent/config.yml

extensions:
  - /path/to/omp-extensions-public/config-overlay
  - /path/to/omp-extensions-public/graphify
  - /path/to/omp-extensions-public/mdreview
  - /path/to/omp-extensions-public/slash_proxy
```

Most extensions also require an entry in `settings.json` (`~/.omp/agent/settings.json`). Check each extension's README for the exact snippet. Example:

```json
// ~/.omp/agent/settings.json
{
  "extensions": [
    "/path/to/omp-extensions-public/graphify",
    "/path/to/omp-extensions-public/mdreview"
  ]
}
```

> **Note:** The dual registration (`config.yml` + `settings.json`) is a known limitation. Upstream [issue #1557](https://github.com/can1357/oh-my-pi/issues/1557) proposes a unified extension registration path that would eliminate the `settings.json` requirement. Once resolved, only `config.yml` would be needed.

Each extension's README documents its own configuration, CLI flags, and usage. Some extensions register custom CLI flags (e.g. `--config-overlay`), custom commands (e.g. `/graphify query`), or both.

## Extension structure

Each extension is a standalone directory:

```
extension-name/
  package.json          # OMP manifest: { "omp": { "extensions": ["./src/main.ts"] } }
  src/
    main.ts             # Extension factory (default export)
  README.md             # Extension-specific docs
```

The factory receives an `ExtensionAPI` instance and registers event handlers, commands, flags, and tools. See the [OMP extension docs](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) for the full API reference.

## Requirements

- [Oh My Pi](https://github.com/can1357/oh-my-pi) (upstream)
- [open-sdk fork](https://github.com/gitrealname/oh-my-pi) (for extensions that use `pi.openSdk.*` APIs)
- Some extensions have additional dependencies (e.g. graphify requires `graphifyy` Python package)

## License

MIT
