import assert from "node:assert/strict";

import { computeRewriteDecision } from "./command-rewriter.ts";
import { DEFAULT_RTK_INTEGRATION_CONFIG, type RtkIntegrationConfig } from "./types.ts";

function runTest(name: string, testFn: () => void): void {
	testFn();
	console.log(`[PASS] ${name}`);
}

function cloneConfig(): RtkIntegrationConfig {
	return structuredClone(DEFAULT_RTK_INTEGRATION_CONFIG);
}

function expectedProxyExecutable(base: "pnpm"): string {
	return process.platform === "win32" ? `${base}.cmd` : base;
}

runTest("pnpm dlx rewrites through RTK proxy instead of generic pnpm wrapper", () => {
	const config = cloneConfig();
	const decision = computeRewriteDecision("pnpm dlx create-vite@latest demo --template react-ts", config);

	assert.equal(decision.changed, true);
	assert.equal(decision.rule?.id, "pnpm-dlx-proxy");
	assert.equal(
		decision.rewrittenCommand,
		`rtk proxy ${expectedProxyExecutable("pnpm")} dlx create-vite@latest demo --template react-ts`,
	);
});

runTest("docker run with shell command bypasses rewrite when interactive flags are missing", () => {
	const config = cloneConfig();
	const decision = computeRewriteDecision("docker run ubuntu bash", config);

	assert.equal(decision.changed, false);
	assert.equal(decision.rewrittenCommand, "docker run ubuntu bash");
	assert.equal(decision.reason, "no_match");
});

runTest("docker run with -it keeps container rewrite enabled", () => {
	const config = cloneConfig();
	const decision = computeRewriteDecision("docker run -it ubuntu bash", config);

	assert.equal(decision.changed, true);
	assert.equal(decision.rule?.id, "docker");
	assert.equal(decision.rewrittenCommand, "rtk docker run -it ubuntu bash");
});

runTest("docker compose exec without -it bypasses interactive shell rewrite", () => {
	const config = cloneConfig();
	const decision = computeRewriteDecision("docker compose exec web bash", config);

	assert.equal(decision.changed, false);
	assert.equal(decision.rewrittenCommand, "docker compose exec web bash");
});

runTest("container rewrites stay enabled for scripted shells and non-shell commands", () => {
	const config = cloneConfig();

	const scriptedShell = computeRewriteDecision('docker run ubuntu bash -lc "echo hi"', config);
	assert.equal(scriptedShell.changed, true);
	assert.equal(scriptedShell.rule?.id, "docker");
	assert.equal(scriptedShell.rewrittenCommand, 'rtk docker run ubuntu bash -lc "echo hi"');

	const nonShell = computeRewriteDecision("docker run ubuntu python app.py", config);
	assert.equal(nonShell.changed, true);
	assert.equal(nonShell.rule?.id, "docker");
	assert.equal(nonShell.rewrittenCommand, "rtk docker run ubuntu python app.py");
});

runTest("kubectl exec requires interactive flags before rewriting shell sessions", () => {
	const config = cloneConfig();
	const missingFlagsDecision = computeRewriteDecision("kubectl exec pod-123 -- bash", config);
	assert.equal(missingFlagsDecision.changed, false);
	assert.equal(missingFlagsDecision.rewrittenCommand, "kubectl exec pod-123 -- bash");

	const interactiveDecision = computeRewriteDecision("kubectl exec -it pod-123 -- bash", config);
	assert.equal(interactiveDecision.changed, true);
	assert.equal(interactiveDecision.rule?.id, "kubectl");
	assert.equal(interactiveDecision.rewrittenCommand, "rtk kubectl exec -it pod-123 -- bash");
});

runTest("sed scripts keep internal separators intact while later pipe segments still rewrite", () => {
	const config = cloneConfig();
	const decision = computeRewriteDecision("sed -e s/a/b/;d file.txt | git status", config);

	assert.equal(decision.changed, true);
	assert.equal(decision.rewrittenCommand, "sed -e s/a/b/;d file.txt | rtk git status");
	assert.equal(decision.rule?.id, "git-any");
});

runTest("background operators rewrite both command segments without misreading redirect ampersands", () => {
	const config = cloneConfig();
	const backgroundDecision = computeRewriteDecision("git status & cargo test", config);
	assert.equal(backgroundDecision.changed, true);
	assert.equal(backgroundDecision.rewrittenCommand, "rtk git status & rtk cargo test");

	const redirectDecision = computeRewriteDecision("cargo test 2>&1 | head -5", config);
	assert.equal(redirectDecision.changed, true);
	assert.equal(redirectDecision.rewrittenCommand, "rtk cargo test 2>&1 | head -5");
	assert.equal(redirectDecision.rule?.id, "cargo-any");
});

runTest("gh structured output commands bypass RTK rewrites", () => {
	const config = cloneConfig();
	const structuredCommands = [
		"gh pr list --json number,title",
		"gh issue list --jq '.[].title'",
		"gh pr view 123 --template '{{.title}}'",
	];

	for (const command of structuredCommands) {
		const decision = computeRewriteDecision(command, config);
		assert.equal(decision.changed, false);
		assert.equal(decision.rewrittenCommand, command);
		assert.equal(decision.reason, "no_match");
	}
});

console.log("All command-rewriter tests passed.");
