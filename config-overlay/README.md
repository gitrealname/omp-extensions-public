# config-overlay

OMP extension for per-invocation settings overlay without modifying `config.yml`.

## Requirements

Requires the [open-sdk fork](https://github.com/gitrealname/oh-my-pi) of oh-my-pi. The open-sdk exposes `settings.override()` and `registerFlag()` via the `ExtensionAPI.pi` namespace, which this extension uses to apply runtime-only settings patches.

Upstream OMP: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) · [Open issues](https://github.com/can1357/oh-my-pi/issues) · [Issue #1733](https://github.com/can1357/oh-my-pi/issues/1733) (core-level overlay)

## Installation

Add the extension path to your `config.yml` (typically `~/.omp/agent/config.yml`):

```yaml
extensions:
  - /path/to/config-overlay
```

No `settings.json` changes needed — the extension is loaded from `config.yml` on startup.

## Usage

```sh
omp --config-overlay config-overlays/no-memory.yml
omp --config-overlay config-overlays/bedrock-only.yml -p "summarize these papers"
omp --config-overlay /absolute/path/to/overlay.yml
```

## Overlay file format

Standard YAML, same keys as `config.yml`. Only keys present are applied — deep-merged on top of global + project settings. Not persisted.

```yaml
# config-overlays/no-memory.yml
memory:
  backend: "off"
```

```yaml
# config-overlays/bedrock-only.yml
disabledProviders:
  - anthropic
  - openai
```

## Path resolution

- **Relative path** (e.g. `config-overlays/no-memory.yml`) — resolves against the agent directory (same directory as `config.yml`, typically `~/.omp/agent/`)
- **Absolute path** (e.g. `/home/user/config-overlays/bedrock-only.yml`) — used as-is

## Storing overlays

Recommended: place overlay files next to `config.yml`:

```
~/.omp/agent/
  config.yml
  config-overlays/
    no-memory.yml
    bedrock-only.yml
    research-mode.yml
```

Then reference them as `config-overlays/no-memory.yml`.

## How it works

1. Extension registers `--config-overlay` CLI flag via `registerFlag()`
2. On `session_start`, reads the flag value via `getFlag()`
3. Loads and parses the YAML file
4. Applies each key as a runtime override via `settings.override()` — in-memory only, not written to `config.yml`

## Scope and limitations

The overlay is applied during `session_start`, **after** session creation.

**Works (lazy-read settings):**

- `disabledProviders` — checked on each provider selection
- `memory.backend` — read when memory subsystem is queried
- Feature flags, UI settings, display options
- Shell configuration

**Does not work (eagerly-initialized at session creation):**

- `modelRoles.default` — model is resolved before `session_start` fires
- Provider credentials — loaded at startup
- UI settings with side-effect hooks (`theme.dark`, `display.tabWidth`, etc.) — `settings.override()` does not fire the hooks that `settings.set()` runs, so the UI won't update until the next session

For eager settings, the core-level `--config-overlay` proposed in [issue #1733](https://github.com/can1357/oh-my-pi/issues/1733) is the proper solution — it applies the overlay in the `Settings` constructor before any subsystem initialization.

## Testing

```sh
# bash / zsh
OMP_EXTENSION_DEBUG=1 omp --config-overlay config-overlays/test.yml -p "say ok"

# Windows cmd
set OMP_EXTENSION_DEBUG=1 && omp --config-overlay config-overlays/test.yml -p "say ok"
```

Create `config-overlays/test.yml` in your agent directory with any lazy-read setting to verify.
