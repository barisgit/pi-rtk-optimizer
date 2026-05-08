import type { RtkIntegrationConfig, RuntimeStatus } from "./types.js";

export function shouldRequireRtkAvailabilityForCommandHandling(
	config: Pick<RtkIntegrationConfig, "guardWhenRtkMissing">,
): boolean {
	return config.guardWhenRtkMissing;
}

export function shouldSkipCommandHandlingWhenRtkMissing(
	config: Pick<RtkIntegrationConfig, "guardWhenRtkMissing">,
	runtimeStatus: Pick<RuntimeStatus, "rtkAvailable">,
): boolean {
	return shouldRequireRtkAvailabilityForCommandHandling(config) && !runtimeStatus.rtkAvailable;
}
