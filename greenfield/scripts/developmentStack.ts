import path from "node:path";

import {
    runDevelopmentStack,
    runManagedPreviewStackWithPreparedState,
} from "./development/developmentRuntime.ts";
import {
    type DevelopmentStackConfig,
    resolveDevelopmentStackConfig as resolveForRoot,
    resolveManagedPreviewStackConfig,
} from "./development/developmentStackConfig.ts";
import {
    openPreparedDevelopmentRuntimeState,
    prepareDevelopmentState,
    resetDevelopmentDatabase,
    resetDevelopmentState,
} from "./development/developmentState.ts";

export type { DevelopmentStackConfig } from "./development/developmentStackConfig.ts";
export {
    runDevelopmentStack,
    runDevelopmentStackWithPreparedState,
} from "./development/developmentRuntime.ts";
export {
    prepareDevelopmentState,
    prepareDevelopmentRuntimeState,
    resetDevelopmentDatabase,
    resetDevelopmentState,
} from "./development/developmentState.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");

/**
 * Resolves development configuration for this self-contained repository root.
 * @param environment Raw configuration environment.
 * @param root Absolute source root to develop.
 * @returns Validated immutable development stack configuration.
 */
export function resolveDevelopmentStackConfig(
    environment: Readonly<Record<string, string | undefined>> = process.env,
    root = repositoryRoot
): DevelopmentStackConfig {
    return resolveForRoot(environment, root);
}

async function main(): Promise<number> {
    const [command] = Bun.argv.slice(2);
    if (command === "--managed-preview") {
        const [, expectedHeadSha] = Bun.argv.slice(2);
        if (expectedHeadSha === undefined) {
            throw new TypeError(
                "Usage: developmentStack.ts --managed-preview <expected-head-sha>"
            );
        }
        const config = resolveManagedPreviewStackConfig(process.env, repositoryRoot);
        const stateSession = await openPreparedDevelopmentRuntimeState(config);
        try {
            return await runManagedPreviewStackWithPreparedState(
                config,
                stateSession,
                expectedHeadSha,
                config.gatewaySocket
            );
        } finally {
            await stateSession.release();
        }
    }
    const config = resolveDevelopmentStackConfig();
    if (command === "--prepare-state") {
        const state = await prepareDevelopmentState(config);
        process.stdout.write(
            `${JSON.stringify({ database: state.database, stateRoot: config.stateRoot })}\n`
        );
        return 0;
    }
    if (command === "--reset-state") {
        await resetDevelopmentState(config);
        process.stdout.write(`Removed marked development state: ${config.stateRoot}\n`);
        return 0;
    }
    if (command === "--reset-database") {
        const removed = await resetDevelopmentDatabase(config);
        process.stdout.write(
            `${
                removed
                    ? `Removed development database: ${config.databasePath}`
                    : `No existing development database: ${config.databasePath}`
            }\n`
        );
        return 0;
    }
    if (command !== undefined) {
        throw new TypeError(
            "Usage: developmentStack.ts [--managed-preview <sha>|--prepare-state|--reset-database|--reset-state]"
        );
    }
    return runDevelopmentStack(config);
}

if (import.meta.main) {
    try {
        process.exitCode = await main();
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? error.message : "Development stack failed"}\n`
        );
        process.exitCode = 1;
    }
}
