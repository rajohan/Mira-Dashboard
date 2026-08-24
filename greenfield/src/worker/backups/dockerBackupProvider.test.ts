import { describe, expect, test } from "bun:test";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import type { BackupType } from "../../contracts/backups.ts";
import { backupWrapperProtocol } from "../../contracts/backupsWorker.ts";
import type {
    DockerComposeDiscoveredService,
    DockerComposeDiscoveryResult,
} from "../docker/composeDiscovery.ts";
import type {
    DockerEngineInventoryAvailableContainer,
    DockerEngineInventoryCollector,
    DockerEngineInventorySnapshot,
} from "../docker/engineInventory.ts";
import {
    createDockerBackupJobExecutionPort,
    createDockerBackupProviderProcess,
    createDockerBackupProviderDiscovery,
    DockerBackupProviderProcessError,
    backupDockerExecutable,
    backupProviderRunWrapper,
    backupProviderStatusWrapper,
    type DockerBackupProviderProcess,
    type DockerBackupProviderProcessRequest,
    type DockerBackupProviderTerminationScheduler,
} from "./dockerBackupProvider.ts";

const rootCompose = "/opt/docker/compose.yaml";
const firstId = "1".repeat(64);
const secondId = "2".repeat(64);
const foreignId = "3".repeat(64);

interface ManualTerminationDeadline {
    cancelled: boolean;
    readonly delayMs: number;
    fire(): void;
}

class ManualTerminationScheduler implements DockerBackupProviderTerminationScheduler {
    readonly entries: ManualTerminationDeadline[] = [];
    readonly #waiters = new Map<
        number,
        ReturnType<typeof Promise.withResolvers<ManualTerminationDeadline>>
    >();

    schedule(callback: () => void, delayMs: number) {
        let fired = false;
        const entry: ManualTerminationDeadline = {
            cancelled: false,
            delayMs,
            fire() {
                if (entry.cancelled || fired) return;
                fired = true;
                callback();
            },
        };
        const index = this.entries.push(entry) - 1;
        this.#waiters.get(index)?.resolve(entry);
        return {
            cancel() {
                entry.cancelled = true;
            },
        };
    }

    waitForEntry(index: number): Promise<ManualTerminationDeadline> {
        const entry = this.entries[index];
        if (entry !== undefined) return Promise.resolve(entry);
        const waiter = Promise.withResolvers<ManualTerminationDeadline>();
        this.#waiters.set(index, waiter);
        return waiter.promise;
    }
}

function composeService(
    type: BackupType,
    overrides: Partial<DockerComposeDiscoveredService> = {}
): DockerComposeDiscoveredService {
    const service = type === "kopia" ? "files-provider" : "database-provider";
    return Object.freeze({
        autoUpdate: false,
        composePath: `/opt/docker/apps/${service}/compose.yaml`,
        configFiles: Object.freeze([rootCompose]),
        contentSha256: "c".repeat(64),
        enabled: false,
        imageReference: `example/${service}:current`,
        labels: Object.freeze({
            "mira.dashboard.backup": type === "kopia" ? "kopia-v1" : "wal-g-v1",
        }),
        pinMode: "tag",
        project: "dynamic-root",
        service,
        ...overrides,
    });
}

function compose(
    services: readonly DockerComposeDiscoveredService[] = [
        composeService("kopia"),
        composeService("walg"),
    ]
): DockerComposeDiscoveryResult {
    return Object.freeze({
        composeFiles: Object.freeze([rootCompose]),
        services: Object.freeze([...services]),
        sourceRevision: "d".repeat(64),
    });
}

function container(
    type: BackupType,
    id: string,
    overrides: Partial<DockerEngineInventoryAvailableContainer> = {}
): DockerEngineInventoryAvailableContainer {
    const service = type === "kopia" ? "files-provider" : "database-provider";
    return Object.freeze({
        availability: "available",
        createdAt: "2026-08-13T00:00:00Z",
        finishedAt: "0001-01-01T00:00:00Z",
        health: "healthy",
        id,
        imageId: `sha256:${"a".repeat(64)}`,
        imageReference: `example/${service}:current`,
        labels: Object.freeze({
            "com.docker.compose.project": "dynamic-root",
            "com.docker.compose.project.config_files": rootCompose,
            "com.docker.compose.service": service,
            "mira.dashboard.backup": type === "kopia" ? "kopia-v1" : "wal-g-v1",
        }),
        mounts:
            type === "kopia"
                ? Object.freeze([
                      {
                          destination: "/source/openclaw",
                          readOnly: true,
                          type: "bind",
                      },
                      {
                          destination: "/source/projects",
                          readOnly: true,
                          type: "bind",
                      },
                  ])
                : Object.freeze([]),
        name: service,
        networks: Object.freeze([]),
        publishedPorts: Object.freeze([]),
        restartCount: 0,
        startedAt: "2026-08-13T00:00:01Z",
        state: "running",
        status: Object.freeze({
            dead: false,
            exitCode: 0,
            oomKilled: false,
            paused: false,
            restarting: false,
            running: true,
        }),
        ...overrides,
    });
}

function snapshot(
    containers: DockerEngineInventorySnapshot["containers"] = [
        container("kopia", firstId),
        container("walg", secondId),
    ],
    sourceRevision = "e".repeat(64)
): DockerEngineInventorySnapshot {
    return Object.freeze({
        containers: Object.freeze([...containers]),
        images: Object.freeze([]),
        sourceRevision,
        stats: Object.freeze([]),
        volumes: Object.freeze([]),
    });
}

function engine(...snapshots: readonly DockerEngineInventorySnapshot[]) {
    let index = 0;
    const collector: DockerEngineInventoryCollector = Object.freeze({
        collect() {
            const value = snapshots[Math.min(index, snapshots.length - 1)];
            index += 1;
            return value === undefined
                ? Promise.reject(new Error("Missing Engine fixture"))
                : Promise.resolve(value);
        },
    });
    return collector;
}

function result(output: unknown, exitCode = 0) {
    return {
        exitCode,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode(JSON.stringify(output)),
    };
}

function providerProcess() {
    const calls: DockerBackupProviderProcessRequest[] = [];
    const process: DockerBackupProviderProcess = (request) => {
        calls.push(request);
        const containerId = request.arguments[3];
        const wrapper = request.arguments[4];
        if (wrapper === backupProviderRunWrapper) {
            return Promise.resolve(
                result({
                    protocol: backupWrapperProtocol,
                    status: "completed",
                    type: containerId === firstId ? "kopia" : "walg",
                })
            );
        }
        return Promise.resolve(
            containerId === firstId
                ? result({
                      idle: true,
                      protocol: backupWrapperProtocol,
                      sources: [
                          {
                              id: "openclaw",
                              latestCompletedAtMs: 1_900_000,
                              latestFileCount: 12,
                              latestSizeBytes: 42,
                              snapshotCount: 2,
                          },
                          {
                              id: "projects",
                              latestCompletedAtMs: 1_800_000,
                              snapshotCount: 1,
                          },
                      ],
                      type: "kopia",
                  })
                : result({
                      backupCount: 3,
                      idle: true,
                      latestCompletedAtMs: 1_950_000,
                      protocol: backupWrapperProtocol,
                      type: "walg",
                  })
        );
    };
    return { calls, process };
}

describe("Docker backup provider discovery", () => {
    test("joins exactly one healthy root-graph provider per capability", async () => {
        const discovery = createDockerBackupProviderDiscovery({
            discoverCompose: () => compose(),
            engine: engine(snapshot()),
        });

        const topology = await discovery.discover();

        expect(topology.providers).toEqual({
            kopia: {
                containerId: firstId,
                kopiaSourceIds: ["openclaw", "projects"],
                type: "kopia",
            },
            walg: { containerId: secondId, kopiaSourceIds: [], type: "walg" },
        });
        expect(topology.sourceRevision).toMatch(/^[0-9a-f]{64}$/u);
    });

    test("ignores a matching foreign project but rejects root ambiguity or disappearance", async () => {
        const foreign = container("kopia", foreignId, {
            labels: Object.freeze({
                "com.docker.compose.project": "foreign",
                "com.docker.compose.project.config_files": "/foreign/compose.yaml",
                "com.docker.compose.service": "files-provider",
                "mira.dashboard.backup": "kopia-v1",
            }),
        });
        const withForeign = createDockerBackupProviderDiscovery({
            discoverCompose: () => compose(),
            engine: engine(
                snapshot([
                    container("kopia", firstId),
                    container("walg", secondId),
                    foreign,
                ])
            ),
        });
        const discoveredWithForeign = await withForeign.discover();
        expect(discoveredWithForeign.providers.kopia.containerId).toBe(firstId);

        const ambiguous = createDockerBackupProviderDiscovery({
            discoverCompose: () =>
                compose([
                    composeService("kopia"),
                    composeService("kopia", { service: "second-kopia" }),
                    composeService("walg"),
                ]),
            engine: engine(snapshot()),
        });
        expect(ambiguous.discover()).rejects.toMatchObject({
            reason: "unavailable",
        });

        const disappeared = createDockerBackupProviderDiscovery({
            discoverCompose: () => compose(),
            engine: engine(
                snapshot([
                    { availability: "disappeared", id: firstId },
                    container("walg", secondId),
                ])
            ),
        });
        expect(disappeared.discover()).rejects.toMatchObject({
            reason: "unavailable",
        });
    });

    test("rejects writable, nested, absent, or duplicate Kopia source mounts", () => {
        const invalidMountSets = [
            [{ destination: "/source/files", readOnly: false, type: "bind" }],
            [{ destination: "/source/files/nested", readOnly: true, type: "bind" }],
            [{ destination: "/elsewhere/files", readOnly: true, type: "bind" }],
            [
                { destination: "/source/files", readOnly: true, type: "bind" },
                { destination: "/source/files", readOnly: true, type: "bind" },
            ],
        ] as const;
        for (const mounts of invalidMountSets) {
            const discovery = createDockerBackupProviderDiscovery({
                discoverCompose: () => compose(),
                engine: engine(
                    snapshot([
                        container("kopia", firstId, { mounts }),
                        container("walg", secondId),
                    ])
                ),
            });
            expect(discovery.discover()).rejects.toMatchObject({
                reason: "unavailable",
            });
        }
    });

    test("changes the opaque revision when provider identity or topology changes", async () => {
        const discovery = createDockerBackupProviderDiscovery({
            discoverCompose: () => compose(),
            engine: engine(snapshot(), snapshot(undefined, "f".repeat(64))),
        });
        const first = await discovery.discover();
        const second = await discovery.discover();
        expect(first.sourceRevision).not.toBe(second.sourceRevision);
    });
});

describe("Docker backup execution port", () => {
    test("rejects an already-aborted refresh before reading provider state", async () => {
        const cancellation = new DOMException("claim lost", "AbortError");
        const controller = new AbortController();
        controller.abort(cancellation);
        const calls: string[] = [];
        const port = createDockerBackupJobExecutionPort({
            discoverCompose() {
                calls.push("compose");
                return compose();
            },
            engine: {
                collect() {
                    calls.push("engine");
                    return Promise.resolve(snapshot());
                },
            },
            nowMs() {
                calls.push("clock");
                return 2_000_000;
            },
            process() {
                calls.push("process");
                return Promise.resolve(result({}));
            },
        });

        expect(await rejectionError(port.refresh(controller.signal))).toBe(cancellation);
        expect(calls).toEqual([]);
    });

    test("rethrows the exact parent cancellation after provider settlement", async () => {
        const cancellation = new DOMException("claim lost", "AbortError");
        const controller = new AbortController();
        const baseProcess = providerProcess();
        const statusContainers: string[] = [];
        const port = createDockerBackupJobExecutionPort({
            discoverCompose: () => compose(),
            engine: engine(snapshot(), snapshot()),
            nowMs: () => 2_000_000,
            process(request) {
                statusContainers.push(request.arguments[3] ?? "");
                if (request.arguments[3] === secondId) {
                    controller.abort(cancellation);
                }
                return baseProcess.process(request);
            },
        });

        expect(await rejectionError(port.refresh(controller.signal))).toBe(cancellation);
        expect(statusContainers).toEqual([firstId, secondId]);
    });

    test("cancels the termination grace when an aborted child exits on TERM", async () => {
        const controller = new AbortController();
        const exited = Promise.withResolvers<number>();
        const launched = Promise.withResolvers<void>();
        const scheduler = new ManualTerminationScheduler();
        const signals: Array<"SIGKILL" | "SIGTERM"> = [];
        const process = createDockerBackupProviderProcess(() => {
            launched.resolve();
            return {
                exited: exited.promise,
                kill(signal) {
                    signals.push(signal);
                    exited.resolve(0);
                },
                stderr: new ReadableStream<Uint8Array>(),
                stdout: new ReadableStream<Uint8Array>(),
            };
        }, scheduler);
        const execution = process({
            arguments: ["fixed"],
            environment: {},
            executable: backupDockerExecutable,
            signal: controller.signal,
            stdoutMaximumBytes: 1,
        });
        await launched.promise;
        controller.abort();

        const termDeadline = await scheduler.waitForEntry(0);
        expect(await rejectionError(execution)).toMatchObject({ dispatched: true });
        expect(signals).toEqual(["SIGTERM"]);
        expect(termDeadline.cancelled).toBe(true);
        expect(scheduler.entries).toHaveLength(1);
    });

    test("bounds TERM-to-KILL teardown when an aborted child never reports exit", async () => {
        const controller = new AbortController();
        const launched = Promise.withResolvers<void>();
        const scheduler = new ManualTerminationScheduler();
        const signals: Array<"SIGKILL" | "SIGTERM"> = [];
        const process = createDockerBackupProviderProcess(() => {
            launched.resolve();
            return {
                exited: new Promise<number>(() => {}),
                kill(signal) {
                    signals.push(signal);
                },
                stderr: new ReadableStream<Uint8Array>(),
                stdout: new ReadableStream<Uint8Array>(),
            };
        }, scheduler);
        const execution = process({
            arguments: ["fixed"],
            environment: {},
            executable: backupDockerExecutable,
            signal: controller.signal,
            stdoutMaximumBytes: 1,
        });
        await launched.promise;
        controller.abort();

        const termDeadline = await scheduler.waitForEntry(0);
        expect(signals).toEqual(["SIGTERM"]);
        expect(termDeadline.delayMs).toBe(250);
        termDeadline.fire();

        const killDeadline = await scheduler.waitForEntry(1);
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(killDeadline.delayMs).toBe(250);
        killDeadline.fire();

        const failure = await rejectionError(execution);

        expect(failure).toBeInstanceOf(DockerBackupProviderProcessError);
        expect(failure).toMatchObject({ dispatched: true });
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(scheduler.entries.every(({ cancelled }) => cancelled)).toBe(true);
    });

    test("uses only fixed non-shell Docker exec wrappers and projects bounded status", async () => {
        const process = providerProcess();
        const port = createDockerBackupJobExecutionPort({
            discoverCompose: () => compose(),
            engine: engine(snapshot(), snapshot(), snapshot()),
            nowMs: () => 2_000_000,
            process: process.process,
        });

        const refresh = await port.refresh();
        expect(refresh.kopia).toMatchObject({
            kind: "succeeded",
            payload: {
                backupCount: 3,
                healthy: true,
                providerIdle: true,
                sources: [{ id: "openclaw" }, { id: "projects" }],
            },
        });
        expect(refresh.walg).toMatchObject({
            kind: "succeeded",
            payload: { backupCount: 3, healthy: true, providerIdle: true },
        });
        const sourceRevision =
            refresh.kopia.kind === "succeeded"
                ? refresh.kopia.payload.sourceRevision
                : "";
        const walgSourceRevision =
            refresh.walg.kind === "succeeded" ? refresh.walg.payload.sourceRevision : "";
        expect(
            await port.run({ expectedSourceRevision: sourceRevision, type: "kopia" })
        ).toMatchObject({ outcome: "completed", sourceRevision });
        expect(
            await port.clearAttention({
                attentionRunId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                sourceRevision: walgSourceRevision,
                type: "walg",
            })
        ).toMatchObject({
            outcome: "completed",
            sourceRevision: walgSourceRevision,
        });

        expect(
            process.calls.every(
                ({ arguments: arguments_, environment, executable }) =>
                    executable === backupDockerExecutable &&
                    arguments_.slice(0, 4).join(" ") ===
                        "--host unix:///var/run/docker.sock exec " + arguments_[3] &&
                    [backupProviderStatusWrapper, backupProviderRunWrapper].includes(
                        arguments_[4] as typeof backupProviderStatusWrapper
                    ) &&
                    environment.PATH === "/usr/bin:/bin" &&
                    !arguments_.includes("sh") &&
                    !arguments_.includes("-c")
            )
        ).toBe(true);
    });

    test("fails closed on source drift, busy provider, and wrapper/source mismatch", async () => {
        const baseProcess = providerProcess();
        const drift = createDockerBackupJobExecutionPort({
            discoverCompose: () => compose(),
            engine: engine(snapshot()),
            process: baseProcess.process,
        });
        expect(
            drift.run({ expectedSourceRevision: "0".repeat(64), type: "kopia" })
        ).rejects.toMatchObject({ reason: "conflict" });

        const busy = createDockerBackupJobExecutionPort({
            discoverCompose: () => compose(),
            engine: engine(snapshot()),
            process: (request) =>
                Promise.resolve(
                    result(
                        request.arguments[3] === firstId
                            ? {
                                  idle: false,
                                  protocol: backupWrapperProtocol,
                                  sources: [
                                      { id: "openclaw", snapshotCount: 0 },
                                      { id: "projects", snapshotCount: 0 },
                                  ],
                                  type: "kopia",
                              }
                            : {
                                  backupCount: 0,
                                  idle: true,
                                  protocol: backupWrapperProtocol,
                                  type: "walg",
                              }
                    )
                ),
        });
        expect(busy.run({ type: "kopia" })).rejects.toMatchObject({
            reason: "provider-busy",
        });

        const mismatched = createDockerBackupJobExecutionPort({
            discoverCompose: () => compose(),
            engine: engine(snapshot()),
            process: () =>
                Promise.resolve(
                    result({
                        idle: true,
                        protocol: backupWrapperProtocol,
                        sources: [{ id: "unexpected", snapshotCount: 0 }],
                        type: "kopia",
                    })
                ),
        });
        const refreshed = await mismatched.refresh();
        expect(refreshed.kopia).toEqual({ kind: "failed" });
    });

    test("preserves independent WAL-G status when Kopia discovery is ambiguous", async () => {
        const process = providerProcess();
        const port = createDockerBackupJobExecutionPort({
            discoverCompose: () =>
                compose([
                    composeService("kopia"),
                    composeService("kopia", { service: "second-kopia" }),
                    composeService("walg"),
                ]),
            engine: engine(snapshot()),
            nowMs: () => 2_000_000,
            process: process.process,
        });

        const refreshed = await port.refresh();
        expect(refreshed.kopia).toEqual({ kind: "failed" });
        expect(refreshed.walg).toMatchObject({
            kind: "succeeded",
            payload: { backupCount: 3, type: "walg" },
        });
    });

    test("reports unknown outcome only after run dispatch might have begun", async () => {
        let runFailureDispatched = true;
        const process: DockerBackupProviderProcess = (request) => {
            if (request.arguments[4] === backupProviderStatusWrapper) {
                return providerProcess().process(request);
            }
            return Promise.reject(
                new DockerBackupProviderProcessError(runFailureDispatched)
            );
        };
        const port = createDockerBackupJobExecutionPort({
            discoverCompose: () => compose(),
            engine: engine(snapshot(), snapshot()),
            process,
        });
        expect(await port.run({ type: "kopia" })).toEqual({
            outcome: "unknown-outcome",
        });

        runFailureDispatched = false;
        expect(port.run({ type: "kopia" })).rejects.toMatchObject({
            reason: "unavailable",
        });
    });

    test("reports unknown outcome when a successful exit loses its completion proof", async () => {
        const process: DockerBackupProviderProcess = (request) =>
            request.arguments[4] === backupProviderStatusWrapper
                ? providerProcess().process(request)
                : Promise.resolve(result({ status: "completed" }));
        const port = createDockerBackupJobExecutionPort({
            discoverCompose: () => compose(),
            engine: engine(snapshot()),
            process,
        });

        expect(await port.run({ type: "kopia" })).toEqual({
            outcome: "unknown-outcome",
        });
    });
});
