import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftEvent } from "../../src/domain/events.js";
import { deliver, sendEvent } from "../../src/daemon/client.js";
import { startDaemon, type Daemon } from "../../src/daemon/server.js";
import { readEvents } from "../../src/store/eventLog.js";

let rptDir = "";
let daemon: Daemon | null = null;

const draft: DraftEvent = {
	ts: "2026-09-09T10:00:00.000Z",
	source: "claude-code",
	kind: "FileMutated",
	payload: { path: "a.ts" },
};

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-daemon-"));
});

afterEach(async () => {
	await daemon?.close();
	daemon = null;
});

describe("daemon round trip", () => {
	it("persists an event sent over the socket", async () => {
		daemon = await startDaemon(rptDir);
		expect(await sendEvent(daemon.socketPath, 1, draft)).toBe(true);
		const { events } = await readEvents(rptDir, 1);
		expect(events[0]?.payload.path).toBe("a.ts");
	});

	it("handles many events without reordering them", async () => {
		daemon = await startDaemon(rptDir);
		for (let index = 0; index < 30; index += 1) {
			await sendEvent(daemon.socketPath, 1, { ...draft, payload: { path: `f${index}.ts` } });
		}
		const { events } = await readEvents(rptDir, 1);
		expect(events.map((event) => event.payload.path)).toEqual(
			Array.from({ length: 30 }, (_, index) => `f${index}.ts`),
		);
	});

	it("reports failure rather than throwing when nothing is listening", async () => {
		expect(await sendEvent(join(rptDir, "absent.sock"), 1, draft)).toBe(false);
	});
});

describe("deliver", () => {
	it("uses the socket when the daemon is up", async () => {
		daemon = await startDaemon(rptDir);
		expect(await deliver(rptDir, 1, draft)).toBe("socket");
	});

	it("falls back to a direct append when the daemon is down", async () => {
		expect(await deliver(rptDir, 1, draft)).toBe("direct");
		const { events } = await readEvents(rptDir, 1);
		expect(events).toHaveLength(1);
	});

	it("records a gap when both paths fail", async () => {
		// /proc/nonexistent/rpt (the brief's original path) doesn't exist as a
		// structural failure mode on macOS, where this project is built - the
		// test would pass for the wrong reason or not at all. Use a path that is
		// unwritable on every platform for the same structural reason: a regular
		// file standing where a directory needs to be created. mkdir(recursive)
		// underneath a file fails with ENOTDIR identically on macOS and Linux.
		const base = await mkdtemp(join(tmpdir(), "rpt-unwritable-"));
		const blocker = join(base, "blocker");
		await writeFile(blocker, "");
		const unwritable = join(blocker, "rpt");
		expect(await deliver(unwritable, 1, draft)).toBe("dropped");
	});
});
