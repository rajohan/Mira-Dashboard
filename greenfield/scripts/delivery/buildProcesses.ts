import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { withBunBuildAdmission } from "./buildAdmission.ts";
import { parseBuildOutputArgument } from "./buildCli.ts";
import { resolveRepositoryBuildPath } from "./buildPaths.ts";

const webEntrypoint = "src/app/dashboardServer.ts";
const workerEntrypoint = "src/app/worker.ts";
const databaseMaintenanceEntrypoint = "src/app/databaseMaintenance.ts";
const productionDeliveryEntrypoint = "scripts/delivery/productionDeliveryExecutor.ts";
const maximumDatabaseMaintenanceGzipBytes = 2 * 1024 * 1024;
const maximumProductionDeliveryGzipBytes = 2 * 1024 * 1024;
const maximumWebGzipBytes = 4 * 1024 * 1024;
const maximumWorkerGzipBytes = 2 * 1024 * 1024;

/** Deterministic bundled process measurements used by release verification. */
export interface ProcessBuildResult {
    readonly databaseMaintenance: Readonly<{
        gzipBytes: number;
        rawBytes: number;
    }>;
    readonly outputDirectory: string;
    readonly productionDelivery: Readonly<{
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
    role: "database-maintenance" | "production-delivery" | "web" | "worker"
): Promise<Readonly<{ gzipBytes: number; rawBytes: number }>> {
    const contents = await readFile(filePath);
    const gzipBytes = gzipSync(contents, { level: 9 }).byteLength;
    if (contents.byteLength === 0 || gzipBytes > maximumGzipBytes) {
        throw new Error(`Dashboard ${role} process bundle exceeds its byte budget`);
    }
    return Object.freeze({ gzipBytes, rawBytes: contents.byteLength });
}

/**
 * Bundles the exact executable web and worker roots for the selected Bun runtime.
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
            emittedNames.length !== 4 ||
            emittedNames[0] !== "dashboardServer.js" ||
            emittedNames[1] !== "databaseMaintenance.js" ||
            emittedNames[2] !== "productionDeliveryExecutor.js" ||
            emittedNames[3] !== "worker.js"
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
        const [databaseMaintenance, productionDelivery, web, worker] = await Promise.all([
            measurements(
                path.join(output, "databaseMaintenance.js"),
                maximumDatabaseMaintenanceGzipBytes,
                "database-maintenance"
            ),
            measurements(
                path.join(output, "productionDelivery.js"),
                maximumProductionDeliveryGzipBytes,
                "production-delivery"
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
            outputDirectory: output,
            productionDelivery,
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
                productionDeliveryGzipBytes: result.productionDelivery.gzipBytes,
                productionDeliveryRawBytes: result.productionDelivery.rawBytes,
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
