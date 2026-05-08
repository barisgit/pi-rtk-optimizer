import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { runTest } from "./test-helpers.ts";
import {
	PRUNE_REGISTER_PROVIDER_EVENT,
	RTK_READ_PRUNE_PROVIDER_NAME,
	createRtkReadPruneProvider,
	mapThresholdToRtkReadLevel,
	registerRtkReadPruneProvider,
	type NormalizedPruneRequest,
} from "./rtk-prune-provider.ts";
import type { RtkExecHost } from "./rtk-executable-resolver.ts";

function request(overrides: Partial<NormalizedPruneRequest> = {}): NormalizedPruneRequest {
	return {
		goal: "keep relevant snippets",
		documents: [
			{ source: "https://example.test/doc", text: "alpha\nbeta\ngamma\ndelta" },
		],
		...overrides,
	};
}

runTest("threshold maps to rtk read compaction levels", () => {
	assert.equal(mapThresholdToRtkReadLevel(0), "none");
	assert.equal(mapThresholdToRtkReadLevel(0.5), "minimal");
	assert.equal(mapThresholdToRtkReadLevel(0.9), "aggressive");
});

await runTest("rtk-read provider writes document text to temp files and invokes rtk read", async () => {
	const calls: Array<{ command: string; args: string[]; inputPaths: string[] }> = [];
	const host: RtkExecHost = {
		async exec(command, args) {
			const inputPaths = args.filter((arg) => /document-\d+\.[^.]+$/.test(arg));
			calls.push({ command, args, inputPaths });
			assert.equal(command, "/opt/rtk/bin/rtk");
			assert.deepEqual(args.slice(0, 5), ["read", "--level", "aggressive", "--max-lines", "3"]);
			assert.equal(args.includes("--line-numbers"), false);
			assert.equal(inputPaths.length, 2);
			assert.ok(inputPaths[0].endsWith(".ts"));
			assert.ok(inputPaths[1].endsWith(".py"));
			return { code: 0, stdout: "compacted output", stderr: "", killed: false };
		},
	};
	const provider = createRtkReadPruneProvider(host, {
		getExecutableResolution: () => ({ command: "/opt/rtk/bin/rtk", resolver: "which" }),
	});

	const result = await provider.prune(request({
		documents: [
			{ source: "https://example.test/one.ts", text: "one\ntwo\nthree" },
			{ source: "/not/read/directly.py", text: "four\nfive\nsix" },
		],
		budget: { ratio: 0.5 },
		options: { threshold: 0.9, lineNumbers: true },
	}));

	assert.equal(result.text, "compacted output");
	assert.equal(result.provider, RTK_READ_PRUNE_PROVIDER_NAME);
	assert.equal(calls.length, 1);
	for (const tempPath of calls[0].inputPaths) {
		assert.equal(existsSync(tempPath), false);
	}
});

await runTest("rtk-read provider fails with rtk stderr", async () => {
	const host: RtkExecHost = {
		async exec() {
			return { code: 2, stdout: "", stderr: "bad read", killed: false };
		},
	};
	const provider = createRtkReadPruneProvider(host);

	await assert.rejects(() => provider.prune(request()), /rtk read failed: bad read/);
});

runTest("registerRtkReadPruneProvider announces a low-priority prune provider", () => {
	const emitted: Array<{ event: string; payload: unknown }> = [];
	registerRtkReadPruneProvider({
		async exec() {
			throw new Error("not used");
		},
		events: {
			emit(event, payload) {
				emitted.push({ event, payload });
			},
		},
	});

	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].event, PRUNE_REGISTER_PROVIDER_EVENT);
	const payload = emitted[0].payload as { name?: string; priority?: number; capabilities?: { multiDocument?: boolean; lineSpans?: boolean; scores?: boolean } };
	assert.equal(payload.name, RTK_READ_PRUNE_PROVIDER_NAME);
	assert.equal(payload.priority, 10);
	assert.deepEqual(payload.capabilities, { multiDocument: true, lineSpans: false, scores: false });
});
