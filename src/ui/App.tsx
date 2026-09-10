import { Box, Text, useApp, useInput, useStdin } from "ink";
import React, { useCallback, useEffect, useState } from "react";
import {
	actorFromEnvironment,
	approveRun,
	rejectRun,
	type Actor,
} from "../app/approveRun.js";
import {
	dashboardModel,
	runDetailModel,
	runDiff,
	type DashboardModel,
	type RunDetailModel,
} from "../app/readModel.js";
import { Approve, type ApprovalStatus } from "./screens/Approve.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Diff } from "./screens/Diff.js";
import { Events } from "./screens/Events.js";
import { Risk } from "./screens/Risk.js";
import { RunDetail } from "./screens/RunDetail.js";
import { Tests } from "./screens/Tests.js";

type Screen = "dashboard" | "detail" | "events" | "diff" | "risk" | "tests" | "approve";

const HINTS: Record<Screen, string> = {
	dashboard: "[up/down] select  [enter] open  [q] quit",
	detail: "[v] events  [d] diff  [t] tests  [r] risk  [a] approve  [esc] back  [q] quit",
	events: "[esc] back  [q] quit",
	diff: "[esc] back  [q] quit",
	risk: "[esc] back  [q] quit",
	tests: "[esc] back  [q] quit",
	approve: "[y] approve  [n] reject  [esc] back  [q] quit",
};

export function App({ repoRoot }: { repoRoot: string }): React.ReactElement {
	const { exit } = useApp();
	const { setRawMode } = useStdin();
	const [screen, setScreen] = useState<Screen>("dashboard");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [dashboard, setDashboard] = useState<DashboardModel | null>(null);
	const [detail, setDetail] = useState<RunDetailModel | null>(null);
	const [patch, setPatch] = useState<string | null>(null);
	const [approval, setApproval] = useState<ApprovalStatus>({ kind: "prompt" });
	const [error, setError] = useState<string | null>(null);

	const selectedId = dashboard?.runs[selectedIndex]?.id ?? null;

	useEffect(() => {
		let live = true;
		dashboardModel(repoRoot).then(
			(model) => live && setDashboard(model),
			(cause: unknown) => live && setError(messageOf(cause)),
		);
		return () => {
			live = false;
		};
	}, [repoRoot]);

	useEffect(() => {
		if (selectedId === null) return;
		let live = true;
		setDetail(null);
		runDetailModel(repoRoot, selectedId).then(
			(model) => live && setDetail(model),
			(cause: unknown) => live && setError(messageOf(cause)),
		);
		return () => {
			live = false;
		};
	}, [repoRoot, selectedId]);

	useEffect(() => {
		if (screen !== "diff" || selectedId === null) return;
		let live = true;
		setPatch(null);
		runDiff(repoRoot, selectedId).then(
			(value) => live && setPatch(value),
			(cause: unknown) => live && setError(messageOf(cause)),
		);
		return () => {
			live = false;
		};
	}, [repoRoot, screen, selectedId]);

	// Raw mode is handed back to the terminal for the duration of the call,
	// because approveRun's typed confirmation reads a whole line from the
	// controlling terminal and cannot do that while Ink is consuming every
	// keystroke. That confirmation is deliberately not reachable any other way -
	// see src/app/approveRun.ts - so the console gives the terminal up rather
	// than growing a second, weaker approval path of its own.
	const decide = useCallback(
		async (decision: "approved" | "rejected"): Promise<void> => {
			if (selectedId === null) return;
			const actor: Actor = actorFromEnvironment();
			setApproval({ kind: "working" });
			setRawMode(false);
			try {
				const record = decision === "approved" ? await approveRun(repoRoot, selectedId, actor) : await rejectRun(repoRoot, selectedId, actor);
				setApproval({ kind: "done", summary: `run ${record.runId} ${record.decision} by ${record.by}` });
			} catch (cause: unknown) {
				setApproval({ kind: "refused", message: messageOf(cause) });
			} finally {
				setRawMode(true);
			}
		},
		[repoRoot, selectedId, setRawMode],
	);

	useInput((input, key) => {
		if (input === "q") {
			exit();
			return;
		}
		if (key.escape) {
			setApproval({ kind: "prompt" });
			setScreen(screen === "dashboard" ? "dashboard" : screen === "detail" ? "dashboard" : "detail");
			return;
		}
		if (screen === "dashboard") {
			handleDashboardKey(input, key, { dashboard, selectedIndex, setSelectedIndex, setScreen });
			return;
		}
		if (screen === "approve") {
			if (input === "y") void decide("approved");
			if (input === "n") void decide("rejected");
			return;
		}
		if (screen === "detail") {
			if (input === "v") setScreen("events");
			if (input === "d") setScreen("diff");
			if (input === "t") setScreen("tests");
			if (input === "r") setScreen("risk");
			if (input === "a") {
				setApproval({ kind: "prompt" });
				setScreen("approve");
			}
		}
	});

	return (
		<Box flexDirection="column">
			{error !== null ? <ErrorPanel message={error} /> : null}
			<Body
				screen={screen}
				dashboard={dashboard}
				detail={detail}
				patch={patch}
				approval={approval}
				selectedIndex={selectedIndex}
			/>
			<Text> </Text>
			<Text dimColor>{HINTS[screen]}</Text>
		</Box>
	);
}

type DashboardKeyContext = {
	dashboard: DashboardModel | null;
	selectedIndex: number;
	setSelectedIndex: (index: number) => void;
	setScreen: (screen: Screen) => void;
};

function handleDashboardKey(input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean }, context: DashboardKeyContext): void {
	const count = context.dashboard?.runs.length ?? 0;
	if (key.upArrow || input === "k") context.setSelectedIndex(Math.max(0, context.selectedIndex - 1));
	if (key.downArrow || input === "j") context.setSelectedIndex(Math.min(count - 1, context.selectedIndex + 1));
	if (key.return && count > 0) context.setScreen("detail");
}

type BodyProps = {
	screen: Screen;
	dashboard: DashboardModel | null;
	detail: RunDetailModel | null;
	patch: string | null;
	approval: ApprovalStatus;
	selectedIndex: number;
};

function Body({ screen, dashboard, detail, patch, approval, selectedIndex }: BodyProps): React.ReactElement {
	if (screen === "dashboard") {
		return dashboard === null ? <Loading /> : <Dashboard model={dashboard} selectedIndex={selectedIndex} />;
	}
	if (detail === null) return <Loading />;
	if (screen === "detail") return <RunDetail model={detail} />;
	if (screen === "events") return <Events model={detail} />;
	if (screen === "risk") return <Risk model={detail} />;
	if (screen === "tests") return <Tests model={detail} />;
	if (screen === "approve") return <Approve model={detail} status={approval} />;
	return patch === null ? <Loading /> : <Diff patch={patch} />;
}

function Loading(): React.ReactElement {
	return <Text dimColor>loading...</Text>;
}

function ErrorPanel({ message }: { message: string }): React.ReactElement {
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
			<Text color="red" bold>
				error
			</Text>
			<Text>{message}</Text>
		</Box>
	);
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
