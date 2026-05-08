import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SettingItem } from "@mariozechner/pi-tui";
import { toOnOff } from "./boolean-format.js";
import { ZellijModal, ZellijSettingsModal } from "./zellij-modal.js";
import { getRtkArgumentCompletions } from "./command-completions.js";
import { BUILTIN_PIPE_TOOLS, DEFAULT_RTK_INTEGRATION_CONFIG, type BuiltinPipeTool, type RtkIntegrationConfig, type RuntimeStatus } from "./types.js";

interface RtkIntegrationController {
	getConfig(): RtkIntegrationConfig;
	setConfig(next: RtkIntegrationConfig, ctx: ExtensionCommandContext): void;
	getConfigPath(): string;
	getRuntimeStatus(): RuntimeStatus;
	refreshRuntimeStatus(): Promise<RuntimeStatus>;
	getMetricsSummary(): string;
	clearMetrics(): void;
	getDisableBudget(): number;
}

interface SettingValueSyncTarget {
	updateValue(id: string, value: string): void;
}

const ON_OFF = ["on", "off"];
const MODE_VALUES = ["rewrite", "suggest"];
const BUILTIN_TOOL_VALUES = [...BUILTIN_PIPE_TOOLS, "none"];
const RTK_USAGE_TEXT =
	"Usage: /rtk [show|path|verify|stats|clear-stats|reset|help] (or run /rtk with no args to open settings modal)";

function summarizeRuntimeStatus(runtimeStatus: RuntimeStatus): string {
	const runtime = runtimeStatus.rtkAvailable
		? "rtk=available"
		: `rtk=missing${runtimeStatus.lastError ? ` (${runtimeStatus.lastError})` : ""}`;
	const executable = runtimeStatus.rtkExecutablePath
		? `, rtkPath=${runtimeStatus.rtkExecutablePath}`
		: runtimeStatus.rtkExecutableResolutionWarning
			? `, rtkPath=unresolved (${runtimeStatus.rtkExecutableResolutionWarning})`
			: "";

	return `${runtime}${executable}`;
}

function formatBuiltinTools(tools: BuiltinPipeTool[]): string {
	return tools.length > 0 ? tools.join(",") : "none";
}

function summarizeConfig(config: RtkIntegrationConfig, runtimeStatus: RuntimeStatus, disableBudget: number): string {
	const budget = disableBudget > 0 ? `, disableBudget=${disableBudget}` : "";
	return `enabled=${config.enabled}, localBashRewrite=${config.localBashRewrite.mode}, rewriteNotice=${config.localBashRewrite.showNotifications}, remoteBashPipe=${config.remoteBashPipeCompaction.enabled}, builtinPipe=${config.builtinPipeCompaction.enabled}, builtinTools=${formatBuiltinTools(config.builtinPipeCompaction.tools)}, ${summarizeRuntimeStatus(runtimeStatus)}${budget}`;
}

function buildSettingItems(config: RtkIntegrationConfig): SettingItem[] {
	return [
		{
			id: "enabled",
			label: "RTK integration enabled",
			description: "Master switch for RTK rewrite and pipe compaction",
			currentValue: toOnOff(config.enabled),
			values: ON_OFF,
		},
		{
			id: "localBashRewriteMode",
			label: "Local bash rewrite mode",
			description: "rewrite = auto-rewrite local bash commands, suggest = notify only",
			currentValue: config.localBashRewrite.mode,
			values: MODE_VALUES,
		},
		{
			id: "localBashRewriteNotifications",
			label: "Show rewrite notifications",
			description: "Show 'RTK rewrite: old -> new' notices in TUI",
			currentValue: toOnOff(config.localBashRewrite.showNotifications),
			values: ON_OFF,
		},
		{
			id: "guardWhenRtkMissing",
			label: "Guard when rtk missing",
			description: "If on, RTK paths are bypassed when the rtk binary is unavailable",
			currentValue: toOnOff(config.guardWhenRtkMissing),
			values: ON_OFF,
		},
		{
			id: "remoteBashPipeCompaction",
			label: "Remote bash pipe compaction",
			description: "Pipe remote bash output through local RTK when RTK can classify the command",
			currentValue: toOnOff(config.remoteBashPipeCompaction.enabled),
			values: ON_OFF,
		},
		{
			id: "builtinPipeCompaction",
			label: "Builtin pipe compaction",
			description: "Pipe builtin grep/find output through local RTK",
			currentValue: toOnOff(config.builtinPipeCompaction.enabled),
			values: ON_OFF,
		},
		{
			id: "builtinPipeTools",
			label: "Builtin pipe tools",
			description: "Implemented builtin filters to enable",
			currentValue: formatBuiltinTools(config.builtinPipeCompaction.tools),
			values: BUILTIN_TOOL_VALUES,
		},
	];
}

function toggleBuiltinTools(current: BuiltinPipeTool[], value: string): BuiltinPipeTool[] {
	if (value === "none") {
		return [];
	}
	if (value !== "grep" && value !== "find") {
		return current;
	}
	return current.includes(value) ? current.filter((tool) => tool !== value) : [...current, value];
}

function applySetting(config: RtkIntegrationConfig, id: string, value: string): RtkIntegrationConfig {
	switch (id) {
		case "enabled":
			return { ...config, enabled: value === "on" };
		case "localBashRewriteMode":
			return {
				...config,
				localBashRewrite: { ...config.localBashRewrite, mode: value === "suggest" ? "suggest" : "rewrite" },
			};
		case "localBashRewriteNotifications":
			return {
				...config,
				localBashRewrite: { ...config.localBashRewrite, showNotifications: value === "on" },
			};
		case "guardWhenRtkMissing":
			return { ...config, guardWhenRtkMissing: value === "on" };
		case "remoteBashPipeCompaction":
			return {
				...config,
				remoteBashPipeCompaction: { enabled: value === "on" },
			};
		case "builtinPipeCompaction":
			return {
				...config,
				builtinPipeCompaction: { ...config.builtinPipeCompaction, enabled: value === "on" },
			};
		case "builtinPipeTools":
			return {
				...config,
				builtinPipeCompaction: {
					...config.builtinPipeCompaction,
					tools: toggleBuiltinTools(config.builtinPipeCompaction.tools, value),
				},
			};
		default:
			return config;
	}
}

function syncSettingValues(settingsList: SettingValueSyncTarget, config: RtkIntegrationConfig): void {
	settingsList.updateValue("enabled", toOnOff(config.enabled));
	settingsList.updateValue("localBashRewriteMode", config.localBashRewrite.mode);
	settingsList.updateValue("localBashRewriteNotifications", toOnOff(config.localBashRewrite.showNotifications));
	settingsList.updateValue("guardWhenRtkMissing", toOnOff(config.guardWhenRtkMissing));
	settingsList.updateValue("remoteBashPipeCompaction", toOnOff(config.remoteBashPipeCompaction.enabled));
	settingsList.updateValue("builtinPipeCompaction", toOnOff(config.builtinPipeCompaction.enabled));
	settingsList.updateValue("builtinPipeTools", formatBuiltinTools(config.builtinPipeCompaction.tools));
}

async function openSettingsModal(ctx: ExtensionCommandContext, controller: RtkIntegrationController): Promise<void> {
	const overlayOptions = { anchor: "center" as const, width: 86, maxHeight: "85%" as const, margin: 1 };

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let current = controller.getConfig();
			let settingsModal: ZellijSettingsModal | null = null;

			settingsModal = new ZellijSettingsModal(
				{
					title: "RTK Integration Settings",
					description: "Local bash rewrite + remote/builtin RTK pipe compaction",
					settings: buildSettingItems(current),
					onChange: (id, newValue) => {
						current = applySetting(current, id, newValue);
						controller.setConfig(current, ctx);
						current = controller.getConfig();
						if (settingsModal) {
							syncSettingValues(settingsModal, current);
						}
					},
					onClose: () => done(),
					helpText: `/rtk show • /rtk verify • /rtk stats • /rtk reset • ${controller.getConfigPath()}`,
					enableSearch: true,
				},
				theme,
			);

			const modal = new ZellijModal(
				settingsModal,
				{
					borderStyle: "rounded",
					titleBar: {
						left: "RTK Integration Settings",
						right: "pi-rtk-optimizer",
					},
					helpUndertitle: {
						text: "Esc: close | ↑↓: navigate | Space: toggle",
						color: "dim",
					},
					overlay: overlayOptions,
				},
				theme,
			);

			return {
				render(width: number) {
					return modal.renderModal(width).lines;
				},
				invalidate() {
					modal.invalidate();
				},
				handleInput(data: string) {
					modal.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions },
	);
}

async function handleArgs(
	args: string,
	ctx: ExtensionCommandContext,
	controller: RtkIntegrationController,
): Promise<boolean> {
	const normalized = (args ?? "").trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	if (normalized === "help") {
		ctx.ui.notify(RTK_USAGE_TEXT, "info");
		return true;
	}

	if (normalized === "show") {
		ctx.ui.notify(
			`rtk: ${summarizeConfig(controller.getConfig(), controller.getRuntimeStatus(), controller.getDisableBudget())}`,
			"info",
		);
		return true;
	}

	if (normalized === "path") {
		ctx.ui.notify(`rtk config: ${controller.getConfigPath()}`, "info");
		return true;
	}

	if (normalized === "verify") {
		const runtimeStatus = await controller.refreshRuntimeStatus();
		if (runtimeStatus.rtkAvailable) {
			const pathDetail = runtimeStatus.rtkExecutablePath ? ` at ${runtimeStatus.rtkExecutablePath}` : "";
			ctx.ui.notify(`RTK binary is available${pathDetail}.`, "info");
		} else {
			ctx.ui.notify(
				`RTK binary is not available${runtimeStatus.lastError ? `: ${runtimeStatus.lastError}` : ""}.`,
				"warning",
			);
		}
		return true;
	}

	if (normalized === "stats") {
		ctx.ui.notify(controller.getMetricsSummary(), "info");
		return true;
	}

	if (normalized === "clear-stats") {
		controller.clearMetrics();
		ctx.ui.notify("RTK metrics cleared.", "info");
		return true;
	}

	if (normalized === "reset") {
		controller.setConfig({ ...DEFAULT_RTK_INTEGRATION_CONFIG }, ctx);
		ctx.ui.notify("RTK integration settings reset to defaults.", "info");
		return true;
	}

	ctx.ui.notify(RTK_USAGE_TEXT, "warning");
	return true;
}

export function registerRtkIntegrationCommand(pi: Pick<ExtensionAPI, "registerCommand">, controller: RtkIntegrationController): void {
	pi.registerCommand("rtk", {
		description: "Configure RTK rewrite and pipe compaction integration",
		getArgumentCompletions: getRtkArgumentCompletions,
		handler: async (args, ctx) => {
			if (await handleArgs(args, ctx, controller)) {
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/rtk requires interactive TUI mode.", "warning");
				return;
			}

			await openSettingsModal(ctx, controller);
		},
	});
}
