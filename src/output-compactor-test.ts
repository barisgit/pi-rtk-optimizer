import assert from "node:assert/strict";
import { derivePipeFilterFromRtkCommand, compactToolResult } from "./output-compactor.ts";
import { cloneDefaultConfig, runTest } from "./test-helpers.ts";

function text(content: unknown): string {
	const block = Array.isArray(content) ? content[0] : undefined;
	return typeof block?.text === "string" ? block.text : "";
}

function createPiMock(rewrites: Record<string, string>, pipes: Record<string, { code: number; stdout: string; stderr?: string }>) {
	const calls: Array<{ command: string; args: string[] }> = [];
	return {
		calls,
		pi: {
			async exec(command: string, args: string[]) {
				calls.push({ command, args });
				if (args[0] === "rewrite") {
					const rewritten = rewrites[args[1]];
					return rewritten
						? { code: 3, stdout: rewritten, stderr: "", killed: false }
						: { code: 1, stdout: "", stderr: "", killed: false };
				}
				if (command === "sh") {
					const filter = args.at(-1) ?? "";
					const result = pipes[filter] ?? { code: 1, stdout: "", stderr: "missing filter" };
					return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? "", killed: false };
				}
				return { code: 1, stdout: "", stderr: "unexpected", killed: false };
			},
		},
	};
}

runTest("derives pipe filters from rewritten RTK commands", () => {
	assert.equal(derivePipeFilterFromRtkCommand("rtk grep foo ."), "grep");
	assert.equal(derivePipeFilterFromRtkCommand("FOO=1 rtk git diff --stat"), "git-diff");
	assert.equal(derivePipeFilterFromRtkCommand("rtk git status"), "git-status");
	assert.equal(derivePipeFilterFromRtkCommand("rtk cargo test"), "cargo-test");
	assert.equal(derivePipeFilterFromRtkCommand("rtk ruff check ."), "ruff-check");
	assert.equal(derivePipeFilterFromRtkCommand("rtk ls -la"), undefined);
});

await runTest("builtin grep pipes through matching RTK filter when enabled", async () => {
	const config = cloneDefaultConfig();
	config.builtinPipeCompaction.enabled = true;
	const { pi, calls } = createPiMock({}, { grep: { code: 0, stdout: "compacted grep" } });

	const result = await compactToolResult(
		{ toolName: "grep", input: { pattern: "needle" }, content: [{ type: "text", text: "raw grep" }] },
		config,
		{ pi, executableResolution: { command: "rtk", resolver: "which" } },
	);

	assert.equal(result.changed, true);
	assert.equal(text(result.content), "compacted grep");
	assert.equal(result.metadata?.filter, "grep");
	assert.equal(calls.some((call) => call.command === "sh" && call.args.at(-1) === "grep"), true);
});

await runTest("builtin pipe compaction respects configured tool list", async () => {
	const config = cloneDefaultConfig();
	config.builtinPipeCompaction.enabled = true;
	config.builtinPipeCompaction.tools = ["find"];
	const { pi, calls } = createPiMock({}, { grep: { code: 0, stdout: "compacted" } });

	const result = await compactToolResult(
		{ toolName: "grep", input: {}, content: [{ type: "text", text: "raw" }] },
		config,
		{ pi, executableResolution: { command: "rtk", resolver: "which" } },
	);

	assert.equal(result.changed, false);
	assert.equal(calls.length, 0);
});

await runTest("remote bash classifies with local rtk rewrite before piping", async () => {
	const config = cloneDefaultConfig();
	const { pi, calls } = createPiMock(
		{ "git diff": "rtk git diff" },
		{ "git-diff": { code: 0, stdout: "compacted diff" } },
	);

	const result = await compactToolResult(
		{ toolName: "bash", input: { command: "git diff", session: "box" }, content: [{ type: "text", text: "raw diff" }] },
		config,
		{ pi, executableResolution: { command: "rtk", resolver: "which" } },
	);

	assert.equal(result.changed, true);
	assert.equal(text(result.content), "compacted diff");
	assert.equal(result.metadata?.filter, "git-diff");
	assert.equal(calls[0].args[0], "rewrite");
});

await runTest("local bash is never post-piped", async () => {
	const config = cloneDefaultConfig();
	const { pi, calls } = createPiMock({ "git diff": "rtk git diff" }, { "git-diff": { code: 0, stdout: "compacted" } });

	const result = await compactToolResult(
		{ toolName: "bash", input: { command: "git diff" }, content: [{ type: "text", text: "raw" }] },
		config,
		{ pi, executableResolution: { command: "rtk", resolver: "which" } },
	);

	assert.equal(result.changed, false);
	assert.equal(calls.length, 0);
});

await runTest("rtk pipe failure keeps original output", async () => {
	const config = cloneDefaultConfig();
	const { pi } = createPiMock({}, { find: { code: 2, stdout: "", stderr: "bad filter" } });

	const result = await compactToolResult(
		{ toolName: "find", input: {}, content: [{ type: "text", text: "raw find" }] },
		config,
		{ pi, executableResolution: { command: "rtk", resolver: "which" } },
	);

	assert.equal(result.changed, false);
});

await runTest("rtk pipe success is trusted even when output is empty", async () => {
	const config = cloneDefaultConfig();
	config.builtinPipeCompaction.enabled = true;
	const { pi } = createPiMock({}, { find: { code: 0, stdout: "" } });

	const result = await compactToolResult(
		{ toolName: "find", input: {}, content: [{ type: "text", text: "raw find" }] },
		config,
		{ pi, executableResolution: { command: "rtk", resolver: "which" } },
	);

	assert.equal(result.changed, true);
	assert.equal(text(result.content), "");
});
