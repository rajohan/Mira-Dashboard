import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import {
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
} from "../../shared/releaseManifest.ts";
import {
    ensureProductionDeliveryExecutor,
    launchProductionDeliveryExecutor,
    type ProductionDeliveryLaunchProcessResult,
} from "./productionDeliveryLauncher.ts";

const temporaryDirectories: string[] = [];
const executorReleaseId = "a".repeat(40);
const runtimeRevision = "b".repeat(40);
const transitionId = "019fd974-54a2-74dd-a64b-d4186f8d8801";

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await chmod(directory, 0o700).catch(() => {});
        await rm(directory, { force: true, recursive: true });
    }
});

async function fixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-delivery-launcher-"));
    temporaryDirectories.push(projectRoot);
    const releaseRoot = path.join(projectRoot, "production/releases", executorReleaseId);
    const runtimeRoot = path.join(
        projectRoot,
        "production/runtimes/bun",
        runtimeRevision
    );
    await Promise.all([
        mkdir(path.join(releaseRoot, "server"), { recursive: true }),
        mkdir(runtimeRoot, { recursive: true }),
    ]);
    const executor = path.join(releaseRoot, "server/productionDelivery.js");
    const runtime = path.join(runtimeRoot, "bun");
    const executorBytes = "executor";
    await Promise.all([
        writeFile(executor, executorBytes, { mode: 0o400 }),
        writeFile(runtime, "runtime", { mode: 0o500 }),
    ]);
    await writeFile(
        path.join(releaseRoot, "release-manifest.json"),
        `${JSON.stringify({
            artifacts: [
                {
                    bytes: Buffer.byteLength(executorBytes),
                    path: "server/productionDelivery.js",
                    sha256: new Bun.CryptoHasher("sha256")
                        .update(executorBytes)
                        .digest("hex"),
                },
            ],
            buildCommands: [...releaseBuildCommands],
            deliveryProtocols: [...releaseDeliveryProtocols],
            display: {
                builtAtMs: 1_800_000_000_000,
                commitTitle: "Test release",
                schemaTarget: 1,
            },
            documentationSha256: "c".repeat(64),
            formatVersion: 1,
            lockfileSha256: "d".repeat(64),
            migrations: [
                {
                    id: "20260804022252_dashboard-foundation",
                    migrationSha256: "e".repeat(64),
                    snapshotSha256: "f".repeat(64),
                },
            ],
            packages: [
                {
                    name: "effect",
                    scope: "dependency",
                    version: "4.0.0-beta.106",
                },
            ],
            processRoles: [...releaseProcessRoles],
            runtime: { revision: runtimeRevision, version: "1.4.0" },
            source: { commitSha: executorReleaseId, treeState: "clean" },
        })}\n`,
        { mode: 0o400 }
    );
    return {
        executor,
        options: {
            executorReleaseId,
            projectRoot,
            readinessUrl: "http://127.0.0.1:3100/api/health/ready",
            runtimeRevision,
            transitionId,
        },
        runtime,
    };
}

const success: ProductionDeliveryLaunchProcessResult = Object.freeze({
    exitCode: 0,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
});

describe("production Delivery launcher", () => {
    test("starts one fixed transient executor with an empty child environment", async () => {
        const { executor, options, runtime } = await fixture();
        let observedCommand: readonly string[] = [];
        let observedEnvironment: Readonly<Record<string, string>> = {};

        await launchProductionDeliveryExecutor(options, {
            execute: (command, environment) => {
                observedCommand = command;
                observedEnvironment = environment;
                return Promise.resolve(success);
            },
        });

        expect(observedCommand).toContain("--property=NoNewPrivileges=yes");
        expect(observedCommand).toContain("--property=ProtectHome=tmpfs");
        expect(observedCommand).toContain(`--property=BindPaths=${options.projectRoot}`);
        expect(observedCommand).toContain(
            "--property=InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/opt/docker -/tmp/openclaw"
        );
        expect(observedCommand).toContain("--property=PrivateDevices=yes");
        expect(observedCommand).toContain("/usr/bin/env");
        expect(observedCommand).toContain("-i");
        expect(observedCommand).toContain("NODE_ENV=production");
        expect(observedCommand).toContain(
            `XDG_RUNTIME_DIR=/run/user/${process.getuid?.()}`
        );
        expect(observedCommand).toContain(runtime);
        expect(observedCommand).toContain(executor);
        expect(observedCommand).toContain(`--transition=${transitionId}`);
        expect(Object.keys(observedEnvironment).toSorted()).toEqual([
            "DBUS_SESSION_BUS_ADDRESS",
            "LANG",
            "PATH",
            "XDG_RUNTIME_DIR",
        ]);
        expect(JSON.stringify(observedCommand)).not.toContain("TOKEN");
        expect(JSON.stringify(observedEnvironment)).not.toContain("TOKEN");
    });

    test("fails closed on mutable artifacts and process diagnostics", async () => {
        const fixture_ = await fixture();
        await chmod(fixture_.executor, 0o600);
        const mutableFailure = await rejectionError(
            launchProductionDeliveryExecutor(fixture_.options, {
                execute: () => Promise.resolve(success),
            })
        );
        expect(mutableFailure.message).toBe("Production Delivery executor launch failed");

        await writeFile(fixture_.executor, "tampered");
        await chmod(fixture_.executor, 0o400);
        const manifestFailure = await rejectionError(
            launchProductionDeliveryExecutor(fixture_.options, {
                execute: () => Promise.resolve(success),
            })
        );
        expect(manifestFailure.message).toBe(
            "Production Delivery executor launch failed"
        );

        await chmod(fixture_.executor, 0o600);
        await writeFile(fixture_.executor, "executor");
        await chmod(fixture_.executor, 0o400);
        const processFailure = await rejectionError(
            launchProductionDeliveryExecutor(fixture_.options, {
                execute: () =>
                    Promise.resolve({
                        exitCode: 1,
                        stderr: new TextEncoder().encode("secret diagnostic"),
                        stdout: new Uint8Array(),
                    }),
            })
        );
        expect(processFailure.message).toBe("Production Delivery executor launch failed");
    });

    test("keeps the exact live transient executor without launching a duplicate", async () => {
        const fixture_ = await fixture();
        const commands: Array<readonly string[]> = [];

        const outcome = await ensureProductionDeliveryExecutor(fixture_.options, {
            execute(command) {
                commands.push(command);
                return Promise.resolve(success);
            },
        });

        expect(outcome).toBe("already-running");
        expect(commands).toHaveLength(1);
        expect(commands[0]).toEqual([
            "/usr/bin/systemctl",
            "--user",
            "is-active",
            "--quiet",
            `mira-dashboard-production-delivery-${transitionId.replaceAll("-", "")}`,
        ]);
    });

    test("relaunches an orphan with the capsule-owned immutable executor tuple", async () => {
        const { executor, options, runtime } = await fixture();
        const commands: Array<readonly string[]> = [];

        const outcome = await ensureProductionDeliveryExecutor(options, {
            execute(command) {
                commands.push(command);
                return Promise.resolve(
                    command[0] === "/usr/bin/systemctl"
                        ? { ...success, exitCode: 3 }
                        : success
                );
            },
        });

        expect(outcome).toBe("launched");
        expect(commands).toHaveLength(2);
        expect(commands[1]).toContain(runtime);
        expect(commands[1]).toContain(executor);
        expect(commands[1]).toContain(`--transition=${transitionId}`);
    });
});
