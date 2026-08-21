import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage = "Usage: bun run storybook [dev|build]";

export function parseStorybookCommandArguments(
    arguments_: readonly string[]
): readonly string[] {
    const [command = "dev", ...rest] = arguments_;
    if (rest.length > 0 || (command !== "dev" && command !== "build")) {
        throw new TypeError(usage);
    }
    return Object.freeze([
        path.join(
            projectRoot,
            "node_modules",
            "storybook",
            "dist",
            "bin",
            "dispatcher.js"
        ),
        command,
        ...(command === "dev"
            ? ["--port", "6006", "--no-open", "--disable-telemetry"]
            : [
                  "--output-dir",
                  "dist/storybook",
                  "--test",
                  "--quiet",
                  "--disable-telemetry",
              ]),
    ]);
}

export async function runStorybookCommand(
    arguments_: readonly string[],
    root = projectRoot
): Promise<number> {
    return runCommandProcess(
        {
            name: "storybook",
            arguments: [process.execPath, ...parseStorybookCommandArguments(arguments_)],
        },
        { cwd: root, environment: process.env }
    );
}

if (import.meta.main) {
    try {
        process.exitCode = await runStorybookCommand(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
