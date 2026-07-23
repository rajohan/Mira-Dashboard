import { database } from "../database.ts";
import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { runProcess } from "../lib/processes.ts";
import {
    arrayFallback,
    nonEmptyEnvironmentFallback,
    nullableString,
    objectFallback,
    stringFallback,
} from "../lib/values.ts";
import {
    type DockerUpdaterStepResult,
    isNonblockingRegistrationFailure,
} from "../services/dockerUpdater.ts";
import {
    cancelJobExecution,
    enqueueJobExecution,
    getJobExecution,
    type JobExecution,
} from "../services/jobExecutionQueue.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "../services/queuedJobExecution.ts";
import { enqueueScheduledJob } from "../services/scheduledJobs.ts";

const dockerBin = nonEmptyEnvironmentFallback("MIRA_DOCKER_BIN", "docker");
const MAX_JOBS = 100;
const MIN_LOG_TAIL = 50;
const MAX_LOG_TAIL = 5000;
const DOCKER_REQUEST_TIMEOUT_MS = 30_000;
const SENSITIVE_ENV_KEY_PATTERN =
    /(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL|PRIVATE|AUTHORIZATION|AUTH|JWT|COOKIE|SESSION|DSN|DATABASE[_-]?URL|DB[_-]?URL|REDIS[_-]?URL|MONGO(?:DB)?[_-]?URL|CONNECTION[_-]?STRING|API[_-]?KEY|ACCESS[_-]?TOKEN|(?:^|[_-])PAT(?:$|[_-])|(?:^|[_-])URL$)/iu;

interface DockerPsRow {
    Command: string;
    CreatedAt: string;
    ID: string;
    Image: string;
    Labels: string;
    Mounts: string;
    Names: string;
    Networks: string;
    Ports: string;
    RunningFor: string;
    State: string;
    Status: string;
}

interface DockerStatsRow {
    BlockIO: string;
    CPUPerc: string;
    ID: string;
    MemPerc: string;
    MemUsage: string;
    NetIO: string;
    PIDs: string;
}

interface DockerInspectMount {
    Destination?: string;
    Mode?: string;
    Name?: string;
    RW?: boolean;
    Source?: string;
    Type?: string;
}

interface DockerInspectRow {
    Config?: {
        Env?: string[];
        Labels?: Record<string, string>;
    };
    Created?: string;
    Id?: string;
    Image?: string;
    Mounts?: DockerInspectMount[];
    NetworkSettings?: {
        Networks?: Record<
            string,
            { Gateway?: string; IPAddress?: string; MacAddress?: string }
        >;
    };
    RestartCount?: number;
    State?: {
        FinishedAt?: string;
        Health?: { Status?: string };
        StartedAt?: string;
    };
}

interface DockerImageRow {
    ContainerName?: string;
    Created?: string;
    CreatedAt?: string;
    CreatedSince?: string;
    ID: string;
    LastTagTime?: string;
    Platform?: string;
    Repository: string;
    Size?: number | string;
    Tag: string;
}

interface DockerVolumeRow {
    Driver: string;
    Labels: string;
    Mountpoint: string;
    Name: string;
    Scope: string;
    Size: string;
}

interface DockerUpdaterServiceRow {
    app_slug: string;
    compose_image_ref: string;
    current_digest: string;
    current_tag: string;
    enabled: string;
    id: string;
    image_repo: string;
    last_checked_at: string;
    last_status: string;
    last_updated_at: string;
    latest_digest: string;
    latest_tag: string;
    metadata: string;
    pin_mode: string;
    policy: string;
    service_name: string;
}

const dockerUpdaterProjection = `
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
`;

function getDockerRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_ROOT", "/opt/docker");
}

function parameters(request: Request): Record<string, string | undefined> {
    return (request as Request & { params?: Record<string, string> }).params ?? {};
}

function queryNumber(request: Request, key: string, fallback: number): number {
    const rawValue = new URL(request.url).searchParams.get(key);
    if (rawValue === null || rawValue === "") return fallback;
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function dockerIdentifier(value: unknown): string | undefined {
    const identifier = stringFallback(value).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(identifier)) return undefined;
    return identifier;
}

function dockerImageIdentifier(value: unknown): string | undefined {
    const identifier = stringFallback(value).trim();
    if (/^sha256:[a-f0-9]{64}$/iu.test(identifier)) return identifier;
    return dockerIdentifier(identifier);
}

function invalidDockerIdentifier(label: string): Response {
    return json({ error: `Invalid ${label}` }, { status: 400 });
}

function parseJsonLines<T>(input: string): T[] {
    return input
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
}

function parseJsonField<T>(value: string | undefined): T | undefined {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

function hasEmbeddedCredentials(value: string): boolean {
    try {
        const url = new URL(value);
        return Boolean(url.username || url.password);
    } catch {
        return false;
    }
}

function redactEnvironmentValue(value: unknown): string {
    const environmentValue = String(value);
    const separatorIndex = environmentValue.indexOf("=");
    if (separatorIndex === -1) {
        return SENSITIVE_ENV_KEY_PATTERN.test(environmentValue)
            ? `${environmentValue}=***`
            : environmentValue;
    }

    const key = environmentValue.slice(0, separatorIndex);
    const rawValue = environmentValue.slice(separatorIndex + 1);
    return SENSITIVE_ENV_KEY_PATTERN.test(key) || hasEmbeddedCredentials(rawValue)
        ? `${key}=***`
        : environmentValue;
}

function redactLabelValue([key, value]: [string, string]): [string, string] {
    return [key, redactEnvironmentValue(`${key}=${value}`).slice(key.length + 1)];
}

function parseLabels(labelsRaw: string | undefined): Record<string, string> {
    if (!labelsRaw) return {};
    return Object.fromEntries(
        labelsRaw
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => {
                const separatorIndex = entry.indexOf("=");
                return separatorIndex === -1
                    ? [entry, ""]
                    : [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)];
            })
    );
}

function parsePorts(portsRaw: string | undefined): string[] {
    return portsRaw
        ? portsRaw
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean)
        : [];
}

function parseDockerSizeToBytes(sizeRaw: string | undefined): number {
    if (!sizeRaw) return 0;
    const match = sizeRaw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Z]*B)$/iu);
    if (!match) return 0;
    const multipliers: Record<string, number> = {
        B: 1,
        GB: 1024 ** 3,
        KB: 1024,
        MB: 1024 ** 2,
        PB: 1024 ** 5,
        TB: 1024 ** 4,
    };
    const [, value, unit] = match;
    return Math.round(
        Number(value ?? "0") * (multipliers[unit?.toUpperCase() ?? ""] ?? 0)
    );
}

async function runDocker(arguments_: string[], signal?: AbortSignal): Promise<string> {
    const { code, stderr, stdout } = await runProcess(dockerBin, arguments_, {
        cwd: getDockerRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
        signal,
        timeoutMs: DOCKER_REQUEST_TIMEOUT_MS,
    });
    if (code !== 0) {
        throw new Error(
            `docker ${arguments_.join(" ")} failed with exit code ${code}: ${
                stderr.trim() || stdout.trim()
            }`
        );
    }
    return String(stdout);
}

async function getContainerInspectMap(containerIds: string[]) {
    if (containerIds.length === 0) return new Map<string, DockerInspectRow>();
    const parsedRows = JSON.parse(
        await runDocker(["inspect", ...containerIds])
    ) as unknown;
    const inspectRows = Array.isArray(parsedRows)
        ? (parsedRows as DockerInspectRow[])
        : [];
    const map = new Map<string, DockerInspectRow>();
    for (const row of inspectRows) {
        const fullId = stringFallback(row.Id);
        if (!fullId) continue;
        map.set(fullId, row);
        map.set(fullId.slice(0, 12), row);
    }
    return map;
}

export async function getContainers() {
    const psRows = parseJsonLines<DockerPsRow>(
        await runDocker(["ps", "-a", "--format", "{{json .}}"])
    );
    const statsRows = await getContainerStatsRows();
    const statsById = new Map(statsRows.map((row) => [row.ID, row]));
    const inspectMap = await getContainerInspectMap(psRows.map((row) => row.ID));

    return psRows.map((row) => {
        const inspect = inspectMap.get(row.ID);
        const labels = objectFallback(inspect?.Config?.Labels);
        const networks = objectFallback(inspect?.NetworkSettings?.Networks);
        const stats = statsById.get(row.ID);
        return {
            command: row.Command,
            createdAt: stringFallback(inspect?.Created ?? row.CreatedAt),
            finishedAt: inspect?.State?.FinishedAt || undefined,
            health: inspect?.State?.Health?.Status || "unknown",
            id: row.ID,
            image: row.Image,
            imageId: stringFallback(inspect?.Image),
            ipAddresses: Object.fromEntries(
                Object.entries(networks).map(([name, value]) => [
                    name,
                    stringFallback(objectFallback(value).IPAddress),
                ])
            ),
            mounts: Array.isArray(inspect?.Mounts)
                ? inspect.Mounts.map((mount) => ({
                      destination: stringFallback(mount.Destination),
                      mode: stringFallback(mount.Mode),
                      name: mount.Name ? String(mount.Name) : undefined,
                      readOnly: mount.RW === false,
                      source: stringFallback(mount.Source),
                      type: stringFallback(mount.Type),
                  }))
                : [],
            name: row.Names,
            ports: parsePorts(row.Ports),
            project: labels["com.docker.compose.project"] || undefined,
            restartCount: Number(inspect?.RestartCount || 0),
            runningFor: row.RunningFor,
            service: labels["com.docker.compose.service"] || undefined,
            startedAt: inspect?.State?.StartedAt || undefined,
            state: row.State,
            stats: stats
                ? {
                      blockIO: stats.BlockIO,
                      cpu: stats.CPUPerc,
                      memory: stats.MemUsage,
                      memoryPercent: stats.MemPerc,
                      netIO: stats.NetIO,
                      pids: stats.PIDs,
                  }
                : undefined,
            status: row.Status,
        };
    });
}

export async function getContainerStatsRows() {
    return parseJsonLines<DockerStatsRow>(
        await runDocker(["stats", "--no-stream", "--format", "{{json .}}"])
    );
}

async function getContainerDetails(containerId: string) {
    const containers = await getContainers();
    const summary = findContainerSummary(containers, containerId);
    if (!summary) return;
    const inspectMap = await getContainerInspectMap([summary.id]);
    const inspect = inspectMap.get(summary.id);
    if (!inspect) return;
    return {
        ...summary,
        env: arrayFallback(inspect.Config?.Env).map((value) =>
            redactEnvironmentValue(value)
        ),
        labels: Object.fromEntries(
            Object.entries(objectFallback(inspect.Config?.Labels)).map((entry) =>
                redactLabelValue(entry)
            )
        ),
        networks: Object.entries(objectFallback(inspect.NetworkSettings?.Networks)).map(
            ([name, value]) => {
                const network = objectFallback(value);
                return {
                    gateway: stringFallback(network.Gateway),
                    ipAddress: stringFallback(network.IPAddress),
                    macAddress: stringFallback(network.MacAddress),
                    name,
                };
            }
        ),
    };
}

function findContainerSummary(
    containers: Awaited<ReturnType<typeof getContainers>>,
    identifier: string
) {
    const exact = containers.find(
        (container) => container.id === identifier || container.name === identifier
    );
    if (exact) return exact;
    const prefixMatches = containers.filter((container) =>
        container.id.startsWith(identifier)
    );
    return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

async function resolveContainerId(identifier: string): Promise<string | undefined> {
    const containers = await getContainers();
    const summary = findContainerSummary(containers, identifier);
    if (!summary) return undefined;
    const inspectMap = await getContainerInspectMap([summary.id]);
    return stringFallback(inspectMap.get(summary.id)?.Id) || summary.id;
}

async function readDockerJson<T>(request: Request): Promise<T | Response> {
    try {
        return await readJson<T>(request);
    } catch (error) {
        return json(
            { error: errorMessage(error, "Invalid JSON") },
            { status: httpStatusCode(error) }
        );
    }
}

export async function getImages(
    containers?: Awaited<ReturnType<typeof getContainers>> | undefined
) {
    const images = parseJsonLines<DockerImageRow>(
        await runDocker(["image", "ls", "--format", "{{json .}}", "--no-trunc"])
    );
    const imageContainers = containers ?? (await getContainers());
    return images.map((image) => {
        const imageReference = `${image.Repository}:${image.Tag}`;
        return {
            containerName: image.ContainerName || "",
            createdAt: image.Created || image.CreatedAt || image.CreatedSince || "",
            id: image.ID,
            inUseBy: imageContainers
                .filter(
                    (container) =>
                        container.imageId.includes(image.ID) ||
                        container.imageId === image.ID ||
                        container.image === imageReference
                )
                .map((container) => container.name),
            lastTagTime: image.LastTagTime || image.CreatedAt || image.CreatedSince || "",
            platform: image.Platform || "unknown",
            repository: image.Repository,
            size:
                typeof image.Size === "number"
                    ? image.Size
                    : parseDockerSizeToBytes(image.Size),
            tag: image.Tag,
        };
    });
}

export async function getVolumes(
    containers?: Awaited<ReturnType<typeof getContainers>> | undefined
) {
    const volumeRows = parseJsonLines<DockerVolumeRow>(
        await runDocker(["volume", "ls", "--format", "{{json .}}"])
    );
    const volumeContainers = containers ?? (await getContainers());
    return volumeRows.map((volume) => ({
        driver: volume.Driver,
        labels: parseLabels(volume.Labels),
        mountpoint: volume.Mountpoint,
        name: volume.Name,
        scope: volume.Scope,
        size: volume.Size,
        usedBy: volumeContainers
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

function hasUpdaterCandidate(service: DockerUpdaterServiceRow): boolean {
    const hasDigestDrift = Boolean(
        service.latest_digest &&
        (!service.current_digest || service.current_digest !== service.latest_digest)
    );
    if (service.pin_mode === "digest") return hasDigestDrift;
    return Boolean(
        hasDigestDrift ||
        (service.current_tag &&
            service.latest_tag &&
            service.current_tag !== service.latest_tag)
    );
}

function mapDockerUpdaterRow(row: DockerUpdaterServiceRow) {
    return {
        appSlug: row.app_slug,
        composeImageRef: nullableString(row.compose_image_ref),
        currentDigest: nullableString(row.current_digest),
        currentTag: nullableString(row.current_tag),
        enabled: row.enabled === "true",
        id: Number(row.id),
        imageRepo: row.image_repo,
        lastCheckedAt: nullableString(row.last_checked_at),
        lastStatus: nullableString(row.last_status),
        lastUpdatedAt: nullableString(row.last_updated_at),
        latestDigest: nullableString(row.latest_digest),
        latestTag: nullableString(row.latest_tag),
        metadata: objectFallback(parseJsonField<Record<string, unknown>>(row.metadata)),
        pinMode: row.pin_mode,
        policy: row.policy,
        serviceName: row.service_name,
        updateAvailable: hasUpdaterCandidate(row),
    };
}

export async function getDockerUpdaterServices() {
    const rows = database
        .prepare(
            `SELECT ${dockerUpdaterProjection}
             FROM docker_managed_services
             ORDER BY app_slug, service_name`
        )
        .all() as unknown as DockerUpdaterServiceRow[];
    return rows.map((row) => mapDockerUpdaterRow(row));
}

async function getDockerUpdaterServiceById(serviceId: number) {
    const rows = database
        .prepare(
            `SELECT ${dockerUpdaterProjection}
             FROM docker_managed_services
             WHERE id = ?
             LIMIT 1`
        )
        .all(Math.floor(serviceId)) as unknown as DockerUpdaterServiceRow[];
    return rows[0] ? mapDockerUpdaterRow(rows[0]) : undefined;
}

function blockingDockerUpdaterFailures(steps: DockerUpdaterStepResult[]) {
    return steps.filter(
        (step) =>
            !step.isOk &&
            !isNonblockingRegistrationFailure(step) &&
            step.step !== "git-sync:docker"
    );
}

function dockerUpdaterSteps(execution: JobExecution): DockerUpdaterStepResult[] {
    const steps = execution.output.steps;
    if (!Array.isArray(steps)) {
        successfulJobExecutionOutput(execution);
        throw new Error("Docker updater result was missing");
    }
    return steps as DockerUpdaterStepResult[];
}

export async function getDockerUpdaterEvents(limit: number) {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = database
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
        .all(boundedLimit) as Array<
        Record<string, string | null | undefined> & { managed_service_id: string | null }
    >;

    return rows.map((row) => ({
        appSlug: row.app_slug,
        createdAt: row.created_at,
        eventType: row.event_type,
        fromDigest: nullableString(row.from_digest),
        fromTag: nullableString(row.from_tag),
        id: Number(row.id),
        managedServiceId:
            row.managed_service_id === null ? undefined : Number(row.managed_service_id),
        message: undefined,
        serviceName: row.service_name,
        toDigest: nullableString(row.to_digest),
        toTag: nullableString(row.to_tag),
    }));
}

export function getDockerUpdaterSummary(
    services: Awaited<ReturnType<typeof getDockerUpdaterServices>>
) {
    return {
        autoPolicy: services.filter((service) => service.policy === "auto").length,
        enabled: services.filter((service) => service.enabled).length,
        failed: services.filter((service) => service.lastStatus === "auto_update_failed")
            .length,
        notifyPolicy: services.filter((service) => service.policy === "notify").length,
        total: services.length,
        updateAvailable: services.filter((service) => service.updateAvailable).length,
    };
}

function parseServiceId(request: Request): number | undefined {
    const rawValue = parameters(request).serviceId;
    if (!rawValue || !/^\d+$/u.test(rawValue)) return undefined;
    const serviceId = Number(rawValue);
    return Number.isSafeInteger(serviceId) && serviceId > 0 ? serviceId : undefined;
}

function updaterResultCode(steps: DockerUpdaterStepResult[]): string {
    return steps.find((step) => !step.isOk)?.code ?? "OK";
}

function statusCodeFromError(error: unknown): number {
    if (!error || typeof error !== "object") return 500;
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    return Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode < 600
        ? statusCode
        : 500;
}

async function runQueuedDockerAction(options: {
    actionKey: string;
    displayName: string;
    payload?: Record<string, unknown>;
    resourceClass?: "host-heavy" | "interactive" | "exclusive";
    timeoutMs: number;
}): Promise<Record<string, unknown>> {
    const execution = enqueueJobExecution({
        actionKey: options.actionKey,
        displayName: options.displayName,
        payload: options.payload,
        resourceClass: options.resourceClass ?? "host-heavy",
        timeoutMs: options.timeoutMs,
    });
    return successfulJobExecutionOutput(
        await waitForJobExecution(execution.id, {
            timeoutMs: options.timeoutMs + 30 * 60 * 1000,
        })
    );
}

function outputString(output: Record<string, unknown>, key: string): string {
    return typeof output[key] === "string" ? output[key] : "";
}

function outputNumber(output: Record<string, unknown>, key: string): number | undefined {
    return typeof output[key] === "number" && Number.isFinite(output[key])
        ? output[key]
        : undefined;
}

function dockerExecExecution(jobId: string): JobExecution | undefined {
    const execution = getJobExecution(jobId);
    return execution?.actionKey === "docker.exec" ? execution : undefined;
}

async function runStackAction(request: Request): Promise<Response> {
    const body = await readDockerJson<{ action?: unknown; service?: unknown }>(request);
    if (body instanceof Response) return body;
    if (!body || typeof body !== "object") {
        return json({ error: "Invalid stack action" }, { status: 400 });
    }
    if (body.action !== "restart" && body.action !== "start" && body.action !== "stop") {
        return json({ error: "Invalid stack action" }, { status: 400 });
    }
    if (
        body.service !== undefined &&
        (typeof body.service !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(body.service))
    ) {
        return json({ error: "Invalid service name" }, { status: 400 });
    }
    const result = await runQueuedDockerAction({
        actionKey: "docker.stack.action",
        displayName: `Docker stack ${body.action}`,
        payload: { action: body.action, service: body.service },
        timeoutMs: 2 * 60 * 1000,
    });
    return json({
        output: outputString(result, "output"),
    });
}

export const dockerRoutes = {
    "/api/docker/containers": {
        GET: async () => json({ containers: await getContainers() }),
    },
    "/api/docker/containers/stats": {
        GET: async () => {
            const rows = await getContainerStatsRows();
            return json({
                stats: rows.map((row) => ({
                    blockIO: row.BlockIO,
                    cpu: row.CPUPerc,
                    id: row.ID,
                    memory: row.MemUsage,
                    memoryPercent: row.MemPerc,
                    netIO: row.NetIO,
                    pids: row.PIDs,
                })),
            });
        },
    },
    "/api/docker/containers/:containerId": {
        GET: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const details = await getContainerDetails(containerId);
            return details
                ? json(details)
                : json({ error: "Container not found" }, { status: 404 });
        },
    },
    "/api/docker/containers/:containerId/action": {
        POST: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const body = await readDockerJson<{ action?: unknown }>(request);
            if (body instanceof Response) return body;
            if (
                !body ||
                (body.action !== "start" &&
                    body.action !== "stop" &&
                    body.action !== "restart")
            ) {
                return json({ error: "Invalid container action" }, { status: 400 });
            }
            const action = body.action;
            const details = await getContainerDetails(containerId);
            if (!details) return json({ error: "Container not found" }, { status: 404 });
            await runQueuedDockerAction({
                actionKey: "docker.container.action",
                displayName: `Docker container ${action}`,
                payload: { action, containerId: details.id },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ output: `${action} sent to ${details.name}` });
        },
    },
    "/api/docker/containers/:containerId/logs": {
        GET: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const requestedTail = Math.trunc(queryNumber(request, "tail", 200)) || 200;
            const tail = Math.min(MAX_LOG_TAIL, Math.max(MIN_LOG_TAIL, requestedTail));
            const { code, stderr, stdout } = await runProcess(
                dockerBin,
                ["logs", "--tail", String(tail), containerId],
                {
                    cwd: getDockerRoot(),
                    env: process.env,
                    maxBuffer: 10 * 1024 * 1024,
                    timeoutMs: DOCKER_REQUEST_TIMEOUT_MS,
                }
            );
            if (code !== 0) {
                throw new Error(
                    `docker logs failed with exit code ${code}: ${
                        stderr.trim() || stdout.trim()
                    }`
                );
            }
            return json({
                content: [String(stdout), String(stderr)]
                    .filter(Boolean)
                    .join("\n")
                    .trim(),
            });
        },
    },
    "/api/docker/exec/:jobId": {
        GET: (request: Request) => {
            const jobId = stringFallback(parameters(request).jobId);
            const execution = dockerExecExecution(jobId);
            if (!execution)
                return json({ error: "Docker exec job not found" }, { status: 404 });
            const output = execution.output;
            const isTerminal = ["success", "failed", "cancelled"].includes(
                execution.status
            );
            return json({
                code: outputNumber(output, "code"),
                containerId:
                    outputString(output, "containerId") ||
                    stringFallback(execution.payload.containerId),
                endedAt: isTerminal
                    ? (outputNumber(output, "endedAt") ??
                      (execution.finishedAt
                          ? Date.parse(execution.finishedAt)
                          : undefined))
                    : undefined,
                jobId: execution.id,
                startedAt:
                    outputNumber(output, "startedAt") ??
                    Date.parse(execution.startedAt ?? execution.queuedAt),
                status: isTerminal ? "done" : "running",
                stderr: outputString(output, "stderr"),
                stdout: outputString(output, "stdout"),
            });
        },
    },
    "/api/docker/exec/:jobId/stop": {
        POST: (request: Request) => {
            const jobId = stringFallback(parameters(request).jobId);
            const execution = dockerExecExecution(jobId);
            if (!execution)
                return json({ error: "Docker exec job not found" }, { status: 404 });
            if (execution.status !== "queued" && execution.status !== "running") {
                return json({ error: "Job is not running" }, { status: 400 });
            }
            try {
                cancelJobExecution(execution.id);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Failed to stop Docker exec job") },
                    { status: statusCodeFromError(error) }
                );
            }
            return json({ isSuccess: true });
        },
    },
    "/api/docker/exec/start": {
        POST: async (request: Request) => {
            const body = await readDockerJson<{
                command?: unknown;
                containerId?: unknown;
            }>(request);
            if (body instanceof Response) return body;
            const requestedContainerId = dockerIdentifier(body?.containerId);
            if (
                !body ||
                !requestedContainerId ||
                typeof body.command !== "string" ||
                !body.command.trim()
            ) {
                return json({ error: "Missing containerId or command" }, { status: 400 });
            }
            const containerId = await resolveContainerId(requestedContainerId);
            if (!containerId) {
                return json({ error: "Container not found" }, { status: 404 });
            }
            const activeJobs = database
                .prepare(
                    `SELECT COUNT(*) AS count FROM job_executions
                     WHERE action_key = 'docker.exec'
                       AND status IN ('queued', 'running')`
                )
                .get() as { count: number };
            if (activeJobs.count >= MAX_JOBS) {
                return json(
                    { error: "Too many active Docker exec jobs" },
                    { status: 429 }
                );
            }
            let execution: JobExecution;
            try {
                execution = enqueueJobExecution({
                    actionKey: "docker.exec",
                    displayName: "Docker container exec",
                    payload: { command: body.command, containerId },
                    resourceClass: "exclusive",
                    timeoutMs: 7 * 60 * 60 * 1000,
                });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Docker exec failed to start") },
                    { status: statusCodeFromError(error) }
                );
            }
            return json({ jobId: execution.id });
        },
    },
    "/api/docker/images": {
        GET: async () => json({ images: await getImages() }),
    },
    "/api/docker/images/:imageId": {
        DELETE: async (request: Request) => {
            const imageId = dockerImageIdentifier(parameters(request).imageId);
            if (!imageId) return invalidDockerIdentifier("imageId");
            await runQueuedDockerAction({
                actionKey: "docker.image.delete",
                displayName: "Delete Docker image",
                payload: { imageId },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ isSuccess: true });
        },
    },
    "/api/docker/prune": {
        POST: async (request: Request) => {
            const body = await readDockerJson<{ target?: unknown }>(request);
            if (body instanceof Response) return body;
            if (body?.target === "images") {
                return json({
                    isSuccess: true,
                    output: outputString(
                        await runQueuedDockerAction({
                            actionKey: "docker.prune.images",
                            displayName: "Prune Docker images",
                            payload: { target: "images" },
                            timeoutMs: 10 * 60 * 1000,
                        }),
                        "output"
                    ),
                });
            }
            if (body?.target === "volumes") {
                return json({
                    isSuccess: true,
                    output: outputString(
                        await runQueuedDockerAction({
                            actionKey: "docker.prune.volumes",
                            displayName: "Prune Docker volumes",
                            payload: { target: "volumes" },
                            timeoutMs: 10 * 60 * 1000,
                        }),
                        "output"
                    ),
                });
            }
            return json({ error: "Invalid prune target" }, { status: 400 });
        },
    },
    "/api/docker/stack/action": {
        POST: runStackAction,
    },
    "/api/docker/updater/events": {
        GET: async (request: Request) =>
            json({
                events: await getDockerUpdaterEvents(queryNumber(request, "limit", 50)),
            }),
    },
    "/api/docker/updater/run": {
        POST: async () => {
            try {
                const scheduledRun = enqueueScheduledJob("docker.updater", "manual");
                const execution = await waitForJobExecution(
                    scheduledRun.executionId as string,
                    { timeoutMs: 60 * 60 * 1000 }
                );
                const steps = dockerUpdaterSteps(execution);
                return json({
                    isSuccess: blockingDockerUpdaterFailures(steps).length === 0,
                    steps,
                });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Docker updater failed") },
                    { status: statusCodeFromError(error) }
                );
            }
        },
    },
    "/api/docker/updater/services": {
        GET: async () => {
            const services = await getDockerUpdaterServices();
            return json({
                services,
                summary: getDockerUpdaterSummary(services),
            });
        },
    },
    "/api/docker/updater/services/:serviceId/update": {
        POST: async (request: Request) => {
            const serviceId = parseServiceId(request);
            if (serviceId === undefined) {
                return json({ error: "Invalid service id" }, { status: 400 });
            }
            const service = await getDockerUpdaterServiceById(serviceId);
            if (!service) {
                return json({ error: "Updater service not found" }, { status: 404 });
            }
            if (!service.enabled) {
                return json({ error: "Updater service is disabled" }, { status: 400 });
            }
            let steps: DockerUpdaterStepResult[];
            try {
                const execution = enqueueJobExecution({
                    actionKey: "docker.updater",
                    displayName: `Update Docker service ${serviceId}`,
                    payload: { serviceId },
                    resourceClass: "exclusive",
                    timeoutMs: 30 * 60 * 1000,
                });
                steps = dockerUpdaterSteps(
                    await waitForJobExecution(execution.id, {
                        timeoutMs: 60 * 60 * 1000,
                    })
                );
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Docker updater failed") },
                    { status: statusCodeFromError(error) }
                );
            }
            const failed = blockingDockerUpdaterFailures(steps);
            const code = updaterResultCode(failed);
            const firstFailure = failed[0];
            if (firstFailure && code === "NOT_FOUND") {
                return json(
                    { error: firstFailure.stderr || "Updater service not found" },
                    { status: 404 }
                );
            }
            if (firstFailure && code === "DISABLED") {
                return json(
                    { error: firstFailure.stderr || "Updater service is disabled" },
                    { status: 400 }
                );
            }
            if (firstFailure && code === "CONFLICT") {
                return json(
                    { error: firstFailure.stderr || "No update available" },
                    { status: 409 }
                );
            }
            if (firstFailure && code === "UNSUPPORTED_REGISTRY") {
                return json(
                    { error: firstFailure.stderr || "Unsupported image registry" },
                    { status: 422 }
                );
            }
            const updatedService = await getDockerUpdaterServiceById(serviceId);
            return json({
                isSuccess: failed.length === 0,
                result: {
                    failed,
                    serviceId,
                    summary: {
                        failed: failed.length,
                        updated: failed.length === 0 ? 1 : 0,
                    },
                    updated: failed.length === 0 ? [serviceId] : [],
                },
                service: updatedService,
                stderr: failed
                    .map((step) => step.stderr)
                    .filter(Boolean)
                    .join("\n"),
            });
        },
    },
    "/api/docker/volumes": {
        GET: async () => json({ volumes: await getVolumes() }),
    },
    "/api/docker/volumes/:volumeName": {
        DELETE: async (request: Request) => {
            const volumeName = dockerIdentifier(parameters(request).volumeName);
            if (!volumeName) return invalidDockerIdentifier("volumeName");
            await runQueuedDockerAction({
                actionKey: "docker.volume.delete",
                displayName: "Delete Docker volume",
                payload: { volumeName },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ isSuccess: true });
        },
    },
} as const;
