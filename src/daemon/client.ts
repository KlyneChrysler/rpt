import { connect } from "node:net";
import type { DraftEvent, RunId } from "../domain/events.js";
import { appendEvent } from "../store/eventLog.js";
import { encode, socketPathOf } from "./protocol.js";

const SEND_TIMEOUT_MS = 200;

export type Delivery = "socket" | "direct" | "dropped";

export async function deliver(rptDir: string, runId: RunId, draft: DraftEvent): Promise<Delivery> {
	if (await sendEvent(socketPathOf(rptDir), runId, draft)) return "socket";
	if (await appendDirectly(rptDir, runId, draft)) return "direct";
	return "dropped";
}

export function sendEvent(socketPath: string, runId: RunId, draft: DraftEvent): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		// Every exit path below must go through settle exactly once: it is the
		// only place the socket is destroyed and the promise resolved. Without
		// the guard, a slow or half-open connection racing a timeout against a
		// late 'error' could double-resolve harmlessly, but skipping destroy()
		// on any path would leak the fd and keep a short-lived hook process alive.
		let settled = false;
		const settle = (delivered: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(delivered);
		};
		socket.setTimeout(SEND_TIMEOUT_MS, () => settle(false));
		socket.on("error", () => settle(false));
		// A cleanly closed peer (daemon killed or shutting down mid-accept, before
		// it writes a reply) fires neither 'error' nor the idle timeout - Node
		// stops tracking the timer once the socket is gone. Without this listener
		// the promise never settles and the caller hangs.
		socket.on("close", () => settle(false));
		socket.on("connect", () => {
			// JSON.stringify (inside encode) can throw on a circular payload or a
			// BigInt. That throw happens outside the promise executor's synchronous
			// scope, so left unguarded it is an uncaught exception, not a
			// rejection - it would kill the hook process instead of just failing
			// this one delivery.
			let frame: string;
			try {
				frame = encode({ runId, draft });
			} catch {
				settle(false);
				return;
			}
			socket.write(frame);
		});
		socket.on("data", () => settle(true));
	});
}

async function appendDirectly(rptDir: string, runId: RunId, draft: DraftEvent): Promise<boolean> {
	try {
		await appendEvent(rptDir, runId, draft);
		return true;
	} catch {
		return false;
	}
}

export async function deliverOrRecordGap(
	rptDir: string,
	runId: RunId,
	draft: DraftEvent,
): Promise<Delivery> {
	const delivery = await deliver(rptDir, runId, draft);
	if (delivery !== "dropped") return delivery;
	// This runs only once both the socket and a direct append to this same
	// rptDir have already failed, so the gap write below is attempted against
	// the same broken location and can predictably fail too. Trace that failure
	// rather than swallow it: this is the one place responsible for guaranteeing
	// nothing is lost silently, matching the daemon's own append-failure pattern.
	try {
		await appendEvent(rptDir, runId, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "GapRecorded",
			payload: { reason: "event delivery failed", lost: 1, kind: draft.kind },
		});
	} catch (error) {
		process.stderr.write(`rpt: gap recording failed: ${(error as Error).message}\n`);
	}
	return "dropped";
}
