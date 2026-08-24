import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");

export interface GitHookInstallationDependencies {
    readonly run: (root: string) => Promise<number>;
}

function defaultDependencies(): GitHookInstallationDependencies {
    return {
        run: (root) =>
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
                        ".githooks",
                    ],
                },
                { cwd: root, environment: process.env }
            ),
    };
}

/**
 * Selects the committed hook wrappers at the Dashboard repository root.
 * @param root Dashboard repository root.
 * @param dependencies Injectable Git process boundaries.
 * @returns Git configuration process exit code.
 */
export async function installGitHooks(
    root = projectRoot,
    dependencies = defaultDependencies()
): Promise<number> {
    return dependencies.run(root);
}

if (import.meta.main) process.exitCode = await installGitHooks();
