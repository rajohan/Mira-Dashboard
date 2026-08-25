import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { measureProcessArtifact } from "./buildProcesses.ts";
import { maximumProductionProvisioningBundleBytes } from "./provisioning/host-operations/policy.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const scriptPath = path.join(import.meta.dir, "buildProcesses.ts");
const outputDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        outputDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function runBuild(outputDirectory: string) {
    const child = Bun.spawn(
        [process.execPath, scriptPath, `--output=${outputDirectory}`],
        {
            cwd: repositoryRoot,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
        }
    );
    const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
    ]);
    return { exitCode, stderr, stdout };
}

describe("Dashboard process artifacts", () => {
    test("rejects a compressible provisioning bundle above the raw installer limit", async () => {
        const outputDirectory = path.join(
            repositoryRoot,
            `dist/test-process-budget-${Bun.randomUUIDv7()}`
        );
        outputDirectories.push(outputDirectory);
        await mkdir(path.dirname(outputDirectory), { recursive: true });
        await writeFile(
            outputDirectory,
            new Uint8Array(maximumProductionProvisioningBundleBytes + 1)
        );

        expect(
            measureProcessArtifact(
                outputDirectory,
                2 * 1024 * 1024,
                maximumProductionProvisioningBundleBytes,
                "production-provisioning"
            )
        ).rejects.toThrow(
            "Dashboard production-provisioning process bundle exceeds its byte budget"
        );
    });

    test("bundles only reviewed executable roots without source maps", async () => {
        const outputDirectory = path.join(
            repositoryRoot,
            `dist/test-processes-${Bun.randomUUIDv7()}`
        );
        outputDirectories.push(outputDirectory);

        const execution = await runBuild(outputDirectory);
        const result = JSON.parse(execution.stdout) as {
            databaseMaintenanceGzipBytes: number;
            databaseMaintenanceRawBytes: number;
            openClawHeartbeatGzipBytes: number;
            openClawHeartbeatRawBytes: number;
            outputDirectory: string;
            prepareProductionStateGzipBytes: number;
            prepareProductionStateRawBytes: number;
            productionDeliveryGzipBytes: number;
            productionDeliveryRawBytes: number;
            productionProvisioningGzipBytes: number;
            productionProvisioningRawBytes: number;
            status: string;
            webGzipBytes: number;
            webRawBytes: number;
            workerGzipBytes: number;
            workerRawBytes: number;
        };
        const directoryEntries = await readdir(outputDirectory);
        const files = directoryEntries.toSorted();
        const [
            databaseMaintenance,
            openClawHeartbeat,
            prepareProductionState,
            productionDelivery,
            productionProvisioning,
            web,
            worker,
        ] = await Promise.all([
            readFile(path.join(outputDirectory, "databaseMaintenance.js"), "utf8"),
            readFile(path.join(outputDirectory, "openClawHeartbeat.js"), "utf8"),
            readFile(path.join(outputDirectory, "prepareProductionState.js"), "utf8"),
            readFile(path.join(outputDirectory, "productionDelivery.js"), "utf8"),
            readFile(path.join(outputDirectory, "productionProvisioning.js"), "utf8"),
            readFile(path.join(outputDirectory, "web.js"), "utf8"),
            readFile(path.join(outputDirectory, "worker.js"), "utf8"),
        ]);

        expect(execution).toMatchObject({ exitCode: 0, stderr: "" });
        expect(files).toEqual([
            "databaseMaintenance.js",
            "openClawHeartbeat.js",
            "prepareProductionState.js",
            "productionDelivery.js",
            "productionProvisioning.js",
            "web.js",
            "worker.js",
        ]);
        expect(result).toMatchObject({ outputDirectory, status: "BUILT" });
        expect(result.databaseMaintenanceGzipBytes).toBeGreaterThan(0);
        expect(result.databaseMaintenanceRawBytes).toBeGreaterThan(
            result.databaseMaintenanceGzipBytes
        );
        expect(result.productionDeliveryGzipBytes).toBeGreaterThan(0);
        expect(result.productionDeliveryRawBytes).toBeGreaterThan(
            result.productionDeliveryGzipBytes
        );
        expect(result.productionProvisioningGzipBytes).toBeGreaterThan(0);
        expect(result.productionProvisioningRawBytes).toBeGreaterThan(
            result.productionProvisioningGzipBytes
        );
        expect(result.openClawHeartbeatGzipBytes).toBeGreaterThan(0);
        expect(result.openClawHeartbeatRawBytes).toBeGreaterThan(
            result.openClawHeartbeatGzipBytes
        );
        expect(result.prepareProductionStateGzipBytes).toBeGreaterThan(0);
        expect(result.prepareProductionStateRawBytes).toBeGreaterThan(
            result.prepareProductionStateGzipBytes
        );
        expect(result.webGzipBytes).toBeGreaterThan(0);
        expect(result.workerGzipBytes).toBeGreaterThan(0);
        expect(result.webRawBytes).toBeGreaterThan(result.webGzipBytes);
        expect(result.workerRawBytes).toBeGreaterThan(result.workerGzipBytes);
        expect(web).toContain("Mira Dashboard web startup failed");
        expect(databaseMaintenance).toContain("Dashboard database maintenance failed");
        expect(productionDelivery).toContain("Production Delivery executor failed");
        expect(productionProvisioning).toContain(
            "Production release provisioning failed"
        );
        expect(openClawHeartbeat).toContain("OpenClaw heartbeat automation failed");
        expect(prepareProductionState).toContain("Production state preparation failed");
        expect(worker).toContain("Mira Dashboard worker startup failed");
        expect(web).not.toContain("sourceMappingURL");
        expect(databaseMaintenance).not.toContain("sourceMappingURL");
        expect(openClawHeartbeat).not.toContain("sourceMappingURL");
        expect(prepareProductionState).not.toContain("sourceMappingURL");
        expect(productionDelivery).not.toContain("sourceMappingURL");
        expect(productionProvisioning).not.toContain("sourceMappingURL");
        expect(worker).not.toContain("sourceMappingURL");
        expect(worker).not.toContain("openclaw-heartbeat.token");
    }, 60_000);

    test("rejects output outside the repository dist boundary", async () => {
        const execution = await runBuild(path.join(repositoryRoot, "build"));

        expect(execution.exitCode).toBe(1);
        expect(execution.stdout).toBe("");
        expect(execution.stderr).toBe("Process build paths are invalid\n");
    });
});
