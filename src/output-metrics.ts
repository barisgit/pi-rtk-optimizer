export interface RtkActivityRecord {
	timestamp: string;
	kind: "rewrite" | "pipe" | "pipe-error";
	tool: string;
	filter?: string;
	command?: string;
	detail?: string;
}

const activityRecords: RtkActivityRecord[] = [];

export function trackRtkActivity(record: Omit<RtkActivityRecord, "timestamp">): RtkActivityRecord {
	const next = {
		...record,
		timestamp: new Date().toISOString(),
	};
	activityRecords.push(next);
	return next;
}

export function clearOutputMetrics(): void {
	activityRecords.length = 0;
}

export function getOutputMetricsSummary(): string {
	if (activityRecords.length === 0) {
		return "RTK activity metrics: no data yet.";
	}

	const counts = new Map<string, number>();
	for (const record of activityRecords) {
		const key = record.filter ? `${record.kind}:${record.tool}:${record.filter}` : `${record.kind}:${record.tool}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	let result = "RTK activity metrics\n";
	result += `events=${activityRecords.length}\n`;
	for (const [key, count] of counts.entries()) {
		result += `- ${key}: ${count}\n`;
	}

	return result.trimEnd();
}
