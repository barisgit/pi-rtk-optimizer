import assert from "node:assert/strict";

import {
	shouldRequireRtkAvailabilityForCommandHandling,
	shouldSkipCommandHandlingWhenRtkMissing,
} from "./runtime-guard.ts";
import { DEFAULT_RTK_INTEGRATION_CONFIG, type RtkIntegrationConfig, type RuntimeStatus } from "./types.ts";

function runTest(name: string, testFn: () => void): void {
	testFn();
	console.log(`[PASS] ${name}`);
}

function cloneConfig(): RtkIntegrationConfig {
	return structuredClone(DEFAULT_RTK_INTEGRATION_CONFIG);
}

function runtimeStatus(rtkAvailable: boolean): RuntimeStatus {
	return { rtkAvailable };
}

runTest("rewrite mode still requires RTK availability when guard is enabled", () => {
	const config = cloneConfig();
	config.mode = "rewrite";
	config.guardWhenRtkMissing = true;

	assert.equal(shouldRequireRtkAvailabilityForCommandHandling(config), true);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(false)), true);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(true)), false);
});

runTest("suggest mode does not suppress suggestions when RTK is missing", () => {
	const config = cloneConfig();
	config.mode = "suggest";
	config.guardWhenRtkMissing = true;

	assert.equal(shouldRequireRtkAvailabilityForCommandHandling(config), false);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(false)), false);
});

runTest("guard disabled never blocks command handling", () => {
	const config = cloneConfig();
	config.mode = "rewrite";
	config.guardWhenRtkMissing = false;

	assert.equal(shouldRequireRtkAvailabilityForCommandHandling(config), false);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(false)), false);
});

console.log("All runtime-guard tests passed.");
