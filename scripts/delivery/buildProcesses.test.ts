import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

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
            productionDeliveryGzipBytes: number;
            productionDeliveryRawBytes: number;
            status: string;
            webGzipBytes: number;
            webRawBytes: number;
            workerGzipBytes: number;
            workerRawBytes: number;
        };
        const directoryEntries = await readdir(outputDirectory);
        const files = directoryEntries.toSorted();
        const [databaseMaintenance, openClawHeartbeat, productionDelivery, web, worker] =
            await Promise.all([
                readFile(path.join(outputDirectory, "databaseMaintenance.js"), "utf8"),
                readFile(path.join(outputDirectory, "openClawHeartbeat.js"), "utf8"),
                readFile(path.join(outputDirectory, "productionDelivery.js"), "utf8"),
                readFile(path.join(outputDirectory, "web.js"), "utf8"),
                readFile(path.join(outputDirectory, "worker.js"), "utf8"),
            ]);

        expect(execution).toMatchObject({ exitCode: 0, stderr: "" });
        expect(files).toEqual([
            "databaseMaintenance.js",
            "openClawHeartbeat.js",
            "productionDelivery.js",
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
        expect(result.openClawHeartbeatGzipBytes).toBeGreaterThan(0);
        expect(result.openClawHeartbeatRawBytes).toBeGreaterThan(
            result.openClawHeartbeatGzipBytes
        );
        expect(result.webGzipBytes).toBeGreaterThan(0);
        expect(result.workerGzipBytes).toBeGreaterThan(0);
        expect(result.webRawBytes).toBeGreaterThan(result.webGzipBytes);
        expect(result.workerRawBytes).toBeGreaterThan(result.workerGzipBytes);
        expect(web).toContain("Mira Dashboard web startup failed");
        expect(databaseMaintenance).toContain("Dashboard database maintenance failed");
        expect(productionDelivery).toContain("Production Delivery executor failed");
        expect(openClawHeartbeat).toContain("OpenClaw heartbeat automation failed");
        expect(worker).toContain("Mira Dashboard worker startup failed");
        expect(web).not.toContain("sourceMappingURL");
        expect(databaseMaintenance).not.toContain("sourceMappingURL");
        expect(openClawHeartbeat).not.toContain("sourceMappingURL");
        expect(productionDelivery).not.toContain("sourceMappingURL");
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
