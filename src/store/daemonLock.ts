import { writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { daemonLockOf } from "./paths.js";

export type DaemonLockRelease = () => Promise<void>;

// A daemon that is killed rather than closed leaves its lock behind. Anything
// older than this is treated as abandoned and reclaimable, so one `kill -9`
// cannot stop every future daemon in that repository from starting. The daemon
// refreshes the lock while it lives, so a healthy one is never mistaken for a
// dead one.
const STALE_MS = 30_000;
const UPDATE_MS = 5_000;

// Exclusive, and non-blocking on purpose: a caller that cannot get this lock
// wants to know that immediately and do nothing, because the only reason to
// hold it is to be the one daemon for this repository. Waiting would just queue
// up daemons to start the moment the current one exits.
export async function acquireDaemonLock(rptDir: string): Promise<DaemonLockRelease | null> {
	const path = daemonLockOf(rptDir);
	await ensureFile(path);
	try {
		return await lockfile.lock(path, { stale: STALE_MS, update: UPDATE_MS, retries: 0 });
	} catch {
		return null;
	}
}

// Whether a live daemon already holds the lock. Answers "is it worth trying to
// start one" without the cost or the side effects of actually trying, which is
// what the hook path needs: it runs on every tool call and must not spawn a
// process per call just to have it exit again.
export async function daemonLockHeld(rptDir: string): Promise<boolean> {
	try {
		return await lockfile.check(daemonLockOf(rptDir), { stale: STALE_MS });
	} catch {
		return false;
	}
}

async function ensureFile(path: string): Promise<void> {
	try {
		await writeFile(path, "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}
