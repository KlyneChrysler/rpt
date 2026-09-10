import { connect } from "node:net";
import type { DraftEvent, RunId } from "../domain/events.js";
import { appendEvent, appendGapUnlocked } from "../store/eventLog.js";
import { socketPathOf } from "../store/paths.js";
import { encode, OK_REPLY } from "./protocol.js";
import { ensureDaemon } from "./spawn.js";

const SEND_TIMEOUT_MS = 200;

export type Delivery = "socket" | "direct" | "dropped";

export async function deliver(rptDir: string, runId: RunId, draft: DraftEvent): Promise<Delivery> {
	if (await sendEvent(socketPathOf(rptDir), runId, draft)) return "socket";
	const delivery = (await appendDirectly(rptDir, runId, draft)) ? "direct" : "dropped";
	// After this event is already safely recorded, never before. The daemon is
	// an optimisation for the events that come after this one - the first tool
	// call of a session pays the direct-append cost and starts the daemon; the
	// rest of the session takes the socket. Starting it first would put a
	// process spawn between the agent and its own tool call, which is exactly
	// the cost this whole path exists to avoid.
	await startDaemonForLater(rptDir);
	return delivery;
}

// Nothing here can fail loudly. ensureDaemon already swallows its own failures;
// this guards the call itself so a future change inside it cannot reach a hook.
async function startDaemonForLater(rptDir: string): Promise<void> {
	try {
		await ensureDaemon(rptDir);
	} catch {
		// A daemon that will not start costs latency, not correctness.
	}
}

export function sendEvent(socketPath: string, runId: RunId, draft: DraftEvent): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		socket.setEncoding("utf8");
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
		// Delivered means persisted, not answered. The daemon replies "failed" for a
		// frame it could not decode or could not append, and treating that as success
		// would skip the direct-append fallback and the gap behind it - the event
		// would vanish while the run still projected clean.
		let reply = "";
		socket.on("data", (chunk: string) => {
			reply += chunk;
			const end = reply.indexOf("\n");
			if (end !== -1) settle(reply.slice(0, end).trim() === OK_REPLY);
		});
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
	await recordGap(rptDir, runId, draft);
	return "dropped";
}

// This is the one place responsible for the promise that no event is ever lost in
// silence, so it must not repeat the write that just failed. Reaching here means a
// locked append against this exact path has already failed; going through
// appendEvent again would fail identically, leaving no gap event, no unparseable
// line, and a run that projects clean. appendGapUnlocked takes neither lock, which
// is the whole difference: it survives a lock a crashed process never released,
// the one structural failure a gap write can still beat. A directory that cannot
// be written at all beats that too, and that case is traced rather than pretended
// about - it is the single documented hole in the guarantee.
async function recordGap(rptDir: string, runId: RunId, draft: DraftEvent): Promise<void> {
	try {
		await appendGapUnlocked(rptDir, runId, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "GapRecorded",
			payload: { reason: "event delivery failed", lost: 1, kind: draft.kind },
		});
	} catch (error) {
		process.stderr.write(`rpt: gap recording failed: ${(error as Error).message}\n`);
	}
}
