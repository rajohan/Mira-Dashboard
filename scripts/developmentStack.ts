import path from "node:path";

import {
    type DevelopmentStackConfig as StackConfig,
    prepareDevelopmentState as prepareState,
    resetDevelopmentState as resetState,
    resolveDevelopmentStackConfig as resolveDevelopmentStackConfigForRoot,
    runDevelopmentStack as runStack,
} from "../backend/src/development/developmentStack.ts";

export type {
    DevelopmentStackConfig,
    DevelopmentStateResult,
} from "../backend/src/development/developmentStack.ts";
export {
    developmentBackendEnvironment,
    prepareDevelopmentState,
    resetDevelopmentState,
    runDevelopmentStack,
} from "../backend/src/development/developmentStack.ts";

const repoRoot = path.resolve(import.meta.dir, "..");

/**
 * Resolves the development stack for this repository unless a test root is supplied.
 * @returns Resolved the development stack for this repository unless a test root is supplied.
 */
export function resolveDevelopmentStackConfig(
    environment: Record<string, string | undefined> = process.env,
    root = repoRoot
): StackConfig {
    return resolveDevelopmentStackConfigForRoot(environment, root);
}

async function main(): Promise<number> {
    const config = resolveDevelopmentStackConfig();
    const [command] = Bun.argv.slice(2);
    if (command === "--prepare-state") {
        const result = prepareState(config);
        console.log(JSON.stringify({ ...result, stateRoot: config.stateRoot }));
        return 0;
    }
    if (command === "--reset-state") {
        resetState(config);
        console.log(`Removed development state: ${config.stateRoot}`);
        return 0;
    }
    if (command) {
        throw new TypeError("Usage: developmentStack.ts [--prepare-state|--reset-state]");
    }
    return runStack(config);
}

if (import.meta.main) {
    try {
        process.exitCode = await main();
    } catch (error) {
        console.error(
            error instanceof Error ? error.message : "Development stack failed"
        );
        process.exitCode = 1;
    }
}
