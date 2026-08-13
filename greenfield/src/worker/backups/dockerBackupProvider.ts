import * as v from "valibot";

import {
    type BackupCachePayload,
    type BackupType,
    backupCapabilityByType,
    backupFreshnessMaximumAgeMs,
    backupKopiaSourceIdSchema,
    backupSourceRevisionSchema,
    backupTypes,
    kopiaBackupCachePayloadSchema,
    walgBackupCachePayloadSchema,
} from "../../contracts/backups.ts";
import {
    type BackupExecutionOutcome,
    BackupExecutionError,
    type BackupJobExecutionPort,
    type BackupRefreshResult,
    backupKopiaSourceSummaryFromWrapper,
    backupWrapperRunResultSchema,
    backupWrapperStatusSchema,
} from "../../contracts/backupsWorker.ts";
import {
    discoverDockerComposeServices,
    type DockerComposeDiscoveredService,
    type DockerComposeDiscoveryResult,
    type DockerEngineComposeIdentity,
} from "../docker/composeDiscovery.ts";
import {
    createDockerEngineInventoryCollector,
    type DockerEngineInventoryAvailableContainer,
    type DockerEngineInventoryCollector,
    type DockerEngineInventoryProcessResult,
    type DockerEngineInventorySnapshot,
} from "../docker/engineInventory.ts";
import { dockerEngineComposeIdentities } from "../docker/overviewProjection.ts";

export const backupDockerExecutable = "/usr/bin/docker" as const;
export const backupProviderStatusWrapper =
    "/usr/local/bin/mira-dashboard-backup-status" as const;
export const backupProviderRunWrapper =
    "/usr/local/bin/mira-dashboard-backup-run" as const;
export const backupProviderStatusDeadlineMs = 30_000;
export const backupProviderRunDeadlineMs = 5 * 60 * 60_000 + 55 * 60_000;

const backupDockerArguments = Object.freeze([
    "--host",
    "unix:///var/run/docker.sock",
] as const);
const backupDockerEnvironment = Object.freeze({
    DOCKER_CONFIG: "/nonexistent/mira-dashboard-docker-config",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
});
const backupProviderOutputMaximumBytes = 64 * 1024;
const backupProviderStderrMaximumBytes = 16 * 1024;
const backupProviderBusyExitCode = 73;

export interface DockerBackupProviderProcessRequest {
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: typeof backupDockerExecutable;
    readonly signal: AbortSignal;
    readonly stdoutMaximumBytes: number;
}

export type DockerBackupProviderProcessResult = DockerEngineInventoryProcessResult;
export type DockerBackupProviderProcess = (
    request: DockerBackupProviderProcessRequest
) => Promise<DockerBackupProviderProcessResult>;

export interface DockerBackupProvider {
    readonly containerId: string;
    readonly kopiaSourceIds: readonly string[];
    readonly type: BackupType;
}

export interface DockerBackupProviderTopology {
    readonly providers: Readonly<Record<BackupType, DockerBackupProvider>>;
    readonly sourceRevision: string;
}

export interface DockerBackupDiscoveredProvider {
    readonly provider: DockerBackupProvider;
    readonly sourceRevision: string;
}

export interface DockerBackupProviderDiscovery {
    readonly discover: (signal?: AbortSignal) => Promise<DockerBackupProviderTopology>;
    readonly discoverOne: (
        type: BackupType,
        signal?: AbortSignal
    ) => Promise<DockerBackupDiscoveredProvider>;
}

export interface DockerBackupProviderDiscoveryOptions {
    readonly discoverCompose?: (
        identities: readonly DockerEngineComposeIdentity[]
    ) => DockerComposeDiscoveryResult;
    readonly engine?: DockerEngineInventoryCollector;
}

export interface DockerBackupJobExecutionOptions extends DockerBackupProviderDiscoveryOptions {
    readonly nowMs?: () => number;
    readonly process?: DockerBackupProviderProcess;
    readonly runDeadlineMs?: number;
    readonly statusDeadlineMs?: number;
}

/** Internal process failure preserving only whether external dispatch might have begun. */
export class DockerBackupProviderProcessError extends Error {
    readonly dispatched: boolean;

    constructor(dispatched: boolean, cause?: unknown) {
        super(
            "Backup provider process failed",
            cause === undefined ? undefined : { cause }
        );
        this.name = "DockerBackupProviderProcessError";
        this.dispatched = dispatched;
    }
}

function fail(reason: ConstructorParameters<typeof BackupExecutionError>[0]): never {
    throw new BackupExecutionError(reason);
}

function compareText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function composeConfigFiles(
    container: DockerEngineInventoryAvailableContainer
): readonly string[] | undefined {
    const raw = container.labels["com.docker.compose.project.config_files"];
    if (raw === undefined) return undefined;
    const files = raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "")
        .toSorted(compareText);
    return files.length > 0 && new Set(files).size === files.length
        ? Object.freeze(files)
        : undefined;
}

function matchesService(
    container: DockerEngineInventoryAvailableContainer,
    service: DockerComposeDiscoveredService
): boolean {
    const configFiles = composeConfigFiles(container);
    return (
        configFiles !== undefined &&
        container.labels["com.docker.compose.project"] === service.project &&
        container.labels["com.docker.compose.service"] === service.service &&
        JSON.stringify(configFiles) === JSON.stringify(service.configFiles)
    );
}

function kopiaSourceIds(
    container: DockerEngineInventoryAvailableContainer
): readonly string[] {
    const ids: string[] = [];
    for (const mount of container.mounts) {
        if (!mount.destination.startsWith("/source/")) continue;
        const parsed = v.safeParse(
            backupKopiaSourceIdSchema,
            mount.destination.slice("/source/".length)
        );
        if (!parsed.success || !mount.readOnly) fail("unavailable");
        ids.push(parsed.output);
    }
    ids.sort(compareText);
    if (ids.length === 0 || new Set(ids).size !== ids.length) fail("unavailable");
    return Object.freeze(ids);
}

function providerFor(
    type: BackupType,
    compose: DockerComposeDiscoveryResult,
    engine: DockerEngineInventorySnapshot
): DockerBackupProvider {
    const capability = backupCapabilityByType[type];
    const composeCandidates = compose.services.filter(
        ({ labels }) => labels["mira.dashboard.backup"] === capability
    );
    if (
        composeCandidates.length !== 1 ||
        composeCandidates[0]?.sourceAmbiguous === true
    ) {
        return fail("unavailable");
    }
    const service = composeCandidates[0]!;
    const containers = engine.containers.filter(
        (container): container is DockerEngineInventoryAvailableContainer =>
            container.availability === "available" &&
            matchesService(container, service) &&
            container.labels["mira.dashboard.backup"] === capability
    );
    if (containers.length !== 1) fail("unavailable");
    const container = containers[0]!;
    if (
        !container.status.running ||
        container.status.dead ||
        container.status.paused ||
        container.status.restarting ||
        container.health !== "healthy"
    ) {
        fail("unavailable");
    }
    const provider: DockerBackupProvider = {
        containerId: container.id,
        kopiaSourceIds: type === "kopia" ? kopiaSourceIds(container) : [],
        type,
    };
    return Object.freeze(provider);
}

function topologyRevision(input: {
    readonly compose: DockerComposeDiscoveryResult;
    readonly engine: DockerEngineInventorySnapshot;
    readonly providers: Readonly<Record<BackupType, DockerBackupProvider>>;
}): string {
    return v.parse(
        backupSourceRevisionSchema,
        new Bun.CryptoHasher("sha256")
            .update(
                JSON.stringify({
                    compose: input.compose.sourceRevision,
                    engine: input.engine.sourceRevision,
                    providers: backupTypes.map((type) => ({
                        containerId: input.providers[type].containerId,
                        kopiaSourceIds: input.providers[type].kopiaSourceIds,
                        type,
                    })),
                })
            )
            .digest("hex")
    );
}

function providerRevision(input: {
    readonly compose: DockerComposeDiscoveryResult;
    readonly engine: DockerEngineInventorySnapshot;
    readonly provider: DockerBackupProvider;
}): string {
    return v.parse(
        backupSourceRevisionSchema,
        new Bun.CryptoHasher("sha256")
            .update(
                JSON.stringify({
                    compose: input.compose.sourceRevision,
                    engine: input.engine.sourceRevision,
                    provider: input.provider,
                })
            )
            .digest("hex")
    );
}

/**
 * Creates root-Compose and Engine provider discovery with independent capability reads.
 * Foreign Compose projects remain inventory-only and no provider names escape this boundary.
 *
 * @param options - Optional discovery and Engine inventory dependencies.
 * @returns The immutable backup provider discovery boundary.
 */
export function createDockerBackupProviderDiscovery(
    options: DockerBackupProviderDiscoveryOptions = {}
): DockerBackupProviderDiscovery {
    const engine = options.engine ?? createDockerEngineInventoryCollector();
    const discoverCompose = options.discoverCompose ?? discoverDockerComposeServices;
    async function collect(signal?: AbortSignal) {
        signal?.throwIfAborted();
        const engineSnapshot = await engine.collect(signal);
        signal?.throwIfAborted();
        return Object.freeze({
            compose: discoverCompose(dockerEngineComposeIdentities(engineSnapshot)),
            engineSnapshot,
        });
    }
    const providerDiscovery: DockerBackupProviderDiscovery = {
        async discover(signal?: AbortSignal) {
            try {
                const { compose, engineSnapshot } = await collect(signal);
                const providers = Object.freeze({
                    kopia: providerFor("kopia", compose, engineSnapshot),
                    walg: providerFor("walg", compose, engineSnapshot),
                });
                return Object.freeze({
                    providers,
                    sourceRevision: topologyRevision({
                        compose,
                        engine: engineSnapshot,
                        providers,
                    }),
                });
            } catch (error) {
                if (signal?.aborted === true) throw error;
                if (error instanceof BackupExecutionError) throw error;
                throw new BackupExecutionError("unavailable", { cause: error });
            }
        },
        async discoverOne(type, signal) {
            try {
                const { compose, engineSnapshot } = await collect(signal);
                const provider = providerFor(type, compose, engineSnapshot);
                return Object.freeze({
                    provider,
                    sourceRevision: providerRevision({
                        compose,
                        engine: engineSnapshot,
                        provider,
                    }),
                });
            } catch (error) {
                if (signal?.aborted === true) throw error;
                if (error instanceof BackupExecutionError) throw error;
                throw new BackupExecutionError("unavailable", { cause: error });
            }
        },
    };
    return Object.freeze(providerDiscovery);
}

async function readBounded(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maximumBytes) throw new RangeError("Backup output is too large");
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

const defaultProcess: DockerBackupProviderProcess = async (request) => {
    request.signal.throwIfAborted();
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
        child = Bun.spawn([request.executable, ...request.arguments], {
            env: request.environment,
            signal: request.signal,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
        });
    } catch (error) {
        throw new DockerBackupProviderProcessError(false, error);
    }
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBounded(child.stdout, request.stdoutMaximumBytes),
            readBounded(child.stderr, backupProviderStderrMaximumBytes),
        ]);
        return { exitCode, stderr, stdout };
    } catch (error) {
        child.kill();
        await child.exited.catch(() => {});
        throw new DockerBackupProviderProcessError(true, error);
    }
};

function operationSignal(
    parentSignal: AbortSignal | undefined,
    deadlineMs: number
): AbortSignal {
    const deadline = AbortSignal.timeout(deadlineMs);
    return parentSignal === undefined
        ? deadline
        : AbortSignal.any([parentSignal, deadline]);
}

function processRequest(
    provider: DockerBackupProvider,
    wrapper: typeof backupProviderRunWrapper | typeof backupProviderStatusWrapper,
    signal: AbortSignal
): DockerBackupProviderProcessRequest {
    return Object.freeze({
        arguments: Object.freeze([
            ...backupDockerArguments,
            "exec",
            provider.containerId,
            wrapper,
        ]),
        environment: backupDockerEnvironment,
        executable: backupDockerExecutable,
        signal,
        stdoutMaximumBytes: backupProviderOutputMaximumBytes,
    });
}

function decodedJson(bytes: Uint8Array): unknown {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new BackupExecutionError("provider-failed", { cause: error });
    }
}

function checkedNow(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) fail("unavailable");
    return value;
}

function checkedDeadline(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new RangeError("Backup provider deadline is invalid");
    }
    return value;
}

function sourceSetsMatch(left: readonly string[], right: readonly string[]): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Creates the fixed, non-shell provider status/run/idle-proof execution port.
 *
 * @param options - Optional provider discovery, process, clock, and deadline dependencies.
 * @returns The immutable worker-only backup execution port.
 */
export function createDockerBackupJobExecutionPort(
    options: DockerBackupJobExecutionOptions = {}
): BackupJobExecutionPort {
    const discovery = createDockerBackupProviderDiscovery(options);
    const execute = options.process ?? defaultProcess;
    const nowMs = options.nowMs ?? Date.now;
    const statusDeadlineMs = checkedDeadline(
        options.statusDeadlineMs ?? backupProviderStatusDeadlineMs,
        backupProviderStatusDeadlineMs
    );
    const runDeadlineMs = checkedDeadline(
        options.runDeadlineMs ?? backupProviderRunDeadlineMs,
        backupProviderRunDeadlineMs
    );

    async function status(
        provider: DockerBackupProvider,
        type: BackupType,
        parentSignal?: AbortSignal
    ) {
        const signal = operationSignal(parentSignal, statusDeadlineMs);
        let result: DockerBackupProviderProcessResult;
        try {
            result = await execute(
                processRequest(provider, backupProviderStatusWrapper, signal)
            );
        } catch (error) {
            throw new BackupExecutionError("unavailable", { cause: error });
        }
        signal.throwIfAborted();
        if (result.exitCode !== 0) fail("unavailable");
        const parsed = v.parse(backupWrapperStatusSchema, decodedJson(result.stdout));
        if (parsed.type !== type) fail("unavailable");
        if (
            parsed.type === "kopia" &&
            !sourceSetsMatch(
                parsed.sources.map(({ id }) => id),
                provider.kopiaSourceIds
            )
        ) {
            fail("unavailable");
        }
        return parsed;
    }

    async function topologyForMutation(
        type: BackupType,
        expectedSourceRevision: string | undefined,
        signal?: AbortSignal
    ): Promise<DockerBackupDiscoveredProvider> {
        const discovered = await discovery.discoverOne(type, signal);
        if (
            expectedSourceRevision !== undefined &&
            discovered.sourceRevision !==
                v.parse(backupSourceRevisionSchema, expectedSourceRevision)
        ) {
            fail("conflict");
        }
        const providerStatus = await status(discovered.provider, type, signal);
        if (!providerStatus.idle) {
            fail("provider-busy");
        }
        return discovered;
    }

    const executionPort: BackupJobExecutionPort = {
        async clearAttention(input, signal) {
            const discovered = await topologyForMutation(
                input.type,
                input.sourceRevision,
                signal
            );
            return Object.freeze({
                outcome: "completed" as const,
                sourceRevision: discovered.sourceRevision,
            });
        },
        async refresh(signal): Promise<BackupRefreshResult> {
            const observedAtMs = checkedNow(nowMs);
            const results = await Promise.allSettled(
                backupTypes.map(async (type): Promise<BackupCachePayload> => {
                    const discovered = await discovery.discoverOne(type, signal);
                    const projected = await status(discovered.provider, type, signal);
                    if (projected.type === "kopia") {
                        const sources = projected.sources.map((source) =>
                            backupKopiaSourceSummaryFromWrapper(
                                source,
                                observedAtMs,
                                backupFreshnessMaximumAgeMs
                            )
                        );
                        const backupCount = sources.reduce(
                            (total, source) => total + source.snapshotCount,
                            0
                        );
                        return v.parse(kopiaBackupCachePayloadSchema, {
                            backupCount,
                            healthy: sources.every(({ health }) => health === "current"),
                            observedAtMs,
                            providerIdle: projected.idle,
                            sourceRevision: discovered.sourceRevision,
                            sources,
                            type,
                        });
                    }
                    const latestCompletedAtMs = projected.latestCompletedAtMs;
                    const healthy =
                        projected.backupCount > 0 &&
                        latestCompletedAtMs !== undefined &&
                        observedAtMs - latestCompletedAtMs <= backupFreshnessMaximumAgeMs;
                    return v.parse(walgBackupCachePayloadSchema, {
                        backupCount: projected.backupCount,
                        healthy,
                        ...(latestCompletedAtMs === undefined
                            ? {}
                            : { latestCompletedAtMs }),
                        observedAtMs,
                        providerIdle: projected.idle,
                        sourceRevision: discovered.sourceRevision,
                        type,
                    });
                })
            );
            return Object.freeze({
                kopia:
                    results[0]?.status === "fulfilled"
                        ? Object.freeze({
                              kind: "succeeded" as const,
                              payload: results[0].value,
                          })
                        : Object.freeze({ kind: "failed" as const }),
                walg:
                    results[1]?.status === "fulfilled"
                        ? Object.freeze({
                              kind: "succeeded" as const,
                              payload: results[1].value,
                          })
                        : Object.freeze({ kind: "failed" as const }),
            });
        },
        async run(input, parentSignal): Promise<BackupExecutionOutcome> {
            const discovered = await topologyForMutation(
                input.type,
                input.expectedSourceRevision,
                parentSignal
            );
            const provider = discovered.provider;
            const signal = operationSignal(parentSignal, runDeadlineMs);
            let result: DockerBackupProviderProcessResult;
            try {
                result = await execute(
                    processRequest(provider, backupProviderRunWrapper, signal)
                );
            } catch (error) {
                if (
                    error instanceof DockerBackupProviderProcessError &&
                    !error.dispatched
                ) {
                    throw new BackupExecutionError("unavailable", { cause: error });
                }
                return Object.freeze({ outcome: "unknown-outcome" as const });
            }
            if (signal.aborted) {
                return Object.freeze({ outcome: "unknown-outcome" as const });
            }
            if (result.exitCode === backupProviderBusyExitCode) fail("provider-busy");
            if (result.exitCode !== 0) fail("provider-failed");
            let parsed: v.InferOutput<typeof backupWrapperRunResultSchema>;
            try {
                parsed = v.parse(
                    backupWrapperRunResultSchema,
                    decodedJson(result.stdout)
                );
            } catch {
                return Object.freeze({ outcome: "unknown-outcome" as const });
            }
            if (parsed.type !== input.type) {
                return Object.freeze({ outcome: "unknown-outcome" as const });
            }
            return Object.freeze({
                outcome: "completed" as const,
                sourceRevision: discovered.sourceRevision,
            });
        },
    };
    return Object.freeze(executionPort);
}
