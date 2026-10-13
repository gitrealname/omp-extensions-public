/**
 * agent-hub-msg core — local snowflake ids.
 *
 * 64-bit, time-sortable, hex-string ids: 42-bit ms since the Discord epoch
 * plus a 22-bit sequence. Same layout as @oh-my-pi/pi-utils Snowflake so ids
 * stay interoperable — implemented locally so the core library has no
 * harness/monorepo dependencies.
 */
import * as nodeCrypto from "node:crypto";

const EPOCH = 1420070400000;
const MAX_SEQ = 0x3fffff; // 22 bits
const MAX_DT = 2 ** 42 - 1;

function randu32(): number {
	return nodeCrypto.webcrypto.getRandomValues(new Uint32Array(1))[0];
}

function formatParts(dt: number, seq: number): string {
	const clamped = Math.min(Math.max(dt, 0), MAX_DT);
	return ((BigInt(clamped) << 22n) | BigInt(seq & MAX_SEQ)).toString(16).padStart(16, "0");
}

let lastTimestamp = 0;
let sequence = 0;

export const Snowflake = {
	/** Next snowflake: monotonic within this process, unique across restarts. */
	next(timestamp = Date.now()): string {
		if (timestamp === lastTimestamp) {
			sequence = (sequence + 1) & MAX_SEQ;
			if (sequence === 0) {
				while ((timestamp = Date.now()) <= lastTimestamp) {}
			}
		} else {
			sequence = randu32() & MAX_SEQ;
			lastTimestamp = timestamp;
		}
		return formatParts(timestamp - EPOCH, sequence);
	},
};
