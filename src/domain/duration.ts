// Pure formatting of two instants, with no dependency on anything at all -
// which is why it lives here rather than beside either surface that renders
// it. The terminal CLI and the Ink console both print a run's duration and an
// event's offset from the run's start, and two copies of that arithmetic is
// two chances for the same run to be reported as lasting different lengths of
// time depending on which screen a person is looking at.
export function formatDuration(fromIso: string, toIso: string | null): string {
	if (toIso === null) return "running";
	return `${pad(Math.floor(elapsedSeconds(fromIso, toIso) / 60))}m ${pad(elapsedSeconds(fromIso, toIso) % 60)}s`;
}

export function formatOffset(startIso: string, atIso: string): string {
	return `${pad(Math.floor(elapsedSeconds(startIso, atIso) / 60))}:${pad(elapsedSeconds(startIso, atIso) % 60)}`;
}

// Floored at zero: hook delivery jitter can time-stamp an event a moment before
// the run it belongs to, and a negative offset reads as a corrupted record
// rather than as the fraction of a second it actually is. Order comes from seq,
// not ts (see domain/events.ts), so nothing downstream depends on this
// difference being signed.
function elapsedSeconds(fromIso: string, toIso: string): number {
	return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
