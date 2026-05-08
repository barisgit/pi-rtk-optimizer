export const RTK_MODES = ["rewrite", "suggest"] as const;
export const BUILTIN_PIPE_TOOLS = ["grep", "find"] as const;

export type RtkMode = (typeof RTK_MODES)[number];
export type BuiltinPipeTool = (typeof BUILTIN_PIPE_TOOLS)[number];

export interface LocalBashRewriteConfig {
	mode: RtkMode;
	showNotifications: boolean;
}

export interface RemoteBashPipeCompactionConfig {
	enabled: boolean;
}

export interface BuiltinPipeCompactionConfig {
	enabled: boolean;
	tools: BuiltinPipeTool[];
}

export interface RtkIntegrationConfig {
	enabled: boolean;
	guardWhenRtkMissing: boolean;
	localBashRewrite: LocalBashRewriteConfig;
	remoteBashPipeCompaction: RemoteBashPipeCompactionConfig;
	builtinPipeCompaction: BuiltinPipeCompactionConfig;
}

export const DEFAULT_RTK_INTEGRATION_CONFIG: RtkIntegrationConfig = {
	enabled: true,
	guardWhenRtkMissing: true,
	localBashRewrite: {
		mode: "rewrite",
		showNotifications: true,
	},
	remoteBashPipeCompaction: {
		enabled: true,
	},
	builtinPipeCompaction: {
		enabled: false,
		tools: ["grep", "find"],
	},
};

export interface ConfigLoadResult {
	config: RtkIntegrationConfig;
	warning?: string;
}

export interface ConfigSaveResult {
	success: boolean;
	error?: string;
}

export interface EnsureConfigResult {
	created: boolean;
	error?: string;
}

export interface RuntimeStatus {
	rtkAvailable: boolean;
	lastCheckedAt?: number;
	lastError?: string;
	rtkExecutablePath?: string;
	rtkExecutableCommand?: string;
	rtkExecutableResolver?: string;
	rtkExecutableResolutionWarning?: string;
}
