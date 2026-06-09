import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";

import { db } from "../db.js";
import { asyncRoute as baseAsyncRoute } from "../lib/errors.js";
import {
    arrayFallback,
    nonEmptyEnvFallback,
    nullableString,
    objectFallback,
    stringFallback,
} from "../lib/values.js";
import {
    type DockerUpdaterStepResult,
    runDockerUpdaterService,
} from "../services/dockerUpdater.js";

const execFileAsync = promisify(execFile);
const DOCKER_ROOT = nonEmptyEnvFallback("MIRA_DOCKER_ROOT", "/opt/docker");
let dockerBin = nonEmptyEnvFallback("MIRA_DOCKER_BIN", "docker");
let runDockerUpdaterServiceForRoutes = runDockerUpdaterService;
const DOCKER_COMPOSE_WRAPPER = nonEmptyEnvFallback(
    "MIRA_DOCKER_COMPOSE_WRAPPER",
    `${DOCKER_ROOT}/bin/docker-compose-doppler`
);
const MAX_OUTPUT_CHARS = 100_000;
const MAX_STDOUT_PENDING_CHARS = 16_384;
const MAX_JOBS = 100;
const MIN_LOG_TAIL = 50;
const MAX_LOG_TAIL = 5_000;
const DOCKER_EXEC_PID_MARKER = "__MIRA_DOCKER_EXEC_PID__=";
const DEFAULT_DOCKER_EXEC_PID_WAIT_TIMEOUT_MS = 5_000;
let dockerExecPidWaitTimeoutMs = DEFAULT_DOCKER_EXEC_PID_WAIT_TIMEOUT_MS;
const DOCKER_EXEC_PID_WAIT_INTERVAL_MS = 50;
const DOCKER_REQUEST_TIMEOUT_MS = 30_000;
const SENSITIVE_ENV_KEY_PATTERN =
    /(?:SECRET|TOKEN|KEY|PASSWORD|API[_-]?KEY|ACCESS[_-]?TOKEN)/iu;
const SAFE_ENV_VALUE_KEYS = new Set([
    "HOME",
    "HOSTNAME",
    "LANG",
    "NODE_ENV",
    "PATH",
    "TZ",
]);

function redactEnvValue(value: unknown): string {
    const envValue = String(value);
    const separatorIndex = envValue.indexOf("=");
    if (separatorIndex === -1) {
        return envValue;
    }

    const key = envValue.slice(0, separatorIndex);
    if (SAFE_ENV_VALUE_KEYS.has(key) && !SENSITIVE_ENV_KEY_PATTERN.test(key)) {
        return envValue;
    }

    return `${key}=***`;
}

/** Represents one docker updater service row. */
interface DockerUpdaterServiceRow {
    id: string;
    app_slug: string;
    service_name: string;
    compose_image_ref: string;
    image_repo: string;
    current_tag: string;
    current_digest: string;
    latest_tag: string;
    latest_digest: string;
    policy: string;
    pin_mode: string;
    enabled: string;
    last_checked_at: string;
    last_updated_at: string;
    last_status: string;
    metadata: string;
}

interface DockerUpdaterService {
    id: number;
    appSlug: string;
    serviceName: string;
    composeImageRef: string | null;
    imageRepo: string;
    currentTag: string | null;
    currentDigest: string | null;
    latestTag: string | null;
    latestDigest: string | null;
    policy: string;
    pinMode: string;
    enabled: boolean;
    lastCheckedAt: string | null;
    lastUpdatedAt: string | null;
    lastStatus: string | null;
    updateAvailable: boolean;
    metadata: Record<string, unknown>;
}

/** Represents docker manual update request. */
interface DockerManualUpdateRequest {
    serviceId?: number;
}

/** Represents one docker ps row. */
interface DockerPsRow {
    Command: string;
    CreatedAt: string;
    ID: string;
    Image: string;
    Labels: string;
    LocalVolumes: string;
    Mounts: string;
    Names: string;
    Networks: string;
    Ports: string;
    RunningFor: string;
    Size: string;
    State: string;
    Status: string;
}

/** Represents one docker stats row. */
interface DockerStatsRow {
    BlockIO: string;
    CPUPerc: string;
    Container: string;
    ID: string;
    MemPerc: string;
    MemUsage: string;
    Name: string;
    NetIO: string;
    PIDs: string;
}

/** Represents one docker image row. */
interface DockerImageRow {
    ID: string;
    ContainerName?: string;
    Repository: string;
    Tag: string;
    Platform?: string;
    Size?: number;
    Created?: string;
    LastTagTime?: string;
    Containers?: string;
    CreatedAt?: string;
    CreatedSince?: string;
    Digest?: string;
    SharedSize?: string;
    UniqueSize?: string;
}

/** Represents one docker volume row. */
interface DockerVolumeRow {
    Driver: string;
    Labels: string;
    Links: string;
    Mountpoint: string;
    Name: string;
    Scope: string;
    Size: string;
}

/** Represents docker inspect mount. */
interface DockerInspectMount {
    Type?: string;
    Source?: string;
    Destination?: string;
    Mode?: string;
    RW?: boolean;
    Name?: string;
}

/** Represents one docker inspect row. */
interface DockerInspectRow {
    Id?: string;
    Image?: string;
    Created?: string;
    RestartCount?: number;
    Config?: {
        Env?: string[];
        Labels?: Record<string, string>;
    };
    NetworkSettings?: {
        Networks?: Record<
            string,
            { Gateway?: string; IPAddress?: string; MacAddress?: string }
        >;
    };
    State?: {
        StartedAt?: string;
        FinishedAt?: string;
        Health?: { Status?: string };
    };
    Mounts?: DockerInspectMount[];
}

/** Represents docker container summary. */
interface DockerContainerSummary {
    id: string;
    name: string;
    image: string;
    imageId: string;
    command: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    runningFor: string;
    state: string;
    status: string;
    health: string;
    restartCount: number;
    service: string | null;
    project: string | null;
    ports: string[];
    ipAddresses: Record<string, string>;
    mounts: Array<{
        type: string;
        source: string;
        destination: string;
        mode: string;
        readOnly: boolean;
        name?: string;
    }>;
    stats: {
        cpu: string;
        memory: string;
        memoryPercent: string;
        netIO: string;
        blockIO: string;
        pids: string;
    } | null;
}

/** Represents docker container details. */
interface DockerContainerDetails extends DockerContainerSummary {
    env: string[];
    labels: Record<string, string>;
    networks: Array<{
        name: string;
        ipAddress: string;
        gateway: string;
        macAddress: string;
    }>;
}

/** Represents docker image summary. */
interface DockerImageSummary {
    id: string;
    repository: string;
    tag: string;
    containerName: string;
    platform: string;
    size: number;
    createdAt: string;
    lastTagTime: string;
    inUseBy: string[];
}

/** Represents docker volume summary. */
interface DockerVolumeSummary {
    name: string;
    driver: string;
    mountpoint: string;
    scope: string;
    size: string;
    labels: Record<string, string>;
    usedBy: string[];
}

/** Represents docker action request. */
interface DockerActionRequest {
    action: "start" | "stop" | "restart";
}

/** Represents docker stack action request. */
interface DockerStackActionRequest {
    action: "restart";
    service?: string;
}

function isSafeDockerArgument(value: string): boolean {
    const trimmed = value.trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(trimmed);
}

function validateDockerStackActionRequest(
    payload: unknown
): DockerStackActionRequest | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }
    const request = payload as Partial<DockerStackActionRequest>;
    if (request.action !== "restart") {
        return null;
    }
    if (request.service !== undefined) {
        if (
            typeof request.service !== "string" ||
            !isSafeDockerArgument(request.service)
        ) {
            return null;
        }
        return { action: request.action, service: request.service.trim() };
    }
    return { action: request.action };
}

/** Represents docker prune request. */
interface DockerPruneRequest {
    target: "images" | "volumes";
}

/** Represents docker exec start request. */
interface DockerExecStartRequest {
    containerId: string;
    command: string;
}

/** Represents docker exec job. */
interface DockerExecJob {
    id: string;
    containerId: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
    process?: ChildProcess;
    inContainerPid?: number | null;
}

type DockerExecResult = {
    code: number | null;
    stdout: string;
    stderr: string;
};

const dockerExecJobs = new Map<string, DockerExecJob>();

/** Wraps docker routes with consistent route logging. */
function asyncRoute(handler: RequestHandler): RequestHandler {
    return baseAsyncRoute(handler, {
        fallback: "Docker route failed",
        logLabel: "[dockerRoutes]",
    });
}

/** Performs trim output. */
function trimOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }
    return text.slice(-MAX_OUTPUT_CHARS);
}

function dockerIdentifierFallback(value: unknown): string | null {
    const identifier = stringFallback(value).trim();
    if (!identifier || identifier.startsWith("-")) {
        return null;
    }
    return identifier;
}

function sendInvalidDockerIdentifier(res: express.Response, label: string): void {
    res.status(400).json({ error: `Invalid ${label}` });
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Parses JSON lines. */
function parseJsonLines<T>(input: string): T[] {
    return input
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
}

/** Parses JSON field. */
function parseJsonField<T>(value: string | undefined): T | null {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

/** Returns whether updater candIDate is present. */
function hasUpdaterCandidate(service: DockerUpdaterServiceRow): boolean {
    if (service.pin_mode === "digest") {
        return Boolean(
            service.latest_digest &&
            (!service.current_digest || service.current_digest !== service.latest_digest)
        );
    }

    return Boolean(
        (service.latest_tag &&
            (service.current_tag === null ||
                service.current_tag !== service.latest_tag)) ||
        (service.latest_digest &&
            (!service.current_digest || service.current_digest !== service.latest_digest))
    );
}

/** Extracts trailing JSON. */
function extractTrailingJson(input: string) {
    const trimmed = input.trim();
    const start = trimmed.lastIndexOf("\n{");
    const candidate = start === -1 ? trimmed : trimmed.slice(start + 1);
    return JSON.parse(candidate);
}

/** Parses labels. */
function parseLabels(labelsRaw: string | undefined): Record<string, string> {
    if (!labelsRaw) {
        return {};
    }

    return Object.fromEntries(
        labelsRaw
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => {
                const separatorIndex = entry.indexOf("=");
                if (separatorIndex === -1) {
                    return [entry, ""];
                }

                return [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)];
            })
    );
}

/** Parses ports. */
function parsePorts(portsRaw: string | undefined): string[] {
    if (!portsRaw) {
        return [];
    }

    return portsRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/** Parses docker size to bytes. */
function parseDockerSizeToBytes(sizeRaw: string | undefined): number {
    if (!sizeRaw) {
        return 0;
    }

    const match = sizeRaw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Z]*B)$/iu);
    if (!match) {
        return 0;
    }
    const value = Number.parseFloat(stringFallback(match[1], "0"));
    const unit = stringFallback(match[2], "B").toUpperCase();
    const multipliers: Record<string, number> = {
        B: 1,
        KB: 1024,
        MB: 1024 ** 2,
        GB: 1024 ** 3,
        TB: 1024 ** 4,
        PB: 1024 ** 5,
    };
    const multiplier = multipliers[unit];
    if (!multiplier) {
        return 0;
    }
    return Math.round(value * multiplier);
}

/** Performs run docker. */
async function runDocker(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(dockerBin, args, {
        cwd: DOCKER_ROOT,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: DOCKER_REQUEST_TIMEOUT_MS,
    });

    return String(stdout);
}

/** Performs run compose. */
async function runCompose(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(DOCKER_COMPOSE_WRAPPER, args, {
        cwd: DOCKER_ROOT,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
        timeout: DOCKER_REQUEST_TIMEOUT_MS,
    });

    return {
        stdout: String(stdout),
        stderr: String(stderr),
    };
}

/** Returns container inspect map. */
async function getContainerInspectMap(containerIds: string[]) {
    if (containerIds.length === 0) {
        return new Map<string, DockerInspectRow>();
    }

    const stdout = await runDocker(["inspect", ...containerIds]);
    const parsedRows = JSON.parse(stdout) as unknown;
    const inspectRows = Array.isArray(parsedRows)
        ? (parsedRows as DockerInspectRow[])
        : [];
    const map = new Map<string, DockerInspectRow>();

    for (const row of inspectRows) {
        const fullId = stringFallback(row.Id);
        if (!fullId) {
            continue;
        }

        map.set(fullId, row);
        map.set(fullId.slice(0, 12), row);
    }

    return map;
}

/** Returns containers. */
async function getContainers(): Promise<DockerContainerSummary[]> {
    const psRows = parseJsonLines<DockerPsRow>(
        await runDocker(["ps", "-a", "--format", "{{json .}}"])
    );
    const statsRows = parseJsonLines<DockerStatsRow>(
        await runDocker(["stats", "--no-stream", "--format", "{{json .}}"])
    );

    const statsById = new Map(statsRows.map((row) => [row.ID, row]));
    const inspectMap = await getContainerInspectMap(psRows.map((row) => row.ID));

    return psRows.map((row) => {
        const inspect = inspectMap.get(row.ID);
        const labels = objectFallback(inspect?.Config?.Labels);
        const networks = objectFallback(inspect?.NetworkSettings?.Networks);
        const stats = statsById.get(row.ID);

        const ipAddresses = Object.fromEntries(
            Object.entries(networks).map(([name, value]) => {
                const network = objectFallback(value);
                return [name, stringFallback(network.IPAddress)];
            })
        );

        return {
            id: row.ID,
            name: row.Names,
            image: row.Image,
            imageId: stringFallback(inspect?.Image),
            command: row.Command,
            createdAt: stringFallback(inspect?.Created ?? row.CreatedAt),
            startedAt: inspect?.State?.StartedAt || null,
            finishedAt: inspect?.State?.FinishedAt || null,
            runningFor: row.RunningFor,
            state: row.State,
            status: row.Status,
            health: inspect?.State?.Health?.Status || "unknown",
            restartCount: Number(inspect?.RestartCount || 0),
            service: labels["com.docker.compose.service"] || null,
            project: labels["com.docker.compose.project"] || null,
            ports: parsePorts(row.Ports),
            ipAddresses,
            mounts: Array.isArray(inspect?.Mounts)
                ? inspect.Mounts.map((mount) => ({
                      type: stringFallback(mount.Type),
                      source: stringFallback(mount.Source),
                      destination: stringFallback(mount.Destination),
                      mode: stringFallback(mount.Mode),
                      readOnly: Boolean(mount.RW === false),
                      name: mount.Name ? String(mount.Name) : undefined,
                  }))
                : [],
            stats: stats
                ? {
                      cpu: stats.CPUPerc,
                      memory: stats.MemUsage,
                      memoryPercent: stats.MemPerc,
                      netIO: stats.NetIO,
                      blockIO: stats.BlockIO,
                      pids: stats.PIDs,
                  }
                : null,
        };
    });
}

/** Returns container details. */
async function getContainerDetails(
    containerId: string
): Promise<DockerContainerDetails | null> {
    const containers = await getContainers();
    const summary = containers.find((container) => container.id.startsWith(containerId));
    if (!summary) {
        return null;
    }

    const inspectMap = await getContainerInspectMap([summary.id]);
    const inspect = inspectMap.get(summary.id);
    if (!inspect) {
        return null;
    }
    const labels = objectFallback(inspect.Config?.Labels) as Record<string, string>;
    const networks = Object.entries(
        objectFallback(inspect.NetworkSettings?.Networks)
    ).map(([name, value]) => {
        const network = objectFallback(value);
        return {
            name,
            ipAddress: stringFallback(network.IPAddress),
            gateway: stringFallback(network.Gateway),
            macAddress: stringFallback(network.MacAddress),
        };
    });

    return {
        ...summary,
        env: arrayFallback(inspect.Config?.Env).map(redactEnvValue),
        labels,
        networks,
    };
}

/** Returns images. */
async function getImages(): Promise<DockerImageSummary[]> {
    const images = parseJsonLines<DockerImageRow>(
        await runDocker(["image", "ls", "--format", "{{json .}}", "--no-trunc"])
    );
    const containers = await getContainers();

    return images.map((image) => {
        const imageRef = `${image.Repository}:${image.Tag}`;
        const inUseBy = containers
            .filter(
                (container) =>
                    container.imageId.includes(image.ID) ||
                    container.imageId === image.ID ||
                    container.image === imageRef
            )
            .map((container) => container.name);

        return {
            id: image.ID,
            repository: image.Repository,
            tag: image.Tag,
            containerName: image.ContainerName || "",
            platform: image.Platform || "unknown",
            size:
                typeof image.Size === "number"
                    ? image.Size
                    : parseDockerSizeToBytes(image.Size as unknown as string),
            createdAt: image.Created || image.CreatedAt || image.CreatedSince || "",
            lastTagTime: image.LastTagTime || image.CreatedAt || image.CreatedSince || "",
            inUseBy,
        };
    });
}

/** Returns volumes. */
async function getVolumes(): Promise<DockerVolumeSummary[]> {
    const volumeRows = parseJsonLines<DockerVolumeRow>(
        await runDocker(["volume", "ls", "--format", "{{json .}}"])
    );
    const containers = await getContainers();

    return volumeRows.map((volume) => ({
        name: volume.Name,
        driver: volume.Driver,
        mountpoint: volume.Mountpoint,
        scope: volume.Scope,
        size: volume.Size,
        labels: parseLabels(volume.Labels),
        usedBy: containers
            .filter((container) =>
                container.mounts.some(
                    (mount) =>
                        mount.name === volume.Name ||
                        mount.source === volume.Mountpoint ||
                        mount.source.endsWith(`/${volume.Name}/_data`)
                )
            )
            .map((container) => container.name),
    }));
}

function mapDockerUpdaterRow(row: DockerUpdaterServiceRow) {
    return {
        id: Number(row.id),
        appSlug: row.app_slug,
        serviceName: row.service_name,
        composeImageRef: nullableString(row.compose_image_ref),
        imageRepo: row.image_repo,
        currentTag: nullableString(row.current_tag),
        currentDigest: nullableString(row.current_digest),
        latestTag: nullableString(row.latest_tag),
        latestDigest: nullableString(row.latest_digest),
        policy: row.policy,
        pinMode: row.pin_mode,
        enabled: row.enabled === "true",
        lastCheckedAt: nullableString(row.last_checked_at),
        lastUpdatedAt: nullableString(row.last_updated_at),
        lastStatus: nullableString(row.last_status),
        updateAvailable: hasUpdaterCandidate(row),
        metadata: parseJsonField<Record<string, unknown>>(row.metadata) ?? {},
    };
}

/** Returns docker updater services. */
async function getDockerUpdaterServices() {
    const rows = db
        .prepare(
            `SELECT
                CAST(id AS TEXT) AS id,
                app_slug,
                service_name,
                COALESCE(compose_image_ref, '') AS compose_image_ref,
                image_repo,
                COALESCE(current_tag, '') AS current_tag,
                COALESCE(current_digest, '') AS current_digest,
                COALESCE(latest_tag, '') AS latest_tag,
                COALESCE(latest_digest, '') AS latest_digest,
                policy,
                pin_mode,
                CASE WHEN enabled = 1 THEN 'true' ELSE 'false' END AS enabled,
                COALESCE(last_checked_at, '') AS last_checked_at,
                COALESCE(last_updated_at, '') AS last_updated_at,
                COALESCE(last_status, '') AS last_status,
                metadata_json AS metadata
             FROM docker_managed_services
             ORDER BY app_slug, service_name`
        )
        .all() as unknown as DockerUpdaterServiceRow[];

    return rows.map(mapDockerUpdaterRow);
}

/** Returns docker updater service by ID. */
async function getDockerUpdaterServiceById(serviceId: number) {
    const rows = db
        .prepare(
            `SELECT
                CAST(id AS TEXT) AS id,
                app_slug,
                service_name,
                COALESCE(compose_image_ref, '') AS compose_image_ref,
                image_repo,
                COALESCE(current_tag, '') AS current_tag,
                COALESCE(current_digest, '') AS current_digest,
                COALESCE(latest_tag, '') AS latest_tag,
                COALESCE(latest_digest, '') AS latest_digest,
                policy,
                pin_mode,
                CASE WHEN enabled = 1 THEN 'true' ELSE 'false' END AS enabled,
                COALESCE(last_checked_at, '') AS last_checked_at,
                COALESCE(last_updated_at, '') AS last_updated_at,
                COALESCE(last_status, '') AS last_status,
                metadata_json AS metadata
             FROM docker_managed_services
             WHERE id = ?
             LIMIT 1`
        )
        .all(Math.floor(serviceId)) as unknown as DockerUpdaterServiceRow[];

    const row = rows[0];
    if (!row) {
        return null;
    }

    return mapDockerUpdaterRow(row);
}

/** Performs run manual updater for service. */
async function runManualUpdaterForService(
    serviceIdOrService: number | DockerUpdaterService
) {
    const service =
        typeof serviceIdOrService === "number"
            ? await getDockerUpdaterServiceById(serviceIdOrService)
            : serviceIdOrService;
    if (!service) {
        return {
            success: false,
            code: "NOT_FOUND",
            output: {},
            stderr: "Docker updater service not found",
            steps: [
                {
                    step: "manual-update",
                    ok: false,
                    stdout: "",
                    stderr: "Docker updater service not found",
                },
            ],
        };
    }
    if (!service.enabled) {
        return {
            success: false,
            code: "DISABLED",
            output: {},
            stderr: "Docker updater service is disabled",
            steps: [
                {
                    step: "manual-update",
                    ok: false,
                    stdout: "",
                    stderr: "Docker updater service is disabled",
                },
            ],
        };
    }
    const serviceId = service.id;
    const steps = await runDockerUpdaterServiceForRoutes(serviceId);
    if (steps.some((step) => !step.ok)) {
        const stderr = steps
            .filter((step) => !step.ok)
            .map((step) => step.stderr)
            .filter(Boolean)
            .join("\n");
        const stepCode = firstFailedStepCode(steps);
        return {
            success: false,
            code: manualUpdaterFailureCode(stepCode),
            output: {},
            stderr,
            steps,
        };
    }

    const updated = steps.some((step) => step.step.startsWith("manual-update:"))
        ? [serviceId]
        : [];

    return {
        success: true,
        code: "OK",
        output: {
            serviceId,
            summary: { updated: updated.length, failed: 0 },
            updated,
            failed: [],
        },
        stderr: "",
        summary: { updated: updated.length, failed: 0 },
        updated,
        failed: [],
        steps,
    };
}

function manualUpdaterFailureCode(stepCode?: string): string {
    if (stepCode) {
        return stepCode;
    }
    return "APPLY_FAILED";
}

function manualUpdaterFailureStatus(code: string): number {
    if (code === "NOT_FOUND") {
        return 404;
    }
    if (code === "DISABLED") {
        return 400;
    }
    if (code === "CONFLICT") {
        return 409;
    }
    if (code === "UNSUPPORTED_REGISTRY") {
        return 422;
    }
    return 500;
}

function firstFailedStepCode(steps: DockerUpdaterStepResult[]): string | undefined {
    return steps.find((step) => !step.ok)?.code;
}

/** Performs run docker updater now. */
export async function runDockerUpdaterNow() {
    const steps = await runDockerUpdaterServiceForRoutes();
    return steps;
}

/** Represents one docker updater event row. */
interface DockerUpdaterEventRow {
    id: string;
    managed_service_id: string | null;
    app_slug: string | null;
    service_name: string | null;
    event_type: string;
    from_tag: string;
    to_tag: string;
    from_digest: string;
    to_digest: string;
    created_at: string;
}

/** Returns docker updater events. */
async function getDockerUpdaterEvents(limit: number) {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = db
        .prepare(
            `SELECT
                CAST(e.id AS TEXT) AS id,
                CAST(e.managed_service_id AS TEXT) AS managed_service_id,
                COALESCE(NULLIF(e.app_slug, ''), s.app_slug, '') AS app_slug,
                COALESCE(NULLIF(e.service_name, ''), s.service_name, '') AS service_name,
                e.event_type,
                COALESCE(e.from_tag, '') AS from_tag,
                COALESCE(e.to_tag, '') AS to_tag,
                COALESCE(e.from_digest, '') AS from_digest,
                COALESCE(e.to_digest, '') AS to_digest,
                e.created_at
             FROM docker_update_events e
             LEFT JOIN docker_managed_services s ON s.id = e.managed_service_id
             ORDER BY e.created_at DESC
             LIMIT ?`
        )
        .all(boundedLimit) as unknown as DockerUpdaterEventRow[];

    return rows.map((row) => ({
        id: Number(row.id),
        managedServiceId:
            row.managed_service_id === null ? null : Number(row.managed_service_id),
        appSlug: row.app_slug,
        serviceName: row.service_name,
        eventType: row.event_type,
        fromTag: nullableString(row.from_tag),
        toTag: nullableString(row.to_tag),
        fromDigest: nullableString(row.from_digest),
        toDigest: nullableString(row.to_digest),
        message: null, // Message excluded from list view due to newlines
        createdAt: row.created_at,
    }));
}

/** Performs run container action. */
async function runContainerAction(
    containerId: string,
    action: DockerActionRequest["action"]
) {
    const details = await getContainerDetails(containerId);
    if (!details) {
        throw new Error("Container not found");
    }

    await runDocker([action, details.id]);
    return { output: `${action} sent to ${details.name}` };
}

/** Performs run stack action. */
async function runStackAction(request: DockerStackActionRequest) {
    const args: string[] = [request.action];
    if (request.service) {
        args.push(request.service);
    }
    const result = await runCompose(args);
    return {
        output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    };
}

/** Performs run docker exec command. */
async function runDockerExecCommand(
    containerId: string,
    command: string,
    jobId: string,
    onUpdate?: (stdout: string, stderr: string) => void
): Promise<DockerExecResult> {
    return new Promise((resolve, reject) => {
        const wrappedCommand = [
            `if command -v setsid >/dev/null 2>&1; then setsid sh -lc ${shellQuote(command)} & command_pid=$!; else sh -lc ${shellQuote(command)} & command_pid=$!; fi`,
            String.raw`printf '%s%s\n' ${shellQuote(DOCKER_EXEC_PID_MARKER)} "$command_pid"`,
            String.raw`wait "$command_pid"`,
        ].join("; ");
        const child = spawn(
            dockerBin,
            ["exec", containerId, "sh", "-lc", wrappedCommand],
            {
                cwd: DOCKER_ROOT,
                env: process.env,
                detached: true,
            }
        );

        const job = dockerExecJobs.get(jobId);
        if (job) {
            job.process = child;
            job.inContainerPid = null;
        }

        let stdout = "";
        let stderr = "";
        let stdoutPending = "";

        const processStdoutLine = (line: string, trailingNewline = false): void => {
            const markerIndex = line.indexOf(DOCKER_EXEC_PID_MARKER);
            if (markerIndex === -1) {
                stdout = trimOutput(stdout + line + (trailingNewline ? "\n" : ""));
                return;
            }
            if (markerIndex > 0) {
                stdout = trimOutput(stdout + line.slice(0, markerIndex));
            }
            const parsedPid = Number.parseInt(
                line.slice(markerIndex + DOCKER_EXEC_PID_MARKER.length),
                10
            );
            const currentJob = dockerExecJobs.get(jobId);
            if (
                currentJob &&
                currentJob.inContainerPid == null &&
                Number.isSafeInteger(parsedPid) &&
                parsedPid > 1
            ) {
                currentJob.inContainerPid = parsedPid;
            }
        };

        const flushNonMarkerPendingStdout = (): void => {
            if (
                stdoutPending.length <= MAX_STDOUT_PENDING_CHARS ||
                DOCKER_EXEC_PID_MARKER.startsWith(stdoutPending)
            ) {
                return;
            }
            stdout = trimOutput(stdout + stdoutPending);
            stdoutPending = "";
        };

        child.stdout?.on("data", (data) => {
            stdoutPending += String(data);
            let newlineIndex = stdoutPending.indexOf("\n");
            while (newlineIndex !== -1) {
                const line = stdoutPending.slice(0, newlineIndex);
                stdoutPending = stdoutPending.slice(newlineIndex + 1);
                processStdoutLine(line, true);
                newlineIndex = stdoutPending.indexOf("\n");
            }
            flushNonMarkerPendingStdout();
            onUpdate?.(stdout, stderr);
        });

        child.stderr?.on("data", (data) => {
            stderr = trimOutput(stderr + String(data));
            onUpdate?.(stdout, stderr);
        });

        child.on("close", (code, signal) => {
            if (stdoutPending) {
                processStdoutLine(stdoutPending);
                stdoutPending = "";
                onUpdate?.(stdout, stderr);
            }
            resolve({
                code: signal ? 130 : code,
                stdout,
                stderr,
            });
        });

        child.on("error", (error) => {
            reject(error);
        });
    });
}

async function stopDockerExecInContainer(job: DockerExecJob): Promise<void> {
    const deadline = Date.now() + dockerExecPidWaitTimeoutMs;
    while (!job.inContainerPid && Date.now() < deadline) {
        await new Promise((resolve) =>
            setTimeout(resolve, DOCKER_EXEC_PID_WAIT_INTERVAL_MS)
        );
    }
    if (!job.inContainerPid) {
        throw new Error("Timed out waiting for Docker exec in-container PID");
    }
    await execFileAsync(
        dockerBin,
        [
            "exec",
            job.containerId,
            "sh",
            "-lc",
            `kill -TERM -- -${job.inContainerPid} 2>/dev/null || kill -TERM ${job.inContainerPid}`,
        ],
        {
            cwd: DOCKER_ROOT,
            env: process.env,
            timeout: 10_000,
            killSignal: "SIGTERM",
        }
    );
}

function stopDockerExecHostProcess(childProcess: ChildProcess): void {
    const { pid } = childProcess;
    try {
        if (typeof pid === "number" && !Number.isNaN(pid) && pid > 1) {
            process.kill(-pid, "SIGTERM");
        } else {
            childProcess.kill("SIGTERM");
        }
    } catch {
        try {
            childProcess.kill("SIGTERM");
        } catch (fallbackError) {
            if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") {
                throw fallbackError;
            }
        }
    }
}

/** Performs cleanup docker exec jobs. */
function cleanupDockerExecJobs() {
    if (dockerExecJobs.size <= MAX_JOBS) {
        return;
    }
    const entries = [...dockerExecJobs.values()]
        .filter((job) => job.status === "done")
        .sort((a, b) => a.startedAt - b.startedAt);
    const overflow = Math.min(entries.length, dockerExecJobs.size - MAX_JOBS);
    for (let index = 0; index < overflow; index += 1) {
        const job = entries[index];
        dockerExecJobs.delete(job.id);
    }
}

function activeDockerExecJobCount(): number {
    return [...dockerExecJobs.values()].filter((job) => job.status !== "done").length;
}

function updateDockerExecJobOutput(jobId: string, stdout: string, stderr: string): void {
    const current = dockerExecJobs.get(jobId);
    if (!current) {
        return;
    }

    current.stdout = stdout;
    current.stderr = stderr;
}

function completeDockerExecJob(jobId: string, result: DockerExecResult): void {
    const current = dockerExecJobs.get(jobId);
    if (!current) {
        return;
    }

    current.status = "done";
    current.code = result.code;
    current.stdout = result.stdout;
    current.stderr = result.stderr;
    current.endedAt = Date.now();
    current.process = undefined;
    cleanupDockerExecJobs();
}

function failDockerExecJob(jobId: string, error: unknown): void {
    const current = dockerExecJobs.get(jobId);
    if (!current) {
        return;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    current.status = "done";
    current.code = 1;
    current.stderr = trimOutput(`${current.stderr}\n${errMsg}`.trim());
    current.endedAt = Date.now();
    current.process = undefined;
    cleanupDockerExecJobs();
}

function resolveManualUpdateServiceId(
    routeServiceIdParam: string,
    payload: DockerManualUpdateRequest
): number | null {
    if (routeServiceIdParam) {
        if (!/^\d+$/u.test(routeServiceIdParam)) {
            return null;
        }
        const routeServiceId = Number(routeServiceIdParam);
        return Number.isSafeInteger(routeServiceId) && routeServiceId > 0
            ? routeServiceId
            : null;
    }

    const serviceId = Number(payload.serviceId || 0);
    return Number.isSafeInteger(serviceId) && serviceId > 0 ? serviceId : null;
}

export const __testing = {
    asyncRoute,
    trimOutput,
    parseJsonLines,
    parseJsonField,
    hasUpdaterCandidate,
    extractTrailingJson,
    firstFailedStepCode,
    manualUpdaterFailureCode,
    manualUpdaterFailureStatus,
    dockerExecJobs,
    cleanupDockerExecJobs,
    activeDockerExecJobCount,
    dockerIdentifierFallback,
    runManualUpdaterForService,
    runDockerExecCommand,
    setDockerBinForTests: (nextDockerBin: string | undefined) => {
        dockerBin = nextDockerBin || nonEmptyEnvFallback("MIRA_DOCKER_BIN", "docker");
    },
    setDockerUpdaterServiceRunnerForTests: (
        nextRunner?: typeof runDockerUpdaterService
    ) => {
        runDockerUpdaterServiceForRoutes = nextRunner ?? runDockerUpdaterService;
    },
    setDockerExecPidWaitTimeoutForTests: (nextTimeoutMs?: number) => {
        dockerExecPidWaitTimeoutMs =
            nextTimeoutMs ?? DEFAULT_DOCKER_EXEC_PID_WAIT_TIMEOUT_MS;
    },
    updateDockerExecJobOutput,
    completeDockerExecJob,
    failDockerExecJob,
    parseLabels,
    parsePorts,
    parseDockerSizeToBytes,
    getContainerInspectMap,
    resolveManualUpdateServiceId,
};

/** Registers docker API routes. */
export default function dockerRoutes(app: express.Application): void {
    app.get(
        "/api/docker/updater/services",
        asyncRoute(async (_req, res) => {
            const services = await getDockerUpdaterServices();
            const summary = {
                total: services.length,
                enabled: services.filter((service) => service.enabled).length,
                updateAvailable: services.filter((service) => service.updateAvailable)
                    .length,
                autoPolicy: services.filter((service) => service.policy === "auto")
                    .length,
                notifyPolicy: services.filter((service) => service.policy === "notify")
                    .length,
                failed: services.filter((service) =>
                    [
                        "auto_update_failed",
                        "manual_update_failed",
                        "registry_check_failed",
                        "unsupported_registry",
                    ].includes(service.lastStatus || "")
                ).length,
            };
            res.json({ services, summary });
        })
    );

    app.get(
        "/api/docker/updater/events",
        asyncRoute(async (req, res) => {
            const limitValue = Number(req.query.limit);
            const limit = Number.isFinite(limitValue) ? limitValue : 50;
            const events = await getDockerUpdaterEvents(limit);
            res.json({ events });
        })
    );

    app.post(
        "/api/docker/updater/run",
        express.json(),
        asyncRoute(async (_req, res) => {
            const steps = await runDockerUpdaterNow();
            res.json({
                success: steps.every((step) => step.ok),
                steps,
            });
        })
    );

    app.post(
        "/api/docker/updater/services/:serviceId/update",
        express.json(),
        asyncRoute(async (req, res) => {
            const payload = req.body as DockerManualUpdateRequest;
            const routeServiceIdParam = stringFallback(req.params.serviceId);
            const serviceId = resolveManualUpdateServiceId(routeServiceIdParam, payload);

            if (serviceId === null) {
                res.status(400).json({ error: "Invalid service id" });
                return;
            }

            const service = await getDockerUpdaterServiceById(serviceId);
            if (!service) {
                res.status(404).json({ error: "Updater service not found" });
                return;
            }

            if (!service.enabled) {
                res.status(400).json({ error: "Updater service is disabled" });
                return;
            }

            const result = await runManualUpdaterForService(service);
            const refreshedService = await getDockerUpdaterServiceById(service.id);
            const updatedService =
                refreshedService ?? (result.code === "NOT_FOUND" ? null : service);
            res.status(
                result.success ? 200 : manualUpdaterFailureStatus(result.code)
            ).json({
                success: result.success,
                error: result.success ? undefined : result.stderr,
                service: updatedService,
                result: result.output,
                stderr: result.stderr,
                steps: result.steps,
            });
        })
    );

    app.get(
        "/api/docker/containers",
        asyncRoute(async (_req, res) => {
            const containers = await getContainers();
            res.json({ containers });
        })
    );

    app.get(
        "/api/docker/containers/:containerId",
        asyncRoute(async (req, res) => {
            const containerId = dockerIdentifierFallback(req.params.containerId);
            if (!containerId) {
                sendInvalidDockerIdentifier(res, "containerId");
                return;
            }

            const details = await getContainerDetails(containerId);
            if (!details) {
                res.status(404).json({ error: "Container not found" });
                return;
            }

            res.json(details);
        })
    );

    app.get(
        "/api/docker/containers/:containerId/logs",
        asyncRoute(async (req, res) => {
            const containerId = dockerIdentifierFallback(req.params.containerId);
            if (!containerId) {
                sendInvalidDockerIdentifier(res, "containerId");
                return;
            }
            const tail = Math.min(
                MAX_LOG_TAIL,
                Math.max(
                    MIN_LOG_TAIL,
                    Number.parseInt(stringFallback(req.query.tail, "200"), 10) || 200
                )
            );
            const { stdout, stderr } = await execFileAsync(
                dockerBin,
                ["logs", "--tail", String(tail), containerId],
                {
                    cwd: DOCKER_ROOT,
                    env: process.env,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: DOCKER_REQUEST_TIMEOUT_MS,
                }
            );
            const content = [String(stdout), String(stderr)]
                .filter(Boolean)
                .join("\n")
                .trim();
            res.json({ content });
        })
    );

    app.post(
        "/api/docker/containers/:containerId/action",
        express.json({ strict: false }),
        asyncRoute(async (req, res) => {
            const payload = req.body as Partial<DockerActionRequest> | null;
            const containerId = dockerIdentifierFallback(req.params.containerId);
            if (!containerId) {
                sendInvalidDockerIdentifier(res, "containerId");
                return;
            }

            if (!payload || typeof payload !== "object") {
                res.status(400).json({ error: "Invalid container action" });
                return;
            }
            const { action } = payload;
            if (action !== "start" && action !== "stop" && action !== "restart") {
                res.status(400).json({ error: "Invalid container action" });
                return;
            }

            let result: Awaited<ReturnType<typeof runContainerAction>>;
            try {
                result = await runContainerAction(containerId, action);
            } catch (error) {
                if ((error as Error).message.includes("Container not found")) {
                    res.status(404).json({ error: (error as Error).message });
                    return;
                }
                throw error;
            }
            res.json(result);
        })
    );

    app.post(
        "/api/docker/stack/action",
        express.json({ strict: false }),
        asyncRoute(async (req, res) => {
            const payload = validateDockerStackActionRequest(req.body);
            if (!payload) {
                res.status(400).json({ error: "Invalid stack action" });
                return;
            }
            const result = await runStackAction(payload);
            res.json(result);
        })
    );

    app.get(
        "/api/docker/images",
        asyncRoute(async (_req, res) => {
            const images = await getImages();
            res.json({ images });
        })
    );

    app.delete(
        "/api/docker/images/:imageId",
        asyncRoute(async (req, res) => {
            const imageId = dockerIdentifierFallback(req.params.imageId);
            if (!imageId) {
                sendInvalidDockerIdentifier(res, "imageId");
                return;
            }

            await runDocker(["image", "rm", imageId]);
            res.json({ success: true });
        })
    );

    app.get(
        "/api/docker/volumes",
        asyncRoute(async (_req, res) => {
            const volumes = await getVolumes();
            res.json({ volumes });
        })
    );

    app.delete(
        "/api/docker/volumes/:volumeName",
        asyncRoute(async (req, res) => {
            const volumeName = dockerIdentifierFallback(req.params.volumeName);
            if (!volumeName) {
                sendInvalidDockerIdentifier(res, "volumeName");
                return;
            }

            await runDocker(["volume", "rm", volumeName]);
            res.json({ success: true });
        })
    );

    app.post(
        "/api/docker/prune",
        express.json(),
        asyncRoute(async (req, res) => {
            const payload = req.body as DockerPruneRequest;

            if (payload.target === "images") {
                const output = await runDocker(["image", "prune", "-a", "-f"]);
                res.json({ success: true, output });
                return;
            }

            if (payload.target === "volumes") {
                const output = await runDocker(["volume", "prune", "-f"]);
                res.json({ success: true, output });
                return;
            }

            res.status(400).json({ error: "Invalid prune target" });
        })
    );

    app.post(
        "/api/docker/exec/start",
        express.json({ strict: false }),
        asyncRoute(async (req, res) => {
            const payload = req.body as DockerExecStartRequest;

            if (!payload || typeof payload !== "object") {
                res.status(400).json({ error: "Missing containerId or command" });
                return;
            }

            if (payload.containerId === undefined || payload.command === undefined) {
                res.status(400).json({ error: "Missing containerId or command" });
                return;
            }

            if (typeof payload.containerId !== "string") {
                sendInvalidDockerIdentifier(res, "containerId");
                return;
            }

            const containerId = dockerIdentifierFallback(payload.containerId);
            if (!containerId) {
                sendInvalidDockerIdentifier(res, "containerId");
                return;
            }

            if (typeof payload.command !== "string" || !payload.command.trim()) {
                res.status(400).json({ error: "Invalid command" });
                return;
            }

            cleanupDockerExecJobs();
            if (activeDockerExecJobCount() >= MAX_JOBS) {
                res.status(429).json({ error: "Too many active Docker exec jobs" });
                return;
            }

            const jobId = randomUUID();
            dockerExecJobs.set(jobId, {
                id: jobId,
                containerId,
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
            });

            void runDockerExecCommand(
                containerId,
                payload.command,
                jobId,
                (stdout, stderr) => updateDockerExecJobOutput(jobId, stdout, stderr)
            )
                .then((result) => completeDockerExecJob(jobId, result))
                .catch((error) => failDockerExecJob(jobId, error));

            res.json({ jobId });
        })
    );

    app.get("/api/docker/exec/:jobId", ((req, res) => {
        const jobId = stringFallback(req.params.jobId);
        const job = dockerExecJobs.get(jobId);

        if (!job) {
            res.status(404).json({ error: "Docker exec job not found" });
            return;
        }

        res.json({
            jobId: job.id,
            containerId: job.containerId,
            status: job.status,
            code: job.code,
            stdout: job.stdout,
            stderr: job.stderr,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
        });
    }) as RequestHandler);

    app.post(
        "/api/docker/exec/:jobId/stop",
        asyncRoute(async (req, res) => {
            const jobId = stringFallback(req.params.jobId);
            const job = dockerExecJobs.get(jobId);
            if (!job) {
                res.status(404).json({ error: "Docker exec job not found" });
                return;
            }

            if (job.status !== "running") {
                res.status(400).json({ error: "Job is not running" });
                return;
            }
            if (!job.process || job.process.killed) {
                res.status(400).json({ error: "Process not available" });
                return;
            }
            const hostProcess = job.process;
            let stopError: unknown;
            try {
                await stopDockerExecInContainer(job);
            } catch (error) {
                stopError = error;
            } finally {
                stopDockerExecHostProcess(hostProcess);
            }
            if (stopError) {
                throw stopError;
            }
            res.json({ success: true });
        })
    );
}
