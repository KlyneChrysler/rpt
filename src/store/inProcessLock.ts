// Per-key queue serializing same-process callers. Only one in-process caller ever
// attempts a cross-process file lock at a time, so proper-lockfile underneath only
// has to arbitrate against a genuinely separate process, not against itself.
const queues = new Map<string, Promise<unknown>>();

export function withInProcessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const settled = previous.then(fn, fn);
	queues.set(key, settled.catch(() => undefined));
	return settled;
}
