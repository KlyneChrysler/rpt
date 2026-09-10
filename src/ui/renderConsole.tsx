import { render, type RenderOptions } from "ink";
import React from "react";
import { App } from "./App.js";

// The one entry point the CLI needs. Kept here rather than in src/cli so that
// swapping the console for another surface changes this directory and nothing
// above it.
//
// `streams` exists so this adapter is testable at all: ink's render binds to
// the real process streams by default, and a four-line function nobody can
// exercise is a four-line function nobody notices breaking. Production passes
// nothing and gets the real terminal.
export async function renderConsole(repoRoot: string, streams: RenderOptions = {}): Promise<void> {
	await render(<App repoRoot={repoRoot} />, streams).waitUntilExit();
}
