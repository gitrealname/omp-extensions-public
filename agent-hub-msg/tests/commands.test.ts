import { describe, expect, it } from "bun:test";
import { msgArgumentCompletions } from "../core/commands";

describe("/msg argument completions", () => {
	it("empty prefix → all subcommands as bare values", () => {
		const items = msgArgumentCompletions("");
		expect(items).not.toBeNull();
		expect(items!.map(i => i.value).sort()).toEqual(["alias ", "instruct", "list"]);
		// Contract: the TUI replaces the argument text with `value` — values
		// must never include the command line itself (regression: "/msg list"
		// as value produced "/msg /msg list" on acceptance).
		for (const item of items!) {
			expect(item.value.startsWith("/")).toBe(false);
			expect(item.value.includes("msg")).toBe(false);
		}
	});

	it("prefix filtering narrows to matching subcommands", () => {
		expect(msgArgumentCompletions("l")!.map(i => i.value)).toEqual(["list"]);
		expect(msgArgumentCompletions("in")!.map(i => i.value)).toEqual(["instruct"]);
		expect(msgArgumentCompletions("a")!.map(i => i.value)).toEqual(["alias "]);
	});

	it("typing a subcommand fully still offers it (keeps trailing space for alias)", () => {
		const items = msgArgumentCompletions("alias ");
		expect(items).not.toBeNull();
		expect(items![0].value).toBe("alias ");
	});

	it("free-form alias name → null (fall through)", () => {
		expect(msgArgumentCompletions("alias my-team")).toBeNull();
	});

	it("non-matching prefix → empty list", () => {
		expect(msgArgumentCompletions("zzz")).toEqual([]);
	});
});
