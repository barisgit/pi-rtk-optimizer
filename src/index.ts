import { isToolCallEventType, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import {
	ensureConfigExists,
	getRtkIntegrationConfigPath,
	loadRtkIntegrationConfig,
	normalizeRtkIntegrationConfig,
	saveRtkIntegrationConfig,
} from "./config-store.js";
import { computeRewriteDecision } from "./command-rewriter.js";
import { registerRtkIntegrationCommand } from "./config-modal.js";
import { EXTENSION_NAME } from "./constants.js";
import { clearOutputMetrics, getOutputMetricsSummary, trackRtkActivity } from "./output-metrics.js";
import { compactToolResult, type ToolResultCompactionMetadata } from "./output-compactor.js";
import { toRecord } from "./record-utils.js";
import { applyRtkCommandEnvironment } from "./rtk-command-environment.js";
import { resolveRtkExecutable, type RtkExecutableResolution } from "./rtk-executable-resolver.js";
import { registerRtkReadPruneProvider } from "./rtk-prune-provider.js";
import { applyRewrittenCommandShellSafetyFixups } from "./rewrite-pipeline-safety.js";
import { shouldRequireRtkAvailabilityForCommandHandling, shouldSkipCommandHandlingWhenRtkMissing } from "./runtime-guard.js";
import { sanitizeStreamingBashExecutionResult } from "./tool-execution-sanitizer.js";
import type { RtkIntegrationConfig, RuntimeStatus } from "./types.js";
import { applyWindowsBashCompatibilityFixes } from "./windows-command-helpers.js";

export type RtkExtensionAPI = Pick<ExtensionAPI, "exec" | "on" | "registerCommand" | "registerTool"> & {
	events: { emit(event: string, payload: unknown): void };
};

const RTK_CONTROL_MAX_BUDGET = 20;

function trimMessage(raw: string, maxLength = 220): string {
	const clean = raw.replace(/\s+/g, " ").trim();
	if (clean.length <= maxLength) {
		return clean;
	}
	return `${clean.slice(0, maxLength - 1)}…`;
}

function mergeCompactionDetails(
	existingDetails: unknown,
	compaction: ToolResultCompactionMetadata,
): Record<string, unknown> {
	const baseDetails = toRecord(existingDetails);
	const baseMetadata = toRecord(baseDetails.metadata);

	const nextDetails: Record<string, unknown> = {
		...baseDetails,
		rtkCompaction: compaction,
		metadata: {
			...baseMetadata,
			rtkCompaction: compaction,
		},
	};

	if (Object.keys(baseDetails).length === 0 && existingDetails !== undefined) {
		nextDetails.rawDetails = existingDetails;
	}

	return nextDetails;
}

export interface BoundedNoticeTracker {
	remember(key: string): boolean;
	reset(): void;
}

export function createBoundedNoticeTracker(maxEntries: number): BoundedNoticeTracker {
	const normalizedLimit = Math.max(1, Math.floor(maxEntries));
	const seen = new Set<string>();
	const order: string[] = [];

	return {
		remember(key: string): boolean {
			if (seen.has(key)) {
				return false;
			}

			seen.add(key);
			order.push(key);
			while (order.length > normalizedLimit) {
				const evicted = order.shift();
				if (evicted !== undefined) {
					seen.delete(evicted);
				}
			}

			return true;
		},
		reset(): void {
			seen.clear();
			order.length = 0;
		},
	};
}

function hasRemoteSession(input: unknown): boolean {
	return typeof toRecord(input).session === "string";
}

function isRtkControlTool(toolName: string): boolean {
	return toolName === "rtk";
}

function normalizeDisableCount(raw: number | undefined): number | undefined {
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		return undefined;
	}
	const rounded = Math.floor(raw);
	if (rounded < 1 || rounded > RTK_CONTROL_MAX_BUDGET) {
		return undefined;
	}
	return rounded;
}

export default function rtkIntegrationExtension(pi: RtkExtensionAPI): void {
	const initialLoad = loadRtkIntegrationConfig();
	let config: RtkIntegrationConfig = initialLoad.config;
	let pendingLoadWarning = initialLoad.warning;
	let runtimeStatus: RuntimeStatus = { rtkAvailable: false };
	const warnedMessages = createBoundedNoticeTracker(100);
	const suggestionNotices = createBoundedNoticeTracker(200);
	const activeBashCommands = new Map<string, string>();
	const disabledToolCallIds = new Set<string>();
	let missingRtkWarningShown = false;
	let disableBudget = 0;

	const formatRewriteNotice = (originalCommand: string, rewrittenCommand: string): string => {
		const original = trimMessage(originalCommand, 100);
		const rewritten = trimMessage(rewrittenCommand, 120);
		return `RTK rewrite: ${original} -> ${rewritten}`;
	};

	const formatRewriteWarning = (command: string, warning: string): string => {
		const target = trimMessage(command, 100);
		const detail = trimMessage(warning, 120);
		return `${EXTENSION_NAME}: rtk rewrite skipped for '${target}' (${detail}).`;
	};

	const warnOnce = (
		ctx: ExtensionContext | ExtensionCommandContext,
		message: string,
		level: "warning" | "error" = "warning",
	): void => {
		if (!warnedMessages.remember(message)) {
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
		}
	};

	const clearTrackedBashCommands = (): void => {
		activeBashCommands.clear();
		disabledToolCallIds.clear();
	};

	const trackBashCommand = (toolCallId: unknown, args: unknown): void => {
		if (typeof toolCallId !== "string") {
			return;
		}

		const argsRecord = toRecord(args);
		const command = typeof argsRecord.command === "string" ? argsRecord.command.trim() : "";
		if (!command) {
			activeBashCommands.delete(toolCallId);
			return;
		}

		activeBashCommands.set(toolCallId, command);
	};

	const getTrackedBashCommand = (toolCallId: unknown): string | undefined => {
		if (typeof toolCallId !== "string") {
			return undefined;
		}

		return activeBashCommands.get(toolCallId);
	};

	const forgetTrackedBashCommand = (toolCallId: unknown): void => {
		if (typeof toolCallId !== "string") {
			return;
		}

		activeBashCommands.delete(toolCallId);
	};

	const refreshRuntimeStatus = async (): Promise<RuntimeStatus> => {
		let executableResolution: RtkExecutableResolution | undefined;
		try {
			executableResolution = await resolveRtkExecutable(pi);
			const result = await pi.exec(executableResolution.command, ["--version"], { timeout: 5000 });
			if (result.code === 0) {
				runtimeStatus = {
					rtkAvailable: true,
					lastCheckedAt: Date.now(),
					rtkExecutablePath: executableResolution.resolvedPath,
					rtkExecutableCommand: executableResolution.command,
					rtkExecutableResolver: executableResolution.resolver,
					rtkExecutableResolutionWarning: executableResolution.warning,
				};
				missingRtkWarningShown = false;
				return runtimeStatus;
			}

			const detail = trimMessage(
				`${result.stderr || ""} ${result.stdout || ""} ${result.code ? `(exit ${result.code})` : ""}`,
			);
			runtimeStatus = {
				rtkAvailable: false,
				lastCheckedAt: Date.now(),
				lastError: detail || `exit ${result.code}`,
				rtkExecutablePath: executableResolution.resolvedPath,
				rtkExecutableCommand: executableResolution.command,
				rtkExecutableResolver: executableResolution.resolver,
				rtkExecutableResolutionWarning: executableResolution.warning,
			};
			return runtimeStatus;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			runtimeStatus = {
				rtkAvailable: false,
				lastCheckedAt: Date.now(),
				lastError: trimMessage(message),
				rtkExecutablePath: executableResolution?.resolvedPath,
				rtkExecutableCommand: executableResolution?.command,
				rtkExecutableResolver: executableResolution?.resolver,
				rtkExecutableResolutionWarning: executableResolution?.warning,
			};
			return runtimeStatus;
		}
	};

	const refreshConfig = async (ctx?: ExtensionContext | ExtensionCommandContext): Promise<void> => {
		const ensured = ensureConfigExists();
		if (ensured.error && ctx) {
			warnOnce(ctx, ensured.error);
		}

		const loaded = loadRtkIntegrationConfig();
		config = loaded.config;
		pendingLoadWarning = loaded.warning;
		await refreshRuntimeStatus();

		if (pendingLoadWarning && ctx) {
			warnOnce(ctx, pendingLoadWarning);
			pendingLoadWarning = undefined;
		}
	};

	const setConfig = (next: RtkIntegrationConfig, ctx: ExtensionCommandContext): void => {
		config = normalizeRtkIntegrationConfig(next);
		const saved = saveRtkIntegrationConfig(config);
		if (!saved.success && saved.error) {
			ctx.ui.notify(saved.error, "error");
		}
	};

	const maybeWarnRtkMissing = (ctx: ExtensionContext): void => {
		if (!config.enabled || !config.guardWhenRtkMissing) {
			return;
		}

		if (runtimeStatus.rtkAvailable) {
			missingRtkWarningShown = false;
			return;
		}

		if (missingRtkWarningShown) {
			return;
		}

		missingRtkWarningShown = true;
		const reason = runtimeStatus.lastError ? ` (${runtimeStatus.lastError})` : "";
		warnOnce(ctx, `${EXTENSION_NAME}: rtk binary unavailable, RTK optimization bypassed${reason}.`);
	};

	const ensureRuntimeStatusFresh = async (): Promise<void> => {
		if (!shouldRequireRtkAvailabilityForCommandHandling(config)) {
			return;
		}

		const now = Date.now();
		const isStale = !runtimeStatus.lastCheckedAt || now - runtimeStatus.lastCheckedAt > 30_000;
		if (isStale) {
			await refreshRuntimeStatus();
		}
	};

	const getExecutableResolution = (): RtkExecutableResolution | undefined => {
		if (!runtimeStatus.rtkExecutableCommand) {
			return undefined;
		}
		const resolver: RtkExecutableResolution["resolver"] =
			runtimeStatus.rtkExecutableResolver === "where" ? "where" : "which";
		return {
			command: runtimeStatus.rtkExecutableCommand,
			resolvedPath: runtimeStatus.rtkExecutablePath,
			resolver,
			warning: runtimeStatus.rtkExecutableResolutionWarning,
		};
	};

	const consumeDisableBudget = (toolCallId: unknown, toolName: string): boolean => {
		if (isRtkControlTool(toolName) || disableBudget <= 0) {
			return false;
		}
		disableBudget -= 1;
		if (typeof toolCallId === "string") {
			disabledToolCallIds.add(toolCallId);
		}
		return true;
	};

	const controller = {
		getConfig: () => config,
		setConfig,
		getConfigPath: getRtkIntegrationConfigPath,
		getRuntimeStatus: () => runtimeStatus,
		refreshRuntimeStatus,
		getMetricsSummary: getOutputMetricsSummary,
		clearMetrics: clearOutputMetrics,
		getDisableBudget: () => disableBudget,
	};

	registerRtkIntegrationCommand(pi, controller);
	registerRtkReadPruneProvider(pi, {
		getRuntimeStatus: () => runtimeStatus,
		getExecutableResolution,
	});

	pi.registerTool({
		name: "rtk",
		label: "RTK",
		description:
			"Control RTK optimization. RTK optimizes token-heavy shell/search output: local bash may use rtk rewrite, remote bash and builtin grep/find may use local rtk pipe. Disable it before tool calls that need raw, unoptimized output.",
		promptSnippet: "Control RTK output optimization for raw-output workflows.",
		promptGuidelines: [
			"RTK may optimize local bash commands and compact eligible remote bash or grep/find output.",
			"Use rtk with action=\"disable\" before tool calls that require raw, unoptimized output; use action=\"enable\" to clear the disable budget early.",
		],
		parameters: Type.Object({
			action: StringEnum(["disable", "enable"] as const),
			n: Type.Optional(Type.Number({ minimum: 1, maximum: RTK_CONTROL_MAX_BUDGET })),
		}),
		async execute(_toolCallId, params: { action: "disable" | "enable"; n?: number }) {
			if (params.action === "enable") {
				const previousBudget = disableBudget;
				disableBudget = 0;
				return {
					content: [{ type: "text" as const, text: `RTK optimization re-enabled. Cleared disable budget: ${previousBudget}.` }],
					details: { previousBudget, disableBudget },
				};
			}

			const nextBudget = normalizeDisableCount(params.n);
			if (nextBudget === undefined) {
				return {
					content: [{ type: "text" as const, text: `Provide n from 1 to ${RTK_CONTROL_MAX_BUDGET} for action=\"disable\".` }],
					isError: true,
					details: { disableBudget },
				};
			}

			disableBudget = nextBudget;
			const inactive = runtimeStatus.rtkAvailable ? "" : " RTK binary is currently unavailable, so optimization is already inactive.";
			return {
				content: [
					{
						type: "text" as const,
						text: `RTK optimization disabled for the next ${nextBudget} tool call(s).${inactive}`,
					},
				],
				details: { disableBudget, rtkAvailable: runtimeStatus.rtkAvailable },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		warnedMessages.reset();
		suggestionNotices.reset();
		clearTrackedBashCommands();
		missingRtkWarningShown = false;
		disableBudget = 0;
		await refreshConfig(ctx);
		maybeWarnRtkMissing(ctx);
	});

	pi.on("agent_end", async () => {
		clearTrackedBashCommands();
	});

	pi.on("tool_execution_start", async (event) => {
		if (!config.enabled) {
			return;
		}

		const eventRecord = toRecord(event);
		if (eventRecord.toolName !== "bash") {
			return;
		}

		trackBashCommand(eventRecord.toolCallId, eventRecord.args);
	});

	pi.on("tool_execution_update", async (event) => {
		if (!config.enabled) {
			return;
		}

		const eventRecord = toRecord(event);
		if (eventRecord.toolName !== "bash") {
			return;
		}

		trackBashCommand(eventRecord.toolCallId, eventRecord.args);
		const sanitization = sanitizeStreamingBashExecutionResult(
			eventRecord.partialResult,
			getTrackedBashCommand(eventRecord.toolCallId),
		);
		if (sanitization.changed) {
			eventRecord.partialResult = sanitization.result;
		}
	});

	pi.on("tool_execution_end", async (event) => {
		const eventRecord = toRecord(event);
		if (eventRecord.toolName !== "bash") {
			return;
		}

		try {
			if (config.enabled) {
				const sanitization = sanitizeStreamingBashExecutionResult(
					eventRecord.result,
					getTrackedBashCommand(eventRecord.toolCallId),
				);
				if (sanitization.changed) {
					eventRecord.result = sanitization.result;
				}
			}
		} finally {
			forgetTrackedBashCommand(eventRecord.toolCallId);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await ensureRuntimeStatusFresh();
		maybeWarnRtkMissing(ctx);
		return {};
	});

	pi.on("tool_call", async (event, ctx) => {
		const disabled = consumeDisableBudget(event.toolCallId, event.toolName);
		if (!config.enabled || disabled) {
			return {};
		}

		if (!isToolCallEventType("bash", event)) {
			return {};
		}

		if (hasRemoteSession(event.input)) {
			return {};
		}

		if (config.localBashRewrite.mode === "rewrite") {
			const compatibility = applyWindowsBashCompatibilityFixes(event.input.command);
			if (compatibility.command !== event.input.command) {
				event.input.command = compatibility.command;
			}
		}

		await ensureRuntimeStatusFresh();
		if (shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus)) {
			return {};
		}

		const decision = await computeRewriteDecision(event.input.command, config, pi, {
			executableResolution: getExecutableResolution(),
		});
		if (!decision.changed) {
			if (decision.warning) {
				warnOnce(ctx, formatRewriteWarning(decision.originalCommand, decision.warning));
			}
			return {};
		}

		if (config.localBashRewrite.mode === "rewrite") {
			if (config.localBashRewrite.showNotifications && ctx.hasUI) {
				ctx.ui.notify(formatRewriteNotice(decision.originalCommand, decision.rewrittenCommand), "info");
			}
			const envScopedRewrittenCommand = applyRtkCommandEnvironment(decision.rewrittenCommand);
			event.input.command = applyRewrittenCommandShellSafetyFixups(envScopedRewrittenCommand);
			trackRtkActivity({ kind: "rewrite", tool: "bash", command: decision.originalCommand });
			return {};
		}

		if (config.localBashRewrite.mode === "suggest") {
			const suggestionKey = `${decision.originalCommand}:${decision.rewrittenCommand}`;
			if (suggestionNotices.remember(suggestionKey) && ctx.hasUI) {
				ctx.ui.notify(`RTK suggestion: ${decision.rewrittenCommand}`, "info");
			}
		}

		return {};
	});

	pi.on("tool_result", async (event, ctx) => {
		const disabled = disabledToolCallIds.delete(event.toolCallId);
		if (!config.enabled || disabled) {
			return {};
		}

		await ensureRuntimeStatusFresh();
		if (shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus)) {
			return {};
		}

		try {
			const outcome = await compactToolResult(
				{
					toolName: event.toolName,
					input: event.input,
					content: event.content,
				},
				config,
				{ pi, executableResolution: getExecutableResolution() },
			);

			if (!outcome.changed || !outcome.content) {
				return {};
			}

			return {
				content: outcome.content,
				details: outcome.metadata ? mergeCompactionDetails(event.details, outcome.metadata) : undefined,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnOnce(ctx, `${EXTENSION_NAME}: RTK pipe compaction failed, using raw output (${trimMessage(message)}).`);
			return {};
		}
	});
}
