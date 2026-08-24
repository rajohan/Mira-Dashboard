import { describe, expect, test } from "bun:test";

import type { DockerOverviewCachePayload } from "../../contracts/docker.ts";
import type {
    DockerComposeDiscoveredService,
    DockerComposeDiscoveryResult,
} from "./composeDiscovery.ts";
import type { DockerEngineInventorySnapshot } from "./engineInventory.ts";
import {
    dockerEngineComposeIdentities,
    projectDockerOverview,
} from "./overviewProjection.ts";
import { parseDockerImageReference } from "./tagPolicy.ts";

const containerId = "a".repeat(64);
const imageId = `sha256:${"b".repeat(64)}`;

function engineSnapshot(
    overrides: Partial<DockerEngineInventorySnapshot> = {}
): DockerEngineInventorySnapshot {
    return {
        containers: [
            {
                availability: "available",
                createdAt: "2026-08-13T04:00:00.000000000Z",
                finishedAt: "2026-08-13T03:59:59.000000000Z",
                health: "healthy",
                id: containerId,
                imageId,
                imageReference: "example/app:1.0.0",
                labels: {
                    "com.docker.compose.project": "media",
                    "com.docker.compose.project.config_files":
                        "/opt/docker/compose.yaml,/opt/docker/apps/app/compose.yaml",
                    "com.docker.compose.service": "app",
                    "mira.updater.autoUpdate": "true",
                    "mira.updater.enabled": "true",
                },
                mounts: [
                    {
                        destination: "/config",
                        name: "app-data",
                        readOnly: false,
                        type: "volume",
                    },
                ],
                name: "media-app-1",
                networks: [{ addresses: ["172.20.0.2"], name: "media" }],
                publishedPorts: [
                    {
                        containerPort: 8080,
                        hostAddress: "0.0.0.0",
                        hostPort: 8080,
                        protocol: "tcp",
                    },
                    {
                        containerPort: 8080,
                        hostAddress: "::",
                        hostPort: 8080,
                        protocol: "tcp",
                    },
                ],
                restartCount: 2,
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
        ],
        images: [
            {
                createdAt: "2026-08-12 12:00:00 +0200 CEST",
                digest: `sha256:${"c".repeat(64)}`,
                id: imageId,
                repository: "example/app",
                size: "128MB",
                tag: "1.0.0",
            },
        ],
        sourceRevision: "d".repeat(64),
        stats: [
            {
                blockIo: "4kB / 8kB",
                cpuPercent: "0.50%",
                id: containerId,
                memoryPercent: "6.25%",
                memoryUsage: "64MiB / 1GiB",
                networkIo: "1kB / 2kB",
                pids: 4,
            },
        ],
        volumes: [{ driver: "local", name: "app-data", scope: "local" }],
        ...overrides,
    };
}

function discoveredService(
    overrides: Partial<DockerComposeDiscoveredService> = {}
): DockerComposeDiscoveredService {
    const image = parseDockerImageReference("example/app:1.0.0");
    if (image === undefined) throw new Error("Invalid test image");
    return {
        autoUpdate: true,
        composePath: "/opt/docker/apps/app/compose.yaml",
        configFiles: ["/opt/docker/apps/app/compose.yaml", "/opt/docker/compose.yaml"],
        contentSha256: "e".repeat(64),
        enabled: true,
        image,
        imageReference: "example/app:1.0.0",
        labels: {
            "mira.updater.autoUpdate": "true",
            "mira.updater.enabled": "true",
        },
        pinMode: "tag",
        project: "media",
        service: "app",
        tagPolicy: { matchType: "exact", pattern: "1.0.0" },
        ...overrides,
    };
}

function composeResult(
    services: readonly DockerComposeDiscoveredService[] = [discoveredService()]
): DockerComposeDiscoveryResult {
    return {
        composeFiles: ["/opt/docker/apps/app/compose.yaml", "/opt/docker/compose.yaml"],
        services,
        sourceRevision: "f".repeat(64),
    };
}

describe("Docker overview projection", () => {
    test("projects a bounded public snapshot with canonical units and references", () => {
        const payload = projectDockerOverview({
            compose: composeResult(),
            engine: engineSnapshot(),
            observedAtMs: Date.parse("2026-08-13T04:01:00Z"),
        });

        expect(payload.containers).toEqual([
            {
                createdAtMs: Date.parse("2026-08-13T04:00:00Z"),
                health: "healthy",
                id: containerId,
                image: "example/app:1.0.0",
                imageId,
                mounts: [
                    {
                        destination: "/config",
                        name: "app-data",
                        readOnly: false,
                        type: "volume",
                    },
                ],
                name: "media-app-1",
                networks: [{ addresses: ["172.20.0.2"], name: "media" }],
                ports: [
                    {
                        containerPort: 8080,
                        hostPort: 8080,
                        hostScope: "all-interfaces",
                        protocol: "tcp",
                    },
                ],
                project: "media",
                restartCount: 2,
                service: "app",
                startedAtMs: Date.parse("2026-08-13T04:00:01Z"),
                state: "running",
                stats: {
                    blockReadBytes: 4000,
                    blockWrittenBytes: 8000,
                    cpuPercent: 0.5,
                    memoryLimitBytes: 1024 ** 3,
                    memoryPercent: 6.25,
                    memoryUsedBytes: 64 * 1024 ** 2,
                    networkReceivedBytes: 1000,
                    networkSentBytes: 2000,
                    pids: 4,
                },
            },
        ]);
        expect(payload.images).toEqual([
            {
                createdAtMs: Date.parse("2026-08-12T10:00:00Z"),
                id: imageId,
                references: ["example/app:1.0.0"],
                sizeBytes: 128_000_000,
                usedByContainerIds: [containerId],
            },
        ]);
        expect(payload.volumes).toEqual([
            {
                driver: "local",
                name: "app-data",
                scope: "local",
                usedByContainerIds: [containerId],
            },
        ]);
        expect(payload.updaterServices).toMatchObject([
            {
                currentImage: "example/app:1.0.0",
                policy: { automatic: true, state: "managed", track: "tag" },
                project: "media",
                service: "app",
                status: { state: "not-checked" },
            },
        ]);
        expect(payload.sourceRevision).toMatch(/^[0-9a-f]{64}$/u);
        expect(JSON.stringify(payload)).not.toContain("/opt/docker");
        expect(payload.containers[0]?.mounts[0]).not.toHaveProperty("source");
        expect(payload.containers[0]?.mounts[0]).not.toHaveProperty("mode");
        expect(payload.containers[0]?.networks[0]).not.toHaveProperty("gateway");
        expect(payload.containers[0]?.networks[0]).not.toHaveProperty("macAddress");
    });

    test("canonicalizes only safe container network and mount fields", () => {
        const raw = engineSnapshot().containers[0];
        if (raw?.availability !== "available") throw new Error("Missing test container");
        const engine = engineSnapshot({
            containers: [
                {
                    ...raw,
                    mounts: [
                        {
                            destination: "/var/lib/app",
                            readOnly: true,
                            type: "bind",
                        },
                        {
                            destination: "/config",
                            name: "app-data",
                            readOnly: false,
                            type: "volume",
                        },
                    ],
                    networks: [
                        { addresses: [], name: "z-backend" },
                        {
                            addresses: ["2001:db8::2", "172.20.0.2"],
                            name: "a-frontend",
                        },
                    ],
                },
            ],
        });

        const payload = projectDockerOverview({
            compose: composeResult(),
            engine,
            observedAtMs: Date.parse("2026-08-13T04:01:00Z"),
        });

        expect(payload.containers[0]?.networks).toEqual([
            {
                addresses: ["172.20.0.2", "2001:db8::2"],
                name: "a-frontend",
            },
            { addresses: [], name: "z-backend" },
        ]);
        expect(payload.containers[0]?.mounts).toEqual([
            {
                destination: "/config",
                name: "app-data",
                readOnly: false,
                type: "volume",
            },
            {
                destination: "/var/lib/app",
                readOnly: true,
                type: "bind",
            },
        ]);
    });

    test("derives unique dynamic Compose identities without names as authority", () => {
        expect(dockerEngineComposeIdentities(engineSnapshot())).toEqual([
            {
                configFiles: [
                    "/opt/docker/apps/app/compose.yaml",
                    "/opt/docker/compose.yaml",
                ],
                project: "media",
                service: "app",
            },
        ]);
    });

    test("retains foreign config collisions until root-graph authority filters them", () => {
        const original = engineSnapshot().containers[0];
        if (original?.availability !== "available") {
            throw new Error("Missing test container");
        }
        const foreign = (id: string, configFile: string) => ({
            ...original,
            id,
            labels: {
                "com.docker.compose.project": "foreign",
                "com.docker.compose.project.config_files": configFile,
                "com.docker.compose.service": "shared",
            },
        });

        expect(
            dockerEngineComposeIdentities(
                engineSnapshot({
                    containers: [
                        original,
                        foreign("c".repeat(64), "/foreign/first.yaml"),
                        foreign("e".repeat(64), "/foreign/second.yaml"),
                    ],
                })
            ).map(({ configFiles, project, service }) => ({
                configFiles,
                project,
                service,
            }))
        ).toEqual([
            {
                configFiles: ["/foreign/first.yaml"],
                project: "foreign",
                service: "shared",
            },
            {
                configFiles: ["/foreign/second.yaml"],
                project: "foreign",
                service: "shared",
            },
            {
                configFiles: [
                    "/opt/docker/apps/app/compose.yaml",
                    "/opt/docker/compose.yaml",
                ],
                project: "media",
                service: "app",
            },
        ]);
    });

    test("does not expose Docker's previous finish timestamp after restart", () => {
        const payload = projectDockerOverview({
            compose: composeResult(),
            engine: engineSnapshot(),
            observedAtMs: Date.parse("2026-08-13T04:01:00Z"),
        });

        expect(payload.containers[0]?.startedAtMs).toBe(
            Date.parse("2026-08-13T04:00:01Z")
        );
        expect(payload.containers[0]?.finishedAtMs).toBeUndefined();
    });

    test("fails closed when a container disappears during collection", () => {
        const engine = engineSnapshot({
            containers: [{ availability: "disappeared", id: containerId }],
        });
        expect(() => dockerEngineComposeIdentities(engine)).toThrow(
            "Docker overview projection failed"
        );
        expect(() =>
            projectDockerOverview({
                compose: composeResult(),
                engine,
                observedAtMs: Date.now(),
            })
        ).toThrow("Docker overview projection failed");
    });

    test("retains updater state only while source, image, and effective policy are unchanged", () => {
        const first = projectDockerOverview({
            compose: composeResult(),
            engine: engineSnapshot(),
            observedAtMs: Date.parse("2026-08-13T04:01:00Z"),
        });
        const previous: DockerOverviewCachePayload = {
            ...first,
            updaterServices: [
                {
                    ...first.updaterServices[0]!,
                    status: {
                        candidateImage: "example/app:1.1.0",
                        state: "update-available",
                    },
                },
            ],
        };

        const unchanged = projectDockerOverview({
            compose: composeResult(),
            engine: engineSnapshot(),
            observedAtMs: Date.parse("2026-08-13T04:02:00Z"),
            previous,
        });
        expect(unchanged.updaterServices[0]?.status).toEqual({
            candidateImage: "example/app:1.1.0",
            state: "update-available",
        });

        const changedService = discoveredService({
            imageReference: "example/app:1.1.0",
        });
        const changed = projectDockerOverview({
            compose: composeResult([changedService]),
            engine: engineSnapshot(),
            observedAtMs: Date.parse("2026-08-13T04:03:00Z"),
            previous,
        });
        expect(changed.updaterServices[0]?.status).toEqual({ state: "not-checked" });

        const changedPolicy = projectDockerOverview({
            compose: {
                ...composeResult([
                    discoveredService({
                        labels: {
                            "mira.updater.autoUpdate": "true",
                            "mira.updater.enabled": "true",
                            "mira.updater.tagPattern": String.raw`^1\.\d+\.\d+$`,
                        },
                        tagPolicy: {
                            matchType: "regex",
                            pattern: String.raw`^1\.\d+\.\d+$`,
                        },
                    }),
                ]),
                sourceRevision: "1".repeat(64),
            },
            engine: engineSnapshot(),
            observedAtMs: Date.parse("2026-08-13T04:04:00Z"),
            previous,
        });
        expect(changedPolicy.updaterServices[0]?.currentImage).toBe("example/app:1.0.0");
        expect(changedPolicy.updaterServices[0]?.status).toEqual({
            state: "not-checked",
        });
    });

    test("removes deleted updater services after one complete new discovery", () => {
        const payload = projectDockerOverview({
            compose: composeResult([]),
            engine: engineSnapshot(),
            observedAtMs: Date.now(),
        });
        expect(payload.updaterServices).toEqual([]);
    });

    test("binds the public CAS revision to the complete private Compose graph digest", () => {
        const first = projectDockerOverview({
            compose: composeResult(),
            engine: engineSnapshot(),
            observedAtMs: Date.now(),
        });
        const changed = projectDockerOverview({
            compose: { ...composeResult(), sourceRevision: "1".repeat(64) },
            engine: engineSnapshot(),
            observedAtMs: Date.now(),
        });

        expect(changed.sourceRevision).not.toBe(first.sourceRevision);
    });

    test("keeps explicit false opt-in inventory-only", () => {
        const payload = projectDockerOverview({
            compose: composeResult([
                discoveredService({
                    autoUpdate: false,
                    enabled: false,
                    labels: { "mira.updater.enabled": "false" },
                    tagPolicy: undefined,
                }),
            ]),
            engine: engineSnapshot(),
            observedAtMs: Date.now(),
        });
        expect(payload.updaterServices[0]?.policy).toEqual({
            reason: "disabled",
            state: "inventory-only",
        });
    });

    test("projects an ambiguous Compose owner as inventory-only", () => {
        const payload = projectDockerOverview({
            compose: composeResult([
                discoveredService({
                    autoUpdate: false,
                    enabled: false,
                    sourceAmbiguous: true,
                    tagPolicy: undefined,
                }),
            ]),
            engine: engineSnapshot(),
            observedAtMs: Date.now(),
        });

        expect(payload.updaterServices[0]?.policy).toEqual({
            reason: "ambiguous-source",
            state: "inventory-only",
        });
    });
});
