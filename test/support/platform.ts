import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

// npm writes two launchers into node_modules/.bin on Windows: an extensionless
// shell script for Git Bash and a .cmd for cmd.exe. Node's spawn resolves
// neither by name, so a bare "tsc" is ENOENT there and every suite that builds
// before it runs dies in beforeAll rather than failing a test.
export function binOf(name: string): string {
	return join(projectRoot, "node_modules", ".bin", IS_WINDOWS ? `${name}.cmd` : name);
}

// Building the CLI is a precondition of every suite that drives the real
// binary, and it is the same build every time.
export function buildCli(): void {
	execFileSync(binOf("tsc"), ["-p", join(projectRoot, "tsconfig.json")], { shell: IS_WINDOWS });
}

export const cliPath = join(projectRoot, "dist", "cli", "index.js");
