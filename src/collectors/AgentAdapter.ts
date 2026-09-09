import type { DraftEvent } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";

export interface AgentAdapter {
	readonly id: string;
	install(repoRoot: string): Promise<void>;
	uninstall(repoRoot: string): Promise<void>;
	normalize(raw: unknown): DraftEvent[];
	enrich(run: AgentRun, context: { transcriptPath: string | null }): Promise<DraftEvent[]>;
}
