import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface RtkRewriteProviderResult {
	changed: boolean;
	originalCommand: string;
	rewrittenCommand: string;
	exitCode: number;
	error?: string;
}

function isAlreadyRtk(command: string): boolean {
	const trimmed = command.trimStart();
	return trimmed === "rtk" || trimmed.startsWith("rtk ");
}

export async function resolveRtkRewrite(
	pi: ExtensionAPI,
	command: string,
	timeoutMs = 3000,
): Promise<RtkRewriteProviderResult> {
	if (!command || !command.trim()) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, exitCode: 1 };
	}

	if (isAlreadyRtk(command)) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, exitCode: 1 };
	}

	try {
		const result = await pi.exec("rtk", ["rewrite", command], { timeout: timeoutMs });

		if (result.code === 1) {
			return { changed: false, originalCommand: command, rewrittenCommand: command, exitCode: 1 };
		}

		if (result.code === 2) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				exitCode: 2,
				error: result.stderr?.trim() || "rtk denied rewrite",
			};
		}

		if (result.code === 0 || result.code === 3) {
			const rewritten = result.stdout?.trim();
			if (!rewritten) {
				return {
					changed: false,
					originalCommand: command,
					rewrittenCommand: command,
					exitCode: result.code,
					error: "rtk returned empty output",
				};
			}
			if (rewritten === command) {
				return {
					changed: false,
					originalCommand: command,
					rewrittenCommand: command,
					exitCode: result.code,
				};
			}
			return {
				changed: true,
				originalCommand: command,
				rewrittenCommand: rewritten,
				exitCode: result.code,
			};
		}

		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			exitCode: result.code,
			error: `unexpected exit code ${result.code}`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			exitCode: -1,
			error: message,
		};
	}
}
