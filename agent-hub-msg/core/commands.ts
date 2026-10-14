/**
 * Slash-command argument completions (harness-neutral).
 *
 * The TUI contract: on acceptance it replaces the argument text (everything
 * after "/msg ") with `value` — so values must be bare arguments and never
 * include the "/msg" command line. Returning null makes the TUI fall through
 * to its default completion behavior.
 */

export interface CompletionItem {
	value: string;
	label: string;
	description: string;
}

export function msgArgumentCompletions(prefix: string): CompletionItem[] | null {
	const arg = prefix.trim().toLowerCase();
	if (arg.startsWith("alias") && arg.length > "alias".length) return null; // free-form name
	const options: Array<{ value: string; description: string }> = [
		{ value: "instruct", description: "re-inject mail instructions" },
		{ value: "list", description: "list registered agent sessions" },
		{ value: "alias ", description: "set an alias for this session" },
	];
	return options
		.filter(o => o.value.trim().startsWith(arg))
		.map(o => ({ value: o.value, label: o.value.trim(), description: o.description }));
}
