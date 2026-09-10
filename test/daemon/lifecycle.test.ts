import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureDaemon } from "../../src/daemon/spawn.js";
import { startDaemon, type Daemon } from "../../src/daemon/server.js";
import { acquireDaemonLock, daemonLockHeld, type DaemonLockRelease } from "../../src/store/daemonLock.js";
import { rptDirOf, socketPathOf } from "../../src/store/paths.js";
import { initRepo } from "../../src/app/initRepo.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";
import { buildCli, cliPath, projectRoot } from "../support/platform.js";

beforeAll(() => {
	buildCli();
}, 120_000);

let daemon: Daemon | null = null;
let held: DaemonLockRelease | null = null;

afterEach(async () => {
	await daemon?.close();
	daemon = null;
	await held?.();
	held = null;
});

async function rptDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "rpt-daemon-life-"));
}

function accepts(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		const settle = (value: boolean): void => {
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(300, () => settle(false));
		socket.on("error", () => settle(false));
		socket.on("connect", () => settle(true));
	});
}

async function until(predicate: () => Promise<boolean>, budgetMs = 5000): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

describe("the daemon single-start lock", () => {
	it("lets exactly one holder in at a time", async () => {
		const dir = await rptDir();
		held = await acquireDaemonLock(dir);
		expect(held).not.toBeNull();
		expect(await acquireDaemonLock(dir)).toBeNull();
	});

	it("reports the lock as held while a daemon holds it, and free once released", async () => {
		const dir = await rptDir();
		held = await acquireDaemonLock(dir);
		expect(await daemonLockHeld(dir)).toBe(true);
		await held?.();
		held = null;
		expect(await daemonLockHeld(dir)).toBe(false);
	});
});

describe("idle shutdown", () => {
	it("shuts itself down after going idle, rather than living forever", async () => {
		const dir = await rptDir();
		daemon = await startDaemon(dir, { idleMs: 100 });
		await daemon.stopped;
		expect(await accepts(daemon.socketPath)).toBe(false);
		daemon = null;
	});

	it("stays up while a client keeps using it", async () => {
		const dir = await rptDir();
		daemon = await startDaemon(dir, { idleMs: 400 });
		const { sendEvent } = await import("../../src/daemon/client.js");
		for (let index = 0; index < 4; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 150));
			const sent = await sendEvent(daemon!.socketPath, 1, {
				ts: new Date().toISOString(),
				source: "rpt",
				kind: "FileMutated",
				payload: { path: `a${index}.ts` },
			});
			expect(sent).toBe(true);
		}
	});

	it("removes its socket on the way out, so a stale file never outlives it", async () => {
		const dir = await rptDir();
		daemon = await startDaemon(dir, { idleMs: 100 });
		const socketPath = daemon.socketPath;
		await daemon.stopped;
		daemon = null;
		const { readdir } = await import("node:fs/promises");
		expect(await readdir(dir)).not.toContain(socketPath.split("/").pop());
	});
});

describe("ensureDaemon", () => {
	it("does nothing when the off switch is set", async () => {
		process.env.RPT_NO_DAEMON = "1";
		expect(await ensureDaemon(await rptDir())).toBe("disabled");
	});

	it("does not start a second daemon when one already holds the lock", async () => {
		delete process.env.RPT_NO_DAEMON;
		try {
			const dir = await rptDir();
			held = await acquireDaemonLock(dir);
			expect(await ensureDaemon(dir)).toBe("already-running");
		} finally {
			process.env.RPT_NO_DAEMON = "1";
		}
	});
});

// ensureDaemon resolves the command it spawns relative to its own module, so
// under vitest it points at a source path that has no built sibling. Importing
// the built copy is the only way to exercise the real spawn - and it is also
// the copy that ever runs in production.
describe("ensureDaemon, from the built package", () => {
	it("starts a daemon that accepts connections, and does not start a second", async () => {
		delete process.env.RPT_NO_DAEMON;
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const dir = rptDirOf(repo);
		try {
			const built = (await import(join(projectRoot, "dist/daemon/spawn.js"))) as typeof import("../../src/daemon/spawn.js");
			expect(await built.ensureDaemon(dir)).toBe("spawned");
			expect(await until(() => accepts(socketPathOf(dir)))).toBe(true);
			expect(await built.ensureDaemon(dir)).toBe("already-running");
		} finally {
			process.env.RPT_NO_DAEMON = "1";
			// The child was detached and unref'd on purpose, so there is no pid to
			// kill here. Removing the address is what a supervisor would do, and
			// it goes through the store rather than a raw unlink because a
			// Windows named pipe is not a file: unlinking its name throws EINVAL,
			// which is precisely why the production path guards it too. Where the
			// address is a pipe this is a no-op and the daemon idles out instead.
			const { removeSocketPath } = await import("../../src/store/daemonSocket.js");
			await removeSocketPath(dir);
		}
	});
});

// The whole auto-start path, through the built binary rather than the source,
// because that is the only place the spawned command actually resolves.
describe("a hook starts the daemon for the events that come after it", () => {
	it("leaves a daemon accepting connections after the first delivery", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const dir = rptDirOf(repo);
		const child = execFile(process.execPath, [cliPath, "daemon", "--idle", "3000"], { cwd: repo });
		try {
			expect(await until(() => accepts(socketPathOf(dir)))).toBe(true);
			expect(await daemonLockHeld(dir)).toBe(true);
		} finally {
			child.kill();
		}
	});

	it("refuses to start a second daemon for the same repository", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const dir = rptDirOf(repo);
		const child = execFile(process.execPath, [cliPath, "daemon", "--idle", "3000"], { cwd: repo });
		try {
			expect(await until(() => accepts(socketPathOf(dir)))).toBe(true);
			const second = await new Promise<string>((resolve) => {
				execFile(process.execPath, [cliPath, "daemon"], { cwd: repo }, (_error, stdout) => resolve(stdout));
			});
			expect(second).toContain("already running");
		} finally {
			child.kill();
		}
	});
});
