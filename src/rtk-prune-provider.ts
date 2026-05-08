import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { RtkExecHost, RtkExecutableResolution } from "./rtk-executable-resolver.js";
import type { RuntimeStatus } from "./types.js";

export const PRUNE_REGISTER_PROVIDER_EVENT = "prune:register-provider";
export const RTK_READ_PRUNE_PROVIDER_NAME = "rtk-read";

const DEFAULT_RTK_READ_PRIORITY = 10;
const DEFAULT_RTK_READ_LEVEL: RtkReadLevel = "minimal";
const DEFAULT_RTK_READ_TIMEOUT_MS = 30_000;
const AVERAGE_CHARS_PER_LINE = 100;

export type RtkReadLevel = "none" | "minimal" | "aggressive";

export interface PruneDocument {
	id?: string;
	source?: string;
	text: string;
	hints?: {
		mimeType?: string;
		language?: string;
		lineOffset?: number;
	};
	metadata?: Record<string, unknown>;
}

export interface NormalizedPruneRequest {
	goal: string;
	documents: PruneDocument[];
	preserve?: string[];
	budget?: {
		tokens?: number;
		chars?: number;
		ratio?: number;
	};
	metadata?: Record<string, unknown>;
	options?: {
		threshold?: number;
		lineNumbers?: boolean;
		maxOutputDocuments?: number;
		maxOutputTokensPerDocument?: number;
		provider?: string;
		timeoutMs?: number;
	};
}

export interface PruneResult {
	text: string;
	documents?: Array<{ id?: string; source?: string; text: string }>;
	stats?: {
		inputTokens?: number;
		outputTokens?: number;
		compressionRatio?: number;
		latencyMs?: number;
		backend?: string;
		provider?: string;
	};
	warnings?: string[];
	provider?: string;
}

export interface PruneProviderRegistration {
	name: string;
	priority?: number;
	capabilities?: {
		multiDocument?: boolean;
		lineSpans?: boolean;
		scores?: boolean;
	};
	prune: (request: NormalizedPruneRequest, signal?: AbortSignal) => Promise<PruneResult>;
}

export interface RtkReadPruneProviderHost extends RtkExecHost {
	events: {
		emit(event: string, payload: unknown): void;
	};
}

export interface RtkReadPruneProviderOptions {
	getRuntimeStatus?: () => RuntimeStatus;
	getExecutableResolution?: () => RtkExecutableResolution | undefined;
}

export function registerRtkReadPruneProvider(
	pi: RtkReadPruneProviderHost,
	options: RtkReadPruneProviderOptions = {},
): void {
	pi.events.emit(PRUNE_REGISTER_PROVIDER_EVENT, createRtkReadPruneProvider(pi, options));
}

export function createRtkReadPruneProvider(
	pi: RtkExecHost,
	options: RtkReadPruneProviderOptions = {},
): PruneProviderRegistration {
	return {
		name: RTK_READ_PRUNE_PROVIDER_NAME,
		priority: getProviderPriority(),
		capabilities: {
			multiDocument: true,
			lineSpans: false,
			scores: false,
		},
		prune: (request, signal) => pruneWithRtkRead(request, pi, options, signal),
	};
}

function getProviderPriority(): number {
	const raw = Number(process.env.RTK_PRUNER_PRIORITY ?? DEFAULT_RTK_READ_PRIORITY);
	return Number.isFinite(raw) ? raw : DEFAULT_RTK_READ_PRIORITY;
}

function getDefaultLevel(): RtkReadLevel {
	return normalizeLevel(process.env.RTK_PRUNER_LEVEL) ?? DEFAULT_RTK_READ_LEVEL;
}

function normalizeLevel(value: unknown): RtkReadLevel | undefined {
	return value === "none" || value === "minimal" || value === "aggressive" ? value : undefined;
}

export function mapThresholdToRtkReadLevel(threshold: number | undefined): RtkReadLevel {
	if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
		return getDefaultLevel();
	}
	if (threshold <= 0) return "none";
	if (threshold >= 0.75) return "aggressive";
	return "minimal";
}

function estimateMaxLines(request: NormalizedPruneRequest): number | undefined {
	const totalLines = request.documents.reduce((sum, document) => sum + Math.max(1, document.text.split(/\r?\n/).length), 0);
	const ratio = request.budget?.ratio;
	if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio < 1) {
		return Math.max(1, Math.floor(totalLines * ratio));
	}

	const chars = request.budget?.chars;
	if (typeof chars === "number" && Number.isFinite(chars) && chars > 0) {
		return Math.max(1, Math.ceil(chars / AVERAGE_CHARS_PER_LINE));
	}

	return undefined;
}

function getExecutable(options: RtkReadPruneProviderOptions): string {
	return options.getExecutableResolution?.()?.command
		?? options.getRuntimeStatus?.().rtkExecutableCommand
		?? "rtk";
}

function extensionFromSource(source: string | undefined): string | undefined {
	if (!source) {
		return undefined;
	}
	try {
		const url = new URL(source);
		return extname(url.pathname) || undefined;
	} catch {
		return extname(source) || undefined;
	}
}

function extensionFromLanguage(language: string | undefined): string | undefined {
	switch (language) {
		case "javascript":
			return ".js";
		case "typescript":
			return ".ts";
		case "python":
			return ".py";
		case "markdown":
			return ".md";
		case "json":
			return ".json";
		case "html":
			return ".html";
		case "css":
			return ".css";
		default:
			return undefined;
	}
}

function getDocumentExtension(document: PruneDocument): string {
	return extensionFromSource(document.source)
		?? extensionFromLanguage(document.hints?.language)
		?? ".txt";
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("RTK read prune aborted");
	}
}

async function pruneWithRtkRead(
	request: NormalizedPruneRequest,
	pi: RtkExecHost,
	options: RtkReadPruneProviderOptions,
	signal?: AbortSignal,
): Promise<PruneResult> {
	assertNotAborted(signal);
	const startedAt = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "pi-rtk-read-prune-"));
	try {
		const paths = request.documents.map((document, index) => {
			const path = join(dir, `document-${index + 1}${getDocumentExtension(document)}`);
			writeFileSync(path, document.text, "utf-8");
			return path;
		});

		const args = ["read", "--level", mapThresholdToRtkReadLevel(request.options?.threshold)];
		const maxLines = estimateMaxLines(request);
		if (maxLines !== undefined) {
			args.push("--max-lines", String(maxLines));
		}
		args.push(...paths);

		const inputChars = request.documents.reduce((sum, document) => sum + document.text.length, 0);
		const executable = getExecutable(options);
		const result = await pi.exec(executable, args, { timeout: request.options?.timeoutMs ?? DEFAULT_RTK_READ_TIMEOUT_MS });
		assertNotAborted(signal);
		if (result.code !== 0) {
			throw new Error(`rtk read failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
		}

		return {
			text: result.stdout,
			provider: RTK_READ_PRUNE_PROVIDER_NAME,
			stats: {
				latencyMs: Date.now() - startedAt,
				compressionRatio: inputChars > 0 ? result.stdout.length / inputChars : undefined,
				backend: "rtk read",
				provider: RTK_READ_PRUNE_PROVIDER_NAME,
			},
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
