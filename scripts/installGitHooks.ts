import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");

/**
 * Selects the committed hook wrappers relative to the current Git worktree.
 * @param root Dashboard repository root.
 * @returns Git configuration process exit code.
 */
export async function installGitHooks(root = projectRoot): Promise<number> {
    const prefixProcess = Bun.spawn(["git", "-C", root, "rev-parse", "--show-prefix"], {
        stdout: "pipe",
        stderr: "inherit",
    });
    const prefixOutput = await new Response(prefixProcess.stdout).text();
    const prefix = prefixOutput.trim();
    const prefixResult = await prefixProcess.exited;
    if (prefixResult !== 0) return prefixResult;
    return runCommandProcess(
        {
            name: "install Git hooks",
            arguments: [
                "git",
                "-C",
                root,
                "config",
                "--local",
                "core.hooksPath",
                `${prefix}.githooks`,
            ],
        },
        { cwd: root, environment: process.env }
    );
}

if (import.meta.main) process.exitCode = await installGitHooks();
