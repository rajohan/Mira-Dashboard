import * as v from "valibot";

import {
    dockerContainerIdSchema,
    dockerContainerLogsMaximumBytes,
    dockerGetContainerLogsInputSchema,
    dockerGetContainerLogsResultSchema,
    dockerImageMaximum,
    dockerObjectIdSchema,
    dockerOverviewCachePayloadSchema,
    dockerPreparePruneInputSchema,
    dockerSourceRevisionSchema,
    dockerVolumeMaximum,
    dockerVolumeNameSchema,
    type DockerGetContainerLogsInput,
    type DockerGetContainerLogsResult,
    type DockerOverviewCachePayload,
    type DockerPreparePruneInput,
    type DockerPreparePruneResult,
} from "../../contracts/docker.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";
import { compareStrings, hasUniqueArrayItems } from "../../shared/validation.ts";
import { dockerComposeRoot, dockerComposeTrustRoot } from "./composeDiscovery.ts";
import { redactDockerLogLine } from "./dockerLogRedaction.ts";
import {
    createDockerOverviewCollector,
    type DockerOverviewCollector,
} from "./overviewCollector.ts";

const dockerExecutable = "/usr/bin/docker" as const;
const dockerComposeWrapper = "/opt/docker/bin/docker-compose-doppler" as const;
const dockerSocket = "unix:///var/run/docker.sock" as const;
const dockerCwd = "/" as const;
const dockerEnvironment = Object.freeze({
    DOCKER_CONFIG: "/nonexistent/mira-dashboard-docker-config",
    DOCKER_HOST: dockerSocket,
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
});
const dockerArguments = Object.freeze(["--host", dockerSocket] as const);
const composeArguments = Object.freeze([
    "--file",
    dockerComposeRoot,
    "--project-directory",
    dockerComposeTrustRoot,
] as const);

const dockerLogDeadlineMs = 15_000;
const dockerMutationDeadlineMs = 2 * 60_000;
const dockerPruneDeadlineMs = 10 * 60_000;
const dockerStackDeadlineMs = 15 * 60_000;
const dockerProcessOutputMaximumBytes = 64 * 1024;
const dockerLogStreamMaximumBytes = dockerContainerLogsMaximumBytes;
const dockerRemovalBatchMaximumArguments = 128;
const dockerRemovalCommandMaximumBytes = 32 * 1024;
const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

const sourceRevision = { sourceRevision: dockerSourceRevisionSchema };
const canonicalImageIdsSchema = v.pipe(
    v.array(dockerObjectIdSchema, "Docker image prune candidates are invalid"),
    v.maxLength(
        dockerImageMaximum,
        "Docker image prune candidates are outside their budget"
    ),
    v.check(
        (ids) =>
            hasUniqueArrayItems(ids) &&
            ids.every(
                (id, index) => index === 0 || compareStrings(ids[index - 1]!, id) < 0
            ),
        "Docker image prune candidates are not canonical"
    )
);
const canonicalVolumeNamesSchema = v.pipe(
    v.array(dockerVolumeNameSchema, "Docker volume prune candidates are invalid"),
    v.maxLength(
        dockerVolumeMaximum,
        "Docker volume prune candidates are outside their budget"
    ),
    v.check(
        (names) =>
            hasUniqueArrayItems(names) &&
            names.every(
                (name, index) =>
                    index === 0 || compareStrings(names[index - 1]!, name) < 0
            ),
        "Docker volume prune candidates are not canonical"
    )
);

/** Exact non-updater durable payload accepted by the fixed worker executor. */
export const fixedDockerOperationPayloadSchema = v.variant("operation", [
    v.strictObject({
        containerId: dockerContainerIdSchema,
        operation: v.literal("container-restart"),
        ...sourceRevision,
    }),
    v.strictObject({
        containerId: dockerContainerIdSchema,
        operation: v.literal("container-start"),
        ...sourceRevision,
    }),
    v.strictObject({
        containerId: dockerContainerIdSchema,
        operation: v.literal("container-stop"),
        ...sourceRevision,
    }),
    v.strictObject({
        imageId: dockerObjectIdSchema,
        operation: v.literal("image-delete"),
        ...sourceRevision,
    }),
    v.strictObject({
        imageIds: canonicalImageIdsSchema,
        operation: v.literal("prune-execute"),
        ...sourceRevision,
        target: v.literal("images"),
    }),
    v.strictObject({
        operation: v.literal("prune-execute"),
        ...sourceRevision,
        target: v.literal("volumes"),
        volumeNames: canonicalVolumeNamesSchema,
    }),
    v.strictObject({ operation: v.literal("stack-restart"), ...sourceRevision }),
    v.strictObject({ operation: v.literal("stack-start"), ...sourceRevision }),
    v.strictObject({ operation: v.literal("stack-stop"), ...sourceRevision }),
    v.strictObject({
        operation: v.literal("volume-delete"),
        ...sourceRevision,
        volumeName: dockerVolumeNameSchema,
    }),
]);

export type FixedDockerOperationPayload = v.InferOutput<
    typeof fixedDockerOperationPayloadSchema
>;

export type FixedDockerOperationsFailureReason =
    | "conflict"
    | "not-found"
    | "unavailable"
    | "unknown-outcome";

/** Sanitized worker failure that never retains Docker output or host details. */
export class FixedDockerOperationsError extends Error {
    readonly reason: FixedDockerOperationsFailureReason;

    constructor(reason: FixedDockerOperationsFailureReason) {
        super("Docker worker operation failed");
        this.name = "FixedDockerOperationsError";
        this.reason = reason;
    }

    toJSON() {
        return Object.freeze({ name: this.name, reason: this.reason });
    }

    [inspectSymbol](): ReturnType<FixedDockerOperationsError["toJSON"]> {
        return this.toJSON();
    }
}

export type FixedDockerPrunePreview =
    | Omit<
          Extract<DockerPreparePruneResult, { readonly target: "images" }>,
          "expiresAtMs" | "issuedAtMs" | "ticketId"
      >
    | Omit<
          Extract<DockerPreparePruneResult, { readonly target: "volumes" }>,
          "expiresAtMs" | "issuedAtMs" | "ticketId"
      >;

export interface FixedDockerOperationResult {
    readonly operation: FixedDockerOperationPayload["operation"];
    readonly status: "completed";
    readonly targetCount: number;
}

export interface FixedDockerProcessRequest {
    readonly arguments: readonly string[];
    readonly cwd: typeof dockerCwd | typeof dockerComposeTrustRoot;
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: typeof dockerExecutable | typeof dockerComposeWrapper;
    readonly signal: AbortSignal;
    readonly stderrMaximumBytes: number;
    readonly stdoutMaximumBytes: number;
}

export interface FixedDockerProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stderrTruncated: boolean;
    readonly stdout: Uint8Array;
    readonly stdoutTruncated: boolean;
}

export type FixedDockerProcess = (
    request: FixedDockerProcessRequest
) => Promise<FixedDockerProcessResult>;

/** Worker-only Docker reads and exact reviewed mutations; no generic argv exists. */
export interface FixedDockerOperations {
    readonly execute: (
        payload: FixedDockerOperationPayload,
        signal?: AbortSignal
    ) => Promise<FixedDockerOperationResult>;
    readonly previewPrune: (
        input: DockerPreparePruneInput,
        signal?: AbortSignal
    ) => Promise<FixedDockerPrunePreview>;
    readonly readContainerLogs: (
        input: DockerGetContainerLogsInput,
        signal?: AbortSignal
    ) => Promise<DockerGetContainerLogsResult>;
}

interface BoundedTail {
    readonly bytes: Uint8Array;
    readonly truncated: boolean;
}

async function readBoundedTail(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number
): Promise<BoundedTail> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let retainedBytes = 0;
    let totalBytes = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            totalBytes += next.value.byteLength;
            chunks.push(next.value);
            retainedBytes += next.value.byteLength;
            while (
                chunks.length > 0 &&
                retainedBytes - chunks[0]!.byteLength >= maximumBytes
            ) {
                retainedBytes -= chunks.shift()!.byteLength;
            }
            if (retainedBytes > maximumBytes && chunks.length > 0) {
                const excess = retainedBytes - maximumBytes;
                chunks[0] = chunks[0]!.slice(excess);
                retainedBytes = maximumBytes;
            }
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(retainedBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return Object.freeze({ bytes, truncated: totalBytes > retainedBytes });
}

const defaultProcess: FixedDockerProcess = async (request) => {
    const child = Bun.spawn([request.executable, ...request.arguments], {
        cwd: request.cwd,
        env: request.environment,
        killSignal: "SIGKILL",
        signal: request.signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBoundedTail(child.stdout, request.stdoutMaximumBytes),
            readBoundedTail(child.stderr, request.stderrMaximumBytes),
        ]);
        return Object.freeze({
            exitCode,
            stderr: stderr.bytes,
            stderrTruncated: stderr.truncated,
            stdout: stdout.bytes,
            stdoutTruncated: stdout.truncated,
        });
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        throw new FixedDockerOperationsError("unavailable");
    }
};

function operationSignal(
    parentSignal: AbortSignal | undefined,
    deadlineMs: number
): AbortSignal {
    const deadline = AbortSignal.timeout(deadlineMs);
    return parentSignal === undefined
        ? deadline
        : AbortSignal.any([deadline, parentSignal]);
}

function validProcessResult(
    result: FixedDockerProcessResult,
    stdoutMaximumBytes: number,
    stderrMaximumBytes: number
): boolean {
    return (
        Number.isSafeInteger(result.exitCode) &&
        result.exitCode >= 0 &&
        result.stdout instanceof Uint8Array &&
        result.stdout.byteLength <= stdoutMaximumBytes &&
        result.stderr instanceof Uint8Array &&
        result.stderr.byteLength <= stderrMaximumBytes &&
        typeof result.stdoutTruncated === "boolean" &&
        typeof result.stderrTruncated === "boolean"
    );
}

function dockerRequest(
    arguments_: readonly string[],
    deadlineMs: number,
    signal: AbortSignal | undefined,
    outputMaximumBytes = dockerProcessOutputMaximumBytes
): FixedDockerProcessRequest {
    return Object.freeze({
        arguments: Object.freeze([...dockerArguments, ...arguments_]),
        cwd: dockerCwd,
        environment: dockerEnvironment,
        executable: dockerExecutable,
        signal: operationSignal(signal, deadlineMs),
        stderrMaximumBytes: outputMaximumBytes,
        stdoutMaximumBytes: outputMaximumBytes,
    });
}

function composeRequest(
    arguments_: readonly string[],
    signal: AbortSignal | undefined
): FixedDockerProcessRequest {
    return Object.freeze({
        arguments: Object.freeze([...composeArguments, ...arguments_]),
        cwd: dockerComposeTrustRoot,
        environment: dockerEnvironment,
        executable: dockerComposeWrapper,
        signal: operationSignal(signal, dockerStackDeadlineMs),
        stderrMaximumBytes: dockerProcessOutputMaximumBytes,
        stdoutMaximumBytes: dockerProcessOutputMaximumBytes,
    });
}

async function runReadCommand(
    execute: FixedDockerProcess,
    request: FixedDockerProcessRequest
): Promise<FixedDockerProcessResult> {
    let result: FixedDockerProcessResult;
    try {
        result = await execute(request);
    } catch {
        throw new FixedDockerOperationsError("unavailable");
    }
    if (
        !validProcessResult(
            result,
            request.stdoutMaximumBytes,
            request.stderrMaximumBytes
        ) ||
        result.exitCode !== 0
    ) {
        throw new FixedDockerOperationsError("unavailable");
    }
    return result;
}

async function runMutationCommand(
    execute: FixedDockerProcess,
    request: FixedDockerProcessRequest
): Promise<void> {
    let result: FixedDockerProcessResult;
    try {
        result = await execute(request);
    } catch {
        throw new FixedDockerOperationsError("unknown-outcome");
    }
    if (
        !validProcessResult(
            result,
            request.stdoutMaximumBytes,
            request.stderrMaximumBytes
        ) ||
        result.exitCode !== 0
    ) {
        throw new FixedDockerOperationsError("unknown-outcome");
    }
}

function dockerRemovalTargetBatches(
    operationArguments: readonly string[],
    targets: readonly string[]
): readonly (readonly string[])[] {
    const fixedArguments = [dockerExecutable, ...dockerArguments, ...operationArguments];
    const fixedBytes = fixedArguments.reduce(
        (total, argument) => total + utf8ByteLength(argument) + 1,
        0
    );
    const batches: string[][] = [];
    let current: string[] = [];
    let currentBytes = fixedBytes;
    for (const target of targets) {
        const targetBytes = utf8ByteLength(target) + 1;
        if (fixedBytes + targetBytes > dockerRemovalCommandMaximumBytes) {
            throw new FixedDockerOperationsError("unavailable");
        }
        if (
            current.length >= dockerRemovalBatchMaximumArguments ||
            currentBytes + targetBytes > dockerRemovalCommandMaximumBytes
        ) {
            batches.push(current);
            current = [];
            currentBytes = fixedBytes;
        }
        current.push(target);
        currentBytes += targetBytes;
    }
    if (current.length > 0) batches.push(current);
    return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

function parsedNowMs(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new FixedDockerOperationsError("unavailable");
    }
    return value;
}

async function currentOverview(
    collector: DockerOverviewCollector,
    expectedSourceRevision: string,
    signal?: AbortSignal
): Promise<DockerOverviewCachePayload> {
    let collected: unknown;
    try {
        collected = await collector.collect(undefined, signal);
    } catch {
        throw new FixedDockerOperationsError("unavailable");
    }
    const parsed = v.safeParse(dockerOverviewCachePayloadSchema, collected, {
        abortEarly: true,
    });
    if (!parsed.success) throw new FixedDockerOperationsError("unavailable");
    if (parsed.output.sourceRevision !== expectedSourceRevision) {
        throw new FixedDockerOperationsError("conflict");
    }
    return parsed.output;
}

function sumBytes(values: readonly number[]): number {
    let total = 0;
    for (const value of values) {
        total += value;
        if (!Number.isSafeInteger(total) || total < 0) {
            throw new FixedDockerOperationsError("unavailable");
        }
    }
    return total;
}

interface TimestampedLogLine {
    readonly line: string;
    readonly order: number;
    readonly timestamp?: string;
}

const dockerLogTimestampPattern =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\s/u;

function physicalLogLines(
    bytes: Uint8Array,
    truncated: boolean,
    startingOrder: number
): readonly TimestampedLogLine[] {
    const decoded = new TextDecoder("utf-8").decode(bytes);
    const rawLines = decoded.split("\n");
    if (rawLines.at(-1) === "") rawLines.pop();
    if (truncated && rawLines.length > 0) rawLines.shift();
    return Object.freeze(
        rawLines.map((raw, index) => {
            const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
            const timestamp = dockerLogTimestampPattern.exec(line)?.[1];
            return Object.freeze({
                line,
                order: startingOrder + index,
                ...(timestamp === undefined ? {} : { timestamp }),
            });
        })
    );
}

function projectLogLines(
    result: FixedDockerProcessResult,
    tail: number
): { readonly lines: readonly string[]; readonly truncated: boolean } {
    const stdout = physicalLogLines(result.stdout, result.stdoutTruncated, 0);
    const stderr = physicalLogLines(result.stderr, result.stderrTruncated, stdout.length);
    const chronological = [...stdout, ...stderr].toSorted((left, right) => {
        if (left.timestamp !== undefined && right.timestamp !== undefined) {
            return (
                compareStrings(left.timestamp, right.timestamp) ||
                left.order - right.order
            );
        }
        return left.order - right.order;
    });
    const selected = chronological.slice(-tail);
    let truncated =
        result.stdoutTruncated ||
        result.stderrTruncated ||
        selected.length < chronological.length;
    const lines = selected.map(({ line }) => {
        const redactedLine = redactDockerLogLine(line);
        if (redactedLine.endsWith("… [truncated]")) truncated = true;
        return redactedLine;
    });
    return Object.freeze({ lines: Object.freeze(lines), truncated });
}

function boundedLogResult(input: {
    readonly containerId: string;
    readonly lines: readonly string[];
    readonly observedAtMs: number;
    readonly sourceRevision: string;
    readonly truncated: boolean;
}): DockerGetContainerLogsResult {
    let lines = [...input.lines];
    let truncated = input.truncated;
    while (
        lines.length > 0 &&
        utf8ByteLength(
            JSON.stringify({
                containerId: input.containerId,
                lines,
                observedAtMs: input.observedAtMs,
                redacted: true,
                sourceRevision: input.sourceRevision,
                truncated,
            })
        ) > dockerContainerLogsMaximumBytes
    ) {
        lines = lines.slice(1);
        truncated = true;
    }
    try {
        return v.parse(dockerGetContainerLogsResultSchema, {
            containerId: input.containerId,
            lines,
            observedAtMs: input.observedAtMs,
            redacted: true,
            sourceRevision: input.sourceRevision,
            truncated,
        });
    } catch {
        throw new FixedDockerOperationsError("unavailable");
    }
}

function requireContainer(
    overview: DockerOverviewCachePayload,
    containerId: string
): void {
    if (!overview.containers.some(({ id }) => id === containerId)) {
        throw new FixedDockerOperationsError("not-found");
    }
}

function unusedImageRemovalTargets(
    overview: DockerOverviewCachePayload,
    imageId: string
): readonly string[] {
    const image = overview.images.find(({ id }) => id === imageId);
    if (image === undefined) throw new FixedDockerOperationsError("not-found");
    if (image.usedByContainerIds.length > 0) {
        throw new FixedDockerOperationsError("conflict");
    }
    return image.references.length > 1 ? image.references : [image.id];
}

function requireUnusedVolume(
    overview: DockerOverviewCachePayload,
    volumeName: string
): void {
    const volume = overview.volumes.find(({ name }) => name === volumeName);
    if (volume === undefined) throw new FixedDockerOperationsError("not-found");
    if (volume.usedByContainerIds.length > 0) {
        throw new FixedDockerOperationsError("conflict");
    }
}

function parseOperationPayload(input: FixedDockerOperationPayload) {
    try {
        return v.parse(fixedDockerOperationPayloadSchema, input);
    } catch {
        throw new FixedDockerOperationsError("unavailable");
    }
}

/**
 * Creates the worker-only Docker read/mutation boundary. Every invocation
 * re-discovers the current Engine/Compose state and fences it against the exact
 * public source revision before issuing one reviewed fixed command.
 * @param options Injectable process, overview, and clock boundaries for composition/tests.
 * @returns Frozen purpose-built Docker worker port.
 */
export function createFixedDockerOperations(
    options: {
        readonly nowMs?: () => number;
        readonly overview?: DockerOverviewCollector;
        readonly process?: FixedDockerProcess;
    } = {}
): FixedDockerOperations {
    const collector = options.overview ?? createDockerOverviewCollector();
    const executeProcess = options.process ?? defaultProcess;
    const nowMs = options.nowMs ?? Date.now;

    return Object.freeze({
        async execute(payload: FixedDockerOperationPayload, signal?: AbortSignal) {
            const operation = parseOperationPayload(payload);
            const overview = await currentOverview(
                collector,
                operation.sourceRevision,
                signal
            );
            switch (operation.operation) {
                case "container-restart":
                case "container-start":
                case "container-stop": {
                    requireContainer(overview, operation.containerId);
                    const action = operation.operation.slice("container-".length);
                    await runMutationCommand(
                        executeProcess,
                        dockerRequest(
                            ["container", action, operation.containerId],
                            dockerMutationDeadlineMs,
                            signal
                        )
                    );
                    return Object.freeze({
                        operation: operation.operation,
                        status: "completed" as const,
                        targetCount: 1,
                    });
                }
                case "image-delete": {
                    const targets = unusedImageRemovalTargets(
                        overview,
                        operation.imageId
                    );
                    await runMutationCommand(
                        executeProcess,
                        dockerRequest(
                            ["image", "rm", ...targets],
                            dockerMutationDeadlineMs,
                            signal
                        )
                    );
                    return Object.freeze({
                        operation: operation.operation,
                        status: "completed" as const,
                        targetCount: 1,
                    });
                }
                case "prune-execute": {
                    const targets =
                        operation.target === "images"
                            ? operation.imageIds.flatMap((imageId) =>
                                  unusedImageRemovalTargets(overview, imageId)
                              )
                            : operation.volumeNames;
                    if (operation.target === "volumes") {
                        for (const volumeName of operation.volumeNames) {
                            requireUnusedVolume(overview, volumeName);
                        }
                    }
                    if (operation.target === "images") {
                        const batches = dockerRemovalTargetBatches(
                            ["image", "rm"],
                            targets
                        );
                        const pruneSignal = operationSignal(
                            signal,
                            dockerPruneDeadlineMs
                        );
                        for (const batch of batches) {
                            await runMutationCommand(
                                executeProcess,
                                dockerRequest(
                                    ["image", "rm", ...batch],
                                    dockerPruneDeadlineMs,
                                    pruneSignal
                                )
                            );
                        }
                    } else if (targets.length > 0) {
                        await runMutationCommand(
                            executeProcess,
                            dockerRequest(
                                ["volume", "rm", ...targets],
                                dockerPruneDeadlineMs,
                                signal
                            )
                        );
                    }
                    return Object.freeze({
                        operation: operation.operation,
                        status: "completed" as const,
                        targetCount:
                            operation.target === "images"
                                ? operation.imageIds.length
                                : operation.volumeNames.length,
                    });
                }
                case "stack-restart":
                case "stack-start":
                case "stack-stop": {
                    const arguments_ = [operation.operation.slice("stack-".length)];
                    await runMutationCommand(
                        executeProcess,
                        composeRequest(arguments_, signal)
                    );
                    return Object.freeze({
                        operation: operation.operation,
                        status: "completed" as const,
                        targetCount: overview.containers.length,
                    });
                }
                case "volume-delete": {
                    requireUnusedVolume(overview, operation.volumeName);
                    await runMutationCommand(
                        executeProcess,
                        dockerRequest(
                            ["volume", "rm", operation.volumeName],
                            dockerMutationDeadlineMs,
                            signal
                        )
                    );
                    return Object.freeze({
                        operation: operation.operation,
                        status: "completed" as const,
                        targetCount: 1,
                    });
                }
            }
            throw new FixedDockerOperationsError("unavailable");
        },
        async previewPrune(input: DockerPreparePruneInput, signal?: AbortSignal) {
            let parsed: DockerPreparePruneInput;
            try {
                parsed = v.parse(dockerPreparePruneInputSchema, input);
            } catch {
                throw new FixedDockerOperationsError("unavailable");
            }
            const overview = await currentOverview(
                collector,
                parsed.sourceRevision,
                signal
            );
            if (parsed.target === "images") {
                const items = overview.images
                    .filter(({ usedByContainerIds }) => usedByContainerIds.length === 0)
                    .map(({ id, references, sizeBytes }) =>
                        Object.freeze({ id, references, sizeBytes })
                    );
                return Object.freeze({
                    estimatedReclaimableBytes: sumBytes(
                        items.map(({ sizeBytes }) => sizeBytes)
                    ),
                    items,
                    sourceRevision: overview.sourceRevision,
                    target: "images" as const,
                });
            }
            const items = overview.volumes
                .filter(({ usedByContainerIds }) => usedByContainerIds.length === 0)
                .map(({ name, sizeBytes }) =>
                    Object.freeze({
                        name,
                        ...(sizeBytes === undefined ? {} : { sizeBytes }),
                    })
                );
            return Object.freeze({
                estimatedReclaimableBytes: sumBytes(
                    items.map(({ sizeBytes }) => sizeBytes ?? 0)
                ),
                items,
                sourceRevision: overview.sourceRevision,
                target: "volumes" as const,
            });
        },
        async readContainerLogs(
            input: DockerGetContainerLogsInput,
            signal?: AbortSignal
        ) {
            let parsed: DockerGetContainerLogsInput;
            try {
                parsed = v.parse(dockerGetContainerLogsInputSchema, input);
            } catch {
                throw new FixedDockerOperationsError("unavailable");
            }
            const overview = await currentOverview(
                collector,
                parsed.sourceRevision,
                signal
            );
            requireContainer(overview, parsed.containerId);
            const request = dockerRequest(
                [
                    "logs",
                    "--tail",
                    String(parsed.tail),
                    "--timestamps",
                    parsed.containerId,
                ],
                dockerLogDeadlineMs,
                signal,
                dockerLogStreamMaximumBytes
            );
            const output = await runReadCommand(executeProcess, request);
            const projected = projectLogLines(output, parsed.tail);
            return boundedLogResult({
                containerId: parsed.containerId,
                lines: projected.lines,
                observedAtMs: parsedNowMs(nowMs),
                sourceRevision: overview.sourceRevision,
                truncated: projected.truncated,
            });
        },
    });
}
