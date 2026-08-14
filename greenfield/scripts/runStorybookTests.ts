import path from "node:path";

import { runTestProcess } from "./runTestSuite.ts";

/**
 * @param projectRoot Repository root containing the pinned Vitest executable.
 * @returns The pinned real-browser Storybook test command.
 */
export function createStorybookTestCommand(projectRoot: string): readonly string[] {
    return [
        path.join(projectRoot, "node_modules", ".bin", "vitest"),
        "run",
        "--config",
        ".storybook/vitest.config.ts",
        "--project=storybook",
        "--maxWorkers=3",
    ];
}

/**
 * Runs Storybook in three isolated Chromium workers behind the repository output policy.
 * @param projectRoot Repository root containing the pinned Vitest executable.
 * @param command Optional exact command used by focused runner tests.
 * @returns The child failure code, or one for forbidden otherwise-green output.
 */
export async function runStorybookTests(
    projectRoot = path.resolve(import.meta.dir, ".."),
    command = createStorybookTestCommand(projectRoot)
): Promise<number> {
    return runTestProcess(command, projectRoot);
}

if (import.meta.main) {
    process.exitCode = await runStorybookTests();
}
