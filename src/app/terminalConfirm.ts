import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";

// The console device, by whatever name the platform gives it. Reading the
// controlling terminal rather than standard input is the whole point of this
// module - a typed answer has to survive stdin being piped or redirected - and
// on Windows that device is CONIN$/CONOUT$ rather than /dev/tty.
const CONSOLE_INPUT_DEVICE = process.platform === "win32" ? "CONIN$" : "/dev/tty";
const CONSOLE_OUTPUT_DEVICE = process.platform === "win32" ? "CONOUT$" : "/dev/tty";

// Reads one line from the console device, not standard input,
// so a typed answer survives stdin/stdout being redirected or piped - the
// gap an automated bypass exploits by attaching a pseudo-terminal that
// satisfies isTTY checks without a human ever being asked anything.
//
// Kept in its own module, with no parameter anywhere in approveRun.ts that
// can swap this implementation out, on purpose: the whole point of moving
// the confirmation into record() (see approveRun.ts) is that bypassing it
// must mean not calling the public approveRun/rejectRun functions at all,
// not calling them with a convenient argument. Tests replace this module's
// export with vi.mock, which patches the module graph inside the test
// runner - not a capability reachable through the public API surface any
// caller of approveRun/rejectRun actually has.
export async function readFromControllingTerminal(prompt: string): Promise<string> {
	const input = createReadStream(CONSOLE_INPUT_DEVICE);
	const output = createWriteStream(CONSOLE_OUTPUT_DEVICE);
	await Promise.all([once(input, "open"), once(output, "open")]);
	const rl = createInterface({ input, output, terminal: true });
	try {
		return await rl.question(prompt);
	} finally {
		rl.close();
		input.destroy();
		output.destroy();
	}
}
