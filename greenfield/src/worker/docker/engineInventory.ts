import { createHash } from "node:crypto";
import { isIP } from "node:net";

import * as v from "valibot";

const dockerExecutable = "/usr/bin/docker" as const;
const dockerEngineArguments = Object.freeze([
    "--host",
    "unix:///var/run/docker.sock",
] as const);
const dockerEnvironment = Object.freeze({
    DOCKER_CONFIG: "/nonexistent/mira-dashboard-docker-config",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
});

export const dockerEngineInventoryContainerMaximum = 256;
export const dockerEngineInventoryImageMaximum = 1024;
export const dockerEngineInventoryVolumeMaximum = 1024;
export const dockerEngineInventoryDeadlineMs = 10_000;

const dockerPsOutputMaximumBytes = 256 * 1024;
const dockerInspectOutputMaximumBytes = 8 * 1024 * 1024;
const dockerImageOutputMaximumBytes = 2 * 1024 * 1024;
const dockerVolumeOutputMaximumBytes = 1024 * 1024;
const dockerStatsOutputMaximumBytes = 2 * 1024 * 1024;
const dockerStderrMaximumBytes = 64 * 1024;

const invalidInventory = "Docker engine inventory failed";
const containerIdPattern = /^[0-9a-f]{64}$/u;
const imageIdPattern = /^sha256:[0-9a-f]{64}$/u;
const containerNamePattern = /^\/[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const portEndpointPattern = /^[1-9][0-9]{0,4}\/(?:tcp|udp|sctp)$/u;
const controlTextPattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const dockerEngineInventoryComposeLabelNames = Object.freeze([
    "com.docker.compose.project",
    "com.docker.compose.service",
    "com.docker.compose.project.config_files",
    "com.docker.compose.project.working_dir",
    "com.docker.compose.config-hash",
    "com.docker.compose.container-number",
] as const);

export const dockerEngineInventoryUpdaterLabelNames = Object.freeze([
    "mira.updater.enabled",
    "mira.updater.autoUpdate",
    "mira.updater.track",
    "mira.updater.tagPattern",
    "mira.updater.tagPatternIsRegex",
] as const);

/** Purpose-built capabilities projected for non-updater worker domains. */
export const dockerEngineInventoryBackupLabelNames = Object.freeze([
    "mira.dashboard.backup",
] as const);

export type DockerEngineInventoryComposeLabel =
    (typeof dockerEngineInventoryComposeLabelNames)[number];
export type DockerEngineInventoryUpdaterLabel =
    (typeof dockerEngineInventoryUpdaterLabelNames)[number];
export type DockerEngineInventoryBackupLabel =
    (typeof dockerEngineInventoryBackupLabelNames)[number];
export type DockerEngineInventoryAllowedLabel =
    | DockerEngineInventoryComposeLabel
    | DockerEngineInventoryUpdaterLabel
    | DockerEngineInventoryBackupLabel;

const allowedLabelNames = Object.freeze([
    ...dockerEngineInventoryComposeLabelNames,
    ...dockerEngineInventoryUpdaterLabelNames,
    ...dockerEngineInventoryBackupLabelNames,
] as const);

function projectedLabel(label: DockerEngineInventoryAllowedLabel): string {
    return `{{with .Config.Labels}}{{json (index . ${JSON.stringify(
        label
    )})}}{{else}}null{{end}}`;
}

const projectedLabels = allowedLabelNames
    .map((label) => `${JSON.stringify(label)}:${projectedLabel(label)}`)
    .join(",");

/**
 * Fixed Docker inspect projection. It deliberately never serializes Config.Env,
 * Config.Cmd, raw labels, mount sources, or other inspect fields.
 */
export const dockerEngineInventoryInspectFormat = [
    "{",
    '"id":{{json .Id}},',
    '"name":{{json .Name}},',
    '"imageReference":{{json .Config.Image}},',
    '"imageId":{{json .Image}},',
    '"state":{{json .State.Status}},',
    '"running":{{json .State.Running}},',
    '"paused":{{json .State.Paused}},',
    '"restarting":{{json .State.Restarting}},',
    '"oomKilled":{{json .State.OOMKilled}},',
    '"dead":{{json .State.Dead}},',
    '"exitCode":{{json .State.ExitCode}},',
    '"health":{{with (index .State "Health")}}{{json (index . "Status")}}{{else}}null{{end}},',
    '"createdAt":{{json .Created}},',
    '"startedAt":{{json .State.StartedAt}},',
    '"finishedAt":{{json .State.FinishedAt}},',
    '"restartCount":{{json .RestartCount}},',
    '"ports":{{json .NetworkSettings.Ports}},',
    '"networks":[{{$networkFirst := true}}{{range $name, $network := .NetworkSettings.Networks}}{{if $networkFirst}}{{$networkFirst = false}}{{else}},{{end}}{',
    '"name":{{json $name}},',
    '"ipv4Address":{{json $network.IPAddress}},',
    '"ipv6Address":{{json $network.GlobalIPv6Address}}',
    "}{{end}}],",
    '"mounts":[{{range $index, $mount := .Mounts}}{{if $index}},{{end}}{',
    '"name":{{with (index $mount "Name")}}{{json .}}{{else}}""{{end}},',
    '"destination":{{json $mount.Destination}},',
    '"type":{{json $mount.Type}},',
    '"readOnly":{{if $mount.RW}}false{{else}}true{{end}}',
    "}{{end}}],",
    `"labels":{${projectedLabels}}`,
    "}",
].join("");

export const dockerEngineInventoryImageFormat = [
    "{",
    '"id":{{json .ID}},',
    '"repository":{{json .Repository}},',
    '"tag":{{json .Tag}},',
    '"digest":{{json .Digest}},',
    '"createdAt":{{json .CreatedAt}},',
    '"size":{{json .Size}}',
    "}",
].join("");

export const dockerEngineInventoryVolumeFormat = [
    "{",
    '"name":{{json .Name}},',
    '"driver":{{json .Driver}},',
    '"scope":{{json .Scope}}',
    "}",
].join("");

export const dockerEngineInventoryStatsFormat = [
    "{",
    '"id":{{json .ID}},',
    '"cpuPercent":{{json .CPUPerc}},',
    '"memoryUsage":{{json .MemUsage}},',
    '"memoryPercent":{{json .MemPerc}},',
    '"networkIo":{{json .NetIO}},',
    '"blockIo":{{json .BlockIO}},',
    '"pids":{{json .PIDs}}',
    "}",
].join("");

export interface DockerEngineInventoryProcessRequest {
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: typeof dockerExecutable;
    readonly signal: AbortSignal;
    readonly stdoutMaximumBytes: number;
}

export interface DockerEngineInventoryProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type DockerEngineInventoryProcess = (
    request: DockerEngineInventoryProcessRequest
) => Promise<DockerEngineInventoryProcessResult>;

export interface DockerEngineInventoryPublishedPort {
    readonly containerPort: number;
    readonly hostAddress: string;
    readonly hostPort: number;
    readonly protocol: "sctp" | "tcp" | "udp";
}

export interface DockerEngineInventoryNetwork {
    readonly addresses: readonly string[];
    readonly name: string;
}

export interface DockerEngineInventoryMount {
    readonly destination: string;
    readonly name?: string;
    readonly readOnly: boolean;
    readonly type: string;
}

export interface DockerEngineInventoryRuntimeStatus {
    readonly dead: boolean;
    readonly exitCode: number;
    readonly oomKilled: boolean;
    readonly paused: boolean;
    readonly restarting: boolean;
    readonly running: boolean;
}

export interface DockerEngineInventoryAvailableContainer {
    readonly availability: "available";
    readonly createdAt: string;
    readonly finishedAt: string;
    readonly health: string | null;
    readonly id: string;
    readonly imageId: string;
    readonly imageReference: string;
    readonly labels: Readonly<Partial<Record<DockerEngineInventoryAllowedLabel, string>>>;
    readonly mounts: readonly DockerEngineInventoryMount[];
    readonly name: string;
    readonly networks: readonly DockerEngineInventoryNetwork[];
    readonly publishedPorts: readonly DockerEngineInventoryPublishedPort[];
    readonly restartCount: number;
    readonly startedAt: string;
    readonly state: string;
    readonly status: DockerEngineInventoryRuntimeStatus;
}

export interface DockerEngineInventoryDisappearedContainer {
    readonly availability: "disappeared";
    readonly id: string;
}

export type DockerEngineInventoryContainer =
    | DockerEngineInventoryAvailableContainer
    | DockerEngineInventoryDisappearedContainer;

export interface DockerEngineInventoryImage {
    readonly createdAt: string;
    readonly digest: string;
    readonly id: string;
    readonly repository: string;
    readonly size: string;
    readonly tag: string;
}

export interface DockerEngineInventoryVolume {
    readonly driver: string;
    readonly name: string;
    readonly scope: string;
}

export interface DockerEngineInventoryStats {
    readonly blockIo: string;
    readonly cpuPercent: string;
    readonly id: string;
    readonly memoryPercent: string;
    readonly memoryUsage: string;
    readonly networkIo: string;
    readonly pids: number;
}

export interface DockerEngineInventorySnapshot {
    readonly containers: readonly DockerEngineInventoryContainer[];
    readonly images: readonly DockerEngineInventoryImage[];
    readonly sourceRevision: string;
    readonly stats: readonly DockerEngineInventoryStats[];
    readonly volumes: readonly DockerEngineInventoryVolume[];
}

export interface DockerEngineInventoryCollector {
    collect(parentSignal?: AbortSignal): Promise<DockerEngineInventorySnapshot>;
}

function inventoryFailure(): Error {
    return new Error(invalidInventory);
}

function boundedStringSchema(maximumLength: number, allowEmpty = false) {
    return v.pipe(
        v.string(invalidInventory),
        v.maxLength(maximumLength, invalidInventory),
        v.check(
            (value) =>
                (allowEmpty || value.length > 0) && !controlTextPattern.test(value),
            invalidInventory
        )
    );
}

const containerIdSchema = v.pipe(
    v.string(invalidInventory),
    v.regex(containerIdPattern, invalidInventory)
);
const imageIdSchema = v.pipe(
    v.string(invalidInventory),
    v.regex(imageIdPattern, invalidInventory)
);
const nonnegativeSafeIntegerSchema = v.pipe(
    v.number(invalidInventory),
    v.safeInteger(invalidInventory),
    v.minValue(0, invalidInventory)
);
const exitCodeSchema = v.pipe(
    v.number(invalidInventory),
    v.safeInteger(invalidInventory),
    v.minValue(-1, invalidInventory),
    v.maxValue(65_535, invalidInventory)
);
const optionalLabelSchema = v.nullable(boundedStringSchema(4096, true));
const projectedLabelsSchema = v.strictObject(
    Object.fromEntries(
        allowedLabelNames.map((label) => [label, optionalLabelSchema])
    ) as Record<DockerEngineInventoryAllowedLabel, typeof optionalLabelSchema>,
    invalidInventory
);
const portBindingSchema = v.strictObject(
    {
        HostIp: v.pipe(
            boundedStringSchema(64, true),
            v.check((value) => value === "" || isIP(value) !== 0, invalidInventory)
        ),
        HostPort: v.pipe(
            v.string(invalidInventory),
            v.regex(/^[1-9][0-9]{0,4}$/u, invalidInventory)
        ),
    },
    invalidInventory
);
const portsSchema = v.record(
    v.pipe(v.string(invalidInventory), v.regex(portEndpointPattern, invalidInventory)),
    v.nullable(v.array(portBindingSchema, invalidInventory)),
    invalidInventory
);
const networkSchema = v.strictObject(
    {
        ipv4Address: v.pipe(
            boundedStringSchema(64, true),
            v.check((value) => value === "" || isIP(value) === 4, invalidInventory)
        ),
        ipv6Address: v.pipe(
            boundedStringSchema(64, true),
            v.check((value) => value === "" || isIP(value) === 6, invalidInventory)
        ),
        name: boundedStringSchema(255),
    },
    invalidInventory
);
const mountSchema = v.strictObject(
    {
        destination: v.pipe(
            boundedStringSchema(4096),
            v.check((value) => value.startsWith("/"), invalidInventory)
        ),
        name: boundedStringSchema(255, true),
        readOnly: v.boolean(invalidInventory),
        type: boundedStringSchema(64),
    },
    invalidInventory
);
const inspectRowSchema = v.strictObject(
    {
        createdAt: boundedStringSchema(64),
        dead: v.boolean(invalidInventory),
        exitCode: exitCodeSchema,
        finishedAt: boundedStringSchema(64),
        health: v.nullable(boundedStringSchema(64)),
        id: containerIdSchema,
        imageId: imageIdSchema,
        imageReference: boundedStringSchema(4096),
        labels: projectedLabelsSchema,
        mounts: v.array(mountSchema, invalidInventory),
        name: v.pipe(
            v.string(invalidInventory),
            v.regex(containerNamePattern, invalidInventory)
        ),
        networks: v.array(networkSchema, invalidInventory),
        oomKilled: v.boolean(invalidInventory),
        paused: v.boolean(invalidInventory),
        ports: portsSchema,
        restartCount: nonnegativeSafeIntegerSchema,
        restarting: v.boolean(invalidInventory),
        running: v.boolean(invalidInventory),
        startedAt: boundedStringSchema(64),
        state: boundedStringSchema(64),
    },
    invalidInventory
);
const imageRowSchema = v.strictObject(
    {
        createdAt: boundedStringSchema(128),
        digest: boundedStringSchema(255),
        id: imageIdSchema,
        repository: boundedStringSchema(4096),
        size: boundedStringSchema(64),
        tag: boundedStringSchema(255),
    },
    invalidInventory
);
const volumeRowSchema = v.strictObject(
    {
        driver: boundedStringSchema(255),
        name: boundedStringSchema(255),
        scope: boundedStringSchema(64),
    },
    invalidInventory
);
const statsRowSchema = v.strictObject(
    {
        blockIo: boundedStringSchema(128),
        cpuPercent: boundedStringSchema(64),
        id: containerIdSchema,
        memoryPercent: boundedStringSchema(64),
        memoryUsage: boundedStringSchema(128),
        networkIo: boundedStringSchema(128),
        pids: v.pipe(
            v.string(invalidInventory),
            v.regex(/^(?:0|[1-9][0-9]{0,15})$/u, invalidInventory)
        ),
    },
    invalidInventory
);

type InspectRow = v.InferOutput<typeof inspectRowSchema>;

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
            if (total > maximumBytes) throw inventoryFailure();
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

const defaultProcess: DockerEngineInventoryProcess = async (request) => {
    const child = Bun.spawn([request.executable, ...request.arguments], {
        env: request.environment,
        signal: request.signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBounded(child.stdout, request.stdoutMaximumBytes),
            readBounded(child.stderr, dockerStderrMaximumBytes),
        ]);
        return { exitCode, stderr, stdout };
    } catch {
        child.kill();
        await child.exited.catch(() => {});
        throw inventoryFailure();
    }
};

function decodeUtf8(value: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
        throw inventoryFailure();
    }
}

function requireProcessResult(
    result: DockerEngineInventoryProcessResult,
    stdoutMaximumBytes: number,
    acceptedExitCodes: readonly number[] = [0]
): string {
    if (
        !acceptedExitCodes.includes(result.exitCode) ||
        !(result.stdout instanceof Uint8Array) ||
        !(result.stderr instanceof Uint8Array) ||
        result.stdout.byteLength > stdoutMaximumBytes ||
        result.stderr.byteLength > dockerStderrMaximumBytes
    ) {
        throw inventoryFailure();
    }
    return decodeUtf8(result.stdout);
}

function parseJsonLines<
    TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
    output: string,
    schema: TSchema,
    maximumRows: number
): readonly v.InferOutput<TSchema>[] {
    const trimmed = output.trim();
    if (trimmed === "") return Object.freeze([]);
    const lines = trimmed.split("\n");
    if (lines.length > maximumRows) throw inventoryFailure();
    return Object.freeze(
        lines.map((line) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(line) as unknown;
            } catch {
                throw inventoryFailure();
            }
            const result = v.safeParse(schema, parsed);
            if (!result.success) throw inventoryFailure();
            return result.output;
        })
    );
}

function parseContainerIds(output: string): readonly string[] {
    const trimmed = output.trim();
    if (trimmed === "") return Object.freeze([]);
    const lines = trimmed.split("\n");
    if (lines.length > dockerEngineInventoryContainerMaximum) {
        throw inventoryFailure();
    }
    const ids = lines.map((line) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line) as unknown;
        } catch {
            throw inventoryFailure();
        }
        const result = v.safeParse(containerIdSchema, parsed);
        if (!result.success) throw inventoryFailure();
        return result.output;
    });
    if (new Set(ids).size !== ids.length) throw inventoryFailure();
    return Object.freeze(ids);
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function selectedLabels(
    labels: InspectRow["labels"]
): Readonly<Partial<Record<DockerEngineInventoryAllowedLabel, string>>> {
    return Object.freeze(
        Object.fromEntries(
            allowedLabelNames.flatMap((label) => {
                const value = labels[label];
                return value === null ? [] : [[label, value]];
            })
        ) as Partial<Record<DockerEngineInventoryAllowedLabel, string>>
    );
}

function publishedPorts(
    ports: InspectRow["ports"]
): readonly DockerEngineInventoryPublishedPort[] {
    const result: DockerEngineInventoryPublishedPort[] = [];
    for (const [endpoint, bindings] of Object.entries(ports)) {
        if (bindings === null) continue;
        const [containerPortText, protocol] = endpoint.split("/") as [
            string,
            "sctp" | "tcp" | "udp",
        ];
        const containerPort = Number(containerPortText);
        if (!Number.isSafeInteger(containerPort) || containerPort > 65_535) {
            throw inventoryFailure();
        }
        for (const binding of bindings) {
            const hostPort = Number(binding.HostPort);
            if (!Number.isSafeInteger(hostPort) || hostPort > 65_535) {
                throw inventoryFailure();
            }
            result.push(
                Object.freeze({
                    containerPort,
                    hostAddress: binding.HostIp === "" ? "0.0.0.0" : binding.HostIp,
                    hostPort,
                    protocol,
                })
            );
        }
    }
    return Object.freeze(
        result.toSorted(
            (left, right) =>
                left.containerPort - right.containerPort ||
                compareStrings(left.protocol, right.protocol) ||
                compareStrings(left.hostAddress, right.hostAddress) ||
                left.hostPort - right.hostPort
        )
    );
}

function projectedNetworks(
    networks: InspectRow["networks"]
): readonly DockerEngineInventoryNetwork[] {
    const names = new Set<string>();
    const result = networks.map((network) => {
        if (names.has(network.name)) throw inventoryFailure();
        names.add(network.name);
        const addresses = [network.ipv4Address, network.ipv6Address]
            .filter((address) => address !== "")
            .toSorted(compareStrings);
        if (new Set(addresses).size !== addresses.length) throw inventoryFailure();
        return Object.freeze({
            addresses: Object.freeze(addresses),
            name: network.name,
        });
    });
    return Object.freeze(
        result.toSorted((left, right) => compareStrings(left.name, right.name))
    );
}

function projectedMounts(
    mounts: InspectRow["mounts"]
): readonly DockerEngineInventoryMount[] {
    return Object.freeze(
        mounts
            .map((mount) =>
                Object.freeze({
                    destination: mount.destination,
                    ...(mount.name === "" ? {} : { name: mount.name }),
                    readOnly: mount.readOnly,
                    type: mount.type,
                })
            )
            .toSorted(
                (left, right) =>
                    compareStrings(left.destination, right.destination) ||
                    compareStrings(left.name ?? "", right.name ?? "") ||
                    compareStrings(left.type, right.type)
            )
    );
}

function availableContainer(row: InspectRow): DockerEngineInventoryAvailableContainer {
    return Object.freeze({
        availability: "available",
        createdAt: row.createdAt,
        finishedAt: row.finishedAt,
        health: row.health,
        id: row.id,
        imageId: row.imageId,
        imageReference: row.imageReference,
        labels: selectedLabels(row.labels),
        mounts: projectedMounts(row.mounts),
        name: row.name.slice(1),
        networks: projectedNetworks(row.networks),
        publishedPorts: publishedPorts(row.ports),
        restartCount: row.restartCount,
        startedAt: row.startedAt,
        state: row.state,
        status: Object.freeze({
            dead: row.dead,
            exitCode: row.exitCode,
            oomKilled: row.oomKilled,
            paused: row.paused,
            restarting: row.restarting,
            running: row.running,
        }),
    });
}

function projectContainers(
    ids: readonly string[],
    inspectResult: DockerEngineInventoryProcessResult
): readonly DockerEngineInventoryContainer[] {
    const output = requireProcessResult(
        inspectResult,
        dockerInspectOutputMaximumBytes,
        [0, 1]
    );
    const rows = parseJsonLines(
        output,
        inspectRowSchema,
        dockerEngineInventoryContainerMaximum
    );
    const expectedIds = new Set(ids);
    const rowsById = new Map<string, InspectRow>();
    for (const row of rows) {
        if (!expectedIds.has(row.id) || rowsById.has(row.id)) throw inventoryFailure();
        rowsById.set(row.id, row);
    }
    if (inspectResult.exitCode === 0 && rowsById.size !== expectedIds.size) {
        throw inventoryFailure();
    }
    if (
        inspectResult.exitCode === 1 &&
        (rowsById.size === 0 || rowsById.size === expectedIds.size)
    ) {
        throw inventoryFailure();
    }
    return Object.freeze(
        ids
            .map((id): DockerEngineInventoryContainer => {
                const row = rowsById.get(id);
                return row === undefined
                    ? Object.freeze({ availability: "disappeared", id })
                    : availableContainer(row);
            })
            .toSorted((left, right) => compareStrings(left.id, right.id))
    );
}

function projectImages(output: string): readonly DockerEngineInventoryImage[] {
    const rows = parseJsonLines(
        output,
        imageRowSchema,
        dockerEngineInventoryImageMaximum
    );
    const identities = new Set<string>();
    const result = rows.map((row) => {
        const identity = `${row.repository}\0${row.tag}\0${row.digest}\0${row.id}`;
        if (identities.has(identity)) throw inventoryFailure();
        identities.add(identity);
        return Object.freeze({ ...row });
    });
    return Object.freeze(
        result.toSorted(
            (left, right) =>
                compareStrings(left.repository, right.repository) ||
                compareStrings(left.tag, right.tag) ||
                compareStrings(left.digest, right.digest) ||
                compareStrings(left.id, right.id)
        )
    );
}

function projectVolumes(output: string): readonly DockerEngineInventoryVolume[] {
    const rows = parseJsonLines(
        output,
        volumeRowSchema,
        dockerEngineInventoryVolumeMaximum
    );
    const names = new Set<string>();
    const result = rows.map((row) => {
        if (names.has(row.name)) throw inventoryFailure();
        names.add(row.name);
        return Object.freeze({ ...row });
    });
    return Object.freeze(
        result.toSorted((left, right) => compareStrings(left.name, right.name))
    );
}

function projectStats(
    output: string,
    containerIds: ReadonlySet<string>
): readonly DockerEngineInventoryStats[] {
    const rows = parseJsonLines(
        output,
        statsRowSchema,
        dockerEngineInventoryContainerMaximum
    );
    const ids = new Set<string>();
    const result: DockerEngineInventoryStats[] = [];
    for (const row of rows) {
        if (ids.has(row.id)) throw inventoryFailure();
        ids.add(row.id);
        if (!containerIds.has(row.id)) continue;
        const pids = Number(row.pids);
        if (!Number.isSafeInteger(pids)) throw inventoryFailure();
        result.push(
            Object.freeze({
                blockIo: row.blockIo,
                cpuPercent: row.cpuPercent,
                id: row.id,
                memoryPercent: row.memoryPercent,
                memoryUsage: row.memoryUsage,
                networkIo: row.networkIo,
                pids,
            })
        );
    }
    return Object.freeze(
        result.toSorted((left, right) => compareStrings(left.id, right.id))
    );
}

function sourceRevision(
    snapshot: Omit<DockerEngineInventorySnapshot, "sourceRevision">
): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                containers: snapshot.containers,
                images: snapshot.images,
                volumes: snapshot.volumes,
            })
        )
        .digest("hex");
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

function processRequest(
    arguments_: readonly string[],
    signal: AbortSignal,
    stdoutMaximumBytes: number
): DockerEngineInventoryProcessRequest {
    return Object.freeze({
        arguments: Object.freeze([...dockerEngineArguments, ...arguments_]),
        environment: dockerEnvironment,
        executable: dockerExecutable,
        signal,
        stdoutMaximumBytes,
    });
}

/**
 * Creates the worker-owned, read-only Docker Engine inventory collector.
 * Every refresh discovers current membership from the Engine and either returns
 * one fully validated snapshot or a generic source failure.
 * @param options Optional bounded deadline and injectable process boundary.
 * @returns A collector that re-discovers the complete Engine inventory per refresh.
 */
export function createDockerEngineInventoryCollector(
    options: {
        readonly deadlineMs?: number;
        readonly process?: DockerEngineInventoryProcess;
    } = {}
): DockerEngineInventoryCollector {
    const deadlineMs = options.deadlineMs ?? dockerEngineInventoryDeadlineMs;
    const execute = options.process ?? defaultProcess;
    if (
        !Number.isSafeInteger(deadlineMs) ||
        deadlineMs < 1 ||
        deadlineMs > dockerEngineInventoryDeadlineMs
    ) {
        throw inventoryFailure();
    }

    return Object.freeze({
        async collect(parentSignal?: AbortSignal) {
            try {
                parentSignal?.throwIfAborted();
                const signal = operationSignal(parentSignal, deadlineMs);
                const psResult = await execute(
                    processRequest(
                        ["ps", "-a", "--no-trunc", "--format", "{{json .ID}}"],
                        signal,
                        dockerPsOutputMaximumBytes
                    )
                );
                signal.throwIfAborted();
                const containerIds = parseContainerIds(
                    requireProcessResult(psResult, dockerPsOutputMaximumBytes)
                );

                let containers: readonly DockerEngineInventoryContainer[] = [];
                if (containerIds.length > 0) {
                    const inspectResult = await execute(
                        processRequest(
                            [
                                "inspect",
                                "--format",
                                dockerEngineInventoryInspectFormat,
                                ...containerIds,
                            ],
                            signal,
                            dockerInspectOutputMaximumBytes
                        )
                    );
                    signal.throwIfAborted();
                    containers = projectContainers(containerIds, inspectResult);
                }

                const [imageResult, volumeResult, statsResult] = await Promise.all([
                    execute(
                        processRequest(
                            [
                                "image",
                                "ls",
                                "-a",
                                "--no-trunc",
                                "--digests",
                                "--format",
                                dockerEngineInventoryImageFormat,
                            ],
                            signal,
                            dockerImageOutputMaximumBytes
                        )
                    ),
                    execute(
                        processRequest(
                            [
                                "volume",
                                "ls",
                                "--format",
                                dockerEngineInventoryVolumeFormat,
                            ],
                            signal,
                            dockerVolumeOutputMaximumBytes
                        )
                    ),
                    execute(
                        processRequest(
                            [
                                "stats",
                                "--no-stream",
                                "--no-trunc",
                                "--format",
                                dockerEngineInventoryStatsFormat,
                            ],
                            signal,
                            dockerStatsOutputMaximumBytes
                        )
                    ),
                ]);
                signal.throwIfAborted();

                const images = projectImages(
                    requireProcessResult(imageResult, dockerImageOutputMaximumBytes)
                );
                const volumes = projectVolumes(
                    requireProcessResult(volumeResult, dockerVolumeOutputMaximumBytes)
                );
                const stats = projectStats(
                    requireProcessResult(statsResult, dockerStatsOutputMaximumBytes),
                    new Set(containerIds)
                );
                const snapshotWithoutRevision = Object.freeze({
                    containers: Object.freeze(containers),
                    images,
                    stats,
                    volumes,
                });
                return Object.freeze({
                    ...snapshotWithoutRevision,
                    sourceRevision: sourceRevision(snapshotWithoutRevision),
                });
            } catch {
                throw inventoryFailure();
            }
        },
    });
}
