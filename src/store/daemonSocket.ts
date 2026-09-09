import { mkdir, rm } from "node:fs/promises";
import { socketPathOf } from "./paths.js";

// Creating .rpt and unlinking a stale socket file are writes under .rpt, and the
// daemon is not the layer allowed to make them - the same reason the current-run
// pointer and the pricing scaffold already live here. The daemon still owns the
// server it binds to the path this returns.
export async function prepareSocketPath(rptDir: string): Promise<string> {
	await mkdir(rptDir, { recursive: true });
	const path = socketPathOf(rptDir);
	// A socket file left behind by a daemon that was killed rather than closed
	// makes listen() fail with EADDRINUSE even though nothing is listening.
	await rm(path, { force: true });
	return path;
}

export async function removeSocketPath(rptDir: string): Promise<void> {
	await rm(socketPathOf(rptDir), { force: true });
}
