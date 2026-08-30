import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import type { DeliveryExpectedHead } from "../../contracts/delivery.ts";
import {
    deliveryGitHubMiraLogin,
    deliveryGitHubReviewerLogin,
    type DeliveryGitHubPullRequestReadPort,
} from "../../contracts/deliveryGithub.ts";
import {
    buildPreviewGatewaySocketSpecification,
    createPreviewGatewayCapability,
    type PreviewGatewaySocketSpecification,
} from "./previewGatewayProxy.ts";
import {
    nextPreviewRetainedOwner,
    readPreviewRetainedOwner,
    reapPreviewRetainedOwnerStages,
    reapPreviewRetainedStages,
    removePreviewRetainedState,
    writePreviewRetainedOwner,
} from "./previewRetainedState.ts";
import {
    buildPreviewIngressSpecification,
    buildPreviewLaunchSpecification,
    type PreviewIngressSpecification,
    type PreviewLaunchSpecification,
} from "./previewSandbox.ts";
import {
    ensurePreviewPrGatewayRoot,
    prepareManagedPreviewStateRoot,
    previewWorktreePath,
    readPreviewState,
    reapPreviewStateStages,
    removePreviewStateFile,
    resolvePreviewStatePaths,
    writePreviewState,
    type PreviewStatePaths,
} from "./previewState.ts";
import type {
    PreviewTailscaleRouteStatus,
    PreviewTailscaleServePort,
} from "./previewTailscaleServe.ts";
import {
    parsePreviewCleanupRequest,
    parsePreviewStartRequest,
    parsePreviewStopRequest,
    PreviewHostError,
    previewFormatVersion,
    previewMaximumDurationMs,
    previewStartingGraceMs,
    type PreviewCleanupRequest,
    type PreviewDurableRecord,
    type PreviewRuntimeState,
    type PreviewScopeAuthority,
    type PreviewStartRequest,
    type PreviewStopRequest,
} from "./previewTypes.ts";
import {
    preparePreviewWorktree,
    removePreviewWorktree,
    type PreviewGitAuthority,
    type PreviewProcessRunner,
} from "./previewWorktree.ts";
import { resolvePullRequestScope } from "./pullRequestScope.ts";

const trustedPreviewAuthors: ReadonlySet<string> = new Set([
    deliveryGitHubMiraLogin,
    deliveryGitHubReviewerLogin,
]);

/**
 * Derives the exact main-rooted preview scope directly from fresh GitHub state.
 * @param github Authenticated Mira GitHub read authority.
 * @returns Fresh scope and close/merge confirmation authority.
 */
export function createDeliveryPreviewScopeAuthority(
    github: DeliveryGitHubPullRequestReadPort
): PreviewScopeAuthority {
    const authority: PreviewScopeAuthority = {
        async confirmClosedOrMerged(number, expectedHeadSha, signal) {
            try {
                const pullRequest = await github.getPullRequest(number, signal);
                return (
                    pullRequest.headSha === expectedHeadSha &&
                    (pullRequest.state === "CLOSED" || pullRequest.state === "MERGED")
                );
            } catch {
                return false;
            }
        },
        async readScope(number, signal) {
            const pullRequests = await github.listOpenPullRequests(signal);
            const scope = resolvePullRequestScope(number, pullRequests);
            const members = scope?.members ?? [];
            return Object.freeze({
                expectedHeads: Object.freeze(
                    members.map(({ headSha, number: memberNumber }) => ({
                        headSha,
                        number: memberNumber,
                    }))
                ),
                mainRooted: scope !== undefined,
                open: members.at(-1)?.number === number,
                trustedAuthors:
                    members.length > 0 &&
                    members.every(
                        ({ authorLogin }) =>
                            authorLogin !== undefined &&
                            trustedPreviewAuthors.has(authorLogin)
                    ),
            });
        },
    };
    return Object.freeze(authority);
}

export interface PreviewRuntimePort {
    readonly bindGateway: (
        unitName: string,
        specification: PreviewGatewaySocketSpecification,
        signal?: AbortSignal
    ) => Promise<void>;
    readonly inspect: (
        unitName: string,
        signal?: AbortSignal
    ) => Promise<PreviewRuntimeState>;
    readonly ingress: Readonly<{
        start: (
            specification: PreviewIngressSpecification,
            signal?: AbortSignal
        ) => Promise<void>;
        stop: (
            specification: PreviewIngressSpecification,
            signal?: AbortSignal
        ) => Promise<void>;
    }>;
    readonly start: (
        specification: PreviewLaunchSpecification,
        gateway: PreviewGatewaySocketSpecification,
        signal?: AbortSignal
    ) => Promise<void>;
    readonly stop: (unitName: string, signal?: AbortSignal) => Promise<void>;
}

export interface PreviewHostConfiguration {
    readonly bunExecutable: string;
    readonly checkoutRoot: string;
    readonly ingressSocket: string;
    readonly previewRoot: string;
}

export interface PreviewHostDependencies {
    readonly clock?: () => number;
    readonly credentials: PreviewGitAuthority;
    readonly processRunner?: PreviewProcessRunner;
    readonly runtime: PreviewRuntimePort;
    readonly scope: PreviewScopeAuthority;
    readonly tailscale: PreviewTailscaleServePort;
}

export type PreviewHostStatus = Readonly<{
    expectedHeads?: readonly DeliveryExpectedHead[];
    expiresAtMs?: number;
    headSha?: string;
    number?: number;
    previewRevision?: string;
    reason?: "expired" | "runtime-failed" | "startup-interrupted";
    startedAtMs?: number;
    status: "failed" | "running" | "starting" | "stopped" | "stopping";
    title?: string;
    updatedAtMs: number;
    url?: string;
}>;

export type PreviewStartResult = Readonly<{
    capability: PreviewGatewaySocketSpecification;
    status: PreviewHostStatus;
}>;

function fail(reason: PreviewHostError["reason"]): never {
    throw new PreviewHostError({ reason });
}

function noValue(): undefined {
    return;
}

function ignoreSettlement(): void {}

function unitName(operationId: string): string {
    return `mira-dashboard-preview-${operationId}.service`;
}

function sameScope(
    left: readonly DeliveryExpectedHead[],
    right: readonly DeliveryExpectedHead[]
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (member, index) =>
                member.number === right[index]?.number &&
                member.headSha === right[index]?.headSha
        )
    );
}

function statusFromRecord(
    record: PreviewDurableRecord,
    nowMs: number,
    runtime?: PreviewRuntimeState,
    publication?: PreviewTailscaleRouteStatus
): PreviewHostStatus {
    const headSha = record.expectedHeads.at(-1)!.headSha;
    if (nowMs >= record.expiresAtMs && record.status !== "stopped") {
        return Object.freeze({
            expectedHeads: record.expectedHeads,
            expiresAtMs: record.expiresAtMs,
            headSha,
            number: record.number,
            previewRevision: record.previewRevision,
            reason: "expired",
            startedAtMs: record.startedAtMs,
            status: "failed",
            title: record.title,
            updatedAtMs: record.updatedAtMs,
        });
    }
    const runtimeFailure =
        runtime?.result === "failed" ||
        (record.status === "running" &&
            (runtime?.ready !== true ||
                !record.ownsTailscaleServe ||
                publication?.enabled !== true ||
                publication.origin !== record.publicOrigin));
    const interruptedStart =
        record.status === "starting" &&
        nowMs - record.updatedAtMs >= previewStartingGraceMs &&
        runtime?.active !== true;
    let reason: PreviewHostStatus["reason"];
    if (runtimeFailure) reason = "runtime-failed";
    else if (interruptedStart) reason = "startup-interrupted";
    let status = record.status;
    if (runtimeFailure || interruptedStart) status = "failed";
    else if (
        runtime?.ready === true &&
        (record.status === "running" || record.status === "starting")
    ) {
        status = "running";
    }
    return Object.freeze({
        expectedHeads: record.expectedHeads,
        expiresAtMs: record.expiresAtMs,
        headSha,
        number: record.number,
        previewRevision: record.previewRevision,
        reason,
        startedAtMs: record.startedAtMs,
        status,
        title: record.title,
        updatedAtMs: record.updatedAtMs,
        ...(status === "running" &&
        publication?.enabled === true &&
        publication.origin === record.publicOrigin
            ? { url: record.publicOrigin }
            : {}),
    });
}

async function assertScope(
    scope: PreviewScopeAuthority,
    request: PreviewStartRequest,
    signal?: AbortSignal
): Promise<void> {
    const current = await scope
        .readScope(request.number, signal)
        .catch(() => fail("scope-changed"));
    if (
        !current.mainRooted ||
        !current.open ||
        !sameScope(current.expectedHeads, request.expectedHeads)
    ) {
        fail("scope-changed");
    }
    if (!current.trustedAuthors) fail("untrusted-author");
}

/**
 * Creates one durable, single-slot preview host without exposing host authority to PR code.
 * @param configuration Fixed runtime, checkout, and preview-state paths.
 * @param dependencies Git, scope, process, and sandbox-runtime authorities.
 * @returns Serialized preview lifecycle with Promise and Effect mutation boundaries.
 */
export function createPreviewHost(
    configuration: PreviewHostConfiguration,
    dependencies: PreviewHostDependencies
) {
    const now = dependencies.clock ?? Date.now;
    let pathsPromise: Promise<PreviewStatePaths> | undefined;
    let mutation: Promise<void> = Promise.resolve();
    const paths = () =>
        (pathsPromise ??= resolvePreviewStatePaths(configuration.previewRoot));
    const ingressDirectory = (operationId: string) =>
        path.join(`${configuration.ingressSocket}.d`, operationId);
    const ingressSocket = (operationId: string) =>
        path.join(ingressDirectory(operationId), "preview.sock");
    const prepareIngress = async (operationId: string): Promise<void> => {
        const directory = ingressDirectory(operationId);
        await rm(directory, { force: true, recursive: true });
        await mkdir(directory, { mode: 0o700, recursive: true });
    };
    const removeIngress = (operationId: string) =>
        rm(ingressDirectory(operationId), { force: true, recursive: true });
    const ingress = (operationId: string, publicOrigin: string) =>
        buildPreviewIngressSpecification({
            listenUnixSocket: ingressSocket(operationId),
            operationId,
            previewPort: 3205,
            publicOrigin,
        });
    const stopRuntime = async (
        record: PreviewDurableRecord,
        signal?: AbortSignal
    ): Promise<void> => {
        let failure: unknown;
        if (record.ownsTailscaleServe) {
            await dependencies.tailscale
                .stopOwned(ingressSocket(record.operationId), record.publicOrigin, signal)
                .catch((error: unknown) => {
                    failure = error;
                });
        }
        await dependencies.runtime.ingress
            .stop(ingress(record.operationId, record.publicOrigin), signal)
            .catch((error: unknown) => {
                failure ??= error;
            });
        await dependencies.runtime
            .stop(unitName(record.operationId), signal)
            .catch((error: unknown) => {
                failure ??= error;
            });
        await removeIngress(record.operationId).catch((error: unknown) => {
            failure ??= error;
        });
        if (failure !== undefined) fail("operation-failed");
    };
    const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = mutation.then(operation, operation);
        mutation = result.then(ignoreSettlement, ignoreSettlement);
        return result;
    };

    const status = async (signal?: AbortSignal): Promise<PreviewHostStatus> => {
        const resolved = await paths();
        const record = await readPreviewState(resolved);
        if (!record) return Object.freeze({ status: "stopped", updatedAtMs: now() });
        const runtime = await dependencies.runtime
            .inspect(unitName(record.operationId), signal)
            .catch(noValue);
        const publication = record.ownsTailscaleServe
            ? await dependencies.tailscale.inspect(
                  ingressSocket(record.operationId),
                  signal
              )
            : undefined;
        return statusFromRecord(record, now(), runtime, publication);
    };

    const stop = (input: unknown, signal?: AbortSignal) =>
        serialized(async (): Promise<PreviewHostStatus> => {
            const request: PreviewStopRequest = parsePreviewStopRequest(input);
            const resolved = await paths();
            const record = await readPreviewState(resolved);
            if (!record) return Object.freeze({ status: "stopped", updatedAtMs: now() });
            if (
                record.number !== request.number ||
                record.previewRevision !== request.previewRevision
            ) {
                fail("slot-conflict");
            }
            const stopping: PreviewDurableRecord = {
                ...record,
                status: "stopping",
                updatedAtMs: now(),
            };
            await writePreviewState(resolved, stopping, record.previewRevision);
            await stopRuntime(stopping, signal).catch(() => fail("operation-failed"));
            const stopped: PreviewDurableRecord = {
                ...stopping,
                expiresAtMs: stopping.updatedAtMs,
                ownsTailscaleServe: false,
                status: "stopped",
            };
            await writePreviewState(resolved, stopped, stopping.previewRevision);
            // Worktree and isolated state are deliberately retained for rebuild.
            return statusFromRecord(stopped, stopped.updatedAtMs, {
                active: false,
                ready: false,
                result: "success",
            });
        });

    const start = (input: unknown, signal?: AbortSignal) =>
        serialized(async (): Promise<PreviewStartResult> => {
            const request = parsePreviewStartRequest(input);
            await assertScope(dependencies.scope, request, signal);
            const resolved = await paths();
            let current = await readPreviewState(resolved);
            if (
                current &&
                current.status !== "stopped" &&
                current.number !== request.number
            ) {
                fail("slot-conflict");
            }
            if (
                current?.status === "running" &&
                current.number === request.number &&
                sameScope(current.expectedHeads, request.expectedHeads)
            ) {
                let runtime = await dependencies.runtime
                    .inspect(unitName(current.operationId), signal)
                    .catch(noValue);
                if (runtime?.active === true) {
                    const requiresRuntimeRecovery = runtime.ready !== true;
                    const capability = buildPreviewGatewaySocketSpecification(
                        await createPreviewGatewayCapability({
                            capabilityRoot: await ensurePreviewPrGatewayRoot(
                                resolved,
                                request.number
                            ),
                        })
                    );
                    await dependencies.runtime.bindGateway(
                        unitName(current.operationId),
                        capability,
                        signal
                    );
                    if (requiresRuntimeRecovery) {
                        await dependencies.runtime.ingress.start(
                            ingress(current.operationId, current.publicOrigin),
                            signal
                        );
                    }
                    runtime = await dependencies.runtime
                        .inspect(unitName(current.operationId), signal)
                        .catch(noValue);
                    let publication = await dependencies.tailscale.inspect(
                        ingressSocket(current.operationId),
                        signal
                    );
                    if (!publication.enabled && current.ownsTailscaleServe) {
                        publication = await dependencies.tailscale.start(
                            ingressSocket(current.operationId),
                            current.publicOrigin,
                            () => Promise.resolve(),
                            signal
                        );
                    }
                    if (
                        runtime?.ready === true &&
                        current.ownsTailscaleServe &&
                        publication.enabled &&
                        publication.origin === current.publicOrigin
                    ) {
                        return {
                            capability,
                            status: statusFromRecord(
                                current,
                                now(),
                                runtime,
                                publication
                            ),
                        };
                    }
                }
            }
            if (current?.status === "stopped" && current.number !== request.number) {
                await removePreviewStateFile(resolved);
                current = undefined;
            }
            if (current && current.status !== "stopped") {
                await stopRuntime(current, signal);
            }
            const publicationBefore = await dependencies.tailscale.inspect(
                ingressSocket(request.operationId),
                signal
            );
            if (publicationBefore.enabled) fail("slot-conflict");
            const startedAtMs = now();
            let starting: PreviewDurableRecord = {
                expectedHeads: request.expectedHeads,
                expiresAtMs: startedAtMs + previewMaximumDurationMs,
                formatVersion: previewFormatVersion,
                number: request.number,
                operationId: request.operationId,
                ownsTailscaleServe: false,
                previewRevision: request.previewRevision,
                publicOrigin: publicationBefore.origin,
                status: "starting",
                title: request.title,
                updatedAtMs: startedAtMs,
            };
            await writePreviewState(resolved, starting, current?.previewRevision);
            const prStateRoot = await prepareManagedPreviewStateRoot(
                resolved,
                request.number
            );
            const prGatewayRoot = await ensurePreviewPrGatewayRoot(
                resolved,
                request.number
            );
            const worktreePath = previewWorktreePath(resolved, request.number);
            await writePreviewRetainedOwner(resolved.ownersRoot, {
                expectedHeadSha: request.expectedHeads.at(-1)!.headSha,
                formatVersion: 1,
                number: request.number,
                previewRevision: request.previewRevision,
                reconciledAtMs: startedAtMs,
            });
            try {
                await preparePreviewWorktree(
                    request,
                    {
                        checkoutRoot: configuration.checkoutRoot,
                        bunExecutable: configuration.bunExecutable,
                        credentials: dependencies.credentials,
                        processRunner: dependencies.processRunner,
                        worktreePath,
                    },
                    signal
                );
                // The GitHub scope is read again after fetch/install and directly before launch.
                await assertScope(dependencies.scope, request, signal);
                const capability = buildPreviewGatewaySocketSpecification(
                    await createPreviewGatewayCapability({
                        capabilityRoot: prGatewayRoot,
                    })
                );
                const launch = buildPreviewLaunchSpecification({
                    bunExecutable: configuration.bunExecutable,
                    capabilitySocket: capability.socketPath,
                    expectedHeadSha: request.expectedHeads.at(-1)!.headSha,
                    ingressSocket: ingressSocket(request.operationId),
                    operationId: request.operationId,
                    publicOrigin: starting.publicOrigin,
                    stateRoot: prStateRoot,
                    worktreePath,
                });
                await prepareIngress(request.operationId);
                await dependencies.runtime.start(launch, capability, signal);
                await dependencies.runtime.ingress.start(
                    ingress(request.operationId, starting.publicOrigin),
                    signal
                );
                const runtime = await dependencies.runtime.inspect(
                    launch.unitName,
                    signal
                );
                if (!runtime.active || !runtime.ready || runtime.result === "failed") {
                    fail("operation-failed");
                }
                const publication = await dependencies.tailscale.start(
                    ingressSocket(request.operationId),
                    starting.publicOrigin,
                    async () => {
                        starting = { ...starting, ownsTailscaleServe: true };
                        await writePreviewState(
                            resolved,
                            starting,
                            starting.previewRevision
                        );
                    },
                    signal
                );
                const runningAt = now();
                const running: PreviewDurableRecord = {
                    ...starting,
                    startedAtMs: runningAt,
                    status: "running",
                    updatedAtMs: runningAt,
                };
                await writePreviewState(resolved, running, starting.previewRevision);
                return {
                    capability,
                    status: statusFromRecord(running, runningAt, runtime, publication),
                };
            } catch (error) {
                const cleanupComplete = await stopRuntime(starting, signal).then(
                    () => true,
                    () => false
                );
                const failedAt = now();
                await writePreviewState(
                    resolved,
                    {
                        ...starting,
                        ownsTailscaleServe: cleanupComplete
                            ? false
                            : starting.ownsTailscaleServe,
                        reason: "Preview startup failed",
                        status: "failed",
                        updatedAtMs: failedAt,
                    },
                    starting.previewRevision
                ).catch(() => {});
                if (error instanceof PreviewHostError) throw error;
                fail("operation-failed");
            }
        });

    const cleanupConfirmed = (input: unknown, signal?: AbortSignal) =>
        serialized(async (): Promise<boolean> => {
            const request: PreviewCleanupRequest = parsePreviewCleanupRequest(input);
            const resolved = await paths();
            const owner = await readPreviewRetainedOwner(
                resolved.ownersRoot,
                request.number
            );
            if (
                owner === undefined ||
                owner.expectedHeadSha !== request.expectedHeadSha
            ) {
                fail("cleanup-not-authorized");
            }
            if (
                !(await dependencies.scope.confirmClosedOrMerged(
                    request.number,
                    request.expectedHeadSha,
                    signal
                ))
            ) {
                fail("cleanup-not-authorized");
            }
            const current = await readPreviewState(resolved);
            const ownsCurrent =
                current?.number === request.number &&
                current.expectedHeads.at(-1)?.headSha === owner.expectedHeadSha &&
                current.previewRevision === owner.previewRevision;
            if (ownsCurrent && current !== undefined) {
                await stopRuntime(current, signal);
                await removePreviewStateFile(resolved);
            }
            await removePreviewWorktree(
                {
                    checkoutRoot: configuration.checkoutRoot,
                    processRunner: dependencies.processRunner,
                    worktreePath: previewWorktreePath(resolved, request.number),
                },
                signal
            );
            await removePreviewRetainedState(
                {
                    gatewaysRoot: resolved.gatewaysRoot,
                    ownersRoot: resolved.ownersRoot,
                    statesRoot: resolved.statesRoot,
                },
                owner
            );
            return true;
        });

    const reconcile = (signal?: AbortSignal) =>
        serialized(async (): Promise<PreviewHostStatus> => {
            const resolved = await paths();
            await reapPreviewStateStages(resolved);
            await reapPreviewRetainedOwnerStages(resolved.ownersRoot);
            await reapPreviewRetainedStages(resolved.statesRoot);
            await reapPreviewRetainedStages(resolved.gatewaysRoot);
            let current = await readPreviewState(resolved);
            const retained = await nextPreviewRetainedOwner(resolved.ownersRoot, now());
            if (retained !== undefined) {
                const closed = await dependencies.scope.confirmClosedOrMerged(
                    retained.number,
                    retained.expectedHeadSha,
                    signal
                );
                if (closed) {
                    const ownsCurrent =
                        current?.number === retained.number &&
                        current.expectedHeads.at(-1)?.headSha ===
                            retained.expectedHeadSha &&
                        current.previewRevision === retained.previewRevision;
                    if (ownsCurrent && current !== undefined) {
                        await stopRuntime(current, signal);
                        await removePreviewStateFile(resolved);
                    }
                    await removePreviewWorktree(
                        {
                            checkoutRoot: configuration.checkoutRoot,
                            processRunner: dependencies.processRunner,
                            worktreePath: previewWorktreePath(resolved, retained.number),
                        },
                        signal
                    );
                    await removePreviewRetainedState(
                        {
                            gatewaysRoot: resolved.gatewaysRoot,
                            ownersRoot: resolved.ownersRoot,
                            statesRoot: resolved.statesRoot,
                        },
                        retained
                    );
                    if (ownsCurrent) {
                        current = undefined;
                    }
                } else {
                    await writePreviewRetainedOwner(resolved.ownersRoot, {
                        ...retained,
                        reconciledAtMs: now(),
                    });
                }
            }
            if (!current) return Object.freeze({ status: "stopped", updatedAtMs: now() });
            let runtime = await dependencies.runtime
                .inspect(unitName(current.operationId), signal)
                .catch(() => ({ active: false, ready: false }));
            if (
                current.status === "running" &&
                runtime.active === true &&
                runtime.ready !== true
            ) {
                const capability = buildPreviewGatewaySocketSpecification(
                    await createPreviewGatewayCapability({
                        capabilityRoot: await ensurePreviewPrGatewayRoot(
                            resolved,
                            current.number
                        ),
                    })
                );
                await dependencies.runtime
                    .bindGateway(unitName(current.operationId), capability, signal)
                    .catch(() => {});
                await dependencies.runtime.ingress
                    .start(ingress(current.operationId, current.publicOrigin), signal)
                    .catch(() => {});
                runtime = await dependencies.runtime
                    .inspect(unitName(current.operationId), signal)
                    .catch(() => ({ active: false, ready: false }));
            }
            let publication = current.ownsTailscaleServe
                ? await dependencies.tailscale.inspect(
                      ingressSocket(current.operationId),
                      signal
                  )
                : undefined;
            if (
                current.status === "running" &&
                current.ownsTailscaleServe &&
                publication?.enabled !== true &&
                runtime.active &&
                runtime.ready
            ) {
                publication = await dependencies.tailscale.start(
                    ingressSocket(current.operationId),
                    current.publicOrigin,
                    () => Promise.resolve(),
                    signal
                );
            }
            if (current.status === "stopping") {
                await stopRuntime(current, signal).catch(() => fail("operation-failed"));
                const stoppedAt = now();
                const stopped: PreviewDurableRecord = {
                    ...current,
                    expiresAtMs: stoppedAt,
                    ownsTailscaleServe: false,
                    status: "stopped",
                    updatedAtMs: stoppedAt,
                };
                await writePreviewState(resolved, stopped, current.previewRevision);
                return statusFromRecord(stopped, stoppedAt, {
                    active: false,
                    ready: false,
                });
            }
            if (
                current.status === "failed" &&
                (current.ownsTailscaleServe || runtime.active)
            ) {
                await stopRuntime(current, signal).catch(() => fail("operation-failed"));
                const failed: PreviewDurableRecord = {
                    ...current,
                    ownsTailscaleServe: false,
                    updatedAtMs: now(),
                };
                await writePreviewState(resolved, failed, current.previewRevision);
                return statusFromRecord(failed, failed.updatedAtMs, {
                    active: false,
                    ready: false,
                    result: "failed",
                });
            }
            const projected = statusFromRecord(current, now(), runtime, publication);
            if (projected.reason === "expired") {
                const cleanupComplete = await stopRuntime(current, signal).then(
                    () => true,
                    () => false
                );
                const stoppedAt = now();
                if (!cleanupComplete) {
                    const failed: PreviewDurableRecord = {
                        ...current,
                        reason: "Preview cleanup is incomplete",
                        status: "failed",
                        updatedAtMs: stoppedAt,
                    };
                    await writePreviewState(resolved, failed, current.previewRevision);
                    return statusFromRecord(failed, stoppedAt, runtime, publication);
                }
                const stopped: PreviewDurableRecord = {
                    ...current,
                    expiresAtMs: stoppedAt,
                    ownsTailscaleServe: false,
                    reason: "Preview expired",
                    status: "stopped",
                    updatedAtMs: stoppedAt,
                };
                await writePreviewState(resolved, stopped, current.previewRevision);
                return statusFromRecord(stopped, stoppedAt, {
                    active: false,
                    ready: false,
                });
            }
            if (
                projected.reason === "startup-interrupted" ||
                projected.reason === "runtime-failed"
            ) {
                const cleanupComplete = await stopRuntime(current, signal).then(
                    () => true,
                    () => false
                );
                const failed: PreviewDurableRecord = {
                    ...current,
                    ownsTailscaleServe: cleanupComplete
                        ? false
                        : current.ownsTailscaleServe,
                    reason: "Preview runtime is unavailable",
                    status: "failed",
                    updatedAtMs: now(),
                };
                await writePreviewState(resolved, failed, current.previewRevision);
                return statusFromRecord(failed, failed.updatedAtMs, runtime, publication);
            }
            return projected;
        });

    return Object.freeze({
        cleanupConfirmed,
        cleanupConfirmedEffect: (input: unknown, signal?: AbortSignal) =>
            Effect.tryPromise({
                catch: (error) =>
                    error instanceof PreviewHostError
                        ? error
                        : new PreviewHostError({ reason: "operation-failed" }),
                try: () => cleanupConfirmed(input, signal),
            }),
        reconcile,
        start,
        startEffect: (input: unknown, signal?: AbortSignal) =>
            Effect.tryPromise({
                catch: (error) =>
                    error instanceof PreviewHostError
                        ? error
                        : new PreviewHostError({ reason: "operation-failed" }),
                try: () => start(input, signal),
            }),
        status,
        stop,
        stopEffect: (input: unknown, signal?: AbortSignal) =>
            Effect.tryPromise({
                catch: (error) =>
                    error instanceof PreviewHostError
                        ? error
                        : new PreviewHostError({ reason: "operation-failed" }),
                try: () => stop(input, signal),
            }),
    });
}
