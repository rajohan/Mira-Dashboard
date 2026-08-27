import { describe, expect, test } from "bun:test";

import type { DockerComposeDiscoveryResult } from "./composeDiscovery.ts";
import type { DockerEngineInventorySnapshot } from "./engineInventory.ts";
import {
    createDockerOverviewCollector,
    DockerOverviewDiscoveryError,
} from "./overviewCollector.ts";
import { parseDockerImageReference } from "./tagPolicy.ts";

const containerId = "a".repeat(64);
const imageId = `sha256:${"b".repeat(64)}`;

function engineSnapshot(): DockerEngineInventorySnapshot {
    return {
        containers: [
            {
                availability: "available",
                createdAt: "2026-08-13T04:00:00Z",
                finishedAt: "0001-01-01T00:00:00Z",
                health: null,
                id: containerId,
                imageId,
                imageReference: "example/app:1.0.0",
                labels: {
                    "com.docker.compose.project": "media",
                    "com.docker.compose.project.config_files":
                        "/opt/docker/compose.yaml,/opt/docker/apps/app/compose.yaml",
                    "com.docker.compose.service": "app",
                },
                mounts: [],
                name: "media-app-1",
                networks: [],
                publishedPorts: [],
                restartCount: 0,
                startedAt: "2026-08-13T04:00:01Z",
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
                digest: "<none>",
                id: imageId,
                repository: "example/app",
                size: "1MB",
                tag: "1.0.0",
            },
        ],
        sourceRevision: "c".repeat(64),
        stats: [],
        volumes: [],
    };
}

function composeResult(): DockerComposeDiscoveryResult {
    const image = parseDockerImageReference("example/app:1.0.0");
    if (image === undefined) throw new Error("Invalid test image");
    return {
        composeFiles: ["/opt/docker/apps/app/compose.yaml", "/opt/docker/compose.yaml"],
        services: [
            {
                autoUpdate: false,
                composePath: "/opt/docker/apps/app/compose.yaml",
                configFiles: [
                    "/opt/docker/apps/app/compose.yaml",
                    "/opt/docker/compose.yaml",
                ],
                contentSha256: "d".repeat(64),
                enabled: false,
                image,
                imageReference: "example/app:1.0.0",
                labels: {},
                pinMode: "tag",
                project: "media",
                service: "app",
            },
        ],
        sourceRevision: "e".repeat(64),
    };
}

describe("Docker overview collector", () => {
    test("rediscovers Engine and Compose membership for every collection", async () => {
        let engineCalls = 0;
        let composeCalls = 0;
        const collector = createDockerOverviewCollector({
            discoverCompose(identities) {
                composeCalls += 1;
                expect(identities).toHaveLength(1);
                return composeResult();
            },
            engine: {
                collect() {
                    engineCalls += 1;
                    return Promise.resolve(engineSnapshot());
                },
            },
            nowMs: () => Date.parse("2026-08-13T04:01:00Z"),
        });

        await collector.collect();
        await collector.collect();
        expect({ composeCalls, engineCalls }).toEqual({
            composeCalls: 2,
            engineCalls: 2,
        });
    });

    test("ignores malformed retained state instead of trusting it", async () => {
        const collector = createDockerOverviewCollector({
            discoverCompose: composeResult,
            engine: { collect: () => Promise.resolve(engineSnapshot()) },
            nowMs: () => Date.parse("2026-08-13T04:01:00Z"),
        });

        const payload = await collector.collect({ updaterServices: "untrusted" });
        expect(payload.updaterServices[0]?.status).toEqual({ state: "not-checked" });
    });

    test("propagates cancellation without publishing a partial empty snapshot", async () => {
        const controller = new AbortController();
        controller.abort();
        const collector = createDockerOverviewCollector({
            discoverCompose: composeResult,
            engine: { collect: () => Promise.resolve(engineSnapshot()) },
        });
        const failure = await collector.collect({}, controller.signal).then(
            () => null,
            (error: unknown) => error
        );
        expect(failure).toHaveProperty("name", "AbortError");
    });

    test("classifies every discovery stage without exposing details", async () => {
        const engineFailure = createDockerOverviewCollector({
            discoverCompose: composeResult,
            engine: {
                collect: () => Promise.reject(new Error("private engine diagnostic")),
            },
        });
        expect(engineFailure.collect()).rejects.toMatchObject({
            message: "Docker overview discovery failed",
            stage: "engine-inventory",
        } satisfies Partial<DockerOverviewDiscoveryError>);

        const composeFailure = createDockerOverviewCollector({
            discoverCompose: () => {
                throw new Error("private Compose diagnostic");
            },
            engine: { collect: () => Promise.resolve(engineSnapshot()) },
        });
        expect(composeFailure.collect()).rejects.toMatchObject({
            message: "Docker overview discovery failed",
            stage: "compose-discovery",
        } satisfies Partial<DockerOverviewDiscoveryError>);

        const projectionFailure = createDockerOverviewCollector({
            discoverCompose: composeResult,
            engine: { collect: () => Promise.resolve(engineSnapshot()) },
            nowMs: () => Number.NaN,
        });
        expect(projectionFailure.collect()).rejects.toMatchObject({
            message: "Docker overview discovery failed",
            stage: "overview-projection",
        } satisfies Partial<DockerOverviewDiscoveryError>);
    });
});
