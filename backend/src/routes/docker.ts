import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import express, { type RequestHandler } from "express";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOCKER_COMPOSE_WRAPPER = "/opt/docker/bin/docker-compose-doppler";
const DOCKER_ROOT = "/opt/docker";
const MAX_OUTPUT_CHARS = 100_000;
const MAX_JOBS = 100;

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
    action: "start" | "stop" | "restart" | "update";
}

interface DockerStackActionRequest {
    action: "restart" | "update";
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

async function runContainerAction(containerId: string, action: DockerActionRequest["action"]) {
    const details = await getContainerDetails(containerId);

    if (!details) {
        throw new Error("Container not found");
    }

    if (action === "update") {
        if (!details.service) {
            throw new Error("Container is not managed by docker compose");
        }

        const pullResult = await runCompose(["pull", details.service]);
        const upResult = await runCompose(["up", "-d", details.service]);

        return {
            output: [pullResult.stdout, pullResult.stderr, upResult.stdout, upResult.stderr]
                .filter(Boolean)
                .join("\n")
                .trim(),
        };
    }

    await runDocker([action, details.id]);
    return { output: `${action} sent to ${details.name}` };
}

async function runStackAction(request: DockerStackActionRequest) {
    if (request.action === "restart") {
        const args = ["restart"];
        if (request.service) {
            args.push(request.service);
        }
        const result = await runCompose(args);
        return {
            output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
        };
    }

    const pullArgs = ["pull"];
    const upArgs = ["up", "-d"];
    if (request.service) {
        pullArgs.push(request.service);
        upArgs.push(request.service);
    }

    const pullResult = await runCompose(pullArgs);
    const upResult = await runCompose(upArgs);

    return {
        output: [pullResult.stdout, pullResult.stderr, upResult.stdout, upResult.stderr]
            .filter(Boolean)
            .join("\n")
            .trim(),
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
    app.get("/api/docker/containers", (async (_req, res) => {
        const containers = await getContainers();
        res.json({ containers });
    }) as RequestHandler);

    app.get("/api/docker/containers/:containerId", (async (req, res) => {
        const details = await getContainerDetails(String(req.params.containerId || ""));
        if (!details) {
            res.status(404).json({ error: "Container not found" });
            return;
        }

        res.json(details);
    }) as RequestHandler);

    app.get("/api/docker/containers/:containerId/logs", (async (req, res) => {
        const containerId = String(req.params.containerId || "");
        const tail = Math.max(50, Number.parseInt(String(req.query.tail || "200"), 10) || 200);
        const stdout = await runDocker(["logs", "--tail", String(tail), containerId]);
        res.json({ content: stdout });
    }) as RequestHandler);

    app.post("/api/docker/containers/:containerId/action", express.json(), (async (req, res) => {
        const payload = req.body as DockerActionRequest;
        const result = await runContainerAction(String(req.params.containerId || ""), payload.action);
        res.json(result);
    }) as RequestHandler);

    app.post("/api/docker/stack/action", express.json(), (async (req, res) => {
        const payload = req.body as DockerStackActionRequest;
        const result = await runStackAction(payload);
        res.json(result);
    }) as RequestHandler);

    app.get("/api/docker/images", (async (_req, res) => {
        const images = await getImages();
        res.json({ images });
    }) as RequestHandler);

    app.delete("/api/docker/images/:imageId", (async (req, res) => {
        await runDocker(["image", "rm", String(req.params.imageId || "")]);
        res.json({ success: true });
    }) as RequestHandler);

    app.get("/api/docker/volumes", (async (_req, res) => {
        const volumes = await getVolumes();
        res.json({ volumes });
    }) as RequestHandler);

    app.delete("/api/docker/volumes/:volumeName", (async (req, res) => {
        await runDocker(["volume", "rm", String(req.params.volumeName || "")]);
        res.json({ success: true });
    }) as RequestHandler);

    app.post("/api/docker/prune", express.json(), (async (req, res) => {
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
    }) as RequestHandler);

    app.post("/api/docker/exec/start", express.json(), (async (req, res) => {
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
    }) as RequestHandler);

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
