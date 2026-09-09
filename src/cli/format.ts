export type OutputFormat = "text" | "json" | "agent";

export function formatDuration(fromIso: string, toIso: string | null): string {
	if (toIso === null) return "running";
	const seconds = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
	return `${pad(Math.floor(seconds / 60))}m ${pad(seconds % 60)}s`;
}

export function formatOffset(startIso: string, atIso: string): string {
	const seconds = Math.max(0, Math.round((Date.parse(atIso) - Date.parse(startIso)) / 1000));
	return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
