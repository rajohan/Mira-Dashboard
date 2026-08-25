import { Redacted } from "effect";

import {
    databaseObservabilityHostnameIsLoopback,
    databaseObservabilityPgBouncerControlAlias,
} from "../../shared/databaseObservabilityPolicy.ts";
import type {
    DatabaseObservabilityConnection,
    DatabaseObservabilityConnectionResolver,
    DatabaseObservabilityConnectionSource,
    DatabaseObservabilityResolvedConnection,
} from "./bunSqlDatabaseObservabilityCollector.ts";

/** Exact opt-in authority read from the candidate container's Compose labels. */
export const databaseObservabilityDockerCapabilityLabel =
    "mira.dashboard.database-observability" as const;
export const databaseObservabilityDockerCapabilityValue = "pgbouncer-v1" as const;
export const databaseObservabilityDockerInspectFormat = [
    "{{json .Id}}",
    "{{json .State.Running}}",
    "{{json .State.Status}}",
    '{{with (index .State "Health")}}{{json (index . "Status")}}{{else}}null{{end}}',
    `{{with .Config.Labels}}{{json (index . "${databaseObservabilityDockerCapabilityLabel}")}}{{else}}null{{end}}`,
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.project")}}{{else}}null{{end}}',
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.service")}}{{else}}null{{end}}',
    "{{json .NetworkSettings.Ports}}",
].join("\t");

export const databaseObservabilityDockerContainerMaximum = 256;
export const databaseObservabilityDockerDiscoveryDeadlineMs = 5000;

const dockerExecutableDefault = "/usr/bin/docker";
const dockerEngineArguments = Object.freeze([
    "--host",
    "unix:///var/run/docker.sock",
] as const);
const dockerPsOutputMaximumBytes = 256 * 1024;
const dockerInspectOutputMaximumBytes = 4 * 1024 * 1024;
const dockerStderrMaximumBytes = 64 * 1024;
const credentialMaximumLength = 4096;
const composeIdentityMaximumLength = 128;
const containerIdPattern = /^[0-9a-f]{64}$/u;
const controlTextPattern = /[\p{Cc}\p{Cf}]/u;

export interface DockerDatabaseObservabilityCredentials {
    readonly password: Redacted.Redacted<string>;
}

export interface DockerDatabaseObservabilityProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type DockerDatabaseObservabilityProcess = (
    executable: string,
    arguments_: readonly string[],
    signal: AbortSignal,
    stdoutMaximumBytes: number
) => Promise<DockerDatabaseObservabilityProcessResult>;

function discoveryFailure(): Error {
    return new Error("Database observability Docker discovery failed");
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
            if (total > maximumBytes) throw discoveryFailure();
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

const defaultProcess: DockerDatabaseObservabilityProcess = async (
    executable,
    arguments_,
    signal,
    stdoutMaximumBytes
) => {
    const child = Bun.spawn([executable, ...arguments_], {
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBounded(child.stdout, stdoutMaximumBytes),
            readBounded(child.stderr, dockerStderrMaximumBytes),
        ]);
        return { exitCode, stderr, stdout };
    } catch {
        child.kill();
        await child.exited.catch(() => {});
        throw discoveryFailure();
    }
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownRecordProperty(value: Record<string, unknown>, property: string): unknown {
    return Object.hasOwn(value, property) ? value[property] : undefined;
}

function decodeUtf8(value: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
        throw discoveryFailure();
    }
}

function requireSuccessfulProcess(
    result: DockerDatabaseObservabilityProcessResult,
    stdoutMaximumBytes: number
): string {
    if (
        result.exitCode !== 0 ||
        !(result.stdout instanceof Uint8Array) ||
        !(result.stderr instanceof Uint8Array) ||
        result.stdout.byteLength > stdoutMaximumBytes ||
        result.stderr.byteLength > dockerStderrMaximumBytes
    ) {
        throw discoveryFailure();
    }
    return decodeUtf8(result.stdout);
}

function parseContainerIds(output: string): readonly string[] {
    const trimmed = output.trim();
    if (trimmed === "") return Object.freeze([]);
    const lines = trimmed.split("\n");
    if (lines.length > databaseObservabilityDockerContainerMaximum) {
        throw discoveryFailure();
    }
    const ids = lines.map((line) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            throw discoveryFailure();
        }
        if (typeof parsed !== "string" || !containerIdPattern.test(parsed)) {
            throw discoveryFailure();
        }
        return parsed;
    });
    if (new Set(ids).size !== ids.length) throw discoveryFailure();
    return Object.freeze(ids);
}

function parseInspectRows(
    output: string,
    containerIds: readonly string[]
): readonly Record<string, unknown>[] {
    const trimmed = output.trim();
    if (trimmed === "") throw discoveryFailure();
    const lines = trimmed.split("\n");
    if (lines.length !== containerIds.length) throw discoveryFailure();
    const expectedIds = new Set(containerIds);
    const observedIds = new Set<string>();
    const rows = lines.map((line) => {
        const fields = line.split("\t");
        if (fields.length !== 8) throw discoveryFailure();
        let projected: unknown[];
        try {
            projected = fields.map((field) => JSON.parse(field) as unknown);
        } catch {
            throw discoveryFailure();
        }
        const [
            id,
            running,
            status,
            healthStatus,
            capability,
            composeProject,
            composeService,
            ports,
        ] = projected;
        if (typeof id !== "string" || !expectedIds.has(id) || observedIds.has(id)) {
            throw discoveryFailure();
        }
        observedIds.add(id);
        const labels = Object.create(null) as Record<string, unknown>;
        if (capability !== null) {
            labels[databaseObservabilityDockerCapabilityLabel] = capability;
        }
        if (composeProject !== null) {
            labels["com.docker.compose.project"] = composeProject;
        }
        if (composeService !== null) {
            labels["com.docker.compose.service"] = composeService;
        }
        return {
            Config: { Labels: labels },
            Id: id,
            NetworkSettings: { Ports: ports },
            State: {
                ...(healthStatus === null ? {} : { Health: { Status: healthStatus } }),
                Running: running,
                Status: status,
            },
        };
    });
    if (observedIds.size !== expectedIds.size) throw discoveryFailure();
    return Object.freeze(rows);
}

function labelsFromInspect(row: Record<string, unknown>): Record<string, unknown> {
    const config = ownRecordProperty(row, "Config");
    if (!isRecord(config)) return Object.create(null) as Record<string, unknown>;
    const labels = ownRecordProperty(config, "Labels");
    return isRecord(labels) ? labels : (Object.create(null) as Record<string, unknown>);
}

function rowHasCapability(row: Record<string, unknown>): boolean {
    const labels = labelsFromInspect(row);
    return (
        ownRecordProperty(labels, databaseObservabilityDockerCapabilityLabel) ===
        databaseObservabilityDockerCapabilityValue
    );
}

function rowIsRunningAndHealthy(row: Record<string, unknown>): boolean {
    const state = ownRecordProperty(row, "State");
    if (!isRecord(state)) return false;
    const health = ownRecordProperty(state, "Health");
    return (
        ownRecordProperty(state, "Running") === true &&
        ownRecordProperty(state, "Status") === "running" &&
        isRecord(health) &&
        ownRecordProperty(health, "Status") === "healthy"
    );
}

function validHostPort(value: unknown): value is string {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/u.test(value)) {
        return false;
    }
    const port = Number(value);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function resolvePublishedBinding(row: Record<string, unknown>): {
    readonly containerPort: number;
    readonly hostname: string;
    readonly port: string;
} {
    const networkSettings = ownRecordProperty(row, "NetworkSettings");
    if (!isRecord(networkSettings)) throw discoveryFailure();
    const ports = ownRecordProperty(networkSettings, "Ports");
    if (!isRecord(ports)) throw discoveryFailure();
    const bindings: Array<{
        readonly containerPort: number;
        readonly hostname: string;
        readonly port: string;
    }> = [];
    for (const [containerEndpoint, rawBindings] of Object.entries(ports)) {
        if (rawBindings === null) continue;
        const endpoint = /^(?<port>[1-9][0-9]{0,4})\/tcp$/u.exec(containerEndpoint);
        if (endpoint?.groups === undefined || !Array.isArray(rawBindings)) {
            continue;
        }
        const containerPort = endpoint.groups.port;
        if (!validHostPort(containerPort)) throw discoveryFailure();
        for (const rawBinding of rawBindings) {
            if (!isRecord(rawBinding)) throw discoveryFailure();
            const hostname = ownRecordProperty(rawBinding, "HostIp");
            const port = ownRecordProperty(rawBinding, "HostPort");
            if (
                typeof hostname !== "string" ||
                !databaseObservabilityHostnameIsLoopback(hostname) ||
                !validHostPort(port)
            ) {
                throw discoveryFailure();
            }
            bindings.push({ containerPort: Number(containerPort), hostname, port });
        }
    }
    if (bindings.length !== 1) throw discoveryFailure();
    return Object.freeze(bindings[0]!);
}

function observedComposeIdentity(
    labels: Record<string, unknown>,
    property: "com.docker.compose.project" | "com.docker.compose.service"
): string | undefined {
    const value = ownRecordProperty(labels, property);
    if (
        typeof value !== "string" ||
        value === "" ||
        value.length > composeIdentityMaximumLength ||
        value !== value.trim() ||
        controlTextPattern.test(value)
    ) {
        return undefined;
    }
    return value;
}

function requireCredentials(
    credentials: DockerDatabaseObservabilityCredentials
): DockerDatabaseObservabilityCredentials {
    const password = Redacted.value(credentials.password);
    if (
        password === "" ||
        password.length > credentialMaximumLength ||
        password !== password.trim() ||
        controlTextPattern.test(password)
    ) {
        throw discoveryFailure();
    }
    return Object.freeze({ password: credentials.password });
}

function resolvedConnection(
    row: Record<string, unknown>,
    credentials: DockerDatabaseObservabilityCredentials
): DatabaseObservabilityResolvedConnection {
    const containerId = ownRecordProperty(row, "Id");
    if (typeof containerId !== "string" || !containerIdPattern.test(containerId)) {
        throw discoveryFailure();
    }
    const binding = resolvePublishedBinding(row);
    const labels = labelsFromInspect(row);
    const connection: DatabaseObservabilityConnection = Object.freeze({
        controlDatabase: databaseObservabilityPgBouncerControlAlias,
        hostname: binding.hostname,
        password: credentials.password,
        port: Number(binding.port),
    });
    const composeProject = observedComposeIdentity(labels, "com.docker.compose.project");
    const composeService = observedComposeIdentity(labels, "com.docker.compose.service");
    const source: DatabaseObservabilityConnectionSource = Object.freeze({
        containerId,
        containerPort: binding.containerPort,
        ...(composeProject === undefined ? {} : { composeProject }),
        ...(composeService === undefined ? {} : { composeService }),
    });
    return Object.freeze({
        connection,
        source,
    });
}

function operationSignal(
    parentSignal: AbortSignal | undefined,
    deadlineMs: number
): AbortSignal {
    const deadline = AbortSignal.timeout(deadlineMs);
    return parentSignal === undefined
        ? deadline
        : AbortSignal.any([deadline, parentSignal]);
}

/**
 * Discovers the single opted-in healthy PgBouncer endpoint from one Docker inventory snapshot.
 * Container, Compose, image, and host-port identities are observations rather than allowlists.
 * @param options Fixed process boundary, observer password, and bounded deadline.
 * @returns A resolver that repeats discovery for every collection attempt.
 */
export function createDockerDatabaseObservabilityConnectionResolver(options: {
    readonly credentials: DockerDatabaseObservabilityCredentials;
    readonly deadlineMs?: number;
    readonly dockerExecutable?: string;
    readonly process?: DockerDatabaseObservabilityProcess;
}): DatabaseObservabilityConnectionResolver {
    const credentials = requireCredentials(options.credentials);
    const deadlineMs =
        options.deadlineMs ?? databaseObservabilityDockerDiscoveryDeadlineMs;
    const executable = options.dockerExecutable ?? dockerExecutableDefault;
    const execute = options.process ?? defaultProcess;
    if (
        !executable.startsWith("/") ||
        executable.includes("\0") ||
        executable.length > 4096 ||
        !Number.isSafeInteger(deadlineMs) ||
        deadlineMs < 1 ||
        deadlineMs > databaseObservabilityDockerDiscoveryDeadlineMs
    ) {
        throw discoveryFailure();
    }

    return Object.freeze({
        async resolve(parentSignal?: AbortSignal) {
            try {
                parentSignal?.throwIfAborted();
                const signal = operationSignal(parentSignal, deadlineMs);
                const psResult = await execute(
                    executable,
                    [
                        ...dockerEngineArguments,
                        "ps",
                        "-a",
                        "--no-trunc",
                        "--format",
                        "{{json .ID}}",
                    ],
                    signal,
                    dockerPsOutputMaximumBytes
                );
                signal.throwIfAborted();
                const containerIds = parseContainerIds(
                    requireSuccessfulProcess(psResult, dockerPsOutputMaximumBytes)
                );
                if (containerIds.length === 0) throw discoveryFailure();
                const inspectResult = await execute(
                    executable,
                    [
                        ...dockerEngineArguments,
                        "inspect",
                        "--format",
                        databaseObservabilityDockerInspectFormat,
                        ...containerIds,
                    ],
                    signal,
                    dockerInspectOutputMaximumBytes
                );
                signal.throwIfAborted();
                const rows = parseInspectRows(
                    requireSuccessfulProcess(
                        inspectResult,
                        dockerInspectOutputMaximumBytes
                    ),
                    containerIds
                );
                const candidates = rows.filter(
                    (row) => rowHasCapability(row) && rowIsRunningAndHealthy(row)
                );
                if (candidates.length !== 1) throw discoveryFailure();
                return resolvedConnection(candidates[0]!, credentials);
            } catch {
                throw discoveryFailure();
            }
        },
    });
}
