// ── config-overlay extension ─────────────────────────────────────────────────
// Per-invocation settings overlay via --config-overlay flag.
//
// Usage: omp --config-overlay config-overlays/no-memory.yml
//
// The overlay file is a YAML subset. Only keys present are applied as
// runtime overrides (not persisted to config.yml). Relative paths resolve
// against the agent directory (same dir as config.yml).

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";

// Bun built-in YAML parser — same one used by OMP's settings system.
const { YAML } = globalThis.Bun as unknown as { YAML: { parse(s: string): unknown } };

// ── Debug guard ─────────────────────────────────────────────────────────────

function dbg(log: { debug(msg: string): void }, msg: string): void {
    if (process.env.OMP_EXTENSION_DEBUG === "1") log.debug(msg);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Flatten a nested object to dotted keys.
 * { memory: { backend: "off" } } → [["memory.backend", "off"]]
 */
function* flatten(obj: unknown, prefix = ""): Generator<[string, unknown]> {
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
        if (prefix) yield [prefix, obj];
        return;
    }
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (value != null && typeof value === "object" && !Array.isArray(value)) {
            yield* flatten(value, full);
        } else {
            yield [full, value];
        }
    }
}

// ── Extension factory ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
    const log = pi.logger;
    dbg(log, `[config-overlay] loaded`);

    // Register the CLI flag. OMP parses --config-overlay <value> before the
    // session starts; getFlag() returns the value in session_start.
    pi.registerFlag("config-overlay", {
        description: "Path to config overlay YAML (resolves relative to agent dir)",
        type: "string",
    });

    pi.on("session_start", (_event, ctx) => {
        const overlayArg = pi.getFlag("config-overlay");
        if (!overlayArg) return;

        // Resolve path: absolute as-is, relative → agent dir (same as config.yml)
        const agentDir = pi.openSdk.settings.getAgentDir();
        const resolved = path.isAbsolute(overlayArg)
            ? overlayArg
            : path.join(agentDir, overlayArg);

        dbg(log, `[config-overlay] flag=${overlayArg} resolved=${resolved}`);

        // Read YAML
        let content: string;
        try {
            content = require("node:fs").readFileSync(resolved, "utf-8");
        } catch (err) {
            const msg = `[config-overlay] failed to read ${resolved}: ${err}`;
            log.warn(msg);
            ctx.ui.notify(msg, "error");
            return;
        }

        // Parse YAML
        let parsed: unknown;
        try {
            parsed = YAML.parse(content);
        } catch (err) {
            const msg = `[config-overlay] YAML parse error in ${resolved}: ${err}`;
            log.warn(msg);
            ctx.ui.notify(msg, "error");
            return;
        }

        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
            log.warn(`[config-overlay] overlay is not a YAML object: ${resolved}`);
            return;
        }

        // Apply all overrides in a single transaction with hooks fired
        const result = pi.openSdk.applyOverrides(
            pi.openSdk.settings,
            Object.fromEntries(flatten(parsed)),
            { fireHooks: true },
        );
        if (result.skipped.length > 0) {
            for (const s of result.skipped) {
                log.warn(`[config-overlay] skipped ${s.key}: ${s.reason}`);
            }
        }
        dbg(log, `[config-overlay] applied ${result.applied.length} override(s) from ${resolved}`);
    });
}
