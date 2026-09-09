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
		socket.on("connect", () => socket.write(encode({ runId, draft })));
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
	await appendDirectly(rptDir, runId, {
		ts: new Date().toISOString(),
		source: "rpt",
		kind: "GapRecorded",
		payload: { reason: "event delivery failed", lost: 1, kind: draft.kind },
	});
	return "dropped";
}
