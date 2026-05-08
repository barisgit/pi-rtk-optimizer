import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mock } from "bun:test";

import { runTest } from "./test-helpers.ts";

mock.module("@mariozechner/pi-coding-agent", () => ({
	getAgentDir: () => "/tmp/.pi/agent",
	getSettingsListTheme: () => ({}),
	isToolCallEventType: (toolName: string, event: { toolName?: string }) => event.toolName === toolName,
}));

mock.module("@mariozechner/pi-tui", () => ({
	Box: class {},
	Container: class {
		addChild(): void {}
		render(): string[] {
			return [];
		}
		invalidate(): void {}
	},
	SettingsList: class {
		handleInput(): void {}
		updateValue(): void {}
	},
	Spacer: class {},
	Text: class {},
	truncateToWidth: (text: string) => text,
	visibleWidth: (text: string) => text.length,
}));

const indexModule = await import("./index.ts");
const { createBoundedNoticeTracker } = indexModule;
const rtkIntegrationExtension = indexModule.default;
import type { RtkExtensionAPI } from "./index.ts";

type Notification = { message: string; level: "info" | "warning" | "error" };
type TestContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		custom<T>(): Promise<T>;
	};
};
type Handler = (event: Record<string, unknown>, ctx: TestContext) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
type RtkToolDefinition = Parameters<RtkExtensionAPI["registerTool"]>[0];

function createNotificationContext(notifications: Notification[]): TestContext {
	return {
		hasUI: true,
		ui: {
			notify(message: string, level: "info" | "warning" | "error") {
				notifications.push({ message, level });
			},
			async custom<T>(): Promise<T> {
				throw new Error("custom UI should not be invoked in index tests");
			},
		},
	};
}

function firstText(content: unknown): string {
	if (!Array.isArray(content) || content.length === 0) {
		return "";
	}
	const block = content[0] as { type?: string; text?: string };
	return block.type === "text" && typeof block.text === "string" ? block.text : "";
}

const TEST_CONFIG_PATH = "/tmp/.pi/agent/extensions/pi-rtk-optimizer/config.json";

function writeTestConfig(config: Record<string, unknown>): void {
	mkdirSync(dirname(TEST_CONFIG_PATH), { recursive: true });
	writeFileSync(TEST_CONFIG_PATH, `${JSON.stringify(config)}\n`, "utf-8");
}

function createHarness(options?: { rtkAvailable?: boolean }) {
	const handlers: Record<string, Handler> = {};
	const notifications: Notification[] = [];
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const emittedEvents: Array<{ event: string; payload: unknown }> = [];
	let rtkAvailable = options?.rtkAvailable ?? true;
	let rewriteCalls = 0;
	let registeredTool: RtkToolDefinition | undefined;

	const api: RtkExtensionAPI = {
		events: {
			emit(event: string, payload: unknown): void {
				emittedEvents.push({ event, payload });
			},
		},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args });
			if (command === "which" || command === "where") {
				return { code: 0, stdout: "/opt/rtk/bin/rtk\n", stderr: "", killed: false };
			}
			if (args[0] === "--version") {
				return rtkAvailable
					? { code: 0, stdout: "rtk 1.0.0", stderr: "", killed: false }
					: { code: 1, stdout: "", stderr: "missing rtk", killed: false };
			}
			if (args[0] === "rewrite") {
				rewriteCalls += 1;
				const source = args[1];
				const rewritten = source === "git status" ? "rtk git status" : source === "git diff" ? "rtk git diff" : "";
				return rewritten
					? { code: 3, stdout: rewritten, stderr: "", killed: false }
					: { code: 1, stdout: "", stderr: "", killed: false };
			}
			if (command === "sh") {
				const filter = args.at(-1);
				return filter === "git-diff" || filter === "grep"
					? { code: 0, stdout: `compacted ${filter}`, stderr: "", killed: false }
					: { code: 2, stdout: "", stderr: "unknown filter", killed: false };
			}
			return { code: 1, stdout: "", stderr: "unexpected", killed: false };
		},
		on(eventName: string, handler: unknown) {
			handlers[eventName] = handler as Handler;
		},
		registerCommand() {},
		registerTool(tool: unknown) {
			registeredTool = tool as RtkToolDefinition;
		},
	};

	rtkIntegrationExtension(api);

	return {
		handlers,
		notifications,
		execCalls,
		emittedEvents,
		get rewriteCalls() {
			return rewriteCalls;
		},
		setRtkAvailable(next: boolean) {
			rtkAvailable = next;
		},
		get registeredTool() {
			return registeredTool;
		},
		ctx: createNotificationContext(notifications),
	};
}

async function call(handler: Handler | undefined, event: Record<string, unknown>, ctx: TestContext): Promise<Record<string, unknown> | void> {
	if (!handler) {
		throw new Error("Expected handler to be registered");
	}
	return handler(event, ctx);
}

runTest("bounded notice tracker evicts old entries and supports reset", () => {
	const tracker = createBoundedNoticeTracker(2);

	assert.equal(tracker.remember("first"), true);
	assert.equal(tracker.remember("second"), true);
	assert.equal(tracker.remember("first"), false);

	assert.equal(tracker.remember("third"), true);
	assert.equal(tracker.remember("second"), false);
	assert.equal(tracker.remember("first"), true);

	tracker.reset();
	assert.equal(tracker.remember("third"), true);
});

runTest("bounded notice tracker coerces invalid limits to a safe minimum", () => {
	const tracker = createBoundedNoticeTracker(0);
	assert.equal(tracker.remember("alpha"), true);
	assert.equal(tracker.remember("beta"), true);
	assert.equal(tracker.remember("alpha"), true);
});

runTest("extension registers the rtk-read prune provider", () => {
	const harness = createHarness();
	const registration = harness.emittedEvents.find((entry) => entry.event === "prune:register-provider");
	assert.equal((registration?.payload as { name?: string } | undefined)?.name, "rtk-read");
});

await runTest("session_start refreshes RTK provenance and runtime guard skips missing rewrites", async () => {
	const harness = createHarness({ rtkAvailable: false });

	await call(harness.handlers.session_start, {}, harness.ctx);
	const skippedEvent = { toolCallId: "bash-1", toolName: "bash", input: { command: "git status" } };
	await call(harness.handlers.tool_call, skippedEvent, harness.ctx);

	assert.equal(skippedEvent.input.command, "git status");
	assert.equal(harness.rewriteCalls, 0);
	assert.ok(harness.notifications.some((notice) => notice.message.includes("rtk binary unavailable")));

	harness.setRtkAvailable(true);
	await call(harness.handlers.session_start, {}, harness.ctx);
	const rewrittenEvent = { toolCallId: "bash-2", toolName: "bash", input: { command: "git status" } };
	await call(harness.handlers.tool_call, rewrittenEvent, harness.ctx);

	assert.equal(harness.rewriteCalls, 1);
	assert.ok(rewrittenEvent.input.command.includes("rtk git status"));
	assert.ok(harness.execCalls.some((call) => call.command === "/opt/rtk/bin/rtk" && call.args[0] === "rewrite"));
});

await runTest("registered rtk tool controls disable budget without consuming itself", async () => {
	const harness = createHarness();
	await call(harness.handlers.session_start, {}, harness.ctx);
	const tool = harness.registeredTool;
	if (!tool) {
		throw new Error("Expected rtk tool to be registered");
	}

	const disabled = await tool.execute("rtk-1", { action: "disable", n: 2 }, undefined, undefined, harness.ctx);
	assert.ok(firstText(disabled.content).includes("next 2 tool call"));

	await call(harness.handlers.tool_call, { toolCallId: "read-1", toolName: "read", input: { path: "README.md" } }, harness.ctx);
	const rawBash = { toolCallId: "bash-raw", toolName: "bash", input: { command: "git status" } };
	await call(harness.handlers.tool_call, rawBash, harness.ctx);
	assert.equal(rawBash.input.command, "git status");
	assert.equal(harness.rewriteCalls, 0);

	const rewrittenBash = { toolCallId: "bash-rewrite", toolName: "bash", input: { command: "git status" } };
	await call(harness.handlers.tool_call, rewrittenBash, harness.ctx);
	assert.ok(rewrittenBash.input.command.includes("rtk git status"));

	await tool.execute("rtk-2", { action: "disable", n: 3 }, undefined, undefined, harness.ctx);
	const enabled = await tool.execute("rtk-3", { action: "enable" }, undefined, undefined, harness.ctx);
	assert.ok(firstText(enabled.content).includes("Cleared disable budget: 3"));
});

await runTest("remote bash is not rewritten but its output can be piped locally", async () => {
	const harness = createHarness();
	await call(harness.handlers.session_start, {}, harness.ctx);

	const remoteCall = { toolCallId: "remote-1", toolName: "bash", input: { command: "git diff", session: "server" } };
	await call(harness.handlers.tool_call, remoteCall, harness.ctx);
	assert.equal(remoteCall.input.command, "git diff");

	const result = await call(
		harness.handlers.tool_result,
		{
			toolCallId: "remote-1",
			toolName: "bash",
			input: remoteCall.input,
			content: [{ type: "text", text: "raw diff" }],
			details: undefined,
		},
		harness.ctx,
	);

	assert.equal(firstText(result?.content), "compacted git-diff");
});

await runTest("builtin grep output is piped through local RTK", async () => {
	writeTestConfig({
		enabled: true,
		guardWhenRtkMissing: true,
		localBashRewrite: { mode: "rewrite", showNotifications: true },
		remoteBashPipeCompaction: { enabled: true },
		builtinPipeCompaction: { enabled: true, tools: ["grep", "find"] },
	});
	const harness = createHarness();
	await call(harness.handlers.session_start, {}, harness.ctx);

	const result = await call(
		harness.handlers.tool_result,
		{
			toolCallId: "grep-1",
			toolName: "grep",
			input: { pattern: "needle" },
			content: [{ type: "text", text: "raw grep" }],
			details: undefined,
		},
		harness.ctx,
	);

	assert.equal(firstText(result?.content), "compacted grep");
});

await runTest("tool execution lifecycle sanitizes streamed bash output", async () => {
	const harness = createHarness();

	await call(
		harness.handlers.tool_execution_start,
		{ toolName: "bash", toolCallId: "bash-1", args: { command: "rtk git status" } },
		harness.ctx,
	);

	const updateEvent = {
		toolName: "bash",
		toolCallId: "bash-1",
		args: { command: "rtk git status" },
		partialResult: {
			stdout: "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings\n\n4 files changed\n",
			stderr: "",
		},
	};
	await call(harness.handlers.tool_execution_update, updateEvent, harness.ctx);
	assert.equal((updateEvent.partialResult as { stdout: string }).stdout, "4 files changed\n");

	const endEvent = {
		toolName: "bash",
		toolCallId: "bash-1",
		args: { command: "rtk git status" },
		result: {
			stdout: "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings\n\nfinal\n",
			stderr: "",
		},
	};
	await call(harness.handlers.tool_execution_end, endEvent, harness.ctx);
	assert.equal((endEvent.result as { stdout: string }).stdout, "final\n");
});

console.log("All index tests passed.");
