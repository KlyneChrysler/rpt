import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { Bar } from "../../src/ui/components/Bar.js";
import { Panel } from "../../src/ui/components/Panel.js";
import { StatTiles } from "../../src/ui/components/StatTiles.js";
import { colorForLevel, colorForState } from "../../src/ui/theme.js";

describe("Panel", () => {
	it("renders its title", () => {
		const { lastFrame } = render(
			<Panel title="RISK">
				<></>
			</Panel>,
		);
		expect(lastFrame()).toContain("RISK");
	});
});

describe("StatTiles", () => {
	it("renders a label and value for each tile", () => {
		const { lastFrame } = render(
			<StatTiles tiles={[{ label: "Duration", value: "08m 41s" }, { label: "Files", value: "7" }]} />,
		);
		expect(lastFrame()).toContain("Duration");
		expect(lastFrame()).toContain("08m 41s");
		expect(lastFrame()).toContain("Files");
	});

	it("stays mounted with an empty tile list", () => {
		expect(render(<StatTiles tiles={[]} />).lastFrame()).toBeDefined();
	});
});

describe("Bar", () => {
	it("fills proportionally", () => {
		expect(render(<Bar value={50} max={100} width={10} />).lastFrame()?.match(/#/g)).toHaveLength(5);
	});

	it("clamps a value above the maximum", () => {
		expect(render(<Bar value={999} max={100} width={10} />).lastFrame()?.match(/#/g)).toHaveLength(10);
	});

	it("renders an empty bar at zero", () => {
		expect(render(<Bar value={0} max={100} width={10} />).lastFrame()?.match(/#/g)).toBeNull();
	});
});

describe("colorForLevel", () => {
	it("gives every band a distinct colour", () => {
		const colors = new Set([
			colorForLevel("LOW"),
			colorForLevel("MEDIUM"),
			colorForLevel("HIGH"),
			colorForLevel("CRITICAL"),
		]);
		expect(colors.size).toBe(4);
	});

	it("has a colour for an unassessed run", () => {
		expect(typeof colorForLevel(null)).toBe("string");
	});
});

describe("colorForState", () => {
	it("separates a cleared run from a refused one", () => {
		expect(colorForState("VERIFIED")).not.toBe(colorForState("FAILED"));
		expect(colorForState("APPROVED")).not.toBe(colorForState("REJECTED"));
	});

	it("has a colour for a state it has never heard of", () => {
		expect(typeof colorForState("SOMETHING_NEW")).toBe("string");
	});
});
