import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftEvent } from "../../src/domain/events.js";
import { deliver, deliverOrRecordGap, sendEvent } from "../../src/daemon/client.js";
import { startDaemon, type Daemon } from "../../src/daemon/server.js";
import { readEvents } from "../../src/store/eventLog.js";
import { eventLogOf } from "../../src/store/paths.js";
import { IS_WINDOWS } from "../support/platform.js";

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

	// The hole this closes, verified against the real server rather than
	// reasoned about: a frame arriving split across two writes leaves the
	// daemon no complete line to persist. It used to answer "ok" for that empty
	// batch, so the client believed a delivery that had not happened and
	// skipped both its fallback append and the gap behind it.
	it("never acknowledges a frame that has only partly arrived", async () => {
		daemon = await startDaemon(rptDir);
		const frame = `${JSON.stringify({ runId: 1, draft })}\n`;
		const half = Math.floor(frame.length / 2);
		const replies: string[] = [];
		const socket = connect(daemon.socketPath);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => replies.push(chunk));
		await new Promise<void>((resolve) => socket.on("connect", () => resolve()));

		socket.write(frame.slice(0, half));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(replies).toEqual([]);
		expect((await readEvents(rptDir, 1)).events).toEqual([]);

		socket.write(frame.slice(half));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(replies.join("").trim()).toBe("ok");
		expect((await readEvents(rptDir, 1)).events).toHaveLength(1);
		socket.destroy();
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

// Writes a raw line straight at the daemon, bypassing encode(), so a frame the
// daemon cannot decode can be tested at all. Resolves with the daemon's reply.
function sendRaw(socketPath: string, line: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(socketPath, () => socket.write(line));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			socket.destroy();
			resolve(chunk);
		});
		socket.on("error", () => resolve(""));
	});
}

// The daemon's reply is a promise that the event reached the log. Anything else
// has to read as undelivered, or the client stops falling back and a failed write
// becomes a run that projects clean.
describe("daemon acknowledgement", () => {
	it("does not acknowledge an event it failed to persist", async () => {
		daemon = await startDaemon(rptDir);
		await mkdir(join(rptDir, "runs"), { recursive: true });
		// A regular file standing where run 1's directory has to be created: the
		// daemon's appendEvent fails on mkdir, structurally, on every platform.
		await writeFile(join(rptDir, "runs", "1"), "");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(await sendEvent(daemon.socketPath, 1, draft)).toBe(false);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("traces a frame it cannot decode rather than skipping it in silence", async () => {
		daemon = await startDaemon(rptDir);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const reply = await sendRaw(daemon.socketPath, "this is not a frame\n");
			expect(reply.trim()).not.toBe("ok");
			const traced = stderrSpy.mock.calls.some((call) => String(call[0]).includes("undecodable"));
			expect(traced).toBe(true);
		} finally {
			stderrSpy.mockRestore();
		}
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

	it("reports dropped when both paths fail", async () => {
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

describe("sendEvent socket lifecycle", () => {
	it(
		"resolves false rather than hanging when the peer closes without replying",
		async () => {
			// A daemon killed or shutting down mid-accept can close the connection
			// before writing "ok\n". Node's idle timer does not fire once the peer
			// has cleanly closed, so only a 'close' listener catches this - without
			// one the promise never settles. The explicit test timeout makes a
			// regression here fail fast instead of stalling the suite.
			// A unix socket path is not bindable on Windows, where an address has to
			// live in the pipe namespace. The production code already picks the
			// right one per platform (socketPathOf); this test builds its own
			// server, so it has to pick too.
			const socketPath = IS_WINDOWS
				? `\\\\.\\pipe\\rpt-test-${process.pid}-${Date.now()}`
				: join(rptDir, "close-without-reply.sock");
			// resume() drains the frame the client writes on connect: without it the
			// server-side socket's readable half never observes EOF, so it never
			// finishes its own half of the close and server.close() below would hang
			// on an unrelated test-harness artifact, not the behaviour under test.
			const server = createServer((socket) => {
				socket.resume();
				socket.end();
			});
			await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
			try {
				expect(await sendEvent(socketPath, 1, draft)).toBe(false);
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
		2000,
	);

	it("resolves false rather than crashing when the payload is circular", async () => {
		daemon = await startDaemon(rptDir);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(await sendEvent(daemon.socketPath, 1, { ...draft, payload: circular })).toBe(false);
	});

	it("resolves false rather than crashing when the payload contains a BigInt", async () => {
		daemon = await startDaemon(rptDir);
		expect(await sendEvent(daemon.socketPath, 1, { ...draft, payload: { big: 10n } })).toBe(false);
	});
});

describe("deliverOrRecordGap", () => {
	it("records no gap when the socket delivers", async () => {
		daemon = await startDaemon(rptDir);
		expect(await deliverOrRecordGap(rptDir, 1, draft)).toBe("socket");
		const { events } = await readEvents(rptDir, 1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("FileMutated");
	});

	it("records no gap when the direct append succeeds", async () => {
		expect(await deliverOrRecordGap(rptDir, 1, draft)).toBe("direct");
		const { events } = await readEvents(rptDir, 1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("FileMutated");
	});

	// The case the gap of last resort exists for. A lock directory left behind by
	// a process that died holding it outlives every retry budget in the store, so
	// the socket has nowhere to go and the direct append cannot take the lock -
	// and neither can a gap write that goes through the same locked path. The gap
	// must still land, or the run projects clean with the event simply missing.
	it("records a gap when the log lock is held past the retry budget", async () => {
		const logPath = eventLogOf(rptDir, 1);
		await mkdir(dirname(logPath), { recursive: true });
		await writeFile(logPath, "");
		const heldLock = `${logPath}.lock`;
		await mkdir(heldLock);
		try {
			expect(await deliverOrRecordGap(rptDir, 1, draft)).toBe("dropped");
			const { events } = await readEvents(rptDir, 1);
			expect(events.map((event) => event.kind)).toContain("GapRecorded");
		} finally {
			await rm(heldLock, { recursive: true, force: true });
		}
	});

	it("traces the gap write failure when everything fails", async () => {
		const base = await mkdtemp(join(tmpdir(), "rpt-unwritable-"));
		const blocker = join(base, "blocker");
		await writeFile(blocker, "");
		const unwritable = join(blocker, "rpt");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(await deliverOrRecordGap(unwritable, 1, draft)).toBe("dropped");
			const traced = stderrSpy.mock.calls.some((call) => String(call[0]).includes("gap recording failed"));
			expect(traced).toBe(true);
		} finally {
			stderrSpy.mockRestore();
		}
	});
});
