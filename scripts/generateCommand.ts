import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage = "Usage: bun run generate <docs|database>";

export function parseGenerateCommandArguments(
    arguments_: readonly string[]
): readonly string[] {
    const [command, ...rest] = arguments_;
    if (rest.length > 0) throw new TypeError(usage);
    if (command === "docs") {
        return Object.freeze([process.execPath, "scripts/generateDocs.ts"]);
    }
    if (command === "database") {
        return Object.freeze([
            path.join(projectRoot, "node_modules", ".bin", "drizzle-kit"),
            "generate",
            "--config",
            "drizzle.config.ts",
            "--output",
            "json",
        ]);
    }
    throw new TypeError(usage);
}

export async function runGenerateCommand(
    arguments_: readonly string[],
    root = projectRoot
): Promise<number> {
    return runCommandProcess(
        { name: "generate", arguments: parseGenerateCommandArguments(arguments_) },
        { cwd: root, environment: process.env }
    );
}

if (import.meta.main) {
    try {
        process.exitCode = await runGenerateCommand(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
