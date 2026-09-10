import { describe, expect, it } from "vitest";
import * as rpt from "../src/index.js";

// The published library surface. Every name here is something a caller
// embedding the engine - a CI step, a different front end - imports by name, so
// a rename or a moved file that only breaks this entry point would otherwise
// ship silently: nothing else in the codebase imports through it.
const USE_CASES = [
	"initRepo",
	"verifyRun",
	"readVerdict",
	"assessRun",
	"gateCommit",
	"recordCommit",
	"attestationFor",
	"approveRun",
	"rejectRun",
	"healApproval",
	"readApproval",
	"actorFromEnvironment",
	"loadRun",
	"dashboardModel",
	"runDetailModel",
	"runDiff",
	"doctor",
	"assessRisk",
	"buildFacts",
] as const;

describe("the library entry point", () => {
	it("exports every use case a caller embeds the engine through", () => {
		const missing = USE_CASES.filter((name) => typeof (rpt as Record<string, unknown>)[name] !== "function");
		expect(missing).toEqual([]);
	});

	it("exports nothing that is not callable, so a broken re-export cannot hide", () => {
		const notFunctions = Object.entries(rpt).filter(([, value]) => typeof value !== "function");
		expect(notFunctions.map(([name]) => name)).toEqual([]);
	});
});
