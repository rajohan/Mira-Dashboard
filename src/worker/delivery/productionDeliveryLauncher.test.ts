import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import type { DeliveryProductionOperationCapsule } from "../../shared/deliveryProductionOperation.ts";
import {
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
} from "../../shared/releaseManifest.ts";
import { publishedReleaseAuthority } from "../../testSupport/publishedReleaseAuthority.ts";
import { createProductionDeliveryControlPort } from "./productionDeliveryControl.ts";
import {
    ensureProductionDeliveryExecutor,
    launchProductionDeliveryExecutor,
    type ProductionDeliveryLaunchProcessResult,
} from "./productionDeliveryLauncher.ts";

const temporaryDirectories: string[] = [];
const executorReleaseId = "a".repeat(40);
const runtimeRevision = "b".repeat(40);
const transitionId = "019fd974-54a2-74dd-a64b-d4186f8d8801";
const previousTransitionId = "019fd974-54a2-74dd-a64b-d4186f8d8800";

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
            artifactSource: "published-release" as const,
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

function operationCapsule(): DeliveryProductionOperationCapsule {
    const payload = {
        activationRevision: "1".repeat(64),
        checkoutRevision: "2".repeat(64),
        expectedMainHeadSha: "c".repeat(40),
        operation: "deploy" as const,
        release: publishedReleaseAuthority("c".repeat(40), "v1.2.3", "d".repeat(40)),
        sourceRevision: "f".repeat(64),
    };
    return Object.freeze({
        cas: {
            current: {
                activationTransitionId: previousTransitionId,
                releaseId: "e".repeat(40),
                rollbackSnapshotTransitionId: transitionId,
                runtimeRevision: "f".repeat(40),
            },
            target: {
                databaseSnapshotTransitionId: null,
                releaseId: "c".repeat(40),
                runtimeRevision: "d".repeat(40),
            },
        },
        enqueue: {
            actionKey: "delivery.production.v1" as const,
            actor: {
                authenticatorId: "a".repeat(32),
                id: "019fd974-54a2-74dd-a64b-d4186f8d8805",
                kind: "user" as const,
            },
            audit: {
                eventId: "019fd974-54a2-74dd-a64b-d4186f8d8804",
                requestId: "request-delivery-control",
            },
            enqueueSha256: "e".repeat(64),
            idempotencyKey: "A".repeat(32),
            payload,
            payloadSha256: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify(payload))
                .digest("hex"),
            queuedAtMs: 1000,
        },
        executor: {
            releaseId: executorReleaseId,
            runtimeRevision,
        },
        protocol: "delivery.production.v2" as const,
        runId: transitionId,
        transitionId,
    });
}

function jsonResult(value: unknown): ProductionDeliveryLaunchProcessResult {
    return Object.freeze({
        ...success,
        stdout: new TextEncoder().encode(JSON.stringify(value)),
    });
}

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
        expect(observedCommand).toContain(
            "--property=BindReadOnlyPaths=/home/ubuntu/.doppler"
        );
        expect(observedCommand).toContain("--property=RuntimeMaxSec=90min");
        expect(observedCommand).toContain(`--property=BindPaths=${options.projectRoot}`);
        expect(observedCommand).toContain(
            "--property=InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/opt/docker -/tmp/openclaw"
        );
        expect(observedCommand).toContain("--property=PrivateDevices=yes");
        expect(observedCommand).toContain("/usr/bin/env");
        expect(observedCommand).toContain("-i");
        expect(observedCommand).toContain("/usr/local/bin/doppler");
        expect(observedCommand).toContain("--only-secrets=MIRA_GITHUB_TOKEN");
        expect(observedCommand).toContain("NODE_ENV=production");
        expect(observedCommand).toContain(
            `XDG_RUNTIME_DIR=/run/user/${process.getuid?.()}`
        );
        expect(observedCommand).toContain(runtime);
        expect(observedCommand).toContain(executor);
        expect(observedCommand).toContain("--artifact-source=published-release");
        expect(observedCommand).toContain(`--transition=${transitionId}`);
        expect(Object.keys(observedEnvironment).toSorted()).toEqual([
            "DBUS_SESSION_BUS_ADDRESS",
            "LANG",
            "PATH",
            "XDG_RUNTIME_DIR",
        ]);
        expect(JSON.stringify(observedEnvironment)).not.toContain("TOKEN");
    });

    test("starts retained-artifact recovery without Doppler or its configuration", async () => {
        const fixture_ = await fixture();
        let observedCommand: readonly string[] = [];

        await launchProductionDeliveryExecutor(
            { ...fixture_.options, artifactSource: "retained" },
            {
                execute: (command) => {
                    observedCommand = command;
                    return Promise.resolve(success);
                },
            }
        );

        expect(observedCommand).not.toContain("/usr/local/bin/doppler");
        expect(observedCommand).not.toContain("--only-secrets=MIRA_GITHUB_TOKEN");
        expect(observedCommand).not.toContain(
            "--property=BindReadOnlyPaths=/home/ubuntu/.doppler"
        );
        expect(observedCommand).toContain(fixture_.runtime);
        expect(observedCommand).toContain(fixture_.executor);
        expect(observedCommand).toContain("--artifact-source=retained");
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

    test("relaunches a runtime-bounded failed executor with the capsule-owned immutable tuple", async () => {
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
        expect(commands[1]).toContain("--property=RuntimeMaxSec=90min");
        expect(commands[1]).toContain("--artifact-source=retained");
        expect(commands[1]).not.toContain("/usr/local/bin/doppler");
        expect(commands[1]).toContain(`--transition=${transitionId}`);
    });

    test("fails closed when systemd cannot prove that the executor is inactive", async () => {
        const fixture_ = await fixture();
        const commands: Array<readonly string[]> = [];

        const failure_ = await rejectionError(
            ensureProductionDeliveryExecutor(fixture_.options, {
                execute(command) {
                    commands.push(command);
                    return Promise.resolve({ ...success, exitCode: 1 });
                },
            })
        );

        expect(failure_.message).toBe("Production Delivery executor launch failed");
        expect(commands).toHaveLength(1);
        expect(commands[0]?.[0]).toBe("/usr/bin/systemctl");
    });
});

describe("production Delivery control port", () => {
    test("bounds an actual immutable executor control process", async () => {
        const fixture_ = await fixture();
        await chmod(fixture_.runtime, 0o700);
        await writeFile(
            fixture_.runtime,
            "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"missing\"}'\n",
            { mode: 0o500 }
        );
        await chmod(fixture_.runtime, 0o500);
        const control = createProductionDeliveryControlPort({
            executorReleaseId,
            projectRoot: fixture_.options.projectRoot,
            runtimeRevision,
        });

        expect(await control.inspectActive()).toEqual({ state: "missing" });
    });

    test("uses only the verified executor for prepare, inspect, and clear", async () => {
        const fixture_ = await fixture();
        const capsule = operationCapsule();
        const commands: Array<readonly string[]> = [];
        const standardInputs: Uint8Array[] = [];
        const terminal = {
            capsule,
            phase: "terminal" as const,
            result: {
                activation: null,
                completedAtMs: 2000,
                outcome: "failed" as const,
                reason: "activation-failed" as const,
            },
            updatedAtMs: 2000,
        };
        const control = createProductionDeliveryControlPort(
            {
                executorReleaseId,
                projectRoot: fixture_.options.projectRoot,
                runtimeRevision,
            },
            {
                execute(command, environment, standardInput) {
                    commands.push(command);
                    standardInputs.push(standardInput);
                    expect(environment).toEqual({ LANG: "C", PATH: "/usr/bin:/bin" });
                    const operation = command.find((part) =>
                        part.startsWith("--operation=")
                    );
                    switch (operation) {
                        case "--operation=prepare": {
                            return Promise.resolve(
                                jsonResult({
                                    capsule,
                                    phase: "intent-recorded",
                                    updatedAtMs: 1000,
                                })
                            );
                        }
                        case "--operation=inspect-active": {
                            return Promise.resolve(jsonResult({ state: "missing" }));
                        }
                        case "--operation=inspect": {
                            return Promise.resolve(
                                jsonResult({
                                    record: terminal,
                                    state: "terminal",
                                    transitionId,
                                })
                            );
                        }
                        case "--operation=clear": {
                            return Promise.resolve(jsonResult(terminal));
                        }
                        default: {
                            throw new Error("Unexpected control operation");
                        }
                    }
                },
            }
        );

        expect(await control.prepare(capsule)).toEqual({
            capsule,
            phase: "intent-recorded",
            updatedAtMs: 1000,
        });
        expect(await control.inspectActive()).toEqual({ state: "missing" });
        expect(await control.inspect(transitionId)).toEqual({
            record: terminal,
            state: "terminal",
            transitionId,
        });
        expect(await control.clear(transitionId)).toEqual(terminal);
        expect(commands).toHaveLength(4);
        for (const command of commands) {
            expect(command.slice(0, 5)).toEqual([
                "/usr/bin/env",
                "-i",
                "NODE_ENV=production",
                fixture_.runtime,
                fixture_.executor,
            ]);
        }
        expect(JSON.parse(new TextDecoder().decode(standardInputs[0]))).toEqual(capsule);
        expect(standardInputs.slice(1).every((input) => input.byteLength === 0)).toBe(
            true
        );
    });

    test("rejects process diagnostics and mismatched executor responses", async () => {
        const fixture_ = await fixture();
        const capsule = operationCapsule();
        const options = {
            executorReleaseId,
            projectRoot: fixture_.options.projectRoot,
            runtimeRevision,
        };
        const diagnosticControl = createProductionDeliveryControlPort(options, {
            execute: () =>
                Promise.resolve({
                    exitCode: 0,
                    stderr: new TextEncoder().encode("private diagnostic"),
                    stdout: new Uint8Array(),
                }),
        });
        const diagnosticFailure = await rejectionError(diagnosticControl.inspectActive());
        expect(diagnosticFailure.message).toBe("Production Delivery control failed");

        const mismatchControl = createProductionDeliveryControlPort(options, {
            execute: () =>
                Promise.resolve(
                    jsonResult({
                        capsule,
                        phase: "intent-recorded",
                        updatedAtMs: 1000,
                    })
                ),
        });
        const mismatchFailure = await rejectionError(mismatchControl.clear(transitionId));
        expect(mismatchFailure.message).toBe("Production Delivery control failed");
        const invalidTransitionFailure = await rejectionError(
            mismatchControl.inspect("not-a-transition")
        );
        expect(invalidTransitionFailure.name).toBe("ValiError");

        const invalidJsonControl = createProductionDeliveryControlPort(options, {
            execute: () =>
                Promise.resolve({
                    ...success,
                    stdout: new TextEncoder().encode("{"),
                }),
        });
        const invalidJsonFailure = await rejectionError(
            invalidJsonControl.inspectActive()
        );
        expect(invalidJsonFailure.message).toBe("Production Delivery control failed");

        const terminalPrepareControl = createProductionDeliveryControlPort(options, {
            execute: () =>
                Promise.resolve(
                    jsonResult({
                        capsule,
                        phase: "terminal",
                        result: {
                            activation: null,
                            completedAtMs: 2000,
                            outcome: "failed",
                            reason: "activation-failed",
                        },
                        updatedAtMs: 2000,
                    })
                ),
        });
        const terminalPrepareFailure = await rejectionError(
            terminalPrepareControl.prepare(capsule)
        );
        expect(terminalPrepareFailure.message).toBe("Production Delivery control failed");

        const changedCapsule = {
            ...capsule,
            enqueue: {
                ...capsule.enqueue,
                idempotencyKey: "B".repeat(32),
            },
        };
        const changedCapsuleControl = createProductionDeliveryControlPort(options, {
            execute: () =>
                Promise.resolve(
                    jsonResult({
                        capsule: changedCapsule,
                        phase: "intent-recorded",
                        updatedAtMs: 1000,
                    })
                ),
        });
        const changedCapsuleFailure = await rejectionError(
            changedCapsuleControl.prepare(capsule)
        );
        expect(changedCapsuleFailure.message).toBe("Production Delivery control failed");
    });
});
