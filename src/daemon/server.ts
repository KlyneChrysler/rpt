import { createServer, type Server, type Socket } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { appendEvent } from "../store/eventLog.js";
import { decode, socketPathOf } from "./protocol.js";

export type Daemon = { socketPath: string; close(): Promise<void> };

export async function startDaemon(rptDir: string): Promise<Daemon> {
	await mkdir(rptDir, { recursive: true });
	const socketPath = socketPathOf(rptDir);
	await rm(socketPath, { force: true });
	const server = createServer((socket) => handle(rptDir, socket));
	await listen(server, socketPath);
	return { socketPath, close: () => close(server, socketPath) };
}

function handle(rptDir: string, socket: Socket): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		void persistAll(rptDir, lines, socket);
	});
	socket.on("error", () => socket.destroy());
}

async function persistAll(rptDir: string, lines: string[], socket: Socket): Promise<void> {
	for (const line of lines) {
		const frame = decode(line);
		if (frame === null) continue;
		try {
			await appendEvent(rptDir, frame.runId, frame.draft);
		} catch (error) {
			process.stderr.write(`rpt daemon: append failed: ${(error as Error).message}\n`);
		}
	}
	socket.write("ok\n");
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
}

async function close(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(socketPath, { force: true });
}
