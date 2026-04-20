import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import express, { type RequestHandler } from "express";
import { promisify } from "node:util";

import { parseTable } from "../lib/cacheStore.js";

const execFileAsync = promisify(execFile);

const DOCKER_COMPOSE_WRAPPER = "/opt/docker/bin/docker-compose-doppler";
const DOCKER_ROOT = "/opt/docker";
const MAX_OUTPUT_CHARS = 100_000;
const MAX_JOBS = 100;
const N8N_DATABASE = "n8n";

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

interface DockerManualUpdateRequest {
    serviceId?: number;
}

interface DockerUpdaterRunResult {
    step: string;
    ok: boolean;
    stdout: string;
    stderr: string;
}

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

interface DockerVolumeRow {
    Driver: string;
    Labels: string;
    Links: string;
    Mountpoint: string;
    Name: string;
    Scope: string;
    Size: string;
}

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

interface DockerVolumeSummary {
    name: string;
    driver: string;
    mountpoint: string;
    scope: string;
    size: string;
    labels: Record<string, string>;
    usedBy: string[];
}

interface DockerActionRequest {
    action: "start" | "stop" | "restart";
}

interface DockerStackActionRequest {
    action: "restart";
    service?: string;
}

interface DockerPruneRequest {
    target: "images" | "volumes";
}

interface DockerExecStartRequest {
    containerId: string;
    command: string;
}

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
}

const dockerExecJobs = new Map<string, DockerExecJob>();

function asyncRoute(handler: RequestHandler): RequestHandler {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch((error) => {
            console.error("[dockerRoutes]", error);
            if (res.headersSent) {
                next(error);
                return;
            }
            res.status(500).json({
                error: error instanceof Error ? error.message : "Docker route failed",
            });
        });
    };
}

function trimOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }

    return text.slice(-MAX_OUTPUT_CHARS);
}

function parseJsonLines<T>(input: string): T[] {
    return input
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
}

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

function buildPostgresUri(database = N8N_DATABASE) {
    const username = process.env.DATABASE_USERNAME || "postgres";
    const password = process.env.DATABASE_PASSWORD || "postgres";
    const host = process.env.DATABASE_HOST || "postgres";
    const port = process.env.DATABASE_PORT || "5432";
    return `postgresql://${username}:${password}@${host}:${port}/${database}`;
}

async function queryN8n(sql: string): Promise<string> {
    const { stdout } = await execFileAsync(
        "docker",
        [
            "exec",
            "postgres",
            "psql",
            buildPostgresUri(),
            "-P",
            "footer=off",
            "-F",
            "\t",
            "--no-align",
            "-c",
            sql,
        ],
        {
            cwd: DOCKER_ROOT,
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
        }
    );

    return String(stdout);
}

async function queryN8nTsvRows<T extends object>(sql: string, columns: string[]): Promise<T[]> {
    // Simple approach: use tab-separated output without header
    const tempFile = `/tmp/updater-events-${Date.now()}.tsv`;
    const copySql = `COPY (${sql}) TO '${tempFile}' WITH (FORMAT text, DELIMITER E'\\t', NULL '');`;

    await execFileAsync(
        "docker",
        ["exec", "postgres", "psql", buildPostgresUri(), "-qAt", "-c", copySql],
        {
            cwd: DOCKER_ROOT,
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
        }
    );

    try {
        const { stdout } = await execFileAsync(
            "docker",
            ["exec", "postgres", "cat", tempFile],
            {
                cwd: DOCKER_ROOT,
                env: process.env,
                maxBuffer: 10 * 1024 * 1024,
            }
        );

        const lines = String(stdout)
            .trim()
            .split("\n")
            .filter(Boolean);

        return lines.map((line) => {
            const cells = line.split("\t");
            return Object.fromEntries(columns.map((col, i) => [col, cells[i] ?? ""])) as T;
        });
    } finally {
        try {
            await execFileAsync(
                "docker",
                ["exec", "postgres", "rm", "-f", tempFile],
                {
                    cwd: DOCKER_ROOT,
                    env: process.env,
                }
            );
        } catch {
            // ignore cleanup errors
        }
    }
}

function hasUpdaterCandidate(service: DockerUpdaterServiceRow): boolean {
    if (service.pin_mode === "digest") {
        return Boolean(
            service.current_digest &&
                service.latest_digest &&
                service.current_digest !== service.latest_digest
        );
    }

    return Boolean(service.current_tag && service.latest_tag && service.current_tag !== service.latest_tag);
}

function extractTrailingJson(input: string) {
    const trimmed = input.trim();
    const start = trimmed.lastIndexOf("\n{");
    const candidate = start === -1 ? trimmed : trimmed.slice(start + 1);
    return JSON.parse(candidate);
}

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

function parsePorts(portsRaw: string | undefined): string[] {
    if (!portsRaw) {
        return [];
    }

    return portsRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function parseDockerSizeToBytes(sizeRaw: string | undefined): number {
    if (!sizeRaw) {
        return 0;
    }

    const match = sizeRaw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?B)$/i);
    if (!match) {
        return 0;
    }

    const value = Number.parseFloat(match[1] || "0");
    const unit = (match[2] || "B").toUpperCase();
    const multipliers: Record<string, number> = {
        B: 1,
        KB: 1024,
        MB: 1024 ** 2,
        GB: 1024 ** 3,
        TB: 1024 ** 4,
        PB: 1024 ** 5,
    };

    return Math.round(value * (multipliers[unit] || 1));
}

async function runDocker(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("docker", args, {
        cwd: DOCKER_ROOT,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
    });

    return String(stdout);
}

async function runCompose(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(DOCKER_COMPOSE_WRAPPER, args, {
        cwd: DOCKER_ROOT,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
    });

    return {
        stdout: String(stdout),
        stderr: String(stderr),
    };
}

async function getContainerInspectMap(containerIds: string[]) {
    if (containerIds.length === 0) {
        return new Map<string, any>();
    }

    const stdout = await runDocker(["inspect", ...containerIds]);
    const inspectRows = JSON.parse(stdout) as any[];
    const map = new Map<string, any>();

    for (const row of inspectRows) {
        const fullId = String(row.Id || "");
        if (!fullId) {
            continue;
        }

        map.set(fullId, row);
        map.set(fullId.slice(0, 12), row);
    }

    return map;
}

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
        const labels = inspect?.Config?.Labels || {};
        const networks = inspect?.NetworkSettings?.Networks || {};
        const stats = statsById.get(row.ID);

        const ipAddresses = Object.fromEntries(
            Object.entries(networks).map(([name, value]) => [
                name,
                String((value as { IPAddress?: string }).IPAddress || ""),
            ])
        );

        return {
            id: row.ID,
            name: row.Names,
            image: row.Image,
            imageId: String(inspect?.Image || ""),
            command: row.Command,
            createdAt: String(inspect?.Created || row.CreatedAt),
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
                ? inspect.Mounts.map((mount: any) => ({
                      type: String(mount.Type || ""),
                      source: String(mount.Source || ""),
                      destination: String(mount.Destination || ""),
                      mode: String(mount.Mode || ""),
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

async function getContainerDetails(containerId: string): Promise<DockerContainerDetails | null> {
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

    const labels = (inspect.Config?.Labels || {}) as Record<string, string>;
    const networks = Object.entries(inspect.NetworkSettings?.Networks || {}).map(
        ([name, value]) => ({
            name,
            ipAddress: String((value as { IPAddress?: string }).IPAddress || ""),
            gateway: String((value as { Gateway?: string }).Gateway || ""),
            macAddress: String((value as { MacAddress?: string }).MacAddress || ""),
        })
    );

    return {
        ...summary,
        env: Array.isArray(inspect.Config?.Env) ? inspect.Config.Env.map(String) : [],
        labels,
        networks,
    };
}

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
            size: typeof image.Size === "number" ? image.Size : parseDockerSizeToBytes(image.Size as unknown as string),
            createdAt: image.Created || image.CreatedAt || image.CreatedSince || "",
            lastTagTime: image.LastTagTime || image.CreatedAt || image.CreatedSince || "",
            inUseBy,
        };
    });
}

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

async function getDockerUpdaterServices() {
    const rows = parseTable<DockerUpdaterServiceRow>(await queryN8n(`
        SELECT
            id::text AS id,
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
            CASE WHEN enabled THEN 'true' ELSE 'false' END AS enabled,
            COALESCE(last_checked_at::text, '') AS last_checked_at,
            COALESCE(last_updated_at::text, '') AS last_updated_at,
            COALESCE(last_status, '') AS last_status,
            metadata::text AS metadata
        FROM docker_managed_services
        ORDER BY app_slug, service_name;
    `));

    return rows.map((row) => ({
        id: Number(row.id),
        appSlug: row.app_slug,
        serviceName: row.service_name,
        composeImageRef: row.compose_image_ref || null,
        imageRepo: row.image_repo,
        currentTag: row.current_tag || null,
        currentDigest: row.current_digest || null,
        latestTag: row.latest_tag || null,
        latestDigest: row.latest_digest || null,
        policy: row.policy,
        pinMode: row.pin_mode,
        enabled: row.enabled === "true",
        lastCheckedAt: row.last_checked_at || null,
        lastUpdatedAt: row.last_updated_at || null,
        lastStatus: row.last_status || null,
        updateAvailable: hasUpdaterCandidate(row),
        metadata: parseJsonField<Record<string, unknown>>(row.metadata) ?? {},
    }));
}

async function getDockerUpdaterServiceById(serviceId: number) {
    const rows = parseTable<DockerUpdaterServiceRow>(await queryN8n(`
        SELECT
            id::text AS id,
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
            CASE WHEN enabled THEN 'true' ELSE 'false' END AS enabled,
            COALESCE(last_checked_at::text, '') AS last_checked_at,
            COALESCE(last_updated_at::text, '') AS last_updated_at,
            COALESCE(last_status, '') AS last_status,
            metadata::text AS metadata
        FROM docker_managed_services
        WHERE id = ${Math.floor(serviceId)}
        LIMIT 1;
    `));

    const row = rows[0];
    if (!row) {
        return null;
    }

    return {
        id: Number(row.id),
        appSlug: row.app_slug,
        serviceName: row.service_name,
        composeImageRef: row.compose_image_ref || null,
        imageRepo: row.image_repo,
        currentTag: row.current_tag || null,
        currentDigest: row.current_digest || null,
        latestTag: row.latest_tag || null,
        latestDigest: row.latest_digest || null,
        policy: row.policy,
        pinMode: row.pin_mode,
        enabled: row.enabled === "true",
        lastCheckedAt: row.last_checked_at || null,
        lastUpdatedAt: row.last_updated_at || null,
        lastStatus: row.last_status || null,
        updateAvailable: hasUpdaterCandidate(row),
        metadata: parseJsonField<Record<string, unknown>>(row.metadata) ?? {},
    };
}

async function runManualUpdaterForService(serviceId: number) {
    const manual = await runUpdaterCommand("manual-update", [
        "/home/ubuntu/projects/n8n/scripts/docker-auto-update.mjs",
        "--mode",
        "manual",
        "--service-id",
        String(serviceId),
    ]);

    const steps: DockerUpdaterRunResult[] = [manual];
    if (!manual.ok) {
        return {
            output: extractTrailingJson(String(manual.stdout || "{}")),
            stderr: String(manual.stderr || ""),
            steps,
        };
    }

    const notify = await runUpdaterCommand("notify", ["/home/ubuntu/projects/n8n/scripts/docker-notify-updates.mjs"]);
    steps.push(notify);
    if (!notify.ok) {
        return {
            output: extractTrailingJson(String(manual.stdout || "{}")),
            stderr: [manual.stderr, notify.stderr].filter(Boolean).join("\n"),
            steps,
        };
    }

    const discord = await runUpdaterCommand("discord", ["/home/ubuntu/projects/n8n/scripts/docker-send-discord-newversion.mjs"]);
    steps.push(discord);

    return {
        output: extractTrailingJson(String(manual.stdout || "{}")),
        stderr: [manual.stderr, notify.stderr, discord.stderr].filter(Boolean).join("\n"),
        steps,
    };
}

async function runUpdaterCommand(step: string, args: string[]): Promise<DockerUpdaterRunResult> {
    const env = {
        ...process.env,
        DB_POSTGRESDB_HOST: "127.0.0.1",
        DB_POSTGRESDB_PORT: "6432",
        DB_POSTGRESDB_DATABASE: N8N_DATABASE,
        DB_POSTGRESDB_USER: process.env.DATABASE_USERNAME || "",
        DB_POSTGRESDB_PASSWORD: process.env.DATABASE_PASSWORD || "",
    };

    try {
        const { stdout, stderr } = await execFileAsync("node", args, {
            cwd: "/home/ubuntu/projects/n8n",
            env,
            maxBuffer: 20 * 1024 * 1024,
        });

        return {
            step,
            ok: true,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
        };
    } catch (error) {
        const execError = error as Error & { stdout?: string; stderr?: string };
        return {
            step,
            ok: false,
            stdout: String(execError.stdout || ""),
            stderr: String(execError.stderr || execError.message || ""),
        };
    }
}

async function runDockerUpdaterNow() {
    const steps: DockerUpdaterRunResult[] = [];

    steps.push(
        await runUpdaterCommand("register", ["/home/ubuntu/projects/n8n/scripts/docker-register-services.mjs"])
    );
    if (!steps.at(-1)?.ok) return steps;

    steps.push(
        await runUpdaterCommand("poll", ["/home/ubuntu/projects/n8n/scripts/docker-registry-poll.mjs"])
    );
    if (!steps.at(-1)?.ok) return steps;

    steps.push(
        await runUpdaterCommand("auto-update", ["/home/ubuntu/projects/n8n/scripts/docker-auto-update.mjs"])
    );
    if (!steps.at(-1)?.ok) return steps;

    steps.push(
        await runUpdaterCommand("notify", ["/home/ubuntu/projects/n8n/scripts/docker-notify-updates.mjs"])
    );
    if (!steps.at(-1)?.ok) return steps;

    steps.push(
        await runUpdaterCommand("discord", ["/home/ubuntu/projects/n8n/scripts/docker-send-discord-newversion.mjs"])
    );

    return steps;
}

interface DockerUpdaterEventRow {
    id: string;
    managed_service_id: string;
    app_slug: string;
    service_name: string;
    event_type: string;
    from_tag: string;
    to_tag: string;
    from_digest: string;
    to_digest: string;
    created_at: string;
}

async function getDockerUpdaterEvents(limit: number) {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const columns = [
        "id",
        "managed_service_id",
        "app_slug",
        "service_name",
        "event_type",
        "from_tag",
        "to_tag",
        "from_digest",
        "to_digest",
        "created_at",
    ];
    const rows = await queryN8nTsvRows<DockerUpdaterEventRow>(`
        SELECT
            e.id::text,
            e.managed_service_id::text,
            s.app_slug,
            s.service_name,
            e.event_type,
            COALESCE(e.from_tag, ''),
            COALESCE(e.to_tag, ''),
            COALESCE(e.from_digest, ''),
            COALESCE(e.to_digest, ''),
            e.created_at::text
        FROM docker_update_events e
        JOIN docker_managed_services s ON s.id = e.managed_service_id
        ORDER BY e.created_at DESC
        LIMIT ${boundedLimit}
    `, columns);

    return rows.map((row) => ({
        id: Number(row.id),
        managedServiceId: Number(row.managed_service_id),
        appSlug: row.app_slug,
        serviceName: row.service_name,
        eventType: row.event_type,
        fromTag: row.from_tag || null,
        toTag: row.to_tag || null,
        fromDigest: row.from_digest || null,
        toDigest: row.to_digest || null,
        message: null, // Message excluded from list view due to newlines
        createdAt: row.created_at,
    }));
}

async function runContainerAction(containerId: string, action: DockerActionRequest["action"]) {
    const details = await getContainerDetails(containerId);

    if (!details) {
        throw new Error("Container not found");
    }

    await runDocker([action, details.id]);
    return { output: `${action} sent to ${details.name}` };
}

async function runStackAction(request: DockerStackActionRequest) {
    const args = ["restart"];
    if (request.service) {
        args.push(request.service);
    }
    const result = await runCompose(args);
    return {
        output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    };
}

async function runDockerExecCommand(
    containerId: string,
    command: string,
    jobId: string,
    onUpdate?: (stdout: string, stderr: string) => void
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", ["exec", containerId, "sh", "-lc", command], {
            cwd: DOCKER_ROOT,
            env: process.env,
            detached: true,
        });

        const job = dockerExecJobs.get(jobId);
        if (job) {
            job.process = child;
        }

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (data) => {
            stdout = trimOutput(stdout + String(data));
            onUpdate?.(stdout, stderr);
        });

        child.stderr?.on("data", (data) => {
            stderr = trimOutput(stderr + String(data));
            onUpdate?.(stdout, stderr);
        });

        child.on("close", (code, signal) => {
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

function cleanupDockerExecJobs() {
    if (dockerExecJobs.size <= MAX_JOBS) {
        return;
    }

    const entries = [...dockerExecJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    const overflow = entries.length - MAX_JOBS;

    for (let index = 0; index < overflow; index += 1) {
        const job = entries[index];
        if (job.process && !job.process.killed) {
            job.process.kill("SIGTERM");
        }
        dockerExecJobs.delete(job.id);
    }
}

export default function dockerRoutes(app: express.Application): void {
    app.get("/api/docker/updater/services", asyncRoute(async (_req, res) => {
        const services = await getDockerUpdaterServices();
        const summary = {
            total: services.length,
            enabled: services.filter((service) => service.enabled).length,
            updateAvailable: services.filter((service) => service.updateAvailable).length,
            autoPolicy: services.filter((service) => service.policy === "auto").length,
            notifyPolicy: services.filter((service) => service.policy === "notify").length,
            failed: services.filter((service) => service.lastStatus === "auto_update_failed").length,
        };
        res.json({ services, summary });
    }));

    app.get("/api/docker/updater/events", asyncRoute(async (req, res) => {
        const limitValue = Number(req.query.limit);
        const limit = Number.isFinite(limitValue) ? limitValue : 50;
        const events = await getDockerUpdaterEvents(limit);
        res.json({ events });
    }));

    app.post("/api/docker/updater/run", express.json(), asyncRoute(async (_req, res) => {
        const steps = await runDockerUpdaterNow();
        res.json({
            success: steps.every((step) => step.ok),
            steps,
        });
    }));

    app.post("/api/docker/updater/services/:serviceId/update", express.json(), asyncRoute(async (req, res) => {
        const payload = req.body as DockerManualUpdateRequest;
        const routeServiceId = Number.parseInt(String(req.params.serviceId || ""), 10);
        const serviceId = Number.isFinite(routeServiceId) ? routeServiceId : Number(payload.serviceId || 0);

        if (!Number.isFinite(serviceId) || serviceId <= 0) {
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

        if (!service.updateAvailable) {
            res.status(400).json({ error: "No update available for this service" });
            return;
        }

        const result = await runManualUpdaterForService(serviceId);
        res.json({
            success: true,
            service,
            result: result.output,
            stderr: result.stderr,
        });
    }));

    app.get("/api/docker/containers", asyncRoute(async (_req, res) => {
        const containers = await getContainers();
        res.json({ containers });
    }));

    app.get("/api/docker/containers/:containerId", asyncRoute(async (req, res) => {
        const details = await getContainerDetails(String(req.params.containerId || ""));
        if (!details) {
            res.status(404).json({ error: "Container not found" });
            return;
        }

        res.json(details);
    }));

    app.get("/api/docker/containers/:containerId/logs", asyncRoute(async (req, res) => {
        const containerId = String(req.params.containerId || "");
        const tail = Math.max(50, Number.parseInt(String(req.query.tail || "200"), 10) || 200);
        const { stdout, stderr } = await execFileAsync("docker", ["logs", "--tail", String(tail), containerId], {
            cwd: DOCKER_ROOT,
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
        });
        const content = [String(stdout), String(stderr)].filter(Boolean).join("\n").trim();
        res.json({ content });
    }));

    app.post("/api/docker/containers/:containerId/action", express.json(), asyncRoute(async (req, res) => {
        const payload = req.body as DockerActionRequest;
        const result = await runContainerAction(String(req.params.containerId || ""), payload.action);
        res.json(result);
    }));

    app.post("/api/docker/stack/action", express.json(), asyncRoute(async (req, res) => {
        const payload = req.body as DockerStackActionRequest;
        const result = await runStackAction(payload);
        res.json(result);
    }));

    app.get("/api/docker/images", asyncRoute(async (_req, res) => {
        const images = await getImages();
        res.json({ images });
    }));

    app.delete("/api/docker/images/:imageId", asyncRoute(async (req, res) => {
        await runDocker(["image", "rm", String(req.params.imageId || "")]);
        res.json({ success: true });
    }));

    app.get("/api/docker/volumes", asyncRoute(async (_req, res) => {
        const volumes = await getVolumes();
        res.json({ volumes });
    }));

    app.delete("/api/docker/volumes/:volumeName", asyncRoute(async (req, res) => {
        await runDocker(["volume", "rm", String(req.params.volumeName || "")]);
        res.json({ success: true });
    }));

    app.post("/api/docker/prune", express.json(), asyncRoute(async (req, res) => {
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
    }));

    app.post("/api/docker/exec/start", express.json(), asyncRoute(async (req, res) => {
        const payload = req.body as DockerExecStartRequest;

        if (!payload.containerId || !payload.command) {
            res.status(400).json({ error: "Missing containerId or command" });
            return;
        }

        const jobId = randomUUID();
        dockerExecJobs.set(jobId, {
            id: jobId,
            containerId: payload.containerId,
            status: "running",
            code: null,
            stdout: "",
            stderr: "",
            startedAt: Date.now(),
            endedAt: null,
        });

        void runDockerExecCommand(payload.containerId, payload.command, jobId, (stdout, stderr) => {
            const current = dockerExecJobs.get(jobId);
            if (!current) {
                return;
            }

            current.stdout = stdout;
            current.stderr = stderr;
        })
            .then((result) => {
                const current = dockerExecJobs.get(jobId);
                if (!current) {
                    return;
                }

                current.status = "done";
                current.code = result.code;
                current.stdout = result.stdout;
                current.stderr = result.stderr;
                current.endedAt = Date.now();
                cleanupDockerExecJobs();
            })
            .catch((error) => {
                const current = dockerExecJobs.get(jobId);
                if (!current) {
                    return;
                }

                current.status = "done";
                current.code = 1;
                current.stderr = trimOutput(`${current.stderr}\n${(error as Error).message}`.trim());
                current.endedAt = Date.now();
                cleanupDockerExecJobs();
            });

        res.json({ jobId });
    }));

    app.get("/api/docker/exec/:jobId", ((req, res) => {
        const jobId = String(req.params.jobId || "");
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

    app.post("/api/docker/exec/:jobId/stop", ((req, res) => {
        const jobId = String(req.params.jobId || "");
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

        try {
            process.kill(-job.process.pid!, "SIGTERM");
        } catch {
            job.process.kill("SIGTERM");
        }

        res.json({ success: true });
    }) as RequestHandler);
}
