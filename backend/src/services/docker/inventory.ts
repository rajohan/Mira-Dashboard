import { runProcess } from "../../lib/processes.ts";
import {
    arrayFallback,
    nonEmptyEnvironmentFallback,
    objectFallback,
    stringFallback,
} from "../../lib/values.ts";

const dockerBin = nonEmptyEnvironmentFallback("MIRA_DOCKER_BIN", "docker");
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

export interface DockerStatsRow {
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

function getDockerRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_ROOT", "/opt/docker");
}
function parseJsonLines<T>(input: string): T[] {
    return input
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
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

export async function getContainers(statsRows?: DockerStatsRow[]) {
    const psRows = parseJsonLines<DockerPsRow>(
        await runDocker(["ps", "-a", "--format", "{{json .}}"])
    );
    const resolvedStatsRows = statsRows ?? (await getContainerStatsRows());
    const statsById = new Map(resolvedStatsRows.map((row) => [row.ID, row]));
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

export async function getContainerLogs(
    containerId: string,
    tail: number
): Promise<string> {
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
            `docker logs failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`
        );
    }
    return [String(stdout), String(stderr)].filter(Boolean).join("\n").trim();
}

export async function getContainerDetails(containerId: string) {
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

export async function resolveContainerId(
    identifier: string
): Promise<string | undefined> {
    const containers = await getContainers();
    const summary = findContainerSummary(containers, identifier);
    if (!summary) return undefined;
    const inspectMap = await getContainerInspectMap([summary.id]);
    return stringFallback(inspectMap.get(summary.id)?.Id) || summary.id;
}

export async function getImages(containers?: Awaited<ReturnType<typeof getContainers>>) {
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

export async function getVolumes(containers?: Awaited<ReturnType<typeof getContainers>>) {
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
