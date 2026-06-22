import { database } from "../database.ts";
import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    type BunProcess,
    killProcessGroup,
    pipeProcessOutput,
    runProcess,
    spawnProcess,
} from "../lib/processes.ts";
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
    registerDockerUpdaterScheduledJobs,
    runDockerUpdaterService,
} from "../services/dockerUpdater.ts";
import {
    createManualScheduledJobRun,
    finishScheduledJobRun,
} from "../services/scheduledJobs.ts";

const dockerBin = nonEmptyEnvironmentFallback("MIRA_DOCKER_BIN", "docker");
const MAX_OUTPUT_CHARS = 100_000;
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

interface DockerExecJob {
    code: number | undefined;
    containerId: string;
    containerPid?: number;
    endedAt: number | undefined;
    id: string;
    process?: BunProcess;
    startedAt: number;
    status: "running" | "done";
    stderr: string;
    stdout: string;
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

const dockerExecJobs = new Map<string, DockerExecJob>();

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

function getDockerComposeWrapper(): string {
    return nonEmptyEnvironmentFallback(
        "MIRA_DOCKER_COMPOSE_WRAPPER",
        `${getDockerRoot()}/bin/docker-compose-doppler`
    );
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

function trimOutput(text: string): string {
    return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(-MAX_OUTPUT_CHARS);
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
    return Math.round(Number(value) * (multipliers[unit?.toUpperCase() ?? ""] ?? 0));
}

async function runDocker(arguments_: string[]): Promise<string> {
    const { code, stderr, stdout } = await runProcess(dockerBin, arguments_, {
        cwd: getDockerRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
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

async function runCompose(
    arguments_: string[]
): Promise<{ stderr: string; stdout: string }> {
    const result = await runProcess(getDockerComposeWrapper(), arguments_, {
        cwd: getDockerRoot(),
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
        timeoutMs: DOCKER_REQUEST_TIMEOUT_MS,
    });
    if (result.code !== 0) {
        throw new Error(
            `docker compose ${arguments_.join(" ")} failed with exit code ${
                result.code
            }: ${result.stderr.trim() || result.stdout.trim()}`
        );
    }
    return result;
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

async function getContainers() {
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

async function getImages() {
    const images = parseJsonLines<DockerImageRow>(
        await runDocker(["image", "ls", "--format", "{{json .}}", "--no-trunc"])
    );
    const containers = await getContainers();
    return images.map((image) => {
        const imageReference = `${image.Repository}:${image.Tag}`;
        return {
            containerName: image.ContainerName || "",
            createdAt: image.Created || image.CreatedAt || image.CreatedSince || "",
            id: image.ID,
            inUseBy: containers
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

async function getVolumes() {
    const volumeRows = parseJsonLines<DockerVolumeRow>(
        await runDocker(["volume", "ls", "--format", "{{json .}}"])
    );
    const containers = await getContainers();
    return volumeRows.map((volume) => ({
        driver: volume.Driver,
        labels: parseLabels(volume.Labels),
        mountpoint: volume.Mountpoint,
        name: volume.Name,
        scope: volume.Scope,
        size: volume.Size,
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

function hasUpdaterCandidate(service: DockerUpdaterServiceRow): boolean {
    const hasDigestDrift = Boolean(
        service.latest_digest &&
        (!service.current_digest || service.current_digest !== service.latest_digest)
    );
    if (service.pin_mode === "digest") return hasDigestDrift;
    return Boolean(
        (service.current_tag &&
            service.latest_tag &&
            service.current_tag !== service.latest_tag) ||
        hasDigestDrift
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

async function getDockerUpdaterServices() {
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
    return steps.filter((step) => !step.isOk && !isNonblockingRegistrationFailure(step));
}

async function getDockerUpdaterEvents(limit: number) {
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
    const arguments_: string[] = [body.action];
    if (body.service !== undefined) arguments_.push(body.service);
    const result = await runCompose(arguments_);
    return json({
        output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    });
}

function cleanupDockerExecJobs(): void {
    if (dockerExecJobs.size <= MAX_JOBS) return;
    const doneJobs = dockerExecJobs
        .values()
        .filter((job) => job.status === "done")
        .toArray()
        .toSorted((a, b) => a.startedAt - b.startedAt);
    const jobsToDelete = doneJobs.slice(0, dockerExecJobs.size - MAX_JOBS);
    for (const job of jobsToDelete) {
        dockerExecJobs.delete(job.id);
    }
}

function activeDockerExecJobCount(): number {
    return dockerExecJobs
        .values()
        .filter((job) => job.status !== "done")
        .toArray().length;
}

function settleDockerExecJob(containerId: string, command: string, jobId: string): void {
    const pidMarker = `__MIRA_DOCKER_EXEC_PID_${jobId}:`;
    let child: BunProcess;
    try {
        child = spawnProcess(
            dockerBin,
            [
                "exec",
                "-e",
                `MIRA_DASHBOARD_EXEC_COMMAND=${command}`,
                containerId,
                "sh",
                "-lc",
                String.raw`if command -v setsid >/dev/null 2>&1; then exec setsid sh -lc 'printf '\''${pidMarker}%s\n'\'' "$$"; exec sh -lc "$MIRA_DASHBOARD_EXEC_COMMAND"'; fi; printf '${pidMarker}%s\n' "$$"; exec sh -lc "$MIRA_DASHBOARD_EXEC_COMMAND"`,
            ],
            {
                cwd: getDockerRoot(),
                env: process.env,
            }
        );
    } catch (error) {
        const job = dockerExecJobs.get(jobId);
        if (job) {
            job.status = "done";
            job.code = 1;
            job.stderr = errorMessage(error, "Docker exec failed");
            job.endedAt = Date.now();
            cleanupDockerExecJobs();
        }
        return;
    }
    const job = dockerExecJobs.get(jobId);
    if (job) job.process = child;

    let stdoutPrefix = "";
    const stdoutDone = pipeProcessOutput(
        child.stdout as ReadableStream<Uint8Array> | undefined,
        (data) => {
            const current = dockerExecJobs.get(jobId);
            if (!current) return;
            const output = stdoutPrefix + String(data);
            const newlineIndex = output.indexOf("\n");
            if (current.containerPid === undefined && newlineIndex === -1) {
                stdoutPrefix = output;
                return;
            }
            let userOutput = output;
            if (current.containerPid === undefined) {
                const firstLine = output.slice(0, newlineIndex).trim();
                if (firstLine.startsWith(pidMarker)) {
                    const pid = Number(firstLine.slice(pidMarker.length));
                    if (Number.isSafeInteger(pid) && pid > 0) {
                        current.containerPid = pid;
                    }
                    userOutput = output.slice(newlineIndex + 1);
                }
                stdoutPrefix = "";
            }
            current.stdout = trimOutput(current.stdout + userOutput);
        }
    );
    const stderrDone = pipeProcessOutput(
        child.stderr as ReadableStream<Uint8Array> | undefined,
        (data) => {
            const current = dockerExecJobs.get(jobId);
            if (current) current.stderr = trimOutput(current.stderr + String(data));
        }
    );
    void (async () => {
        const code = await child.exited;
        await Promise.all([stdoutDone, stderrDone]);
        return code;
    })()
        .then((code) => {
            const current = dockerExecJobs.get(jobId);
            if (!current) return;
            current.status = "done";
            current.code = code;
            current.endedAt = Date.now();
            current.process = undefined;
            cleanupDockerExecJobs();
        })
        .catch((error: unknown) => {
            const current = dockerExecJobs.get(jobId);
            if (!current) return;
            current.status = "done";
            current.code = 1;
            current.stderr = trimOutput(
                `${current.stderr}\n${errorMessage(error, "Docker exec failed")}`.trim()
            );
            current.endedAt = Date.now();
            current.process = undefined;
            cleanupDockerExecJobs();
        });
}

export const dockerRoutes = {
    "/api/docker/containers": {
        GET: async () => json({ containers: await getContainers() }),
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
            const details = await getContainerDetails(containerId);
            if (!details) return json({ error: "Container not found" }, { status: 404 });
            await runDocker([body.action, details.id]);
            return json({ output: `${body.action} sent to ${details.name}` });
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
            const job = dockerExecJobs.get(stringFallback(parameters(request).jobId));
            if (!job)
                return json({ error: "Docker exec job not found" }, { status: 404 });
            return json({
                code: job.code,
                containerId: job.containerId,
                endedAt: job.endedAt,
                jobId: job.id,
                startedAt: job.startedAt,
                status: job.status,
                stderr: job.stderr,
                stdout: job.stdout,
            });
        },
    },
    "/api/docker/exec/:jobId/stop": {
        POST: async (request: Request) => {
            const job = dockerExecJobs.get(stringFallback(parameters(request).jobId));
            if (!job)
                return json({ error: "Docker exec job not found" }, { status: 404 });
            if (job.status !== "running") {
                return json({ error: "Job is not running" }, { status: 400 });
            }
            if (!job.process) {
                return json({ error: "Process not available" }, { status: 400 });
            }
            let containerStopError: string | undefined;
            if (job.containerPid) {
                try {
                    await runDocker([
                        "exec",
                        job.containerId,
                        "kill",
                        "-TERM",
                        `-${job.containerPid}`,
                    ]);
                } catch (groupError) {
                    try {
                        await runDocker([
                            "exec",
                            job.containerId,
                            "kill",
                            "-TERM",
                            String(job.containerPid),
                        ]);
                    } catch (processError) {
                        containerStopError = `${errorMessage(groupError, "Failed to stop in-container process group")}; ${errorMessage(processError, "Failed to stop in-container process")}`;
                        job.stderr = trimOutput(
                            `${job.stderr}\n${containerStopError}`.trim()
                        );
                    }
                }
            }
            try {
                killProcessGroup(job.process, "SIGTERM");
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Failed to stop Docker exec job") },
                    { status: 500 }
                );
            }
            if (containerStopError) {
                return json({ error: containerStopError }, { status: 500 });
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
            cleanupDockerExecJobs();
            if (activeDockerExecJobCount() >= MAX_JOBS) {
                return json(
                    { error: "Too many active Docker exec jobs" },
                    { status: 429 }
                );
            }
            const jobId = Bun.randomUUIDv7();
            dockerExecJobs.set(jobId, {
                code: undefined,
                containerId,
                endedAt: undefined,
                id: jobId,
                startedAt: Date.now(),
                status: "running",
                stderr: "",
                stdout: "",
            });
            settleDockerExecJob(containerId, body.command, jobId);
            return json({ jobId });
        },
    },
    "/api/docker/images": {
        GET: async () => json({ images: await getImages() }),
    },
    "/api/docker/images/:imageId": {
        DELETE: async (request: Request) => {
            const imageId = dockerImageIdentifier(parameters(request).imageId);
            if (!imageId) return invalidDockerIdentifier("imageId");
            await runDocker(["image", "rm", imageId]);
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
                    output: await runDocker(["image", "prune", "-a", "-f"]),
                });
            }
            if (body?.target === "volumes") {
                return json({
                    isSuccess: true,
                    output: await runDocker(["volume", "prune", "-f"]),
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
            let scheduledRun;
            try {
                registerDockerUpdaterScheduledJobs();
                scheduledRun = createManualScheduledJobRun("docker.updater");
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Docker updater failed") },
                    { status: statusCodeFromError(error) }
                );
            }
            try {
                const steps = await runDockerUpdaterService();
                finishScheduledJobRun(
                    scheduledRun,
                    blockingDockerUpdaterFailures(steps).length === 0
                        ? "success"
                        : "failed",
                    undefined,
                    { steps }
                );
                return json({
                    isSuccess: blockingDockerUpdaterFailures(steps).length === 0,
                    steps,
                });
            } catch (error) {
                finishScheduledJobRun(
                    scheduledRun,
                    "failed",
                    errorMessage(error, "Docker updater failed"),
                    { steps: [] }
                );
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
                summary: {
                    autoPolicy: services.filter((service) => service.policy === "auto")
                        .length,
                    enabled: services.filter((service) => service.enabled).length,
                    failed: services.filter(
                        (service) => service.lastStatus === "auto_update_failed"
                    ).length,
                    notifyPolicy: services.filter(
                        (service) => service.policy === "notify"
                    ).length,
                    total: services.length,
                    updateAvailable: services.filter((service) => service.updateAvailable)
                        .length,
                },
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
            let scheduledRun;
            try {
                registerDockerUpdaterScheduledJobs();
                scheduledRun = createManualScheduledJobRun("docker.updater");
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Docker updater failed") },
                    { status: statusCodeFromError(error) }
                );
            }
            let steps: DockerUpdaterStepResult[];
            try {
                steps = await runDockerUpdaterService(serviceId);
                finishScheduledJobRun(
                    scheduledRun,
                    blockingDockerUpdaterFailures(steps).length === 0
                        ? "success"
                        : "failed",
                    undefined,
                    { serviceId, steps }
                );
            } catch (error) {
                finishScheduledJobRun(
                    scheduledRun,
                    "failed",
                    errorMessage(error, "Docker updater failed"),
                    { serviceId }
                );
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
            await runDocker(["volume", "rm", volumeName]);
            return json({ isSuccess: true });
        },
    },
} as const;
