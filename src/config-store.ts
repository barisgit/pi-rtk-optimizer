import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_PATH } from "./constants.js";
import {
	BUILTIN_PIPE_TOOLS,
	DEFAULT_RTK_INTEGRATION_CONFIG,
	RTK_MODES,
	type BuiltinPipeTool,
	type ConfigLoadResult,
	type ConfigSaveResult,
	type EnsureConfigResult,
	type RtkIntegrationConfig,
} from "./types.js";

function toBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function toMode(value: unknown): RtkIntegrationConfig["localBashRewrite"]["mode"] {
	return RTK_MODES.includes(value as RtkIntegrationConfig["localBashRewrite"]["mode"])
		? (value as RtkIntegrationConfig["localBashRewrite"]["mode"])
		: DEFAULT_RTK_INTEGRATION_CONFIG.localBashRewrite.mode;
}

function toObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function toBuiltinPipeTools(value: unknown): BuiltinPipeTool[] {
	if (!Array.isArray(value)) {
		return [...DEFAULT_RTK_INTEGRATION_CONFIG.builtinPipeCompaction.tools];
	}

	const allowed = new Set<string>(BUILTIN_PIPE_TOOLS);
	const next: BuiltinPipeTool[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && allowed.has(entry) && !next.includes(entry as BuiltinPipeTool)) {
			next.push(entry as BuiltinPipeTool);
		}
	}

	return next;
}

export function normalizeRtkIntegrationConfig(raw: unknown): RtkIntegrationConfig {
	const source = toObject(raw);
	const legacyOutputCompaction = toObject(source.outputCompaction);
	const localBashRewrite = toObject(source.localBashRewrite);
	const remoteBashPipeCompaction = toObject(source.remoteBashPipeCompaction);
	const builtinPipeCompaction = toObject(source.builtinPipeCompaction);

	return {
		enabled: toBoolean(source.enabled, DEFAULT_RTK_INTEGRATION_CONFIG.enabled),
		guardWhenRtkMissing: toBoolean(
			source.guardWhenRtkMissing,
			DEFAULT_RTK_INTEGRATION_CONFIG.guardWhenRtkMissing,
		),
		localBashRewrite: {
			mode: toMode(localBashRewrite.mode ?? source.mode),
			showNotifications: toBoolean(
				localBashRewrite.showNotifications ?? source.showRewriteNotifications,
				DEFAULT_RTK_INTEGRATION_CONFIG.localBashRewrite.showNotifications,
			),
		},
		remoteBashPipeCompaction: {
			enabled: toBoolean(
				remoteBashPipeCompaction.enabled ?? legacyOutputCompaction.enabled,
				DEFAULT_RTK_INTEGRATION_CONFIG.remoteBashPipeCompaction.enabled,
			),
		},
		builtinPipeCompaction: {
			enabled: toBoolean(
				builtinPipeCompaction.enabled,
				DEFAULT_RTK_INTEGRATION_CONFIG.builtinPipeCompaction.enabled,
			),
			tools: toBuiltinPipeTools(builtinPipeCompaction.tools),
		},
	};
}

export function ensureConfigExists(configPath = CONFIG_PATH): EnsureConfigResult {
	if (existsSync(configPath)) {
		return { created: false };
	}

	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify(DEFAULT_RTK_INTEGRATION_CONFIG, null, 2)}\n`, "utf-8");
		return { created: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			created: false,
			error: `Failed to create ${configPath}: ${message}`,
		};
	}
}

export function loadRtkIntegrationConfig(configPath = CONFIG_PATH): ConfigLoadResult {
	if (!existsSync(configPath)) {
		return { config: { ...DEFAULT_RTK_INTEGRATION_CONFIG } };
	}

	try {
		const rawText = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(rawText) as unknown;
		return { config: normalizeRtkIntegrationConfig(parsed) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			config: { ...DEFAULT_RTK_INTEGRATION_CONFIG },
			warning: `Failed to parse ${configPath}: ${message}`,
		};
	}
}

export function saveRtkIntegrationConfig(
	config: RtkIntegrationConfig,
	configPath = CONFIG_PATH,
): ConfigSaveResult {
	const normalized = normalizeRtkIntegrationConfig(config);
	const tmpPath = `${configPath}.tmp`;

	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
		renameSync(tmpPath, configPath);
		return { success: true };
	} catch (error) {
		try {
			if (existsSync(tmpPath)) {
				unlinkSync(tmpPath);
			}
		} catch {
			// Ignore cleanup failures.
		}

		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `Failed to save ${configPath}: ${message}`,
		};
	}
}

export function getRtkIntegrationConfigPath(): string {
	return CONFIG_PATH;
}
