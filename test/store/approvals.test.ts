import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Approval } from "../../src/domain/approval.js";
import { approvalPathOf, runDirOf } from "../../src/store/paths.js";
import { readApproval, writeApproval } from "../../src/store/approvals.js";

let rptDir = "";

function approval(overrides: Partial<Approval> = {}): Approval {
	return {
		runId: 1,
		decision: "approved",
		by: "klyne",
		at: "2026-09-10T10:00:00.000Z",
		override: false,
		level: "LOW",
		score: 3,
		contributions: [{ id: "files-changed-count", label: "Files changed", points: 3 }],
		configFingerprint: "deadbeef",
		...overrides,
	};
}

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-approvals-"));
	// Mirrors real usage: by the time src/app/approveRun.ts calls writeApproval,
	// the run directory already exists (created by the event log's earlier
	// writes for this run) - writeApproval, like store/verdicts.ts's
	// writeVerdict, does not create it itself.
	await mkdir(runDirOf(rptDir, 1), { recursive: true });
});

describe("writeApproval / readApproval", () => {
	it("round-trips a written approval", async () => {
		await writeApproval(rptDir, approval());
		expect(await readApproval(rptDir, 1)).toEqual(approval());
	});

	it("returns null when nothing has been recorded", async () => {
		expect(await readApproval(rptDir, 1)).toBeNull();
	});

	it("does not leave the temporary file behind after a successful write", async () => {
		await writeApproval(rptDir, approval());
		const entries = await readdir(runDirOf(rptDir, 1));
		expect(entries).toEqual(["approval.json"]);
	});
});

describe("readApproval validation", () => {
	async function writeRaw(runId: number, raw: unknown): Promise<void> {
		await mkdir(runDirOf(rptDir, runId), { recursive: true });
		await writeFile(approvalPathOf(rptDir, runId), JSON.stringify(raw), "utf8");
	}

	it("rejects a record whose runId does not match the run being read", async () => {
		await writeRaw(1, approval({ runId: 2 }));
		await expect(readApproval(rptDir, 1)).rejects.toThrow(/run 1/);
	});

	it("rejects an approver name containing a control character", async () => {
		await writeRaw(1, approval({ by: "klyne\nFORGED" }));
		await expect(readApproval(rptDir, 1)).rejects.toThrow();
	});

	// Regression: a denylist of ASCII control characters missed these -
	// U+2028 LINE SEPARATOR and U+0085 NEXT LINE render as a line break in
	// enough contexts to forge one the same way a plain "\n" does, without
	// being an ASCII control character themselves.
	it("rejects an approver name containing a Unicode line separator", async () => {
		await writeRaw(1, approval({ by: "klyne FORGED" }));
		await expect(readApproval(rptDir, 1)).rejects.toThrow();
	});

	it("rejects an approver name containing NEL (U+0085)", async () => {
		await writeRaw(1, approval({ by: "klyneFORGED" }));
		await expect(readApproval(rptDir, 1)).rejects.toThrow();
	});

	it("accepts an approver name with accented and non-Latin letters", async () => {
		await writeRaw(1, approval({ by: "Klyné 클라인" }));
		expect((await readApproval(rptDir, 1))?.by).toBe("Klyné 클라인");
	});

	it("rejects a timestamp containing a literal newline", async () => {
		await writeRaw(1, { ...approval(), at: "2026-09-10T10:00:00.000Z\nrpt: FORGED LINE" });
		await expect(readApproval(rptDir, 1)).rejects.toThrow();
	});

	it("rejects a decision outside the known enum", async () => {
		await writeRaw(1, { ...approval(), decision: "maybe" });
		await expect(readApproval(rptDir, 1)).rejects.toThrow();
	});

	it("rejects a risk level outside the known enum", async () => {
		await writeRaw(1, { ...approval(), level: "EXTREME" });
		await expect(readApproval(rptDir, 1)).rejects.toThrow();
	});

	it("rejects unparseable JSON", async () => {
		await mkdir(runDirOf(rptDir, 1), { recursive: true });
		await writeFile(approvalPathOf(rptDir, 1), "{not json", "utf8");
		await expect(readApproval(rptDir, 1)).rejects.toThrow(/JSON/);
	});

	it("rejects an unknown extra field rather than silently ignoring it", async () => {
		await writeRaw(1, { ...approval(), forged: true });
		await expect(readApproval(rptDir, 1)).rejects.toThrow();
	});
});
