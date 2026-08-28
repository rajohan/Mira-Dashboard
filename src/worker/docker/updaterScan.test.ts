import { describe, expect, test } from "bun:test";

import type {
    DockerOverviewCachePayload,
    DockerUpdaterStatus,
} from "../../contracts/docker.ts";
import type {
    DockerComposeDiscoveredService,
    DockerComposeDiscoveryResult,
} from "./composeDiscovery.ts";
import { parseDockerImageReference } from "./tagPolicy.ts";
import { scanDockerUpdates } from "./updaterScan.ts";

const serviceId = "a".repeat(64);
const sourceRevision = "b".repeat(64);

function sourceService(
    overrides: Partial<DockerComposeDiscoveredService> = {}
): DockerComposeDiscoveredService {
    const image = parseDockerImageReference("ghcr.io/example/app:1.0.0");
    if (image === undefined) throw new Error("Invalid test image");
    return {
        autoUpdate: true,
        composePath: "/opt/docker/apps/app/compose.yaml",
        configFiles: ["/opt/docker/apps/app/compose.yaml", "/opt/docker/compose.yaml"],
        contentSha256: "c".repeat(64),
        enabled: true,
        image,
        imageReference: "ghcr.io/example/app:1.0.0",
        labels: {
            "mira.updater.autoUpdate": "true",
            "mira.updater.enabled": "true",
        },
        pinMode: "tag",
        project: "media",
        service: "app",
        tagPolicy: { matchType: "regex", pattern: String.raw`^\d+\.\d+\.\d+$` },
        ...overrides,
    };
}

function compose(
    services: readonly DockerComposeDiscoveredService[] = [sourceService()]
): DockerComposeDiscoveryResult {
    return {
        composeFiles: ["/opt/docker/compose.yaml"],
        settlementRevision: "e".repeat(64),
        services,
        sourceRevision: "d".repeat(64),
    };
}

function payload(status?: DockerUpdaterStatus): DockerOverviewCachePayload {
    return {
        containers: [
            {
                createdAtMs: 900,
                health: "healthy",
                id: "1".repeat(64),
                image: "ghcr.io/example/app:1.0.0",
                imageId: `sha256:${"2".repeat(64)}`,
                mounts: [],
                name: "media-app-1",
                networks: [],
                ports: [],
                project: "media",
                restartCount: 0,
                service: "app",
                startedAtMs: 950,
                state: "running",
            },
        ],
        images: [
            {
                createdAtMs: 800,
                id: `sha256:${"2".repeat(64)}`,
                references: ["ghcr.io/example/app:1.0.0"],
                sizeBytes: 100,
                usedByContainerIds: ["1".repeat(64)],
            },
        ],
        observedAtMs: 1000,
        sourceRevision,
        updaterEvents: [],
        updaterServices: [
            {
                currentImage: "ghcr.io/example/app:1.0.0",
                id: serviceId,
                policy: {
                    automatic: true,
                    state: "managed",
                    track: "tag",
                },
                project: "media",
                service: "app",
                status: status ?? { state: "unavailable" },
            },
        ],
        volumes: [],
    };
}

function ids() {
    let next = 0;
    return () => {
        next += 1;
        return `018f6f50-6a9e-7b88-8000-${String(next).padStart(12, "0")}`;
    };
}

describe("Docker updater scan", () => {
    test("reports durable per-service scan progress", async () => {
        const progress: unknown[] = [];
        const input = payload();
        input.updaterServices.push({
            currentImage: "ghcr.io/example/app:1.0.0",
            id: "b".repeat(64),
            policy: { automatic: true, state: "managed", track: "tag" },
            project: "downloads",
            service: "second",
            status: { state: "unavailable" },
        });
        await scanDockerUpdates(
            compose([
                sourceService(),
                sourceService({
                    project: "downloads",
                    service: "second",
                    contentSha256: "f".repeat(64),
                }),
            ]),
            input,
            undefined,
            {
                generateId: ids(),
                lookup: () =>
                    Promise.resolve({
                        digest: `sha256:${"d".repeat(64)}`,
                        tag: "1.0.0",
                    }),
                nowMs: () => 2000,
                platform: "linux/amd64",
                reportProgress: (value) => {
                    progress.push(value);
                    return Promise.resolve();
                },
            }
        );

        expect(progress).toEqual([
            {
                completed: 1,
                message: expect.stringMatching(/^Checked /u),
                phase: "scanning",
                total: 2,
            },
            {
                completed: 2,
                message: expect.stringMatching(/^Checked /u),
                phase: "scanning",
                total: 2,
            },
        ]);
    });

    test("emits one transition and canonical candidate for a newer matching tag", async () => {
        const result = await scanDockerUpdates(compose(), payload(), undefined, {
            generateId: ids(),
            lookup: () =>
                Promise.resolve({ digest: `sha256:${"d".repeat(64)}`, tag: "1.1.0" }),
            nowMs: () => 2000,
            platform: "linux/amd64",
        });

        expect(result.payload.updaterServices[0]?.status).toEqual({
            candidateImage: "ghcr.io/example/app:1.1.0",
            state: "update-available",
        });
        expect(result.events.map(({ kind }) => kind)).toEqual([
            "update-available",
            "scan-completed",
        ]);
        expect(result.payload.updaterEvents.map(({ kind }) => kind)).toEqual([
            "update-available",
            "scan-completed",
        ]);
    });

    test("does not repeat an unchanged update-available transition", async () => {
        const result = await scanDockerUpdates(
            compose(),
            payload({
                candidateImage: "ghcr.io/example/app:1.1.0",
                state: "update-available",
            }),
            undefined,
            {
                generateId: ids(),
                lookup: () =>
                    Promise.resolve({
                        digest: `sha256:${"d".repeat(64)}`,
                        tag: "1.1.0",
                    }),
                nowMs: () => 2000,
                platform: "linux/amd64",
            }
        );
        expect(result.events.map(({ kind }) => kind)).toEqual(["scan-completed"]);
    });

    test("tracks exact platform digest changes for digest-pinned services", async () => {
        const currentDigest = `sha256:${"e".repeat(64)}`;
        const imageReference = `ghcr.io/example/app:latest@${currentDigest}`;
        const image = parseDockerImageReference(imageReference);
        if (image === undefined) throw new Error("Invalid digest test image");
        const service = sourceService({
            image,
            imageReference,
            pinMode: "digest",
            tagPolicy: { matchType: "exact", pattern: "latest" },
        });
        const input = payload();
        input.updaterServices[0] = {
            ...input.updaterServices[0]!,
            currentImage: imageReference,
            policy: {
                automatic: true,
                state: "managed",
                track: "digest",
            },
        };
        input.containers[0] = { ...input.containers[0]!, image: imageReference };
        input.images[0] = { ...input.images[0]!, references: [imageReference] };
        const nextDigest = `sha256:${"f".repeat(64)}`;
        const result = await scanDockerUpdates(compose([service]), input, undefined, {
            generateId: ids(),
            lookup: () => Promise.resolve({ digest: nextDigest, tag: "latest" }),
            nowMs: () => 2000,
            platform: "linux/arm64/v8",
        });
        expect(result.payload.updaterServices[0]?.status).toEqual({
            candidateImage: `ghcr.io/example/app:latest@${nextDigest}`,
            state: "update-available",
        });
    });

    test("isolates registry failure and revokes a previously known candidate", async () => {
        const known: DockerUpdaterStatus = {
            candidateImage: "ghcr.io/example/app:1.1.0",
            state: "update-available",
        };
        const result = await scanDockerUpdates(compose(), payload(known), undefined, {
            generateId: ids(),
            lookup: () => Promise.reject(new Error("raw provider secret")),
            nowMs: () => 2000,
            platform: "linux/amd64",
        });
        expect(result.payload.updaterServices[0]?.status).toEqual({
            state: "unavailable",
        });
        expect(result.events).toMatchObject([
            {
                kind: "scan-failed",
                summary:
                    "Registry lookup was unavailable for 1 of 1 services; stale candidates cannot authorize updates.",
            },
        ]);
        expect(JSON.stringify(result)).not.toContain("raw provider secret");
    });

    test("does not scan or authorize an update for an ineligible managed runtime", async () => {
        const input = payload({
            candidateImage: "ghcr.io/example/app:1.1.0",
            state: "update-available",
        });
        input.containers[0] = {
            ...input.containers[0]!,
            health: "unhealthy",
        };
        let calls = 0;

        const result = await scanDockerUpdates(compose(), input, undefined, {
            generateId: ids(),
            lookup: () => {
                calls += 1;
                return Promise.resolve({
                    digest: `sha256:${"d".repeat(64)}`,
                    tag: "1.1.0",
                });
            },
            nowMs: () => 2000,
            platform: "linux/amd64",
        });

        expect(calls).toBe(0);
        expect(result.payload.updaterServices[0]?.status).toEqual({
            state: "not-checked",
        });
        expect(result.events.map(({ kind }) => kind)).toEqual(["scan-completed"]);
    });

    test("never calls a registry for an inventory-only service", async () => {
        let calls = 0;
        const source = sourceService({
            autoUpdate: false,
            enabled: false,
            labels: { "mira.updater.enabled": "false" },
            tagPolicy: undefined,
        });
        const input = payload();
        input.updaterServices[0] = {
            ...input.updaterServices[0]!,
            policy: { reason: "disabled", state: "inventory-only" },
        };
        const result = await scanDockerUpdates(compose([source]), input, undefined, {
            generateId: ids(),
            lookup: () => {
                calls += 1;
                return Promise.reject(new Error("must not run"));
            },
            nowMs: () => 2000,
            platform: "linux/amd64",
        });
        expect(calls).toBe(0);
        expect(result.events.map(({ kind }) => kind)).toEqual(["scan-completed"]);
    });
});
