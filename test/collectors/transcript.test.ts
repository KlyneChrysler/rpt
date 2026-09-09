import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readTranscriptUsage } from "../../src/collectors/transcript.js";

describe("readTranscriptUsage", () => {
	it("emits one ModelUsageRecorded per assistant message", async () => {
		const events = await readTranscriptUsage("test/fixtures/transcript.jsonl");
		expect(events).toHaveLength(3);
		expect(events.every((event) => event.kind === "ModelUsageRecorded")).toBe(true);
	});

	it("carries the model and all four token counts", async () => {
		const [event] = await readTranscriptUsage("test/fixtures/transcript.jsonl");
		expect(typeof event?.payload.model).toBe("string");
		expect(typeof event?.payload.input).toBe("number");
		expect(typeof event?.payload.output).toBe("number");
		expect(typeof event?.payload.cacheRead).toBe("number");
		expect(typeof event?.payload.cacheCreate).toBe("number");
	});

	it("skips malformed lines rather than failing the whole read", async () => {
		const dir = await mkdtemp(join(tmpdir(), "rpt-transcript-"));
		const path = join(dir, "t.jsonl");
		await writeFile(path, 'not json\n{"type":"assistant","message":{"model":"m","usage":{"output_tokens":1}}}\n');
		expect(await readTranscriptUsage(path)).toHaveLength(1);
	});

	it("returns nothing for a missing transcript instead of throwing", async () => {
		expect(await readTranscriptUsage("/nonexistent/transcript.jsonl")).toEqual([]);
	});
});
