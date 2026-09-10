import { render } from "ink";
import React from "react";
import { App } from "./App.js";

// The one entry point the CLI needs. Kept here rather than in src/cli so that
// swapping the console for another surface changes this directory and nothing
// above it.
export async function renderConsole(repoRoot: string): Promise<void> {
	await render(<App repoRoot={repoRoot} />).waitUntilExit();
}
