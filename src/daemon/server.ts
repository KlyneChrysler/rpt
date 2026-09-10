import { createServer, type Server, type Socket } from "node:net";
import { prepareSocketPath, removeSocketPath } from "../store/daemonSocket.js";
import { appendEvent } from "../store/eventLog.js";
import { decode, FAILED_REPLY, OK_REPLY } from "./protocol.js";

export type Daemon = { socketPath: string; close(): Promise<void> };

const TRACE_MAX_CHARS = 200;

export async function startDaemon(rptDir: string): Promise<Daemon> {
	const socketPath = await prepareSocketPath(rptDir);
	const server = createServer((socket) => handle(rptDir, socket));
	await listen(server, socketPath);
	return { socketPath, close: () => close(server, rptDir) };
}

function handle(rptDir: string, socket: Socket): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		// A frame split across more than one chunk leaves no complete line yet.
		// Answering that with "ok" - which is what replying for an empty batch
		// amounted to - told the client an event was persisted when nothing had
		// been written at all, and the client, believing it, skipped both the
		// direct-append fallback and the gap behind it. Staying silent instead
		// leaves the client waiting: it gets a real answer when the rest of the
		// frame arrives, or its own send timeout fires and it falls back. Both
		// of those are honest; the acknowledgement was not.
		if (lines.length === 0) return;
		void persistAll(rptDir, lines, socket);
	});
	socket.on("error", () => socket.destroy());
}

// An acknowledgement is a promise that the event is in the log. The client treats
// anything but "ok" as undelivered and falls back to its own append and then to a
// gap, so a frame that could not be decoded or could not be appended must never be
// answered with "ok": that is precisely how a failed write turns into a run that
// projects clean. One reply per batch, so any failure in the batch fails the batch.
async function persistAll(rptDir: string, lines: string[], socket: Socket): Promise<void> {
	let persisted = true;
	for (const line of lines) {
		persisted = (await persistOne(rptDir, line)) && persisted;
	}
	socket.write(persisted ? `${OK_REPLY}\n` : `${FAILED_REPLY}\n`);
}

async function persistOne(rptDir: string, line: string): Promise<boolean> {
	const frame = decode(line);
	if (frame === null) {
		process.stderr.write(`rpt daemon: undecodable frame dropped: ${line.slice(0, TRACE_MAX_CHARS)}\n`);
		return false;
	}
	try {
		await appendEvent(rptDir, frame.runId, frame.draft);
		return true;
	} catch (error) {
		process.stderr.write(`rpt daemon: append failed: ${(error as Error).message}\n`);
		return false;
	}
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// A persistent listener, not `.once`: an error after startup must still be
		// caught (an EventEmitter with no 'error' listener throws on the next one,
		// crashing the daemon), and rejecting a settled promise is a silent no-op,
		// so a post-startup error is traced to stderr instead of vanishing.
		let started = false;
		server.on("error", (error) => {
			if (started) {
				process.stderr.write(`rpt daemon: server error: ${(error as Error).message}\n`);
				return;
			}
			reject(error);
		});
		server.listen(socketPath, () => {
			started = true;
			resolve();
		});
	});
}

async function close(server: Server, rptDir: string): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await removeSocketPath(rptDir);
}
