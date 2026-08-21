import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";
import { ensurePlaywrightChromium } from "./playwrightBrowser.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage =
    "Usage: bun run test [all|browser|bun|storybook|coverage|timings] [browser|bun|storybook|merge]";

export interface TestCommandArguments {
    readonly command: "all" | "browser" | "bun" | "coverage" | "storybook" | "timings";
    readonly partition?: "browser" | "bun" | "merge" | "storybook";
}

export function parseTestCommandArguments(
    arguments_: readonly string[]
): TestCommandArguments {
    const [command = "all", partition, ...rest] = arguments_;
    const commands = ["all", "browser", "bun", "coverage", "storybook", "timings"];
    const partitions = ["browser", "bun", "merge", "storybook"];
    const requiresPartition = command === "timings";
    if (
        !commands.includes(command) ||
        rest.length > 0 ||
        (partition !== undefined && !partitions.includes(partition)) ||
        (requiresPartition && (partition === undefined || partition === "merge")) ||
        (!requiresPartition && command !== "coverage" && partition !== undefined)
    ) {
        throw new TypeError(usage);
    }
    return Object.freeze({
        command: command as TestCommandArguments["command"],
        partition: partition as TestCommandArguments["partition"],
    });
}

function commandArguments(parsed: TestCommandArguments): readonly string[] {
    switch (parsed.command) {
        case "browser":
        case "bun": {
            return [process.execPath, "scripts/runBatchedTestSuite.ts", parsed.command];
        }
        case "storybook": {
            return [process.execPath, "scripts/runStorybookTests.ts"];
        }
        case "coverage": {
            let option: readonly string[] = [];
            if (parsed.partition === "merge") option = ["--merge"];
            else if (parsed.partition !== undefined) {
                option = [`--partition=${parsed.partition}`];
            }
            return [process.execPath, "scripts/runCoverage.ts", ...option];
        }
        case "timings": {
            if (parsed.partition === "storybook") {
                return [
                    process.execPath,
                    "scripts/runStorybookTests.ts",
                    "--update-timings",
                ];
            }
            return [
                process.execPath,
                "scripts/runBatchedTestSuite.ts",
                parsed.partition!,
                "--update-timings",
            ];
        }
        case "all": {
            throw new TypeError("The complete test plan contains multiple commands");
        }
    }
}

export async function runTestCommand(
    arguments_: readonly string[],
    root = projectRoot
): Promise<number> {
    const parsed = parseTestCommandArguments(arguments_);
    if (parsed.command === "all") {
        for (const command of ["bun", "browser", "storybook"] as const) {
            const result = await runTestCommand([command], root);
            if (result !== 0) return result;
        }
        return 0;
    }
    if (
        parsed.command === "storybook" ||
        (parsed.command === "coverage" &&
            parsed.partition !== "bun" &&
            parsed.partition !== "browser" &&
            parsed.partition !== "merge") ||
        (parsed.command === "coverage" && parsed.partition === undefined)
    ) {
        const installResult = await ensurePlaywrightChromium(root);
        if (installResult !== 0) return installResult;
    }
    return runCommandProcess(
        {
            name: `test:${parsed.command}`,
            arguments: commandArguments(parsed),
            environment:
                parsed.command === "storybook" || parsed.command === "coverage"
                    ? { PLAYWRIGHT_BROWSERS_PATH: "node_modules/.cache/playwright" }
                    : undefined,
        },
        { cwd: root, environment: process.env }
    );
}

if (import.meta.main) {
    try {
        process.exitCode = await runTestCommand(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
