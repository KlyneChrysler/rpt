import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { DashboardModel } from "../../src/app/readModel.js";
import { Dashboard } from "../../src/ui/screens/Dashboard.js";

const model: DashboardModel = {
	runs: [
		{
			id: 1842,
			task: "fix authentication timeout",
			state: "VERIFIED",
			startedAt: "2026-09-09T10:00:00.000Z",
			endedAt: "2026-09-09T10:08:41.000Z",
			riskScore: 47,
			riskLevel: "MEDIUM",
			costUsd: 1.84,
			unprojectable: null,
		},
		{
			id: 1841,
			task: "add pagination",
			state: "FAILED",
			startedAt: "2026-09-09T09:00:00.000Z",
			endedAt: "2026-09-09T09:02:00.000Z",
			riskScore: 12,
			riskLevel: "LOW",
			costUsd: null,
			unprojectable: null,
		},
	],
};

function frameOf(dashboard: React.ReactElement): string {
	return render(dashboard).lastFrame() ?? "";
}

describe("Dashboard", () => {
	it("lists every run with id, task and state", () => {
		const frame = frameOf(<Dashboard model={model} selectedIndex={0} />);
		expect(frame).toContain("1842");
		expect(frame).toContain("fix authentication timeout");
		expect(frame).toContain("VERIFIED");
	});

	it("shows the risk band", () => {
		expect(frameOf(<Dashboard model={model} selectedIndex={0} />)).toContain("MEDIUM");
	});

	it("shows unknown rather than a number when cost could not be priced", () => {
		expect(frameOf(<Dashboard model={model} selectedIndex={0} />)).toContain("unknown");
	});

	it("marks the selected row", () => {
		const frame = frameOf(<Dashboard model={model} selectedIndex={1} />);
		const selected = frame.split("\n").find((line) => line.includes("1841")) ?? "";
		expect(selected.trimStart().startsWith(">")).toBe(true);
	});

	it("renders an explanatory empty state", () => {
		const frame = frameOf(<Dashboard model={{ runs: [] }} selectedIndex={0} />);
		expect(frame).toMatch(/no runs/i);
		expect(frame).toMatch(/rpt init/);
	});

	it("shows a dash, not a zero, for a run with no assessment", () => {
		const unscored: DashboardModel = {
			runs: [{ ...model.runs[0]!, riskScore: null, riskLevel: null }],
		};
		const line = frameOf(<Dashboard model={unscored} selectedIndex={0} />).split("\n").find((row) => row.includes("1842")) ?? "";
		expect(line).not.toContain("0 LOW");
		expect(line).toContain("-");
	});

	it("says a run is unreadable rather than showing it as an ordinary blank row", () => {
		const damaged: DashboardModel = {
			runs: [{ ...model.runs[0]!, task: "", unprojectable: "run 1842 does not begin with RunStarted" }],
		};
		expect(frameOf(<Dashboard model={damaged} selectedIndex={0} />)).toMatch(/unreadable/i);
	});
});
