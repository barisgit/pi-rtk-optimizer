import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mock } from "bun:test";

import { clearOutputMetrics, getOutputMetricsSummary, trackRtkActivity } from "./output-metrics.ts";
import { runTest } from "./test-helpers.ts";
import { applyWindowsBashCompatibilityFixes } from "./windows-command-helpers.ts";
import { applyRewrittenCommandShellSafetyFixups } from "./rewrite-pipeline-safety.ts";
import { applyRtkCommandEnvironment } from "./rtk-command-environment.ts";
import { sanitizeStreamingBashExecutionResult } from "./tool-execution-sanitizer.ts";

mock.module("@mariozechner/pi-coding-agent", () => ({
	getAgentDir: () => "/tmp/.pi/agent",
}));

const {
	ensureConfigExists,
	getRtkIntegrationConfigPath,
	loadRtkIntegrationConfig,
	normalizeRtkIntegrationConfig,
	saveRtkIntegrationConfig,
} = await import("./config-store.ts");

function makeTempConfigPath(): string {
	return `${getRtkIntegrationConfigPath()}.test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function cleanupFile(path: string): void {
	for (const candidate of [path, `${path}.tmp`]) {
		try {
			if (existsSync(candidate)) {
				unlinkSync(candidate);
			}
		} catch {
			// Ignore cleanup failures in tests.
		}
	}
}

runTest("config-store normalizes new config and filters builtin pipe tools", () => {
	const normalized = normalizeRtkIntegrationConfig({
		enabled: "yes",
		guardWhenRtkMissing: false,
		localBashRewrite: { mode: "suggest", showNotifications: false },
		remoteBashPipeCompaction: { enabled: false },
		builtinPipeCompaction: { enabled: true, tools: ["grep", "ls", "find", "grep"] },
	});

	assert.equal(normalized.enabled, true);
	assert.equal(normalized.guardWhenRtkMissing, false);
	assert.equal(normalized.localBashRewrite.mode, "suggest");
	assert.equal(normalized.localBashRewrite.showNotifications, false);
	assert.equal(normalized.remoteBashPipeCompaction.enabled, false);
	assert.deepEqual(normalized.builtinPipeCompaction.tools, ["grep", "find"]);
});

runTest("config-store migrates legacy mode and output compaction enabled flag", () => {
	const normalized = normalizeRtkIntegrationConfig({
		mode: "suggest",
		showRewriteNotifications: false,
		outputCompaction: { enabled: false },
	});

	assert.equal(normalized.localBashRewrite.mode, "suggest");
	assert.equal(normalized.localBashRewrite.showNotifications, false);
	assert.equal(normalized.remoteBashPipeCompaction.enabled, false);
	assert.equal(normalized.builtinPipeCompaction.enabled, false);
});

runTest("config-store can ensure, save, and reload isolated config files", () => {
	const tempPath = makeTempConfigPath();
	cleanupFile(tempPath);

	try {
		const ensured = ensureConfigExists(tempPath);
		assert.equal(ensured.error, undefined);
		assert.equal(existsSync(tempPath), true);

		const defaultLoad = loadRtkIntegrationConfig(tempPath);
		assert.equal(defaultLoad.warning, undefined);
		assert.equal(defaultLoad.config.localBashRewrite.mode, "rewrite");
		assert.equal(defaultLoad.config.builtinPipeCompaction.enabled, false);
		assert.deepEqual(defaultLoad.config.builtinPipeCompaction.tools, ["grep", "find"]);

		const saved = saveRtkIntegrationConfig(
			{
				...defaultLoad.config,
				localBashRewrite: { mode: "suggest", showNotifications: false },
				builtinPipeCompaction: { enabled: true, tools: ["find"] },
			},
			tempPath,
		);
		assert.equal(saved.success, true);

		const reloaded = loadRtkIntegrationConfig(tempPath);
		assert.equal(reloaded.config.localBashRewrite.mode, "suggest");
		assert.deepEqual(reloaded.config.builtinPipeCompaction.tools, ["find"]);
		assert.ok(readFileSync(tempPath, "utf-8").endsWith("\n"));
	} finally {
		cleanupFile(tempPath);
	}
});

runTest("config-store falls back to defaults when JSON is invalid", () => {
	const tempPath = makeTempConfigPath();
	cleanupFile(tempPath);

	try {
		writeFileSync(tempPath, "{not valid json", "utf-8");
		const loaded = loadRtkIntegrationConfig(tempPath);
		assert.equal(loaded.config.localBashRewrite.mode, "rewrite");
		assert.ok((loaded.warning ?? "").includes(tempPath));
		assert.ok((loaded.warning ?? "").includes("Failed to parse"));
	} finally {
		cleanupFile(tempPath);
	}
});

runTest("RTK activity metrics summarize and clear state", () => {
	clearOutputMetrics();
	assert.equal(getOutputMetricsSummary(), "RTK activity metrics: no data yet.");

	trackRtkActivity({ kind: "rewrite", tool: "bash", command: "git status" });
	trackRtkActivity({ kind: "pipe", tool: "grep", filter: "grep" });
	trackRtkActivity({ kind: "pipe-error", tool: "bash", filter: "git-diff", detail: "exit 2" });

	const summary = getOutputMetricsSummary();
	assert.ok(summary.includes("RTK activity metrics"));
	assert.ok(summary.includes("events=3"));
	assert.ok(summary.includes("- rewrite:bash: 1"));
	assert.ok(summary.includes("- pipe:grep:grep: 1"));
	assert.ok(summary.includes("- pipe-error:bash:git-diff: 1"));

	clearOutputMetrics();
	assert.equal(getOutputMetricsSummary(), "RTK activity metrics: no data yet.");
});

runTest("RTK command environment preserves explicit leading RTK_DB_PATH overrides", () => {
	const command = 'RTK_DB_PATH="/custom/history.db" rtk git diff';
	assert.equal(applyRtkCommandEnvironment(command), command);

	const singleQuotedCommand = "RTK_DB_PATH='/custom/it'\''s/history.db' rtk git diff";
	assert.equal(applyRtkCommandEnvironment(singleQuotedCommand), singleQuotedCommand);

	const exportedCommand = 'export RTK_DB_PATH="/custom/history.db"; rtk git diff';
	assert.equal(applyRtkCommandEnvironment(exportedCommand), exportedCommand);
});

runTest("RTK command environment single-quotes hostile temp paths", () => {
	const previousTmpDir = process.env.TMPDIR;
	const previousTmp = process.env.TMP;
	const previousTemp = process.env.TEMP;
	const hostilePath = process.platform === "win32" ? "C:\\Temp\\$(touch owned)`bad`'dir" : "/tmp/$(touch owned)`bad`'dir";

	try {
		process.env.TMPDIR = hostilePath;
		process.env.TMP = hostilePath;
		process.env.TEMP = hostilePath;

		const rewritten = applyRtkCommandEnvironment("rtk git status");
		assert.ok(rewritten.startsWith("export RTK_DB_PATH='"));
		assert.ok(rewritten.includes("$(touch owned)`bad`'\\''dir"));
		assert.ok(rewritten.endsWith("; rtk git status"));
		assert.equal(/^export RTK_DB_PATH=\"/.test(rewritten), false);
	} finally {
		process.env.TMPDIR = previousTmpDir;
		process.env.TMP = previousTmp;
		process.env.TEMP = previousTemp;
	}
});

runTest("rewrite shell safety fixups leave POSIX commands unchanged", () => {
	assert.equal(applyRewrittenCommandShellSafetyFixups("rtk grep foo . | head -20"), "rtk grep foo . | head -20");
	assert.equal(applyRewrittenCommandShellSafetyFixups("rtk grep foo . |"), "rtk grep foo . |");
});

runTest("Windows compatibility fixes git bash path mangling when needed", () => {
	const fixed = applyWindowsBashCompatibilityFixes("git diff -- C:/Users/blaz/project/file.ts");
	assert.ok(fixed.command.includes("C:/Users/blaz/project/file.ts"));
});

runTest("streaming sanitizer strips RTK hook warning and emoji noise", () => {
	const result = sanitizeStreamingBashExecutionResult(
		{ stdout: "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings\n\n[OK] done\n", stderr: "" },
		"rtk git status",
	);
	const sanitized = result.result as { stdout: string };
	assert.equal(result.changed, true);
	assert.equal(sanitized.stdout, "[OK] done\n");
});

console.log("All additional coverage tests passed.");
