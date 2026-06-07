// ── Graphify extension types ──────────────────────────────────────────────────
// Shared interfaces for the graphify extension modules.

/** Minimal model reference — the full OMP model object has more fields. */
export interface ModelRef {
    id: string;
    [key: string]: unknown;
}

/** Shape of the `complete()` function from open-sdk. */
export interface CompleteResult {
    content?: Array<{ type: string; text?: string }>;
}

export type CompleteFn = (
    model: ModelRef,
    opts: {
        systemPrompt?: string[];
        messages: Array<{
            role: string;
            content: Array<{ type: string; text?: string } | string> | string;
            timestamp?: number;
        }>;
    },
    extra?: { maxTokens?: number },
) => Promise<CompleteResult>;

/** Minimal logger interface — pi.logger satisfies this. */
export interface PiLogger {
    debug(msg: string): void;
}

/** Minimal command context — the full ctx object has more fields. */
export interface CommandContext {
    cwd: string;
    model?: ModelRef;
    modelRegistry: {
        getAvailable(): ModelRef[];
    };
    signal?: AbortSignal;
}

/** Tool result event from pi.on("tool_result"). */
export interface ToolResultEvent {
    toolName?: string;
    input?: { command?: string };
}

/** Options for pi.sendMessage. */
export interface SendMessageOptions {
    deliverAs: string;
    triggerTurn?: boolean;
}

/** Handle returned by anthropicProxyServer. */
export interface ProxyHandle {
    port: number;
    stop: () => number;
    getCount: () => { total: number; active: number };
}

/** Type for creating a proxy server — bound with `complete` in main.ts. */
export type CreateProxyFn = (
    pi: { logger: PiLogger },
    ctx: CommandContext,
    deepMode: boolean,
    onFirstChunk?: () => void,
) => Promise<ProxyHandle | null>;
