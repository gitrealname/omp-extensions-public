/**
 * secrets-obfuscator — circuit breaker.
 *
 * omp swallows extension failures: a module that calls process.exit(1) is
 * reported and unloaded, a hook that throws is reported and the request goes
 * out anyway. Neither can stop a session from reaching the model unmasked.
 *
 * The breaker therefore sits at the one place omp cannot retry around: the
 * outbound HTTP call. When the guard is not armed, every non-loopback request
 * fails with the reason. No request, no leak.
 */

const GUARD_FLAG = Symbol.for("secrets-obfuscator.breaker");

function isLoopback(url: string): boolean {
	return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	const url = (input as { url?: unknown } | null)?.url;
	return typeof url === "string" ? url : String(input);
}

let reason = "config unusable";

/**
 * Point every outbound fetch at a rejection. Idempotent: a second call keeps
 * the patch and refreshes the reason, so a later config failure is reported
 * with its own message.
 */
export function blockOutbound(why: string): void {
	reason = why;
	const scope = globalThis as unknown as Record<symbol, unknown>;
	if (scope[GUARD_FLAG]) return;
	scope[GUARD_FLAG] = true;

	const original = globalThis.fetch;

	globalThis.fetch = ((input: unknown, init?: unknown) => {
		const url = requestUrl(input);
		if (/^https?:\/\//i.test(url) && !isLoopback(url)) {
			return Promise.reject(new Error(`secrets-obfuscator: guard not armed, request blocked (${reason}): ${url}`));
		}
		return original(input as RequestInfo, init as RequestInit);
	}) as typeof globalThis.fetch;

	// Bun.fetch is a separate, read-only own property; it cannot be replaced.
	// omp reaches the provider through the global fetch above, which is why
	// this patch is enough (proved against a real blocked request).
}

/** True when this process has already been stopped by the breaker. */
export function breakerActive(): boolean {
	return Boolean((globalThis as unknown as Record<symbol, unknown>)[GUARD_FLAG]);
}