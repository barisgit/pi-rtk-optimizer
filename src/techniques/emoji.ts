const RTK_COMMAND_PATTERN = /^\s*rtk(?:\.exe)?(?:\s|$)/;
const RTK_OUTPUT_SIGNATURE_PATTERNS = [
	/^\uD83D\uDCC2 PATH Variables:/m,
	/^\uD83D\uDD27 Language\/Runtime:/m,
	/^\u2601\uFE0F?\s+Cloud\/Services:/m,
	/^\uD83D\uDEE0\uFE0F?\s+Tools:/m,
	/^\uD83D\uDCCB Other:/m,
	/^\uD83D\uDCCA Total:/m,
	/^\uD83D\uDCCA\s+.+\s+\u2192\s+.+/m,
	/^\uD83D\uDCCC\s+/m,
	/^\u2705 Files are identical$/m,
	/^\u2705 Staged:/m,
	/^\uD83D\uDCDD Modified:/m,
	/^\u2753 Untracked:/m,
	/^\u26A0\uFE0F?\s+Conflicts:/m,
	/^\uD83D\uDD0D CI Checks Summary:/m,
	/^\uD83D\uDD0D\s+\d+\s+in\s+\d+F:/m,
	/^--- Changes ---$/m,
	/^\uD83D\uDCC4\s+.+$/m,
	/^\uD83D\uDCC1\s+\d+F\s+\d+D:/m,
	/^\u2638\uFE0F?\s+\d+\s+pods:/m,
	/^\uD83D\uDCE6\s+/m,
] as const;

const LINE_PREFIX_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
	{ pattern: /^\uD83D\uDD0D\s+/gm, replacement: "" },
	{ pattern: /^\uD83D\uDCC4\s+/gm, replacement: "> " },
	{ pattern: /^\uD83D\uDCC2\s+/gm, replacement: "" },
	{ pattern: /^\uD83D\uDD27\s+/gm, replacement: "" },
	{ pattern: /^\u2601\uFE0F?\s+/gm, replacement: "" },
	{ pattern: /^\uD83D\uDEE0\uFE0F?\s+/gm, replacement: "" },
	{ pattern: /^\uD83D\uDCCB\s+/gm, replacement: "" },
	{ pattern: /^\uD83D\uDCCA\s+/gm, replacement: "" },
	{ pattern: /^\uD83D\uDCCC\s+/gm, replacement: "Branch: " },
	{ pattern: /^\uD83D\uDCDD\s+/gm, replacement: "" },
	{ pattern: /^\uD83D\uDCE6\s+/gm, replacement: "" },
	{ pattern: /^\uD83D\uDCC1\s+/gm, replacement: "" },
	{ pattern: /^\u2638\uFE0F?\s+/gm, replacement: "" },
] as const;

const INLINE_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
	{ pattern: /\u2705|\u2713|\u2714/g, replacement: "[OK]" },
	{ pattern: /\u274C|\u2717|\u2715/g, replacement: "[ERROR]" },
	{ pattern: /\u26A0\uFE0F|\u26A0/g, replacement: "[WARN]" },
	{ pattern: /\u2753/g, replacement: "[INFO]" },
	{ pattern: /\u23ED\uFE0F|\u23ED/g, replacement: "[SKIP]" },
	{ pattern: /\u23F3/g, replacement: "Pending" },
	{ pattern: /\u2B06\uFE0F|\u2B06/g, replacement: "up" },
	{ pattern: /\u2192/g, replacement: "->" },
	{ pattern: /\u2022/g, replacement: "-" },
] as const;

const REMAINING_EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;
const EMOJI_VARIATION_SELECTOR_PATTERN = /\uFE0F/g;
const INLINE_LABEL_SPACING_PATTERN = /(\[[A-Z]+\])(\S)/g;

function isRtkCommand(command: string | undefined | null): boolean {
	return typeof command === "string" && RTK_COMMAND_PATTERN.test(command);
}

function looksLikeRtkStyledOutput(output: string): boolean {
	return RTK_OUTPUT_SIGNATURE_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * RTK emits emoji-heavy presentation in several command outputs. Pi should
 * present tool results as plain text, so normalize RTK output markers before
 * the agent consumes them. We apply this to explicit `rtk ...` commands and to
 * recognizable RTK-shaped output that may have been prefixed by another layer.
 */
export function sanitizeRtkEmojiOutput(output: string, command: string | undefined | null): string | null {
	if (!isRtkCommand(command) && !looksLikeRtkStyledOutput(output)) {
		return null;
	}

	let nextText = output;

	for (const { pattern, replacement } of LINE_PREFIX_REPLACEMENTS) {
		nextText = nextText.replace(pattern, replacement);
	}

	for (const { pattern, replacement } of INLINE_REPLACEMENTS) {
		nextText = nextText.replace(pattern, replacement);
	}

	nextText = nextText.replace(REMAINING_EMOJI_PATTERN, "");
	nextText = nextText.replace(EMOJI_VARIATION_SELECTOR_PATTERN, "");
	nextText = nextText.replace(INLINE_LABEL_SPACING_PATTERN, "$1 $2");

	return nextText === output ? null : nextText;
}
