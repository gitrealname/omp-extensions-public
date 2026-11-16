# secrets-obfuscator

The model never sees a real secret. The agent still uses them.

`secrets-obfuscator` is an omp extension. It replaces each configured secret with
a placeholder before the text leaves for the LLM, and puts the real value back
before a tool runs. No proxy, no port, no network, no daemon.

```text
you type     my token is ghp_realtokenvalue123456789
model sees   my token is <SECRET:GITHUB_TOKEN:1A2B3C4D>
tool runs    curl -H "Authorization: Bearer ghp_realtokenvalue123456789"
```

## How it works

Four hooks do all the work.

| Hook | Direction | Job |
|---|---|---|
| `context` | outbound | mask every string in the transcript before each LLM call |
| `before_provider_request` | outbound | mask the final provider payload (safety net) |
| `tool_call` | inbound | restore aliases in tool arguments before execution |
| `tool_result` | inbound | mask tool output before the model sees it |

The session file therefore only ever holds aliases. Nothing rewrites old
sessions, and no state file exists.

### Aliases are derived, not stored

```text
<SECRET:GITHUB_TOKEN:1A2B3C4D>
tag           first 8 hex of sha256(label + NUL + value)
```

The alias is a pure function of the label and the value. The label is part of
the hash input, so two labels can carry the same value and each gets its own
alias. Identical values always produce the same alias, so a transcript is
masked once at the moment it is created and stays correct for the life of the
session. Decoding is unambiguous: the tag names the exact value.

## Configuration

File: `~/.omp/agent/secrets-obfuscator.yaml`. Override the path with the
`SECRETS_OBFUSCATOR_CONFIG` environment variable.

```yaml
mappings:
  GITHUB_TOKEN: ghp_realtokenvalue123456789
  DATABASE_PASSWORD:          # one label, every value it ever had
    - old_password_value_123
    - new_password_value_456
```

1. Create the file.
2. Add one entry per secret.
3. Restart omp.

A rotated secret keeps its label and gains a value. Old sessions stay masked
with the old tag, new sessions use the new one, and each alias restores the
value it names.

A value does not have to be a whole secret. Configure a fragment and every
occurrence around it is masked:

```yaml
mappings:
  EMAIL_DOMAIN: "@example.com"
  API_HOST: api.example.com
```

```text
alice@example.com            alice<SECRET:EMAIL_DOMAIN:...>
https://api.example.com/v1   https://<SECRET:API_HOST:...>/v1
```

The text around the fragment stays readable. When two values overlap, the
longer one at that position wins.

The file holds real values. Keep it out of git.

## Install

The extension is listed in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - d:/.ai/OMP/src/omp-extensions-public/secrets-obfuscator
```

List it last. `context` handlers run in load order, and the last registration of
a provider URL wins.

## Session sweep

Sessions recorded before the extension existed still hold real values. The sweep
walks a sessions tree and masks them in place.

```bash
bun src/cli.ts                    # dry run: report only
bun src/cli.ts --apply            # mask in place
bun src/cli.ts --root <dir>       # sweep another tree
bun src/cli.ts --config <file>    # use another mapping file
```

| Flag | Default | Meaning |
|---|---|---|
| `--root` | `~/.omp/agent/sessions` | tree to walk |
| `--config` | `~/.omp/agent/secrets-obfuscator.yaml` | mapping file |
| `--apply` | off | write changes; without it nothing is written |
| `--verbose` | off | log every file read |

Files ending in `.jsonl`, `.json` or `.log` are masked. JSON lines are rewritten
field by field. Other lines keep their formatting. The sweep is idempotent: a
second run reports 0 changes.

## Test

```bash
bun tests/hooks.e2e.ts
```

The test drives the four handlers with the payloads omp hands them. It needs no
model and no network.

## Limits

1. Matching is exact and literal, including the JSON-escaped spelling of a value.
   Base64, URL-encoded or split values are not found.
2. The model still sees the alias, so it can mention or repeat it.
3. Aliases can collide with real text if a value is very short.
4. A secret that never appears in the transcript is never masked, because there is
   nothing to mask.
5. Short or common values can mask ordinary text. A value under 4 characters logs
   a warning at load.