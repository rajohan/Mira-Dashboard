import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage =
    "Usage: bun run delivery <prepare-state|activate|install-deploy-credential> [explicit delivery arguments]";

export function parseDeliveryCommandArguments(
    arguments_: readonly string[]
): readonly string[] {
    const [command, ...options] = arguments_;
    let entrypoint: string | undefined;
    if (command === "prepare-state") {
        entrypoint = "scripts/delivery/prepareProductionState.ts";
    } else if (command === "activate") {
        entrypoint = "scripts/delivery/activateProductionRelease.ts";
    } else if (command === "install-deploy-credential" && options.length === 0) {
        entrypoint = "scripts/installProductionDeployCredential.ts";
    }
    if (entrypoint === undefined) throw new TypeError(usage);
    return Object.freeze([process.execPath, entrypoint, ...options]);
}

export async function runDeliveryCommand(
    arguments_: readonly string[],
    root = projectRoot
): Promise<number> {
    return runCommandProcess(
        {
            name: "delivery",
            arguments: parseDeliveryCommandArguments(arguments_),
        },
        { cwd: root, environment: process.env }
    );
}

if (import.meta.main) {
    try {
        process.exitCode = await runDeliveryCommand(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
