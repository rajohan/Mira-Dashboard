import path from "node:path";

import {
    prepareProtectedProductionStatePath,
    type PreparedProductionStatePaths,
} from "./productionStateFilesystem.ts";

const usage =
    "Usage: bun run delivery:prepare-state --project-root=/absolute/dashboard/project/root";

/** Explicit state-preparation operation parsed from the delivery CLI. */
export interface PrepareProductionStateCliArguments {
    readonly projectRoot: string;
}

/** Project-state preparation boundary injected by focused CLI tests. */
export type PrepareProductionState = (
    projectRoot: string
) => Promise<PreparedProductionStatePaths>;

function readProjectRoot(argument: string | undefined): string {
    const prefix = "--project-root=";
    const value = argument?.startsWith(prefix) ? argument.slice(prefix.length) : "";
    if (
        !value ||
        value.includes("\0") ||
        !path.isAbsolute(value) ||
        path.resolve(value) !== value ||
        path.parse(value).root === value
    ) {
        throw new TypeError(usage);
    }
    return value;
}

/**
 * Parses the single deliberately explicit state-preparation option.
 * @param arguments_ Arguments after the Bun entrypoint.
 * @returns Validated absolute project root.
 */
export function parsePrepareProductionStateCliArguments(
    arguments_: readonly string[]
): PrepareProductionStateCliArguments {
    if (arguments_.length !== 1) throw new TypeError(usage);
    return Object.freeze({ projectRoot: readProjectRoot(arguments_[0]) });
}

/**
 * Prepares project-local production state before release activation or runtime startup.
 * The web and worker processes intentionally have no access to this repair boundary.
 * @param arguments_ Arguments after the Bun entrypoint.
 * @param prepare Injected state-preparation boundary.
 * @returns Fixed safe status metadata.
 */
export async function runPrepareProductionStateCli(
    arguments_: readonly string[],
    prepare: PrepareProductionState = prepareProtectedProductionStatePath
): Promise<Readonly<{ status: "PREPARED" }>> {
    const { projectRoot } = parsePrepareProductionStateCliArguments(arguments_);
    await prepare(projectRoot);
    return Object.freeze({ status: "PREPARED" });
}

if (import.meta.main) {
    try {
        const result = await runPrepareProductionStateCli(Bun.argv.slice(2));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        const message =
            error instanceof TypeError
                ? error.message
                : "Production state preparation failed";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
