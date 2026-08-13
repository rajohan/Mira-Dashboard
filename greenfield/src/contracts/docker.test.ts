import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { cacheEntryPayloadMaximumBytes } from "./cache.ts";
import {
    dockerContainerLogTailDefault,
    dockerContainerLogTailMaximum,
    dockerContainerMaximum,
    dockerContainerMountMaximum,
    dockerContainerNetworkMaximum,
    dockerGetContainerLogsInputSchema,
    dockerGetContainerLogsResultSchema,
    dockerOperationIds,
    dockerOverviewCacheKey,
    dockerOverviewCachePayloadMaximumBytes,
    dockerOverviewCachePayloadSchema,
    dockerOverviewCacheSchemaId,
    dockerOverviewCacheSource,
    dockerOverviewSchema,
    dockerPreparePruneResultSchema,
    dockerProcedureContracts,
    dockerRequestOperationInputSchema,
    dockerRequestOperationResultSchema,
    dockerUpdaterEventKinds,
    dockerUpdaterEventSchema,
} from "./docker.ts";

const containerId = "a".repeat(64);
const imageId = `sha256:${"b".repeat(64)}`;
const revision = "c".repeat(64);
const serviceId = "d".repeat(64);
const idempotencyKey = "A".repeat(43);
const ticketId = "018f6f50-6a9e-7b88-8000-000000000001";
const jobRunId = "018f6f50-6a9e-7b88-8000-000000000002";

function payload() {
    return {
        containers: [
            {
                createdAtMs: 100,
                health: "healthy" as const,
                id: containerId,
                image: "example/service:1.0.0",
                imageId,
                mounts: [
                    {
                        destination: "/data",
                        name: "service-data",
                        readOnly: false,
                        type: "volume",
                    },
                ],
                name: "service-1",
                networks: [
                    {
                        addresses: ["172.20.0.2", "2001:db8::2"],
                        name: "mira-default",
                    },
                ],
                ports: [
                    {
                        containerPort: 8080,
                        hostPort: 18_080,
                        hostScope: "loopback" as const,
                        protocol: "tcp" as const,
                    },
                ],
                project: "mira",
                restartCount: 0,
                service: "service",
                startedAtMs: 200,
                state: "running" as const,
                stats: {
                    blockReadBytes: 1,
                    blockWrittenBytes: 2,
                    cpuPercent: 3.5,
                    memoryLimitBytes: 200,
                    memoryPercent: 50,
                    memoryUsedBytes: 100,
                    networkReceivedBytes: 3,
                    networkSentBytes: 4,
                    pids: 5,
                },
            },
        ],
        images: [
            {
                createdAtMs: 50,
                id: imageId,
                references: ["example/service:1.0.0"],
                sizeBytes: 1000,
                usedByContainerIds: [containerId],
            },
        ],
        observedAtMs: 1000,
        sourceRevision: revision,
        updaterEvents: [
            {
                atMs: 900,
                id: "018f6f50-6a9e-7b88-8000-000000000003",
                kind: "update-available" as const,
                serviceId,
                summary: "An update is available",
            },
        ],
        updaterServices: [
            {
                currentImage: "example/service:1.0.0",
                id: serviceId,
                policy: {
                    automatic: true,
                    state: "managed" as const,
                    track: "tag" as const,
                },
                project: "mira",
                service: "service",
                status: {
                    candidateImage: "example/service:1.1.0",
                    state: "update-available" as const,
                },
            },
        ],
        volumes: [
            {
                driver: "local",
                name: "service-data",
                scope: "local" as const,
                sizeBytes: 500,
                usedByContainerIds: [containerId],
            },
        ],
    };
}

describe("Docker contracts", () => {
    test("uses Jobs as the sole durable queued-operation state", () => {
        expect(dockerUpdaterEventKinds).not.toContain("update-queued");
        expect(
            v.safeParse(dockerUpdaterEventSchema, {
                atMs: 900,
                id: "018f6f50-6a9e-7b88-8000-000000000003",
                kind: "update-queued",
                summary: "Docker update queued",
            }).success
        ).toBeFalse();
    });

    test("locks the cache identity and a strict bounded provider payload", () => {
        expect({
            key: dockerOverviewCacheKey,
            schemaId: dockerOverviewCacheSchemaId,
            source: dockerOverviewCacheSource,
        }).toEqual({
            key: "docker.overview",
            schemaId: "docker.overview.v1",
            source: "docker-engine.compose",
        });
        expect(dockerOverviewCachePayloadMaximumBytes).toBeLessThanOrEqual(
            cacheEntryPayloadMaximumBytes
        );
        expect(v.parse(dockerOverviewCachePayloadSchema, payload())).toEqual(payload());

        for (const invalid of [
            { ...payload(), environment: ["SECRET=value"] },
            {
                ...payload(),
                containers: [{ ...payload().containers[0], labels: { secret: "value" } }],
            },
            {
                ...payload(),
                containers: [
                    {
                        ...payload().containers[0],
                        mounts: [
                            {
                                ...payload().containers[0]!.mounts[0]!,
                                source: "/secret",
                            },
                        ],
                    },
                ],
            },
            {
                ...payload(),
                containers: [
                    {
                        ...payload().containers[0],
                        networks: [
                            {
                                ...payload().containers[0]!.networks[0]!,
                                gateway: "172.20.0.1",
                            },
                        ],
                    },
                ],
            },
            {
                ...payload(),
                containers: [
                    { ...payload().containers[0], imageId: `sha256:${"f".repeat(64)}` },
                ],
            },
            {
                ...payload(),
                images: [
                    { ...payload().images[0], usedByContainerIds: ["f".repeat(64)] },
                ],
            },
        ]) {
            expect(
                v.safeParse(dockerOverviewCachePayloadSchema, invalid).success
            ).toBeFalse();
        }

        expect(
            v.safeParse(dockerOverviewCachePayloadSchema, {
                ...payload(),
                containers: Array.from(
                    { length: dockerContainerMaximum + 1 },
                    (_, index) => ({
                        ...payload().containers[0],
                        id: index.toString(16).padStart(64, "0"),
                    })
                ),
                images: [],
            }).success
        ).toBeFalse();
    });

    test("accepts only bounded canonical safe network and mount projections", () => {
        const base = payload();
        const container = base.containers[0]!;
        const withContainer = (value: unknown) => ({
            ...base,
            containers: [value],
        });
        for (const invalidContainer of [
            {
                ...container,
                networks: [
                    {
                        addresses: ["2001:db8::2", "172.20.0.2"],
                        name: "mira-default",
                    },
                ],
            },
            {
                ...container,
                networks: [{ addresses: ["not-an-ip-address"], name: "mira-default" }],
            },
            {
                ...container,
                networks: [
                    { addresses: [], name: "z-network" },
                    { addresses: [], name: "a-network" },
                ],
            },
            {
                ...container,
                networks: Array.from(
                    { length: dockerContainerNetworkMaximum + 1 },
                    (_, index) => ({
                        addresses: [],
                        name: `network-${String(index).padStart(3, "0")}`,
                    })
                ),
            },
            {
                ...container,
                mounts: [
                    { destination: "/z", readOnly: false, type: "volume" },
                    { destination: "/a", readOnly: false, type: "volume" },
                ],
            },
            {
                ...container,
                mounts: [{ destination: "relative", readOnly: false, type: "bind" }],
            },
            {
                ...container,
                mounts: Array.from(
                    { length: dockerContainerMountMaximum + 1 },
                    (_, index) => ({
                        destination: `/mount/${String(index).padStart(3, "0")}`,
                        readOnly: false,
                        type: "volume",
                    })
                ),
            },
        ]) {
            expect(
                v.safeParse(
                    dockerOverviewCachePayloadSchema,
                    withContainer(invalidContainer)
                ).success
            ).toBeFalse();
        }
    });

    test("accepts only causal fresh, retained, and unavailable overview states", () => {
        expect(
            v.parse(dockerOverviewSchema, {
                ...payload(),
                checkedAtMs: 1100,
                state: "fresh",
            }).state
        ).toBe("fresh");
        expect(
            v.parse(dockerOverviewSchema, {
                ...payload(),
                checkedAtMs: 1200,
                staleSinceMs: 1100,
                state: "last-known-good",
            }).state
        ).toBe("last-known-good");
        expect(
            v.parse(dockerOverviewSchema, {
                checkedAtMs: 1200,
                state: "unavailable",
            })
        ).toEqual({ checkedAtMs: 1200, state: "unavailable" });

        for (const invalid of [
            { ...payload(), checkedAtMs: 999, state: "fresh" },
            {
                ...payload(),
                checkedAtMs: 1200,
                staleSinceMs: 900,
                state: "last-known-good",
            },
            {
                checkedAtMs: 1200,
                error: "docker inspect: SECRET=value",
                state: "unavailable",
            },
        ]) {
            expect(v.safeParse(dockerOverviewSchema, invalid).success).toBeFalse();
        }
    });

    test("requires exact full container ids and bounded redacted log output", () => {
        expect(
            v.parse(dockerGetContainerLogsInputSchema, {
                containerId,
                sourceRevision: revision,
            })
        ).toEqual({
            containerId,
            sourceRevision: revision,
            tail: dockerContainerLogTailDefault,
        });
        expect(
            v.parse(dockerGetContainerLogsResultSchema, {
                containerId,
                lines: ["password=[REDACTED]"],
                observedAtMs: 1100,
                redacted: true,
                sourceRevision: revision,
                truncated: false,
            }).redacted
        ).toBeTrue();

        for (const invalid of [
            { containerId: containerId.slice(0, 12), sourceRevision: revision },
            {
                containerId,
                sourceRevision: revision,
                tail: dockerContainerLogTailMaximum + 1,
            },
            {
                containerId,
                lines: ["bad\0line"],
                observedAtMs: 1100,
                redacted: true,
                sourceRevision: revision,
                truncated: false,
            },
            {
                containerId,
                lines: ["line"],
                observedAtMs: 1100,
                output: "raw output",
                redacted: true,
                sourceRevision: revision,
                truncated: false,
            },
        ]) {
            const schema =
                "lines" in invalid
                    ? dockerGetContainerLogsResultSchema
                    : dockerGetContainerLogsInputSchema;
            expect(v.safeParse(schema, invalid).success).toBeFalse();
        }
    });

    test("issues only short source-bound typed prune preview tickets", () => {
        const common = {
            estimatedReclaimableBytes: 1000,
            expiresAtMs: 2000,
            issuedAtMs: 1000,
            sourceRevision: revision,
            ticketId,
        };
        expect(
            v.parse(dockerPreparePruneResultSchema, {
                ...common,
                items: [{ id: imageId, references: [], sizeBytes: 1000 }],
                target: "images",
            }).target
        ).toBe("images");
        expect(
            v.parse(dockerPreparePruneResultSchema, {
                ...common,
                items: [{ name: "unused-data", sizeBytes: 1000 }],
                target: "volumes",
            }).target
        ).toBe("volumes");

        for (const invalid of [
            {
                ...common,
                expiresAtMs: common.issuedAtMs,
                items: [],
                target: "images",
            },
            {
                ...common,
                expiresAtMs: common.issuedAtMs + 5 * 60 * 1000 + 1,
                items: [],
                target: "volumes",
            },
            {
                ...common,
                items: [{ mountpoint: "/opt/docker/data", name: "unused-data" }],
                target: "volumes",
            },
        ]) {
            expect(
                v.safeParse(dockerPreparePruneResultSchema, invalid).success
            ).toBeFalse();
        }
    });

    test("admits only exact confirmed idempotent operations and no generic exec", () => {
        const valid = [
            {
                confirmation: "restart-docker-container",
                containerId,
                operation: "container-restart",
            },
            {
                confirmation: "start-docker-container",
                containerId,
                operation: "container-start",
            },
            {
                confirmation: "stop-docker-container",
                containerId,
                operation: "container-stop",
            },
            { confirmation: "delete-docker-image", imageId, operation: "image-delete" },
            {
                confirmation: "prune-docker-images",
                operation: "prune-execute",
                target: "images",
                ticketId,
            },
            { confirmation: "restart-docker-stack", operation: "stack-restart" },
            { confirmation: "start-docker-stack", operation: "stack-start" },
            { confirmation: "stop-docker-stack", operation: "stack-stop" },
            { confirmation: "run-docker-updates", operation: "updater-run" },
            { confirmation: "scan-docker-updates", operation: "updater-scan" },
            {
                candidateImage: "example/service:1.1.0",
                confirmation: "update-docker-service",
                currentImage: "example/service:1.0.0",
                operation: "updater-update-service",
                serviceId,
            },
            {
                confirmation: "delete-docker-volume",
                operation: "volume-delete",
                volumeName: "unused-data",
            },
        ] as const;
        expect(valid.map(({ operation }) => operation).toSorted()).toEqual(
            [...dockerOperationIds].toSorted()
        );
        for (const operation of valid) {
            expect(
                v.parse(dockerRequestOperationInputSchema, {
                    ...operation,
                    idempotencyKey,
                    sourceRevision: revision,
                }).operation
            ).toBe(operation.operation);
        }

        for (const invalid of [
            {
                confirmation: "restart-docker-container",
                containerId,
                idempotencyKey,
                operation: "container-stop",
                sourceRevision: revision,
            },
            {
                confirmation: "prune-docker-volumes",
                idempotencyKey,
                operation: "prune-execute",
                sourceRevision: revision,
                target: "images",
                ticketId,
            },
            {
                confirmation: "update-docker-service",
                idempotencyKey,
                operation: "updater-update-service",
                serviceId,
                sourceRevision: revision,
            },
            {
                command: "sh -c env",
                confirmation: "exec-docker-command",
                containerId,
                idempotencyKey,
                operation: "exec",
                sourceRevision: revision,
            },
            {
                argv: ["compose", "down"],
                confirmation: "stop-docker-stack",
                idempotencyKey,
                operation: "stack-stop",
                sourceRevision: revision,
            },
            {
                confirmation: "delete-docker-volume",
                idempotencyKey,
                operation: "volume-delete",
                path: "/opt/docker/data",
                sourceRevision: revision,
                volumeName: "unused-data",
            },
        ]) {
            expect(
                v.safeParse(dockerRequestOperationInputSchema, invalid).success
            ).toBeFalse();
        }

        expect(
            v.parse(dockerRequestOperationResultSchema, {
                jobRunId,
                operation: "updater-scan",
                queued: true,
            })
        ).toEqual({ jobRunId, operation: "updater-scan", queued: true });
    });

    test("declares session reads and one recent-MFA operation boundary", () => {
        expect(
            dockerProcedureContracts.map(({ access, kind, name }) => ({
                access,
                kind,
                name,
            }))
        ).toEqual([
            {
                access: {
                    capabilities: ["docker:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                kind: "query",
                name: "docker.overview",
            },
            {
                access: {
                    capabilities: ["docker:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                kind: "query",
                name: "docker.getContainerLogs",
            },
            {
                access: {
                    capabilities: ["docker:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                kind: "query",
                name: "docker.preparePrune",
            },
            {
                access: {
                    capabilities: ["docker:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                kind: "mutation",
                name: "docker.requestOperation",
            },
        ]);
    });
});
