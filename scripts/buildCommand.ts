import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage = "Usage: bun run build <browser|processes|release|storybook>";

export function parseBuildCommandArguments(
    arguments_: readonly string[]
): readonly string[] {
    const [command, ...rest] = arguments_;
    if (rest.length > 0) throw new TypeError(usage);
    const argumentsByCommand = {
        browser: [process.execPath, "scripts/delivery/buildBrowser.ts"],
        processes: [process.execPath, "scripts/delivery/buildProcesses.ts"],
        release: [process.execPath, "scripts/delivery/buildRelease.ts"],
        storybook: [process.execPath, "scripts/storybookCommand.ts", "build"],
    } as const;
    if (command === undefined || !(command in argumentsByCommand)) {
        throw new TypeError(usage);
    }
    return Object.freeze([
        ...argumentsByCommand[command as keyof typeof argumentsByCommand],
    ]);
}

export async function runBuildCommand(
    arguments_: readonly string[],
    root = projectRoot
): Promise<number> {
    return runCommandProcess(
        { name: "build", arguments: parseBuildCommandArguments(arguments_) },
        { cwd: root, environment: process.env }
    );
}

if (import.meta.main) {
    try {
        process.exitCode = await runBuildCommand(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
