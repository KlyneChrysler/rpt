import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { daemonLockHeld } from "../store/daemonLock.js";

export type EnsureOutcome = "already-running" | "spawned" | "disabled" | "unavailable";

// An explicit off switch, for environments where a background process is
// unwelcome regardless of the latency it would save: CI, a sandbox, a test
// suite that must not leave anything behind. Without the daemon every hook
// appends directly under a file lock, which is slower and equally correct.
const DISABLED = "RPT_NO_DAEMON";

// Resolved from this module's own location rather than from PATH. A hook runs
// with whatever environment the agent gives it, which may not include the
// directory `rpt` was installed into, and a daemon that only starts for some
// users is worse than one that starts for none.
const CLI_PATH = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const DAEMON_ARGS = ["daemon"];

// Best-effort, and never on the critical path of recording an event: the event
// has already been written directly by the time this is called. A daemon that
// fails to start costs a little hook latency and nothing else, so every failure
// here is swallowed into a return value rather than raised. rpt breaking the
// agent it observes is the one outcome worth more than any optimisation.
export async function ensureDaemon(rptDir: string): Promise<EnsureOutcome> {
	if (process.env[DISABLED] === "1") return "disabled";
	if (await daemonLockHeld(rptDir)) return "already-running";
	try {
		const child = spawn(process.execPath, [CLI_PATH, ...DAEMON_ARGS], {
			cwd: rptDir,
			detached: true,
			stdio: "ignore",
		});
		// An error after a successful spawn (the binary vanishing mid-exec, say)
		// arrives as an event, and an EventEmitter with no 'error' listener
		// throws - out of a hook process, which must never happen.
		child.on("error", () => {});
		child.unref();
		return "spawned";
	} catch {
		return "unavailable";
	}
}
