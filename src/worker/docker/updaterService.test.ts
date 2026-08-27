import { describe, expect, test } from "bun:test";

import type {
    DockerOverviewCachePayload,
    DockerUpdaterStatus,
} from "../../contracts/docker.ts";
import { DockerUpdaterSourceConflictError } from "../../contracts/dockerWorker.ts";
import type {
    DockerComposeDiscoveredService,
    DockerComposeDiscoveryResult,
} from "./composeDiscovery.ts";
import {
    DockerComposeImageUpdateError,
    type DockerComposeImageUpdateCommand,
    type DockerComposeImageUpdateResult,
    type DockerComposeImageUpdaterOptions,
} from "./composeImageUpdate.ts";
import type {
    DockerUpdaterGitHeadFilesRequest,
    DockerUpdaterGitSyncRequest,
    DockerUpdaterGitSyncResult,
} from "./gitSync.ts";
import type { DockerOverviewCollector } from "./overviewCollector.ts";
import { parseDockerImageReference } from "./tagPolicy.ts";
import {
    createDockerUpdaterService,
    type DockerUpdaterRunResult,
} from "./updaterService.ts";

const composePath = "/private/opt/docker/apps/shared/compose.yaml";
const rootComposePath = "/private/opt/docker/compose.yaml";
const repositoryHead = "1".repeat(40);

interface MutableService {
    readonly automatic: boolean;
    readonly candidateTag: string;
    readonly id: string;
    imageReference: string;
    readonly name: string;
}

interface HarnessOptions {
    readonly abortOnFirstReconcile?: AbortController;
    readonly driftOnDiscoverCall?: number;
    readonly finalGitThrows?: boolean;
    readonly failService?: string;
    readonly finalGit?: DockerUpdaterGitSyncResult;
    readonly headVerificationFails?: boolean;
    readonly preflightGit?: DockerUpdaterGitSyncResult;
    readonly preflightGitSequence?: readonly DockerUpdaterGitSyncResult[];
    readonly registryFailure?: boolean;
    readonly reconcileFails?: boolean;
    readonly rollbackFailsService?: string;
    readonly runtimeImageDriftAfterRecovery?: boolean;
    readonly runtimeImageDriftOnDiscoverCall?: number;
    readonly serviceCount?: 1 | 2;
    readonly sourceChangeOnDiscoverCall?: number;
    readonly sourceChangeDuringReconcile?: boolean;
    readonly throwOnDiscoverCall?: number;
    readonly unconfirmedService?: string;
}

function contentSha256(version: number): string {
    return version.toString(16).padStart(64, "0");
}

function sourceRevision(version: number): string {
    return (version + 100).toString(16).padStart(64, "0");
}

function eventIds() {
    let value = 0;
    return () => {
        value += 1;
        return `018f6f50-6a9e-7b88-8000-${String(value).padStart(12, "0")}`;
    };
}

function sourceService(
    service: MutableService,
    contentVersion: number
): DockerComposeDiscoveredService {
    const image = parseDockerImageReference(service.imageReference);
    if (image === undefined) throw new Error("Invalid test image");
    return {
        autoUpdate: service.automatic,
        composePath,
        configFiles: [composePath, rootComposePath],
        contentSha256: contentSha256(contentVersion),
        enabled: true,
        image,
        imageReference: service.imageReference,
        labels: {
            "mira.updater.autoUpdate": service.automatic ? "true" : "false",
            "mira.updater.enabled": "true",
        },
        pinMode: "tag",
        project: "media",
        service: service.name,
        tagPolicy: { matchType: "regex", pattern: String.raw`^\d+\.\d+\.\d+$` },
    };
}

function createHarness(options: HarnessOptions = {}) {
    const services: MutableService[] = [
        {
            automatic: true,
            candidateTag: "1.1.0",
            id: "a".repeat(64),
            imageReference: "ghcr.io/example/one:1.0.0",
            name: "one",
        },
        ...(options.serviceCount === 1
            ? []
            : [
                  {
                      automatic: true,
                      candidateTag: "2.1.0",
                      id: "b".repeat(64),
                      imageReference: "ghcr.io/example/two:2.0.0",
                      name: "two",
                  },
              ]),
    ];
    let contentVersion = 10;
    let revisionVersion = 20;
    let discoverCalls = 0;
    const updateCommands: DockerComposeImageUpdateCommand[] = [];
    const order: string[] = [];
    const gitHeadRequests: DockerUpdaterGitHeadFilesRequest[] = [];
    const gitRequests: DockerUpdaterGitSyncRequest[] = [];
    let preflightGitCalls = 0;
    let reconcileCalls = 0;
    const reconcileSignals: Array<AbortSignal | undefined> = [];
    const reconcileServices: string[][] = [];

    function compose(): DockerComposeDiscoveryResult {
        return {
            composeFiles: [composePath, rootComposePath],
            services: services.map((service) => sourceService(service, contentVersion)),
            sourceRevision: sourceRevision(revisionVersion),
        };
    }

    function payload(previous?: unknown): DockerOverviewCachePayload {
        const prior = previous as DockerOverviewCachePayload | undefined;
        const previousById = new Map(
            (prior?.updaterServices ?? []).map((service) => [service.id, service])
        );
        const runtimeImageId = (index: number): string => {
            if (
                options.runtimeImageDriftAfterRecovery &&
                reconcileCalls >= 2 &&
                index === 0
            ) {
                return `sha256:${"9".repeat(64)}`;
            }
            if (
                options.runtimeImageDriftOnDiscoverCall !== undefined &&
                discoverCalls >= options.runtimeImageDriftOnDiscoverCall &&
                index === 0
            ) {
                return `sha256:${"8".repeat(64)}`;
            }
            return `sha256:${String(index + 3).repeat(64)}`;
        };
        const containers = services.map((service, index) => ({
            createdAtMs: 900,
            health: "healthy" as const,
            id: String(index + 1).repeat(64),
            image: service.imageReference,
            imageId: runtimeImageId(index),
            mounts: [],
            name: `media-${service.name}-1`,
            networks: [],
            ports: [],
            project: "media",
            restartCount: 0,
            service: service.name,
            startedAtMs: 950,
            state: "running" as const,
        }));
        return {
            containers,
            images: containers.map((container) => ({
                createdAtMs: 800,
                id: container.imageId,
                references: [container.image],
                sizeBytes: 100,
                usedByContainerIds: [container.id],
            })),
            observedAtMs: 1000 + discoverCalls,
            sourceRevision: sourceRevision(revisionVersion),
            updaterEvents: [...(prior?.updaterEvents ?? [])],
            updaterServices: services.map((service) => {
                const previousService = previousById.get(service.id);
                const status: DockerUpdaterStatus =
                    prior?.sourceRevision === sourceRevision(revisionVersion) &&
                    previousService?.currentImage === service.imageReference
                        ? previousService.status
                        : { state: "unavailable" };
                return {
                    currentImage: service.imageReference,
                    id: service.id,
                    policy: {
                        automatic: service.automatic,
                        state: "managed" as const,
                        track: "tag" as const,
                    },
                    project: "media",
                    service: service.name,
                    status,
                };
            }),
            volumes: [],
        };
    }

    const collector: DockerOverviewCollector = {
        collect(previous) {
            return Promise.resolve(payload(previous));
        },
        discover(previous) {
            discoverCalls += 1;
            if (options.throwOnDiscoverCall === discoverCalls) {
                return Promise.reject(
                    new Error("raw private post-mutation discovery diagnostic")
                );
            }
            if (options.driftOnDiscoverCall === discoverCalls) {
                revisionVersion += 1;
            }
            if (options.sourceChangeOnDiscoverCall === discoverCalls) {
                contentVersion += 1;
                revisionVersion += 1;
            }
            return Promise.resolve({ compose: compose(), payload: payload(previous) });
        },
    };
    const git = {
        readHead() {
            order.push("git-head");
            return Promise.resolve(repositoryHead);
        },
        sync(request: DockerUpdaterGitSyncRequest) {
            gitRequests.push(request);
            order.push(`git-sync:${request.changes.length}`);
            if (options.finalGitThrows && request.changes.length > 0) {
                return Promise.reject(new Error("raw private Git settlement diagnostic"));
            }
            return Promise.resolve(
                request.changes.length === 0
                    ? (options.preflightGitSequence?.[preflightGitCalls++] ??
                          options.preflightGit ?? {
                              composePaths: [],
                              status: "no-change" as const,
                          })
                    : (options.finalGit ?? {
                          commit: "2".repeat(40),
                          composePaths: [composePath],
                          status: "pushed" as const,
                      })
            );
        },
        verifyHeadFiles(request: DockerUpdaterGitHeadFilesRequest) {
            gitHeadRequests.push(request);
            order.push(`git-verify:${request.files.length}`);
            return options.headVerificationFails
                ? Promise.reject(new Error("raw private Git HEAD diagnostic"))
                : Promise.resolve();
        },
    };
    const updateImage = async (
        command: DockerComposeImageUpdateCommand,
        updaterOptions: DockerComposeImageUpdaterOptions
    ): Promise<DockerComposeImageUpdateResult> => {
        order.push(`update:${command.service}`);
        updateCommands.push(command);
        await updaterOptions.revalidateTarget("pre-update");
        await updaterOptions.revalidateTarget("pre-update");
        if (options.failService === command.service) {
            throw new DockerComposeImageUpdateError(
                "unavailable",
                true,
                new Error("raw private provider diagnostic")
            );
        }
        const service = services.find(({ name }) => name === command.service);
        if (service === undefined) throw new Error("Missing test service");
        const previousImageReference = service.imageReference;
        const previousContentVersion = contentVersion;
        const previousRevisionVersion = revisionVersion;
        service.imageReference = command.targetImageReference;
        contentVersion += 1;
        revisionVersion += 1;
        if (options.unconfirmedService === command.service) {
            throw new DockerComposeImageUpdateError(
                "rollback-failed",
                false,
                new Error("raw private rollback diagnostic")
            );
        }
        let settlementPending = true;
        return {
            fromImageReference: command.expectedImageReference,
            project: command.project,
            rollback() {
                order.push(`rollback:${command.service}`);
                if (!settlementPending) return Promise.resolve(false);
                settlementPending = false;
                if (options.rollbackFailsService === command.service) {
                    return Promise.resolve(false);
                }
                service.imageReference = previousImageReference;
                contentVersion = previousContentVersion;
                revisionVersion = previousRevisionVersion;
                return Promise.resolve(true);
            },
            service: command.service,
            settle() {
                settlementPending = false;
            },
            status: "updated",
            toImageReference: command.targetImageReference,
        };
    };
    const updater = createDockerUpdaterService({
        collector,
        generateId: eventIds(),
        git,
        nowMs: () => 2000,
        reconcileStack(services, signal) {
            reconcileCalls += 1;
            reconcileServices.push([...services]);
            reconcileSignals.push(signal);
            if (options.sourceChangeDuringReconcile && reconcileCalls === 1) {
                revisionVersion += 1;
            }
            if (options.reconcileFails && reconcileCalls === 1) {
                options.abortOnFirstReconcile?.abort();
                return Promise.reject(new Error("raw reconcile diagnostic"));
            }
            return Promise.resolve();
        },
        scan: {
            lookup({ image }) {
                if (options.registryFailure) {
                    return Promise.reject(new Error("raw private registry diagnostic"));
                }
                const service = services.find(({ imageReference }) => {
                    const current = parseDockerImageReference(imageReference);
                    return current?.name === image.name;
                });
                if (service === undefined) {
                    return Promise.reject(new Error("raw registry diagnostic"));
                }
                return Promise.resolve({
                    digest: `sha256:${"f".repeat(64)}`,
                    tag: service.candidateTag,
                });
            },
            platform: "linux/amd64",
        },
        updateImage,
    });
    return {
        currentPayload: () => payload(),
        gitHeadRequests,
        gitRequests,
        order,
        reconcileCalls: () => reconcileCalls,
        reconcileServices,
        reconcileSignals,
        updateCommands,
        updater,
    };
}

function eventKinds(result: DockerUpdaterRunResult): string[] {
    return result.payload.updaterEvents.map(({ kind }) => kind);
}

describe("Docker updater service", () => {
    test("preserves exact scanned candidates across its own multi-service source changes", async () => {
        const harness = createHarness();
        const initial = harness.currentPayload();
        const result = await harness.updater.run(
            {
                expectedSourceRevision: initial.sourceRevision,
                previous: initial,
            },
            new AbortController().signal
        );

        expect(result).toMatchObject({
            failedCount: 0,
            git: { commit: "2".repeat(40), status: "pushed" },
            outcome: "completed",
            updatedCount: 2,
        });
        expect(harness.reconcileCalls()).toBe(1);
        expect(harness.reconcileServices).toEqual([["one", "two"]]);
        expect(harness.order).toEqual([
            "git-head",
            "git-sync:0",
            "git-verify:1",
            "update:one",
            "update:two",
            "git-sync:1",
        ]);
        expect(
            harness.updateCommands.map(
                ({ expectedContentSha256 }) => expectedContentSha256
            )
        ).toEqual([contentSha256(10), contentSha256(11)]);
        expect(harness.gitRequests[1]?.changes).toEqual([
            {
                composePath,
                expectedAfterContentSha256: contentSha256(12),
                expectedBeforeContentSha256: contentSha256(10),
            },
        ]);
        expect(harness.gitHeadRequests).toEqual([
            {
                expectedRepositoryHead: repositoryHead,
                files: [
                    {
                        composePath,
                        expectedContentSha256: contentSha256(10),
                    },
                ],
            },
        ]);
        expect(result.payload.updaterServices.map(({ status }) => status)).toEqual([
            { state: "current" },
            { state: "current" },
        ]);
        expect(
            eventKinds(result).filter((kind) => kind === "update-succeeded")
        ).toHaveLength(2);
        expect(JSON.stringify(result)).not.toContain(composePath);
        expect(JSON.stringify(result)).not.toContain("provider diagnostic");
    });

    test("restores the prior sources and reconciles selected services after an unhealthy result", async () => {
        const harness = createHarness({ reconcileFails: true, serviceCount: 1 });
        const initial = harness.currentPayload();

        const result = await harness.updater.run(
            {
                expectedSourceRevision: initial.sourceRevision,
                previous: initial,
            },
            new AbortController().signal
        );

        expect(result).toMatchObject({
            failedCount: 1,
            git: { status: "no-change" },
            outcome: "completed-with-failures",
            updatedCount: 0,
        });
        expect(harness.reconcileCalls()).toBe(2);
        expect(harness.reconcileSignals[0]).toBeInstanceOf(AbortSignal);
        expect(harness.reconcileSignals[1]).toBeInstanceOf(AbortSignal);
        expect(harness.reconcileSignals[1]).not.toBe(harness.reconcileSignals[0]);
        expect(harness.order).toContain("rollback:one");
        expect(eventKinds(result)).toContain("update-failed");
    });

    test("rejects Compose source drift observed across selected reconciliation", async () => {
        const harness = createHarness({
            serviceCount: 1,
            sourceChangeDuringReconcile: true,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(harness.reconcileCalls()).toBe(2);
        expect(harness.order).toContain("rollback:one");
        expect(result.outcome).toBe("completed-with-failures");
        expect(result.updatedCount).toBe(0);
    });

    test("uses an independently bounded recovery signal after lifecycle cancellation", async () => {
        const controller = new AbortController();
        const harness = createHarness({
            abortOnFirstReconcile: controller,
            reconcileFails: true,
            serviceCount: 1,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run(
            { expectedSourceRevision: initial.sourceRevision, previous: initial },
            controller.signal
        );

        expect(controller.signal.aborted).toBe(true);
        expect(harness.reconcileSignals[1]?.aborted).toBe(false);
        expect(result.outcome).toBe("completed-with-failures");
    });

    test("reports recovery as unknown when a restored service runtime image ID drifts", async () => {
        const harness = createHarness({
            reconcileFails: true,
            runtimeImageDriftAfterRecovery: true,
            serviceCount: 1,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(harness.reconcileCalls()).toBe(2);
        expect(result.outcome).toBe("unknown-outcome");
    });

    test("verifies recovery against the runtime image captured by update revalidation", async () => {
        const harness = createHarness({
            reconcileFails: true,
            runtimeImageDriftOnDiscoverCall: 3,
            serviceCount: 1,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result.outcome).toBe("completed-with-failures");
    });

    test("does not reconcile unverified source after isolated rollback fails", async () => {
        const harness = createHarness({
            reconcileFails: true,
            rollbackFailsService: "one",
            serviceCount: 1,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run(
            {
                expectedSourceRevision: initial.sourceRevision,
                previous: initial,
            },
            new AbortController().signal
        );

        expect(harness.order).toContain("rollback:one");
        expect(harness.reconcileCalls()).toBe(1);
        expect(result.outcome).toBe("unknown-outcome");
    });

    test("updates only the exact user-confirmed service image pair", async () => {
        const harness = createHarness();
        const initial = harness.currentPayload();
        const result = await harness.updater.run({
            candidateImage: "ghcr.io/example/one:1.1.0",
            currentImage: "ghcr.io/example/one:1.0.0",
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
            serviceId: "a".repeat(64),
        });

        expect(result).toMatchObject({
            failedCount: 0,
            outcome: "completed",
            updatedCount: 1,
        });
        expect(harness.updateCommands).toEqual([
            expect.objectContaining({
                expectedImageReference: "ghcr.io/example/one:1.0.0",
                targetImageReference: "ghcr.io/example/one:1.1.0",
            }),
        ]);
    });

    test("rejects a replacement candidate before Git or Compose mutation", async () => {
        for (const changed of [
            { candidateImage: "ghcr.io/example/one:1.2.0" },
            { currentImage: "ghcr.io/example/one:0.9.0" },
        ]) {
            const harness = createHarness({ serviceCount: 1 });
            const initial = harness.currentPayload();
            const failure = await harness.updater
                .run({
                    candidateImage: "ghcr.io/example/one:1.1.0",
                    currentImage: "ghcr.io/example/one:1.0.0",
                    expectedSourceRevision: initial.sourceRevision,
                    previous: initial,
                    serviceId: "a".repeat(64),
                    ...changed,
                })
                .catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(DockerUpdaterSourceConflictError);
            expect(harness.order).toEqual([]);
            expect(harness.updateCommands).toEqual([]);
        }
    });

    test("classifies late pre-mutation Compose source drift as a harmless stale conflict", async () => {
        const harness = createHarness({
            serviceCount: 1,
            sourceChangeOnDiscoverCall: 3,
        });
        const initial = harness.currentPayload();

        const failure = await harness.updater
            .run({
                expectedSourceRevision: initial.sourceRevision,
                previous: initial,
            })
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DockerUpdaterSourceConflictError);
        expect(harness.order).toEqual([
            "git-head",
            "git-sync:0",
            "git-verify:1",
            "update:one",
        ]);
        expect(harness.gitRequests).toHaveLength(1);
    });

    test("preflights Git before deploy and stops on pending source synchronization", async () => {
        const harness = createHarness({
            preflightGit: {
                composePaths: [composePath],
                reason: "unrelated-staged",
                status: "unavailable",
            },
            serviceCount: 1,
        });
        const initial = harness.currentPayload();
        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(harness.order).toEqual(["git-head", "git-sync:0"]);
        expect(result).toMatchObject({
            failedCount: 0,
            git: { reason: "unrelated-staged", status: "unavailable" },
            outcome: "source-sync-pending",
            updatedCount: 0,
        });
        expect(eventKinds(result)).toContain("source-sync-pending");
        expect(JSON.stringify(result)).not.toContain(composePath);
    });

    test("does not mutate Compose when recovered Git write authentication is unavailable", async () => {
        const harness = createHarness({
            preflightGit: {
                composePaths: [],
                reason: "upstream",
                status: "unavailable",
            },
            serviceCount: 1,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            failedCount: 0,
            git: { reason: "upstream", status: "unavailable" },
            outcome: "source-sync-pending",
            updatedCount: 0,
        });
        expect(harness.order).toEqual(["git-head", "git-sync:0"]);
        expect(harness.updateCommands).toEqual([]);
    });

    test("never authorizes an update from a stale candidate after registry failure", async () => {
        const harness = createHarness({ registryFailure: true, serviceCount: 1 });
        const initial = harness.currentPayload();
        initial.updaterServices[0] = {
            ...initial.updaterServices[0]!,
            status: {
                candidateImage: "ghcr.io/example/one:1.1.0",
                state: "update-available",
            },
        };

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            failedCount: 0,
            outcome: "completed",
            updatedCount: 0,
        });
        expect(result.payload.updaterServices[0]?.status).toEqual({
            state: "unavailable",
        });
        expect(harness.order).toEqual(["git-head", "git-sync:0"]);
        expect(harness.updateCommands).toEqual([]);
        expect(eventKinds(result)).toContain("scan-failed");
        expect(JSON.stringify(result)).not.toContain("raw private registry diagnostic");
    });

    test("stops before mutation when a planned Compose file does not match Git HEAD", async () => {
        const harness = createHarness({
            headVerificationFails: true,
            serviceCount: 1,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            git: { reason: "conflict", status: "unavailable" },
            outcome: "source-sync-pending",
            updatedCount: 0,
        });
        expect(harness.order).toEqual(["git-head", "git-sync:0", "git-verify:1"]);
        expect(harness.updateCommands).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("raw private Git HEAD diagnostic");
        expect(JSON.stringify(result)).not.toContain(composePath);
    });

    test("isolates a confirmed rollback and continues the other service", async () => {
        const harness = createHarness({ failService: "one" });
        const initial = harness.currentPayload();
        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            failedCount: 1,
            outcome: "completed-with-failures",
            updatedCount: 1,
        });
        expect(harness.order).toEqual([
            "git-head",
            "git-sync:0",
            "git-verify:1",
            "update:one",
            "update:two",
            "git-sync:1",
        ]);
        expect(result.payload.updaterServices.map(({ status }) => status)).toEqual([
            { state: "unavailable" },
            { state: "current" },
        ]);
        expect(eventKinds(result)).toContain("update-failed");
        expect(eventKinds(result)).toContain("update-succeeded");
        expect(JSON.stringify(result)).not.toContain("raw private provider diagnostic");
    });

    test("classifies pushed, pending, and unknown final Git outcomes", async () => {
        for (const [git, outcome, eventKind] of [
            [
                {
                    commit: "3".repeat(40),
                    composePaths: [composePath],
                    status: "committed-push-pending",
                },
                "source-sync-pending",
                "source-sync-pending",
            ],
            [
                {
                    composePaths: [composePath],
                    status: "unknown-outcome",
                },
                "unknown-outcome",
                "update-outcome-unknown",
            ],
        ] as const) {
            const harness = createHarness({ finalGit: git, serviceCount: 1 });
            const initial = harness.currentPayload();
            const result = await harness.updater.run({
                expectedSourceRevision: initial.sourceRevision,
                previous: initial,
            });
            expect(result.outcome).toBe(outcome);
            expect(result.git.status).toBe(git.status);
            expect(eventKinds(result)).toContain(eventKind);
            expect(result.payload.updaterServices[0]?.status).toEqual({
                state: "current",
            });
            expect(JSON.stringify(result)).not.toContain(composePath);
        }
    });

    test("recovers a pending Git push when the next scan has no image changes", async () => {
        const recoveredCommit = "3".repeat(40);
        const harness = createHarness({
            finalGit: {
                commit: recoveredCommit,
                composePaths: [composePath],
                status: "committed-push-pending",
            },
            preflightGitSequence: [
                { composePaths: [], status: "no-change" },
                {
                    commit: recoveredCommit,
                    composePaths: [composePath],
                    status: "pushed",
                },
            ],
            serviceCount: 1,
        });
        const initial = harness.currentPayload();
        const pending = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(pending).toMatchObject({
            git: { commit: recoveredCommit, status: "committed-push-pending" },
            outcome: "source-sync-pending",
            updatedCount: 1,
        });

        const recovered = await harness.updater.run({ previous: pending.payload });

        expect(recovered).toMatchObject({
            failedCount: 0,
            git: { commit: recoveredCommit, status: "pushed" },
            outcome: "completed",
            updatedCount: 0,
        });
        expect(harness.order).toEqual([
            "git-head",
            "git-sync:0",
            "git-verify:1",
            "update:one",
            "git-sync:1",
            "git-head",
            "git-sync:0",
        ]);
        expect(eventKinds(recovered)).toContain("update-succeeded");
        expect(JSON.stringify(recovered)).not.toContain(composePath);
    });

    test("rolls all applied services back in reverse after pre-commit Git rejection", async () => {
        const harness = createHarness({
            finalGit: {
                composePaths: [],
                reason: "conflict",
                status: "unavailable",
            },
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            failedCount: 2,
            git: { reason: "conflict", status: "unavailable" },
            outcome: "completed-with-failures",
            updatedCount: 0,
        });
        expect(harness.order).toEqual([
            "git-head",
            "git-sync:0",
            "git-verify:1",
            "update:one",
            "update:two",
            "git-sync:1",
            "rollback:two",
            "rollback:one",
        ]);
        expect(harness.reconcileServices).toEqual([
            ["one", "two"],
            ["one", "two"],
        ]);
        expect(result.payload.updaterServices.map(({ status }) => status)).toEqual([
            { candidateImage: "ghcr.io/example/one:1.1.0", state: "update-available" },
            { candidateImage: "ghcr.io/example/two:2.1.0", state: "update-available" },
        ]);
        expect(
            eventKinds(result).filter((kind) => kind === "update-failed")
        ).toHaveLength(2);
    });

    test("returns unknown outcome when pre-commit rollback cannot be verified", async () => {
        const harness = createHarness({
            finalGit: {
                composePaths: [],
                reason: "conflict",
                status: "unavailable",
            },
            rollbackFailsService: "one",
            serviceCount: 1,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            git: { status: "unknown-outcome" },
            outcome: "unknown-outcome",
            updatedCount: 0,
        });
        expect(result.payload.updaterServices[0]?.status).toEqual({
            state: "unavailable",
        });
        expect(eventKinds(result)).toContain("update-outcome-unknown");
    });

    test("returns sanitized unknown outcome when rollback cannot be confirmed", async () => {
        const harness = createHarness({
            serviceCount: 1,
            unconfirmedService: "one",
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            failedCount: 0,
            git: { status: "unknown-outcome" },
            outcome: "unknown-outcome",
            updatedCount: 0,
        });
        expect(result.payload.updaterServices[0]?.status).toEqual({
            state: "unavailable",
        });
        expect(eventKinds(result)).toContain("update-outcome-unknown");
        expect(harness.order).toEqual([
            "git-head",
            "git-sync:0",
            "git-verify:1",
            "update:one",
        ]);
        expect(JSON.stringify(result)).not.toContain("raw private rollback diagnostic");
        expect(JSON.stringify(result)).not.toContain(composePath);
    });

    test("returns sanitized unknown outcome when rediscovery fails after mutation", async () => {
        const harness = createHarness({
            serviceCount: 1,
            throwOnDiscoverCall: 5,
        });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            failedCount: 0,
            git: { status: "unknown-outcome" },
            outcome: "unknown-outcome",
            updatedCount: 0,
        });
        expect(result.payload.updaterServices[0]?.status).toEqual({
            state: "unavailable",
        });
        expect(eventKinds(result)).toContain("update-outcome-unknown");
        expect(harness.order).toContain("rollback:one");
        expect(JSON.stringify(result)).not.toContain(
            "raw private post-mutation discovery diagnostic"
        );
        expect(JSON.stringify(result)).not.toContain(composePath);
    });

    test("returns sanitized unknown outcome when Git settlement throws after mutation", async () => {
        const harness = createHarness({ finalGitThrows: true, serviceCount: 1 });
        const initial = harness.currentPayload();

        const result = await harness.updater.run({
            expectedSourceRevision: initial.sourceRevision,
            previous: initial,
        });

        expect(result).toMatchObject({
            failedCount: 0,
            git: { status: "unknown-outcome" },
            outcome: "unknown-outcome",
            updatedCount: 1,
        });
        expect(result.payload.updaterServices[0]?.status).toEqual({ state: "current" });
        expect(eventKinds(result)).toContain("update-outcome-unknown");
        expect(JSON.stringify(result)).not.toContain(
            "raw private Git settlement diagnostic"
        );
        expect(JSON.stringify(result)).not.toContain(composePath);
    });

    test("fails the source revision fence before Git or Compose mutation", async () => {
        const mismatch = createHarness({ serviceCount: 1 });
        const failure = await mismatch.updater
            .run({
                expectedSourceRevision: "f".repeat(64),
                previous: mismatch.currentPayload(),
            })
            .then(
                () => null,
                (error: unknown) => error
            );
        expect(failure).toBeInstanceOf(DockerUpdaterSourceConflictError);
        expect(mismatch.order).toEqual([]);

        const drift = createHarness({ driftOnDiscoverCall: 2, serviceCount: 1 });
        const driftFailure = await drift.updater
            .run({
                expectedSourceRevision: drift.currentPayload().sourceRevision,
                previous: drift.currentPayload(),
            })
            .then(
                () => null,
                (error: unknown) => error
            );
        expect(driftFailure).toBeInstanceOf(DockerUpdaterSourceConflictError);
        expect(drift.order).toEqual(["git-head", "git-sync:0"]);
        expect(drift.updateCommands).toEqual([]);
    });
});
