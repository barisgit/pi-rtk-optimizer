import assert from "node:assert/strict";

import { computeRewriteDecision } from "./command-rewriter.ts";
import { cloneDefaultConfig, runTest } from "./test-helpers.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function createMockPi(execResult: { code: number; stdout?: string; stderr?: string }): ExtensionAPI {
	return { exec: async () => execResult } as unknown as ExtensionAPI;
}

runTest("empty command unchanged", async () => {
	const config = cloneDefaultConfig();
	const decision = await computeRewriteDecision("", config, createMockPi({ code: 1 }));
	assert.equal(decision.changed, false);
	assert.equal(decision.reason, "empty");
});

runTest("already rtk unchanged", async () => {
	const config = cloneDefaultConfig();
	const decision = await computeRewriteDecision("rtk status", config, createMockPi({ code: 1 }));
	assert.equal(decision.changed, false);
	assert.equal(decision.reason, "already_rtk");
});

runTest("rtk unsupported heredoc result leaves command unchanged", async () => {
	const config = cloneDefaultConfig();
	const decision = await computeRewriteDecision("cat <<EOF", config, createMockPi({ code: 1 }));
	assert.equal(decision.changed, false);
	assert.equal(decision.reason, "no_match");
});

runTest("quoted heredoc marker is delegated to RTK rewrite", async () => {
	const config = cloneDefaultConfig();
	const command = 'echo "<<not heredoc" && git status';
	const decision = await computeRewriteDecision(
		command,
		config,
		createMockPi({ code: 3, stdout: 'echo "<<not heredoc" && rtk git status' }),
	);
	assert.equal(decision.changed, true);
	assert.equal(decision.rewrittenCommand, 'echo "<<not heredoc" && rtk git status');
	assert.equal(decision.reason, "ok");
});

runTest("legacy category toggles do not pre-filter RTK rewrite source of truth", async () => {
	const config = { ...cloneDefaultConfig(), rewriteGitGithub: false };
	const decision = await computeRewriteDecision("git status", config, createMockPi({ code: 3, stdout: "rtk git status" }));
	assert.equal(decision.changed, true);
	assert.equal(decision.rewrittenCommand, "rtk git status");
	assert.equal(decision.reason, "ok");
});

runTest("rtk exit 0 rewrites", async () => {
	const config = cloneDefaultConfig();
	const decision = await computeRewriteDecision("git status", config, createMockPi({ code: 0, stdout: "rtk git status" }));
	assert.equal(decision.changed, true);
	assert.equal(decision.rewrittenCommand, "rtk git status");
	assert.equal(decision.reason, "ok");
});

runTest("rtk exit 3 rewrites", async () => {
	const config = cloneDefaultConfig();
	const decision = await computeRewriteDecision("git status", config, createMockPi({ code: 3, stdout: "rtk git status" }));
	assert.equal(decision.changed, true);
	assert.equal(decision.rewrittenCommand, "rtk git status");
	assert.equal(decision.reason, "ok");
});

runTest("exit 1 leaves unchanged", async () => {
	const config = cloneDefaultConfig();
	const decision = await computeRewriteDecision("git status", config, createMockPi({ code: 1 }));
	assert.equal(decision.changed, false);
	assert.equal(decision.reason, "no_match");
});

runTest("exit 2 leaves unchanged", async () => {
	const config = cloneDefaultConfig();
	const decision = await computeRewriteDecision("git status", config, createMockPi({ code: 2, stderr: "denied" }));
	assert.equal(decision.changed, false);
	assert.equal(decision.reason, "no_match");
});

runTest("unknown category passes through to RTK", async () => {
	const config = cloneDefaultConfig();
	const pi = createMockPi({ code: 0, stdout: "rtk custom" });
	const decision = await computeRewriteDecision("custom-cmd", config, pi);
	assert.equal(decision.changed, true);
	assert.equal(decision.rewrittenCommand, "rtk custom");
	assert.equal(decision.reason, "ok");
});

runTest("exec error/timeout leaves unchanged", async () => {
	const config = cloneDefaultConfig();
	const pi = {
		exec: async () => {
			throw new Error("timeout");
		},
	} as unknown as ExtensionAPI;
	const decision = await computeRewriteDecision("git status", config, pi);
	assert.equal(decision.changed, false);
	assert.equal(decision.reason, "no_match");
});

runTest("compound commands forwarded to RTK", async () => {
	const config = cloneDefaultConfig();
	let capturedArgs: string[] = [];
	const pi = {
		exec: async (_cmd: string, args: string[]) => {
			capturedArgs = args;
			return { code: 0, stdout: "rtk result" };
		},
	} as unknown as ExtensionAPI;
	const decision = await computeRewriteDecision("git status && cargo test", config, pi);
	assert.equal(decision.changed, true);
	assert.deepEqual(capturedArgs, ["rewrite", "git status && cargo test"]);
});

console.log("All command-rewriter tests passed.");
