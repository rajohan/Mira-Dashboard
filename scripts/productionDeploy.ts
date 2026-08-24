import { deployProduction } from "./productionBootstrap.ts";

interface ProductionDeployDependencies {
    readonly deploy: () => Promise<void>;
    readonly writeError: (message: string) => void;
    readonly writeOutput: (message: string) => void;
}

const defaultDependencies: ProductionDeployDependencies = {
    deploy: deployProduction,
    writeError: (message) => process.stderr.write(message),
    writeOutput: (message) => process.stdout.write(message),
};

/**
 * Runs the production deploy command with injectable process boundaries.
 *
 * @param dependencies - Deploy and output boundaries.
 * @returns The process exit code.
 */
export async function runProductionDeploy(
    dependencies: ProductionDeployDependencies = defaultDependencies
): Promise<number> {
    try {
        await dependencies.deploy();
        dependencies.writeOutput("Production deploy complete.\n");
        return 0;
    } catch (error) {
        dependencies.writeError(
            `${error instanceof Error ? error.message : "Production deploy failed"}\n`
        );
        return 1;
    }
}

if (import.meta.main) {
    process.exitCode = await runProductionDeploy();
}
