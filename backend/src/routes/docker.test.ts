import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalPath = process.env.PATH;
const originalDockerRoot = process.env.MIRA_DOCKER_ROOT;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!${process.execPath}
const args = process.argv.slice(2);
const command = args.join(" ");
const container = {
  Command: "node server.js",
  CreatedAt: "2026-05-10 12:00:00 +0000 UTC",
  ID: "abc123def456",
  Image: "repo/app:1.0.0",
  Labels: "",
  LocalVolumes: "0",
  Mounts: "app_data",
  Names: "app",
  Networks: "frontend",
  Ports: "127.0.0.1:3000->3000/tcp, 443/tcp",
  RunningFor: "2 hours",
  Size: "0B",
  State: "running",
  Status: "Up 2 hours (healthy)"
};
const stats = {
  BlockIO: "1MB / 2MB",
  CPUPerc: "1.23%",
  Container: "app",
  ID: "abc123def456",
  MemPerc: "4.56%",
  MemUsage: "128MiB / 1GiB",
  Name: "app",
  NetIO: "3MB / 4MB",
  PIDs: "12"
};
const inspect = [{
  Id: "abc123def4567890",
  Image: "sha256:image123",
  Created: "2026-05-10T12:00:00Z",
  RestartCount: 2,
  Config: {
    Env: ["NODE_ENV=production", "SECRET_TOKEN=hidden"],
    Labels: {
      "com.docker.compose.service": "web",
      "com.docker.compose.project": "mira"
    }
  },
  NetworkSettings: {
    Networks: {
      frontend: { Gateway: "172.20.0.1", IPAddress: "172.20.0.2", MacAddress: "02:42:ac:14:00:02" }
    }
  },
  State: {
    StartedAt: "2026-05-10T12:01:00Z",
    FinishedAt: "0001-01-01T00:00:00Z",
    Health: { Status: "healthy" }
  },
  Mounts: [
    { Type: "volume", Source: "/var/lib/docker/volumes/app_data/_data", Destination: "/data", Mode: "rw", RW: true, Name: "app_data" }
  ]
}];
if (command === "ps -a --format {{json .}}") {
  process.stdout.write(JSON.stringify(container) + "\n");
  process.exit(0);
}
if (command === "stats --no-stream --format {{json .}}") {
  process.stdout.write(JSON.stringify(stats) + "\n");
  process.exit(0);
}
if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify(inspect));
  process.exit(0);
}
if (command === "image ls --format {{json .}} --no-trunc") {
  process.stdout.write(JSON.stringify({ ID: "sha256:image123", Repository: "repo/app", Tag: "1.0.0", Platform: "linux/arm64", Size: "10MB", CreatedAt: "2026-05-10" }) + "\n");
  process.exit(0);
}
if (command === "volume ls --format {{json .}}") {
  process.stdout.write(JSON.stringify({ Driver: "local", Labels: "owner=mira,empty", Links: "1", Mountpoint: "/var/lib/docker/volumes/app_data/_data", Name: "app_data", Scope: "local", Size: "42MB" }) + "\n");
  process.exit(0);
}
if (args[0] === "logs") {
  process.stdout.write("stdout log\n");
  process.stderr.write("stderr log\n");
  process.exit(0);
}
process.stderr.write("unexpected docker args: " + command);
process.exit(1);
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

async function startServer(): Promise<TestServer> {
    const { default: dockerRoutes } = await import("./docker.js");
    const app = express();
    app.use(express.json());
    dockerRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("docker routes", () => {
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-docker-routes-"));
        await installFakeDocker(tempDir);
        process.env.MIRA_DOCKER_ROOT = tempDir;
        server = await startServer();
    });

    after(async () => {
        await server.close();
        process.env.PATH = originalPath;
        if (originalDockerRoot === undefined) {
            delete process.env.MIRA_DOCKER_ROOT;
        } else {
            process.env.MIRA_DOCKER_ROOT = originalDockerRoot;
        }
        await rm(tempDir, { recursive: true, force: true });
    });

    it("returns container summaries with inspect, stats, ports, and mounts", async () => {
        const response = await requestJson<{
            containers: Array<{
                id: string;
                name: string;
                imageId: string;
                health: string;
                restartCount: number;
                service: string;
                project: string;
                ports: string[];
                ipAddresses: Record<string, string>;
                mounts: Array<{ name: string; destination: string; readOnly: boolean }>;
                stats: { cpu: string; memoryPercent: string };
            }>;
        }>(server, "/api/docker/containers");

        assert.equal(response.status, 200);
        assert.equal(response.body.containers.length, 1);
        assert.deepEqual(response.body.containers[0], {
            id: "abc123def456",
            name: "app",
            image: "repo/app:1.0.0",
            imageId: "sha256:image123",
            command: "node server.js",
            createdAt: "2026-05-10T12:00:00Z",
            startedAt: "2026-05-10T12:01:00Z",
            finishedAt: "0001-01-01T00:00:00Z",
            runningFor: "2 hours",
            state: "running",
            status: "Up 2 hours (healthy)",
            health: "healthy",
            restartCount: 2,
            service: "web",
            project: "mira",
            ports: ["127.0.0.1:3000->3000/tcp", "443/tcp"],
            ipAddresses: { frontend: "172.20.0.2" },
            mounts: [
                {
                    type: "volume",
                    source: "/var/lib/docker/volumes/app_data/_data",
                    destination: "/data",
                    mode: "rw",
                    readOnly: false,
                    name: "app_data",
                },
            ],
            stats: {
                cpu: "1.23%",
                memory: "128MiB / 1GiB",
                memoryPercent: "4.56%",
                netIO: "3MB / 4MB",
                blockIO: "1MB / 2MB",
                pids: "12",
            },
        });
    });

    it("returns container details and combined logs", async () => {
        const details = await requestJson<{
            id: string;
            env: string[];
            labels: Record<string, string>;
            networks: Array<{ name: string; ipAddress: string }>;
        }>(server, "/api/docker/containers/abc123");
        assert.equal(details.status, 200);
        assert.deepEqual(details.body.env, [
            "NODE_ENV=production",
            "SECRET_TOKEN=hidden",
        ]);
        assert.deepEqual(details.body.labels, {
            "com.docker.compose.service": "web",
            "com.docker.compose.project": "mira",
        });
        assert.deepEqual(details.body.networks, [
            {
                name: "frontend",
                ipAddress: "172.20.0.2",
                gateway: "172.20.0.1",
                macAddress: "02:42:ac:14:00:02",
            },
        ]);

        const logs = await requestJson<{ content: string }>(
            server,
            "/api/docker/containers/abc123/logs?tail=10"
        );
        assert.equal(logs.status, 200);
        assert.equal(logs.body.content, "stdout log\n\nstderr log");
    });

    it("returns images and volumes with usage information", async () => {
        const images = await requestJson<{
            images: Array<{ id: string; size: number; inUseBy: string[] }>;
        }>(server, "/api/docker/images");
        assert.equal(images.status, 200);
        assert.deepEqual(images.body.images, [
            {
                id: "sha256:image123",
                repository: "repo/app",
                tag: "1.0.0",
                containerName: "",
                platform: "linux/arm64",
                size: 10 * 1024 * 1024,
                createdAt: "2026-05-10",
                lastTagTime: "2026-05-10",
                inUseBy: ["app"],
            },
        ]);

        const volumes = await requestJson<{
            volumes: Array<{
                name: string;
                labels: Record<string, string>;
                usedBy: string[];
            }>;
        }>(server, "/api/docker/volumes");
        assert.equal(volumes.status, 200);
        assert.deepEqual(volumes.body.volumes, [
            {
                name: "app_data",
                driver: "local",
                mountpoint: "/var/lib/docker/volumes/app_data/_data",
                scope: "local",
                size: "42MB",
                labels: { owner: "mira", empty: "" },
                usedBy: ["app"],
            },
        ]);
    });

    it("validates prune targets before shelling out", async () => {
        const response = await requestJson<{ error: string }>(
            server,
            "/api/docker/prune",
            {
                method: "POST",
                body: { target: "containers" },
            }
        );

        assert.equal(response.status, 400);
        assert.equal(response.body.error, "Invalid prune target");
    });
});
