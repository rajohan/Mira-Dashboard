import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage = "Usage: bun run preflight [--parallel]";

/** Exact unchanged-candidate gate sequence required before a production rehearsal. */
export const productionPreflightCommands = Object.freeze([
    Object.freeze([process.execPath, "install", "--frozen-lockfile"]),
    Object.freeze([process.execPath, "audit"]),
    Object.freeze([process.execPath, "run", "check"]),
    Object.freeze([process.execPath, "run", "test", "coverage"]),
    Object.freeze([process.execPath, "run", "build", "storybook"]),
    Object.freeze([process.execPath, "run", "build", "release"]),
]);

export async function runProductionPreflight(
    arguments_: readonly string[],
    root = projectRoot,
    run: (command: readonly string[]) => Promise<number> = (command) =>
        runCommandProcess(
            { name: command.join(" "), arguments: command },
            { cwd: root, environment: { ...process.env, CI: "1" } }
        )
): Promise<number> {
    const parallel = arguments_.length === 1 && arguments_[0] === "--parallel";
    if (arguments_.length > 0 && !parallel) throw new TypeError(usage);
    if (parallel) {
        const installation = await run(productionPreflightCommands[0]!);
        if (installation !== 0) return installation;
        for (const commandPair of [
            productionPreflightCommands.slice(1, 3),
            productionPreflightCommands.slice(3, 5),
        ]) {
            const results = await Promise.all(commandPair.map((command) => run(command)));
            const failure = results.find((result) => result !== 0);
            if (failure !== undefined) return failure;
        }
        const release = await run(productionPreflightCommands[5]!);
        if (release !== 0) return release;
        process.stdout.write("Production preflight passed.\n");
        return 0;
    }
    for (const command of productionPreflightCommands) {
        const result = await run(command);
        if (result !== 0) return result;
    }
    process.stdout.write("Production preflight passed.\n");
    return 0;
}

if (import.meta.main) {
    try {
        process.exitCode = await runProductionPreflight(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
