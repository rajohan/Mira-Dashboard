import { describe, expect, test } from "bun:test";

import {
    createDockerEngineInventoryCollector,
    dockerEngineInventoryContainerMaximum,
    dockerEngineInventoryImageFormat,
    dockerEngineInventoryInspectFormat,
    dockerEngineInventoryStatsFormat,
    dockerEngineInventoryVolumeFormat,
    type DockerEngineInventoryProcess,
    type DockerEngineInventoryProcessRequest,
    type DockerEngineInventoryProcessResult,
} from "./engineInventory.ts";

const encoder = new TextEncoder();
const firstId = "1".repeat(64);
const secondId = "2".repeat(64);
const thirdId = "3".repeat(64);
const firstImageId = `sha256:${"a".repeat(64)}`;
const secondImageId = `sha256:${"b".repeat(64)}`;

function processResult(
    output: string | readonly unknown[] = "",
    options: { readonly exitCode?: number; readonly stderr?: string } = {}
): DockerEngineInventoryProcessResult {
    const text = Array.isArray(output)
        ? output.map((value) => JSON.stringify(value)).join("\n")
        : String(output);
    return {
        exitCode: options.exitCode ?? 0,
        stderr: encoder.encode(options.stderr ?? ""),
        stdout: encoder.encode(text),
    };
}

function labels(
    overrides: Partial<Record<string, string | null>> = {}
): Record<string, string | null> {
    return {
        "com.docker.compose.config-hash": null,
        "com.docker.compose.container-number": null,
        "com.docker.compose.project": null,
        "com.docker.compose.project.config_files": null,
        "com.docker.compose.project.working_dir": null,
        "com.docker.compose.service": null,
        "mira.updater.autoUpdate": null,
        "mira.updater.enabled": null,
        "mira.updater.tagPattern": null,
        "mira.updater.tagPatternIsRegex": null,
        "mira.updater.track": null,
        ...overrides,
    };
}

function inspectRow(
    id: string,
    overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
    return {
        createdAt: "2026-08-13T04:00:00.000000000Z",
        dead: false,
        exitCode: 0,
        finishedAt: "0001-01-01T00:00:00Z",
        health: "healthy",
        id,
        imageId: id === firstId ? firstImageId : secondImageId,
        imageReference: id === firstId ? "example/app:1.0.0" : "example/db:2.0.0",
        labels: labels(),
        mounts: [],
        name: id === firstId ? "/app" : "/db",
        networks: [],
        oomKilled: false,
        paused: false,
        ports: {},
        restartCount: 0,
        restarting: false,
        running: true,
        startedAt: "2026-08-13T04:00:01.000000000Z",
        state: "running",
        ...overrides,
    };
}

function imageRow(id: string, repository: string, tag: string): Record<string, unknown> {
    return {
        createdAt: "2026-08-12 12:00:00 +0200 CEST",
        digest: `sha256:${id === firstImageId ? "c" : "d"}`.padEnd(71, "0"),
        id,
        repository,
        size: "128MB",
        tag,
    };
}

function statsRow(id: string, pids = "4"): Record<string, unknown> {
    return {
        blockIo: "0B / 0B",
        cpuPercent: "0.50%",
        id,
        memoryPercent: "1.00%",
        memoryUsage: "64MiB / 1GiB",
        networkIo: "1kB / 2kB",
        pids,
    };
}

interface FixtureOutputs {
    readonly imageRows?: readonly unknown[];
    readonly inspectExitCode?: number;
    readonly inspectRows?: readonly unknown[];
    readonly psIds?: readonly string[];
    readonly statsRows?: readonly unknown[];
    readonly volumeRows?: readonly unknown[];
}

function fixtureProcess(outputs: FixtureOutputs = {}) {
    const calls: DockerEngineInventoryProcessRequest[] = [];
    const process: DockerEngineInventoryProcess = (request) => {
        calls.push(request);
        switch (request.arguments[2]) {
            case "ps": {
                return Promise.resolve(processResult(outputs.psIds ?? [firstId]));
            }
            case "inspect": {
                return Promise.resolve(
                    processResult(outputs.inspectRows ?? [inspectRow(firstId)], {
                        exitCode: outputs.inspectExitCode,
                    })
                );
            }
            case "image": {
                return Promise.resolve(
                    processResult(
                        outputs.imageRows ?? [
                            imageRow(firstImageId, "example/app", "1.0.0"),
                        ]
                    )
                );
            }
            case "volume": {
                return Promise.resolve(
                    processResult(
                        outputs.volumeRows ?? [
                            { driver: "local", name: "app-data", scope: "local" },
                        ]
                    )
                );
            }
            case "stats": {
                return Promise.resolve(
                    processResult(outputs.statsRows ?? [statsRow(firstId)])
                );
            }
            default: {
                throw new Error("Unexpected Docker command");
            }
        }
    };
    return { calls, process };
}

describe("Docker Engine inventory", () => {
    test("uses fixed scrubbed commands and returns only the sanitized projection", async () => {
        const fixture = fixtureProcess({
            inspectRows: [
                inspectRow(firstId, {
                    labels: labels({
                        "com.docker.compose.config-hash": "config-hash",
                        "com.docker.compose.container-number": "1",
                        "com.docker.compose.project": "media",
                        "com.docker.compose.project.config_files":
                            "/opt/docker/apps/app/compose.yaml",
                        "com.docker.compose.project.working_dir": "/opt/docker",
                        "com.docker.compose.service": "app",
                        "mira.updater.autoUpdate": "false",
                        "mira.updater.enabled": "true",
                        "mira.updater.tagPattern": String.raw`^1\.`,
                        "mira.updater.tagPatternIsRegex": "true",
                        "mira.updater.track": "stable",
                    }),
                    mounts: [
                        {
                            destination: "/config",
                            name: "app-config",
                            readOnly: true,
                            type: "volume",
                        },
                        {
                            destination: "/run/socket",
                            name: "",
                            readOnly: false,
                            type: "bind",
                        },
                    ],
                    networks: [
                        {
                            ipv4Address: "172.20.0.3",
                            ipv6Address: "fd00::3",
                            name: "z-network",
                        },
                        {
                            ipv4Address: "172.19.0.2",
                            ipv6Address: "",
                            name: "a-network",
                        },
                    ],
                    ports: {
                        "8080/tcp": [
                            { HostIp: "::1", HostPort: "18081" },
                            { HostIp: "127.0.0.1", HostPort: "18080" },
                        ],
                        "8443/tcp": null,
                    },
                    restartCount: 3,
                }),
            ],
            statsRows: [statsRow(firstId, "7"), statsRow(thirdId, "99")],
        });

        const snapshot = await createDockerEngineInventoryCollector({
            process: fixture.process,
        }).collect();

        expect(snapshot.sourceRevision).toMatch(/^[0-9a-f]{64}$/u);
        expect(snapshot.containers).toEqual([
            {
                availability: "available",
                createdAt: "2026-08-13T04:00:00.000000000Z",
                finishedAt: "0001-01-01T00:00:00Z",
                health: "healthy",
                id: firstId,
                imageId: firstImageId,
                imageReference: "example/app:1.0.0",
                labels: {
                    "com.docker.compose.project": "media",
                    "com.docker.compose.service": "app",
                    "com.docker.compose.project.config_files":
                        "/opt/docker/apps/app/compose.yaml",
                    "com.docker.compose.project.working_dir": "/opt/docker",
                    "com.docker.compose.config-hash": "config-hash",
                    "com.docker.compose.container-number": "1",
                    "mira.updater.enabled": "true",
                    "mira.updater.autoUpdate": "false",
                    "mira.updater.track": "stable",
                    "mira.updater.tagPattern": String.raw`^1\.`,
                    "mira.updater.tagPatternIsRegex": "true",
                },
                mounts: [
                    {
                        destination: "/config",
                        name: "app-config",
                        readOnly: true,
                        type: "volume",
                    },
                    {
                        destination: "/run/socket",
                        readOnly: false,
                        type: "bind",
                    },
                ],
                name: "app",
                networks: [
                    { addresses: ["172.19.0.2"], name: "a-network" },
                    { addresses: ["172.20.0.3", "fd00::3"], name: "z-network" },
                ],
                publishedPorts: [
                    {
                        containerPort: 8080,
                        hostAddress: "127.0.0.1",
                        hostPort: 18_080,
                        protocol: "tcp",
                    },
                    {
                        containerPort: 8080,
                        hostAddress: "::1",
                        hostPort: 18_081,
                        protocol: "tcp",
                    },
                ],
                restartCount: 3,
                startedAt: "2026-08-13T04:00:01.000000000Z",
                state: "running",
                status: {
                    dead: false,
                    exitCode: 0,
                    oomKilled: false,
                    paused: false,
                    restarting: false,
                    running: true,
                },
            },
        ]);
        expect(snapshot.stats).toEqual([
            {
                blockIo: "0B / 0B",
                cpuPercent: "0.50%",
                id: firstId,
                memoryPercent: "1.00%",
                memoryUsage: "64MiB / 1GiB",
                networkIo: "1kB / 2kB",
                pids: 7,
            },
        ]);

        expect(fixture.calls.map((call) => call.arguments)).toEqual([
            [
                "--host",
                "unix:///var/run/docker.sock",
                "ps",
                "-a",
                "--no-trunc",
                "--format",
                "{{json .ID}}",
            ],
            [
                "--host",
                "unix:///var/run/docker.sock",
                "inspect",
                "--format",
                dockerEngineInventoryInspectFormat,
                firstId,
            ],
            [
                "--host",
                "unix:///var/run/docker.sock",
                "image",
                "ls",
                "-a",
                "--no-trunc",
                "--digests",
                "--format",
                dockerEngineInventoryImageFormat,
            ],
            [
                "--host",
                "unix:///var/run/docker.sock",
                "volume",
                "ls",
                "--format",
                dockerEngineInventoryVolumeFormat,
            ],
            [
                "--host",
                "unix:///var/run/docker.sock",
                "stats",
                "--no-stream",
                "--no-trunc",
                "--format",
                dockerEngineInventoryStatsFormat,
            ],
        ]);
        for (const call of fixture.calls) {
            expect(call.executable).toBe("/usr/bin/docker");
            expect(call.environment).toEqual({
                DOCKER_CONFIG: "/nonexistent/mira-dashboard-docker-config",
                HOME: "/nonexistent",
                LANG: "C",
                LC_ALL: "C",
                PATH: "/usr/bin:/bin",
            });
            expect(call.environment.DOCKER_CONTEXT).toBeUndefined();
            expect(call.environment.DOCKER_HOST).toBeUndefined();
        }
        expect(dockerEngineInventoryInspectFormat).not.toContain(".Config.Env");
        expect(dockerEngineInventoryInspectFormat).not.toContain(".State.Health");
        expect(dockerEngineInventoryInspectFormat).not.toContain("$mount.Name");
        expect(dockerEngineInventoryInspectFormat).toContain('(index .State "Health")');
        expect(dockerEngineInventoryInspectFormat).toContain('(index $mount "Name")');
        expect(dockerEngineInventoryInspectFormat).not.toContain(".Config.Cmd");
        expect(dockerEngineInventoryInspectFormat).not.toContain("$mount.Source");
        expect(dockerEngineInventoryInspectFormat).not.toContain(
            "{{json .Config.Labels}}"
        );
        expect(dockerEngineInventoryInspectFormat).not.toContain(".State.Error");
        expect(dockerEngineInventoryVolumeFormat).not.toContain("Mountpoint");
        expect(dockerEngineInventoryVolumeFormat).not.toContain("Labels");
        expect(dockerEngineInventoryImageFormat).not.toContain("Labels");
    });

    test("sorts every source deterministically and hashes the canonical projection", async () => {
        const first = fixtureProcess({
            imageRows: [
                imageRow(secondImageId, "z/repository", "2.0.0"),
                imageRow(firstImageId, "a/repository", "1.0.0"),
            ],
            inspectRows: [inspectRow(secondId), inspectRow(firstId)],
            psIds: [secondId, firstId],
            statsRows: [statsRow(secondId), statsRow(firstId)],
            volumeRows: [
                { driver: "local", name: "z-volume", scope: "local" },
                { driver: "local", name: "a-volume", scope: "local" },
            ],
        });
        const second = fixtureProcess({
            imageRows: [
                imageRow(firstImageId, "a/repository", "1.0.0"),
                imageRow(secondImageId, "z/repository", "2.0.0"),
            ],
            inspectRows: [inspectRow(firstId), inspectRow(secondId)],
            psIds: [firstId, secondId],
            statsRows: [statsRow(firstId), statsRow(secondId)],
            volumeRows: [
                { driver: "local", name: "a-volume", scope: "local" },
                { driver: "local", name: "z-volume", scope: "local" },
            ],
        });

        const firstSnapshot = await createDockerEngineInventoryCollector({
            process: first.process,
        }).collect();
        const secondSnapshot = await createDockerEngineInventoryCollector({
            process: second.process,
        }).collect();

        expect(firstSnapshot).toEqual(secondSnapshot);
        expect(firstSnapshot.containers.map((container) => container.id)).toEqual([
            firstId,
            secondId,
        ]);
        expect(firstSnapshot.images.map((image) => image.repository)).toEqual([
            "a/repository",
            "z/repository",
        ]);
        expect(firstSnapshot.volumes.map((volume) => volume.name)).toEqual([
            "a-volume",
            "z-volume",
        ]);
    });

    test("excludes volatile telemetry from the revision but retains topology changes", async () => {
        const first = fixtureProcess();
        const telemetryChanged = fixtureProcess({
            statsRows: [
                {
                    ...statsRow(firstId),
                    cpuPercent: "73.25%",
                    memoryPercent: "2.00%",
                    memoryUsage: "128MiB / 1GiB",
                    networkIo: "9kB / 12kB",
                    pids: "8",
                },
            ],
        });
        const topologyChanged = fixtureProcess({
            volumeRows: [
                { driver: "local", name: "app-data", scope: "local" },
                { driver: "local", name: "new-data", scope: "local" },
            ],
        });

        const firstSnapshot = await createDockerEngineInventoryCollector({
            process: first.process,
        }).collect();
        const telemetrySnapshot = await createDockerEngineInventoryCollector({
            process: telemetryChanged.process,
        }).collect();
        const topologySnapshot = await createDockerEngineInventoryCollector({
            process: topologyChanged.process,
        }).collect();

        expect(telemetrySnapshot.stats).not.toEqual(firstSnapshot.stats);
        expect(telemetrySnapshot.sourceRevision).toBe(firstSnapshot.sourceRevision);
        expect(topologySnapshot.sourceRevision).not.toBe(firstSnapshot.sourceRevision);
    });

    test("rediscovers additions and removals on every collection", async () => {
        let collection = 0;
        const process: DockerEngineInventoryProcess = (request) => {
            const current = collection === 0 ? firstId : secondId;
            switch (request.arguments[2]) {
                case "ps": {
                    return Promise.resolve(processResult([current]));
                }
                case "inspect": {
                    return Promise.resolve(processResult([inspectRow(current)]));
                }
                case "image":
                case "volume": {
                    return Promise.resolve(processResult());
                }
                case "stats": {
                    const result = processResult([statsRow(current)]);
                    collection += 1;
                    return Promise.resolve(result);
                }
                default: {
                    throw new Error("Unexpected Docker command");
                }
            }
        };
        const collector = createDockerEngineInventoryCollector({ process });

        const first = await collector.collect();
        const second = await collector.collect();

        expect(first.containers.map((container) => container.id)).toEqual([firstId]);
        expect(second.containers.map((container) => container.id)).toEqual([secondId]);
        expect(first.sourceRevision).not.toBe(second.sourceRevision);
    });

    test("represents a container that disappears during the batched inspect", async () => {
        const fixture = fixtureProcess({
            inspectExitCode: 1,
            inspectRows: [inspectRow(firstId)],
            psIds: [secondId, firstId],
            statsRows: [statsRow(firstId)],
        });

        const snapshot = await createDockerEngineInventoryCollector({
            process: fixture.process,
        }).collect();

        expect(snapshot.containers).toEqual([
            expect.objectContaining({ availability: "available", id: firstId }),
            { availability: "disappeared", id: secondId },
        ]);
        expect(
            fixture.calls.filter((call) => call.arguments[2] === "inspect")
        ).toHaveLength(1);
    });

    test("fails closed when a source command fails without exposing raw output", async () => {
        const calls: DockerEngineInventoryProcessRequest[] = [];
        const process: DockerEngineInventoryProcess = (request) => {
            calls.push(request);
            if (request.arguments[2] === "ps") {
                return Promise.resolve(processResult([firstId]));
            }
            if (request.arguments[2] === "inspect") {
                return Promise.resolve(processResult([inspectRow(firstId)]));
            }
            if (request.arguments[2] === "image") {
                return Promise.resolve(
                    processResult("private-token-in-stdout", {
                        exitCode: 2,
                        stderr: "private-token-in-stderr",
                    })
                );
            }
            return Promise.resolve(processResult());
        };

        const failedCollection = createDockerEngineInventoryCollector({
            process,
        }).collect();
        expect(failedCollection).rejects.toThrow(
            new Error("Docker engine inventory failed")
        );
        await failedCollection.catch(() => {});
        expect(calls.some((call) => call.arguments[2] === "volume")).toBe(true);
        expect(calls.some((call) => call.arguments[2] === "stats")).toBe(true);
    });

    test("bounds membership before inspect and rejects malformed projected data", async () => {
        let inspected = false;
        const overflowProcess: DockerEngineInventoryProcess = (request) => {
            if (request.arguments[2] === "ps") {
                return Promise.resolve(
                    processResult(
                        Array.from(
                            { length: dockerEngineInventoryContainerMaximum + 1 },
                            (_, index) => index.toString(16).padStart(64, "0")
                        )
                    )
                );
            }
            inspected = true;
            return Promise.resolve(processResult());
        };
        const overflowCollection = createDockerEngineInventoryCollector({
            process: overflowProcess,
        }).collect();
        expect(overflowCollection).rejects.toThrow(
            new Error("Docker engine inventory failed")
        );
        await overflowCollection.catch(() => {});
        expect(inspected).toBe(false);

        const malformed = fixtureProcess({
            inspectRows: [
                {
                    ...inspectRow(firstId),
                    networks: [
                        {
                            ipv4Address: "not-an-address",
                            ipv6Address: "",
                            name: "default",
                        },
                    ],
                },
            ],
        });
        const malformedCollection = createDockerEngineInventoryCollector({
            process: malformed.process,
        }).collect();
        expect(malformedCollection).rejects.toThrow(
            new Error("Docker engine inventory failed")
        );
        await malformedCollection.catch(() => {});
    });

    test("rejects invalid deadlines and an already-aborted collection", async () => {
        expect(() => createDockerEngineInventoryCollector({ deadlineMs: 0 })).toThrow(
            new Error("Docker engine inventory failed")
        );
        const controller = new AbortController();
        controller.abort();
        let called = false;
        const process: DockerEngineInventoryProcess = () => {
            called = true;
            return Promise.resolve(processResult());
        };

        const abortedCollection = createDockerEngineInventoryCollector({
            process,
        }).collect(controller.signal);
        expect(abortedCollection).rejects.toThrow(
            new Error("Docker engine inventory failed")
        );
        await abortedCollection.catch(() => {});
        expect(called).toBe(false);
    });
});
