import { describe, expect, test } from "bun:test";

import {
    type DockerOverviewCachePayload,
    dockerPrunePreviewTicketTtlMs,
} from "../../../contracts/docker.ts";
import { captureFailure } from "../../test/support/promise.ts";
import { DockerOperationQueueError } from "./operationQueue.ts";
import {
    createDockerService,
    type DockerControlContext,
    type DockerServiceOptions,
    DockerServiceError,
} from "./service.ts";
import type { DockerOverviewSnapshotRecord } from "./snapshotRepository.ts";

const containerId = "a".repeat(64);
const usedImageId = `sha256:${"b".repeat(64)}`;
const unusedImageId = `sha256:${"c".repeat(64)}`;
const sourceRevision = "d".repeat(64);
const serviceId = "e".repeat(64);
const ticketId = "018f6f50-6a9e-7b88-8000-000000000001";
const jobRunId = "018f6f50-6a9e-7b88-8000-000000000002";
const idempotencyKey = "A".repeat(43);

const actor = Object.freeze({
    authenticatorId: "018f6f50-6a9e-7b88-8000-000000000010",
    id: "018f6f50-6a9e-7b88-8000-000000000011",
    kind: "user" as const,
});

function payload(
    overrides: Partial<DockerOverviewCachePayload> = {}
): DockerOverviewCachePayload {
    return {
        containers: [
            {
                createdAtMs: 100,
                health: "healthy",
                id: containerId,
                image: "example/service:1",
                imageId: usedImageId,
                mounts: [],
                name: "service-1",
                networks: [],
                ports: [],
                project: "mira",
                restartCount: 0,
                service: "service",
                startedAtMs: 200,
                state: "running",
            },
        ],
        images: [
            {
                createdAtMs: 50,
                id: usedImageId,
                references: ["example/service:1"],
                sizeBytes: 1000,
                usedByContainerIds: [containerId],
            },
            {
                createdAtMs: 60,
                id: unusedImageId,
                references: [],
                sizeBytes: 500,
                usedByContainerIds: [],
            },
        ],
        observedAtMs: 1000,
        sourceRevision,
        updaterEvents: [],
        updaterServices: [
            {
                currentImage: "example/service:1",
                id: serviceId,
                policy: { automatic: false, state: "managed", track: "tag" },
                project: "mira",
                service: "service",
                status: {
                    candidateImage: "example/service:2",
                    state: "update-available",
                },
            },
        ],
        volumes: [
            {
                driver: "local",
                name: "service-data",
                scope: "local",
                usedByContainerIds: [containerId],
            },
            {
                driver: "local",
                name: "unused-data",
                scope: "local",
                sizeBytes: 250,
                usedByContainerIds: [],
            },
        ],
        ...overrides,
    };
}

function snapshot(
    overrides: Partial<DockerOverviewSnapshotRecord> = {}
): DockerOverviewSnapshotRecord {
    return {
        expiresAtMs: 6400,
        key: "docker.overview",
        lastAttemptAtMs: 1000,
        lastAttemptStatus: "succeeded",
        lastSuccessAtMs: 1000,
        payload: payload(),
        schemaId: "docker.overview.v1",
        source: "docker-engine.compose",
        ...overrides,
    };
}

function controlContext(reauthorize: () => void = () => {}): DockerControlContext {
    return { actor, reauthorize, requestId: "request-1" };
}

function serviceFixture(
    overrides: Partial<DockerServiceOptions> = {},
    row: DockerOverviewSnapshotRecord | undefined = snapshot()
) {
    const audits: unknown[] = [];
    const queueInputs: unknown[] = [];
    const queuePayloads: unknown[] = [];
    return {
        audits,
        queueInputs,
        queuePayloads,
        service: createDockerService({
            auditWriter: {
                record(event) {
                    audits.push(event);
                    return Promise.resolve();
                },
            },
            generateId: () => ticketId,
            nowMs: () => 2000,
            operationQueue: {
                async enqueue(request) {
                    queueInputs.push(request.input);
                    const dispatch = await request.authorizeDispatch();
                    queuePayloads.push(dispatch.payload);
                    dispatch.authorize();
                    dispatch.onAccepted();
                    return {
                        jobRunId,
                        operation: request.input.operation,
                        queued: true,
                    };
                },
            },
            snapshotRepository: { read: () => row },
            workerReadPort: {
                previewPrune(input) {
                    return Promise.resolve(
                        input.target === "images"
                            ? {
                                  estimatedReclaimableBytes: 500,
                                  items: [
                                      {
                                          id: unusedImageId,
                                          references: [],
                                          sizeBytes: 500,
                                      },
                                  ],
                                  sourceRevision,
                                  target: "images" as const,
                              }
                            : {
                                  estimatedReclaimableBytes: 250,
                                  items: [{ name: "unused-data", sizeBytes: 250 }],
                                  sourceRevision,
                                  target: "volumes" as const,
                              }
                    );
                },
                readContainerLogs(input) {
                    return Promise.resolve({
                        containerId: input.containerId,
                        lines: ["token=[REDACTED]"],
                        observedAtMs: 1500,
                        redacted: true,
                        sourceRevision: input.sourceRevision,
                        truncated: false,
                    });
                },
            },
            ...overrides,
        }),
    };
}

describe("Docker service", () => {
    test("projects strict fresh, retained, unavailable, and failed-empty states", () => {
        expect(serviceFixture().service.overview().state).toBe("fresh");
        expect(
            serviceFixture(
                { nowMs: () => 2500 },
                snapshot({
                    expiresAtMs: 6400,
                    lastAttemptAtMs: 2000,
                    lastAttemptStatus: "failed",
                })
            ).service.overview()
        ).toMatchObject({ staleSinceMs: 2000, state: "last-known-good" });
        expect(
            serviceFixture(
                { nowMs: () => 2000 },
                snapshot({ expiresAtMs: 1500 })
            ).service.overview()
        ).toMatchObject({ staleSinceMs: 1500, state: "last-known-good" });
        expect(
            serviceFixture(
                { nowMs: () => 24 * 60 * 60 * 1000 + 1001 },
                snapshot()
            ).service.overview().state
        ).toBe("unavailable");
        expect(
            serviceFixture(
                { nowMs: () => 2500 },
                snapshot({
                    lastAttemptAtMs: 2000,
                    lastAttemptStatus: "failed",
                    payload: payload({
                        containers: [],
                        images: [],
                        updaterServices: [],
                        volumes: [],
                    }),
                })
            ).service.overview().state
        ).toBe("last-known-good");
        expect(
            serviceFixture(
                {},
                snapshot({ source: "private diagnostic" })
            ).service.overview().state
        ).toBe("unavailable");
    });

    test("serves only source-fenced redacted exact-container logs", async () => {
        const service = serviceFixture().service;
        expect(
            await service.getContainerLogs({ containerId, sourceRevision, tail: 10 })
        ).toMatchObject({
            containerId,
            lines: ["token=[REDACTED]"],
            redacted: true,
            sourceRevision,
        });
        expect(
            await captureFailure(() =>
                service.getContainerLogs({
                    containerId,
                    sourceRevision: "f".repeat(64),
                    tail: 10,
                })
            )
        ).toMatchObject({ reason: "conflict" });

        const failed = serviceFixture({
            workerReadPort: {
                previewPrune: () => Promise.reject(new Error("SECRET provider output")),
                readContainerLogs: () =>
                    Promise.reject(new Error("SECRET provider output")),
            },
        }).service;
        const error = await failed
            .getContainerLogs({ containerId, sourceRevision, tail: 10 })
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(DockerServiceError);
        expect(JSON.stringify(error)).not.toContain("SECRET provider output");
    });

    test("binds prune tickets to actor, session, revision, expiry, and one enqueue", async () => {
        let atMs = 2000;
        const fixture = serviceFixture({ nowMs: () => atMs });
        const preview = await fixture.service.preparePrune(
            { sourceRevision, target: "images" },
            { actor }
        );
        expect(preview).toMatchObject({
            sourceRevision,
            target: "images",
            ticketId,
        });

        expect(
            await fixture.service.requestOperation(
                {
                    confirmation: "prune-docker-images",
                    idempotencyKey,
                    operation: "prune-execute",
                    sourceRevision,
                    target: "images",
                    ticketId,
                },
                controlContext()
            )
        ).toMatchObject({ jobRunId, queued: true });
        expect(
            await captureFailure(() =>
                fixture.service.requestOperation(
                    {
                        confirmation: "prune-docker-images",
                        idempotencyKey: `${"A".repeat(42)}Q`,
                        operation: "prune-execute",
                        sourceRevision,
                        target: "images",
                        ticketId,
                    },
                    controlContext()
                )
            )
        ).toMatchObject({ reason: "not-found" });

        const next = serviceFixture({ nowMs: () => atMs });
        await next.service.preparePrune({ sourceRevision, target: "images" }, { actor });
        expect(
            await next.service.requestOperation(
                {
                    confirmation: "prune-docker-images",
                    idempotencyKey,
                    operation: "prune-execute",
                    sourceRevision,
                    target: "images",
                    ticketId,
                },
                controlContext(() => {})
            )
        ).toBeDefined();
        atMs += 5 * 60 * 1000 + 1;
        const expired = serviceFixture(
            { nowMs: () => atMs },
            snapshot({ expiresAtMs: 1_000_000 })
        );
        atMs = 2000;
        await expired.service.preparePrune(
            { sourceRevision, target: "images" },
            { actor }
        );
        atMs += 5 * 60 * 1000 + 1;
        expect(
            await captureFailure(() =>
                expired.service.requestOperation(
                    {
                        confirmation: "prune-docker-images",
                        idempotencyKey,
                        operation: "prune-execute",
                        sourceRevision,
                        target: "images",
                        ticketId,
                    },
                    controlContext()
                )
            )
        ).toMatchObject({ reason: "not-found" });
    });

    test("rejects full prune-ticket capacity before preview and admits after expiry", async () => {
        let atMs = 2000;
        let previewCalls = 0;
        const fixture = serviceFixture(
            {
                generateId: () => Bun.randomUUIDv7(),
                nowMs: () => atMs,
                workerReadPort: {
                    previewPrune() {
                        previewCalls += 1;
                        return Promise.resolve({
                            estimatedReclaimableBytes: 500,
                            items: [
                                {
                                    id: unusedImageId,
                                    references: [],
                                    sizeBytes: 500,
                                },
                            ],
                            sourceRevision,
                            target: "images" as const,
                        });
                    },
                    readContainerLogs: () => Promise.reject(new Error("unused")),
                },
            },
            snapshot({ expiresAtMs: 1_000_000 })
        );

        for (let index = 0; index < 128; index += 1) {
            await fixture.service.preparePrune(
                { sourceRevision, target: "images" },
                { actor }
            );
        }
        expect(previewCalls).toBe(128);
        expect(
            await captureFailure(() =>
                fixture.service.preparePrune(
                    { sourceRevision, target: "images" },
                    { actor }
                )
            )
        ).toMatchObject({ reason: "unavailable" });
        expect(previewCalls).toBe(128);

        atMs += dockerPrunePreviewTicketTtlMs;
        expect(
            await fixture.service.preparePrune(
                { sourceRevision, target: "images" },
                { actor }
            )
        ).toMatchObject({ sourceRevision, target: "images" });
        expect(previewCalls).toBe(129);
    });

    test("rejects a prune ticket from another session without revealing it", async () => {
        const fixture = serviceFixture();
        await fixture.service.preparePrune(
            { sourceRevision, target: "volumes" },
            { actor }
        );
        expect(
            await captureFailure(() =>
                fixture.service.requestOperation(
                    {
                        confirmation: "prune-docker-volumes",
                        idempotencyKey,
                        operation: "prune-execute",
                        sourceRevision,
                        target: "volumes",
                        ticketId,
                    },
                    {
                        ...controlContext(),
                        actor: { ...actor, authenticatorId: "other-session" },
                    }
                )
            )
        ).toMatchObject({ reason: "not-found" });
    });

    test("keeps a prune ticket retryable until durable enqueue accepts it", async () => {
        let queueAttempts = 0;
        const fixture = serviceFixture({
            operationQueue: {
                async enqueue(request) {
                    const dispatch = await request.authorizeDispatch();
                    dispatch.authorize();
                    queueAttempts += 1;
                    if (queueAttempts === 1) {
                        throw new DockerOperationQueueError("conflict");
                    }
                    dispatch.onAccepted();
                    return {
                        jobRunId,
                        operation: request.input.operation,
                        queued: true,
                    };
                },
            },
        });
        await fixture.service.preparePrune(
            { sourceRevision, target: "images" },
            { actor }
        );
        const input = {
            confirmation: "prune-docker-images" as const,
            idempotencyKey,
            operation: "prune-execute" as const,
            sourceRevision,
            target: "images" as const,
            ticketId,
        };

        expect(
            await captureFailure(() =>
                fixture.service.requestOperation(input, controlContext())
            )
        ).toMatchObject({ reason: "conflict" });
        expect(
            await fixture.service.requestOperation(
                { ...input, idempotencyKey: `${"A".repeat(42)}Q` },
                controlContext()
            )
        ).toMatchObject({ jobRunId, queued: true });
        expect(
            await captureFailure(() =>
                fixture.service.requestOperation(
                    { ...input, idempotencyKey: `${"A".repeat(42)}g` },
                    controlContext()
                )
            )
        ).toMatchObject({ reason: "not-found" });
    });

    test("reauthorizes and rechecks the source inside durable admission", async () => {
        let reauthorizations = 0;
        const fixture = serviceFixture();
        const result = await fixture.service.requestOperation(
            {
                confirmation: "restart-docker-container",
                containerId,
                idempotencyKey,
                operation: "container-restart",
                sourceRevision,
            },
            controlContext(() => {
                reauthorizations += 1;
            })
        );
        expect(result).toMatchObject({ operation: "container-restart", queued: true });
        expect(reauthorizations).toBe(1);
        expect(fixture.audits).toMatchObject([
            { operation: "container-restart", settlement: "attempted" },
            {
                jobRunId,
                operation: "container-restart",
                settlement: "queued",
            },
        ]);
    });

    test("fences a service update to the exact current and candidate images", async () => {
        const fixture = serviceFixture();
        const input = {
            candidateImage: "example/service:2",
            confirmation: "update-docker-service" as const,
            currentImage: "example/service:1",
            idempotencyKey,
            operation: "updater-update-service" as const,
            serviceId,
            sourceRevision,
        };

        expect(
            await fixture.service.requestOperation(input, controlContext())
        ).toMatchObject({ operation: "updater-update-service", queued: true });
        expect(fixture.queuePayloads).toEqual([
            {
                candidateImage: input.candidateImage,
                currentImage: input.currentImage,
                operation: input.operation,
                serviceId,
                sourceRevision,
            },
        ]);

        for (const changed of [
            { ...input, candidateImage: "example/service:3" },
            { ...input, currentImage: "example/service:0" },
        ]) {
            expect(
                await captureFailure(() =>
                    fixture.service.requestOperation(
                        { ...changed, idempotencyKey: `${"A".repeat(42)}Q` },
                        controlContext()
                    )
                )
            ).toMatchObject({ reason: "conflict" });
        }
    });

    test("fails closed when attempt audit is unavailable", async () => {
        let queueCalls = 0;
        const service = serviceFixture({
            auditWriter: { record: () => Promise.reject(new Error("private")) },
            operationQueue: {
                enqueue() {
                    queueCalls += 1;
                    return Promise.reject(new Error("should not run"));
                },
            },
        }).service;

        expect(
            await captureFailure(() =>
                service.requestOperation(
                    {
                        confirmation: "scan-docker-updates",
                        idempotencyKey,
                        operation: "updater-scan",
                        sourceRevision,
                    },
                    controlContext()
                )
            )
        ).toMatchObject({ reason: "audit-unavailable" });
        expect(queueCalls).toBe(0);
    });
});
