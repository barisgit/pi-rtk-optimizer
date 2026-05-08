import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRtkRewrite } from "./rtk-rewrite-provider.js";
import { splitLeadingEnvAssignments } from "./shell-env-prefix.js";
import { trackRtkActivity } from "./output-metrics.js";
import { toRecord } from "./record-utils.js";
import type { RtkExecHost, RtkExecutableResolution } from "./rtk-executable-resolver.js";
import type { BuiltinPipeTool, RtkIntegrationConfig } from "./types.js";

interface ContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface ToolResultLikeEvent {
	toolName: string;
	input?: unknown;
	content?: unknown;
}

export interface ToolResultCompactionMetadata {
	kind: "rtk-pipe";
	tool: string;
	filter: string;
}

export interface ToolResultCompactionOutcome {
	changed: boolean;
	content?: unknown;
	metadata?: ToolResultCompactionMetadata;
}

export interface RtkPipeCompactionOptions {
	pi: RtkExecHost;
	executableResolution?: RtkExecutableResolution;
}

const KNOWN_PIPE_FILTERS = new Set([
	"cargo-test",
	"pytest",
	"go-test",
	"go-build",
	"tsc",
	"vitest",
	"grep",
	"rg",
	"find",
	"fd",
	"git-log",
	"git-diff",
	"git-status",
	"mypy",
	"ruff-check",
	"ruff-format",
	"prettier",
]);

function getFirstTextBlock(content: unknown): { blocks: ContentBlock[]; index: number; text: string } | undefined {
	if (!Array.isArray(content)) {
		return undefined;
	}

	const blocks = content as ContentBlock[];
	const index = blocks.findIndex((block) => block?.type === "text" && typeof block.text === "string");
	if (index === -1) {
		return undefined;
	}

	return { blocks, index, text: blocks[index].text ?? "" };
}

function hasRemoteSession(input: unknown): boolean {
	return typeof toRecord(input).session === "string";
}

function getCommand(input: unknown): string | undefined {
	const command = toRecord(input).command;
	return typeof command === "string" ? command : undefined;
}

function splitCommandWords(command: string): string[] {
	return command.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map((part) => part.replace(/^['"]|['"]$/g, "")) ?? [];
}

export function derivePipeFilterFromRtkCommand(command: string): string | undefined {
	const withoutEnv = splitLeadingEnvAssignments(command).command.trim();
	const words = splitCommandWords(withoutEnv);
	if (words[0] !== "rtk") {
		return undefined;
	}

	const [first, second, third] = words.slice(1);
	if (!first) {
		return undefined;
	}

	let candidate: string | undefined;
	if (["grep", "rg", "find", "fd", "pytest", "vitest", "tsc", "mypy", "prettier"].includes(first)) {
		candidate = first;
	} else if (first === "git" && ["diff", "status", "log"].includes(second ?? "")) {
		candidate = `git-${second}`;
	} else if (first === "cargo" && second === "test") {
		candidate = "cargo-test";
	} else if (first === "go" && ["test", "build"].includes(second ?? "")) {
		candidate = `go-${second}`;
	} else if (first === "ruff" && ["check", "format"].includes(second ?? "")) {
		candidate = `ruff-${second}`;
	} else if (first === "python" && second === "-m" && third === "pytest") {
		candidate = "pytest";
	}

	return candidate && KNOWN_PIPE_FILTERS.has(candidate) ? candidate : undefined;
}

async function selectRemoteBashFilter(
	command: string,
	options: RtkPipeCompactionOptions,
): Promise<string | undefined> {
	const result = await resolveRtkRewrite(options.pi, command, {
		executableResolution: options.executableResolution,
	});
	if (!result.changed) {
		return undefined;
	}
	return derivePipeFilterFromRtkCommand(result.rewrittenCommand);
}

function selectBuiltinFilter(event: ToolResultLikeEvent, config: RtkIntegrationConfig): BuiltinPipeTool | undefined {
	if (!config.builtinPipeCompaction.enabled) {
		return undefined;
	}
	if (event.toolName !== "grep" && event.toolName !== "find") {
		return undefined;
	}
	return config.builtinPipeCompaction.tools.includes(event.toolName) ? event.toolName : undefined;
}

async function runRtkPipe(
	text: string,
	filter: string,
	options: RtkPipeCompactionOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const executable = options.executableResolution?.command ?? "rtk";
	const dir = mkdtempSync(join(tmpdir(), "pi-rtk-pipe-"));
	const inputPath = join(dir, "input.txt");
	try {
		writeFileSync(inputPath, text, "utf-8");
		const script = 'cat "$1" | "$2" pipe -f "$3"';
		const result = await options.pi.exec("sh", ["-c", script, "pi-rtk-pipe", inputPath, executable, filter], {
			timeout: 10_000,
		});
		return { code: result.code, stdout: result.stdout, stderr: result.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function compactToolResult(
	event: ToolResultLikeEvent,
	config: RtkIntegrationConfig,
	options: RtkPipeCompactionOptions,
): Promise<ToolResultCompactionOutcome> {
	const textBlock = getFirstTextBlock(event.content);
	if (!textBlock) {
		return { changed: false };
	}

	let filter: string | undefined;
	if (event.toolName === "bash") {
		if (!config.remoteBashPipeCompaction.enabled || !hasRemoteSession(event.input)) {
			return { changed: false };
		}
		const command = getCommand(event.input);
		if (!command) {
			return { changed: false };
		}
		filter = await selectRemoteBashFilter(command, options);
	} else {
		filter = selectBuiltinFilter(event, config);
	}

	if (!filter) {
		return { changed: false };
	}

	const result = await runRtkPipe(textBlock.text, filter, options);
	if (result.code !== 0) {
		trackRtkActivity({
			kind: "pipe-error",
			tool: event.toolName,
			filter,
			detail: result.stderr || `exit ${result.code}`,
		});
		return { changed: false };
	}

	trackRtkActivity({ kind: "pipe", tool: event.toolName, filter, command: getCommand(event.input) });

	const nextBlocks = [...textBlock.blocks];
	nextBlocks[textBlock.index] = { ...nextBlocks[textBlock.index], text: result.stdout };
	return {
		changed: true,
		content: nextBlocks,
		metadata: {
			kind: "rtk-pipe",
			tool: event.toolName,
			filter,
		},
	};
}
