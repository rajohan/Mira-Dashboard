import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { withBunBuildAdmission } from "./buildAdmission.ts";
import { parseBuildOutputArgument } from "./buildCli.ts";
import { resolveRepositoryBuildPath } from "./buildPaths.ts";

const webEntrypoint = "src/app/dashboardServer.ts";
const workerEntrypoint = "src/app/worker.ts";
const databaseMaintenanceEntrypoint = "src/app/databaseMaintenance.ts";
const productionDeliveryEntrypoint = "scripts/delivery/productionDeliveryExecutor.ts";
const prepareProductionStateEntrypoint = "scripts/delivery/prepareProductionState.ts";
const productionProvisioningEntrypoint =
    "scripts/delivery/productionReleaseProvisioner.ts";
const openClawHeartbeatEntrypoint = "scripts/openClawHeartbeat.ts";
const maximumDatabaseMaintenanceGzipBytes = 2 * 1024 * 1024;
const maximumProductionDeliveryGzipBytes = 2 * 1024 * 1024;
const maximumPrepareProductionStateGzipBytes = 2 * 1024 * 1024;
const maximumProductionProvisioningGzipBytes = 2 * 1024 * 1024;
const maximumOpenClawHeartbeatGzipBytes = 2 * 1024 * 1024;
const maximumWebGzipBytes = 4 * 1024 * 1024;
const maximumWorkerGzipBytes = 2 * 1024 * 1024;

/** Deterministic bundled process measurements used by release verification. */
export interface ProcessBuildResult {
    readonly databaseMaintenance: Readonly<{
        gzipBytes: number;
        rawBytes: number;
    }>;
    readonly outputDirectory: string;
    readonly openClawHeartbeat: Readonly<{
        gzipBytes: number;
        rawBytes: number;
    }>;
    readonly productionDelivery: Readonly<{
        gzipBytes: number;
        rawBytes: number;
    }>;
    readonly prepareProductionState: Readonly<{
        gzipBytes: number;
        rawBytes: number;
    }>;
    readonly productionProvisioning: Readonly<{
        gzipBytes: number;
        rawBytes: number;
    }>;
    readonly web: Readonly<{ gzipBytes: number; rawBytes: number }>;
    readonly worker: Readonly<{ gzipBytes: number; rawBytes: number }>;
}

function validatedOutputDirectory(
    repositoryRoot: string,
    outputDirectory: string
): string {
    return resolveRepositoryBuildPath(
        repositoryRoot,
        outputDirectory,
        "Process build paths are invalid"
    ).output;
}

async function measurements(
    filePath: string,
    maximumGzipBytes: number,
    role:
        | "database-maintenance"
        | "openclaw-heartbeat"
        | "production-delivery"
        | "prepare-production-state"
        | "production-provisioning"
        | "web"
        | "worker"
): Promise<Readonly<{ gzipBytes: number; rawBytes: number }>> {
    const contents = await readFile(filePath);
    const gzipBytes = Bun.gzipSync(contents, { level: 9 }).byteLength;
    if (contents.byteLength === 0 || gzipBytes > maximumGzipBytes) {
        throw new Error(`Dashboard ${role} process bundle exceeds its byte budget`);
    }
    return Object.freeze({ gzipBytes, rawBytes: contents.byteLength });
}

/**
 * Bundles every exact process and ancillary executable root for the selected Bun runtime.
 * @param repositoryRoot Canonical future-root checkout.
 * @param outputDirectory Explicit contained `dist` child.
 * @returns Bounded bundle measurements.
 */
export async function buildProcessArtifacts(
    repositoryRoot: string,
    outputDirectory: string
): Promise<ProcessBuildResult> {
    const output = validatedOutputDirectory(repositoryRoot, outputDirectory);
    return withBunBuildAdmission(repositoryRoot, async () => {
        await rm(output, { force: true, recursive: true });
        await mkdir(output, { recursive: true });

        const result = await Bun.build({
            allowUnresolved: [],
            conditions: ["production"],
            entrypoints: [
                path.join(repositoryRoot, databaseMaintenanceEntrypoint),
                path.join(repositoryRoot, productionDeliveryEntrypoint),
                path.join(repositoryRoot, prepareProductionStateEntrypoint),
                path.join(repositoryRoot, productionProvisioningEntrypoint),
                path.join(repositoryRoot, openClawHeartbeatEntrypoint),
                path.join(repositoryRoot, webEntrypoint),
                path.join(repositoryRoot, workerEntrypoint),
            ],
            format: "esm",
            metafile: true,
            minify: true,
            naming: { entry: "[name].js" },
            outdir: output,
            packages: "bundle",
            root: repositoryRoot,
            sourcemap: "none",
            splitting: false,
            target: "bun",
        });
        if (!result.success) {
            throw new AggregateError(result.logs, "Dashboard process build failed");
        }
        const emittedNames = result.outputs
            .map(({ path: outputPath }) => path.basename(outputPath))
            .toSorted();
        if (
            emittedNames.length !== 7 ||
            emittedNames[0] !== "dashboardServer.js" ||
            emittedNames[1] !== "databaseMaintenance.js" ||
            emittedNames[2] !== "openClawHeartbeat.js" ||
            emittedNames[3] !== "prepareProductionState.js" ||
            emittedNames[4] !== "productionDeliveryExecutor.js" ||
            emittedNames[5] !== "productionReleaseProvisioner.js" ||
            emittedNames[6] !== "worker.js"
        ) {
            throw new Error("Dashboard process build emitted an unexpected artifact set");
        }
        await rename(
            path.join(output, "dashboardServer.js"),
            path.join(output, "web.js")
        );
        await rename(
            path.join(output, "productionDeliveryExecutor.js"),
            path.join(output, "productionDelivery.js")
        );
        await rename(
            path.join(output, "productionReleaseProvisioner.js"),
            path.join(output, "productionProvisioning.js")
        );
        const [
            databaseMaintenance,
            openClawHeartbeat,
            prepareProductionState,
            productionDelivery,
            productionProvisioning,
            web,
            worker,
        ] = await Promise.all([
            measurements(
                path.join(output, "databaseMaintenance.js"),
                maximumDatabaseMaintenanceGzipBytes,
                "database-maintenance"
            ),
            measurements(
                path.join(output, "openClawHeartbeat.js"),
                maximumOpenClawHeartbeatGzipBytes,
                "openclaw-heartbeat"
            ),
            measurements(
                path.join(output, "prepareProductionState.js"),
                maximumPrepareProductionStateGzipBytes,
                "prepare-production-state"
            ),
            measurements(
                path.join(output, "productionDelivery.js"),
                maximumProductionDeliveryGzipBytes,
                "production-delivery"
            ),
            measurements(
                path.join(output, "productionProvisioning.js"),
                maximumProductionProvisioningGzipBytes,
                "production-provisioning"
            ),
            measurements(path.join(output, "web.js"), maximumWebGzipBytes, "web"),
            measurements(
                path.join(output, "worker.js"),
                maximumWorkerGzipBytes,
                "worker"
            ),
        ]);
        return Object.freeze({
            databaseMaintenance,
            openClawHeartbeat,
            outputDirectory: output,
            prepareProductionState,
            productionDelivery,
            productionProvisioning,
            web,
            worker,
        });
    });
}

if (import.meta.main) {
    try {
        const repositoryRoot = path.resolve(import.meta.dir, "../..");
        const result = await buildProcessArtifacts(
            repositoryRoot,
            parseBuildOutputArgument(
                process.argv.slice(2),
                path.join(repositoryRoot, "dist/processes")
            )
        );
        process.stdout.write(
            `${JSON.stringify({
                outputDirectory: result.outputDirectory,
                status: "BUILT",
                databaseMaintenanceGzipBytes: result.databaseMaintenance.gzipBytes,
                databaseMaintenanceRawBytes: result.databaseMaintenance.rawBytes,
                openClawHeartbeatGzipBytes: result.openClawHeartbeat.gzipBytes,
                openClawHeartbeatRawBytes: result.openClawHeartbeat.rawBytes,
                prepareProductionStateGzipBytes: result.prepareProductionState.gzipBytes,
                prepareProductionStateRawBytes: result.prepareProductionState.rawBytes,
                productionDeliveryGzipBytes: result.productionDelivery.gzipBytes,
                productionDeliveryRawBytes: result.productionDelivery.rawBytes,
                productionProvisioningGzipBytes: result.productionProvisioning.gzipBytes,
                productionProvisioningRawBytes: result.productionProvisioning.rawBytes,
                webGzipBytes: result.web.gzipBytes,
                webRawBytes: result.web.rawBytes,
                workerGzipBytes: result.worker.gzipBytes,
                workerRawBytes: result.worker.rawBytes,
            })}\n`
        );
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Dashboard process build failed";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
