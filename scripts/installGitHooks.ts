import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");

export interface GitHookInstallationDependencies {
    readonly readPrefix: (root: string) => Promise<readonly [number, string]>;
    readonly run: (root: string, hooksPath: string) => Promise<number>;
}

function defaultDependencies(): GitHookInstallationDependencies {
    return {
        readPrefix: async (root) => {
            const process = Bun.spawn(["git", "-C", root, "rev-parse", "--show-prefix"], {
                stdout: "pipe",
                stderr: "inherit",
            });
            const output = await new Response(process.stdout).text();
            return [await process.exited, output.trim()];
        },
        run: (root, hooksPath) =>
            runCommandProcess(
                {
                    name: "install Git hooks",
                    arguments: [
                        "git",
                        "-C",
                        root,
                        "config",
                        "--local",
                        "core.hooksPath",
                        hooksPath,
                    ],
                },
                { cwd: root, environment: process.env }
            ),
    };
}

/**
 * Selects the committed hook wrappers relative to the current Git worktree.
 * @param root Dashboard repository root.
 * @param dependencies Injectable Git process boundaries.
 * @returns Git configuration process exit code.
 */
export async function installGitHooks(
    root = projectRoot,
    dependencies = defaultDependencies()
): Promise<number> {
    const [prefixResult, prefix] = await dependencies.readPrefix(root);
    if (prefixResult !== 0) return prefixResult;
    return dependencies.run(root, `${prefix}.githooks`);
}

if (import.meta.main) process.exitCode = await installGitHooks();
