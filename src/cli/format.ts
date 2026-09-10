export type OutputFormat = "text" | "json" | "agent";

// Re-exported rather than reimplemented: the Ink console renders the same two
// values from the same domain helper, and a second copy here is how the two
// surfaces come to disagree about how long a run took.
export { formatDuration, formatOffset } from "../domain/duration.js";
