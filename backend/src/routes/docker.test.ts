import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import express from "express";

import { db } from "../db.js";
import { upsertScheduledJob } from "../services/scheduledJobs.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalPath = process.env.PATH;
const originalDockerRoot = process.env.MIRA_DOCKER_ROOT;
const originalDockerBin = process.env.MIRA_DOCKER_BIN;
const fakeEnvKeys = [
    "MIRA_DOCKER_COMPOSE_WRAPPER",
    "MIRA_FAKE_DOCKER_EMPTY",
    "MIRA_FAKE_DOCKER_SPARSE",
    "MIRA_FAKE_DOCKER_NON_ARRAY_INSPECT",
    "MIRA_FAKE_DOCKER_NUMERIC_IMAGE_SIZE",
    "MIRA_FAKE_DOCKER_RM_FAIL",
    "MIRA_FAKE_DOCKER_ACTION_FAIL",
    "MIRA_FAKE_DOCKER_MOUNT_SOURCE_MATCH",
    "MIRA_FAKE_DOCKER_PARTIAL_EXEC_STDOUT",
    "MIRA_FAKE_DOCKER_LONG_PARTIAL_EXEC_STDOUT",
    "MIRA_FAKE_DOCKER_LONG_MARKER_PREFIX_STDOUT",
    "MIRA_FAKE_DOCKER_MARKER_WITHOUT_NEWLINE",
    "MIRA_FAKE_DOCKER_EXEC_SIGNAL",
    "MIRA_FAKE_DOCKER_STOP_IN_CONTAINER_FAIL",
    "MIRA_FAKE_DOCKER_SPLIT_EXEC_MARKER",
    "MIRA_FAKE_DOCKER_COALESCED_EXEC_MARKER",
    "MIRA_FAKE_DOCKER_DUPLICATE_EXEC_MARKER",
    "MIRA_FAKE_DOCKER_NO_SETSID",
] as const;
const originalFakeEnv = new Map(
    fakeEnvKeys.map((key) => [key, process.env[key]] as const)
);

function createMockChildProcess(
    overrides: Pick<ChildProcess, "killed" | "kill"> & Partial<ChildProcess>
): ChildProcess {
    const child = {
        exitCode: null,
        signalCode: null,
        ...overrides,
    } as ChildProcess;
    child.off = () => child;
    child.once = () => child;
    return child;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            clearTimeout(overallTimeout);
            child.off("exit", done);
            resolve();
        };
        const timeout = setTimeout(() => {
            try {
                if (!child.kill("SIGKILL")) {
                    done();
                }
            } catch {
                done();
            }
        }, 100);
        const overallTimeout = setTimeout(done, 3000);
        child.once("exit", done);
        try {
            if (!child.kill("SIGTERM")) {
                done();
            }
        } catch {
            done();
        }
    });
}

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
    Env: [
        "NODE_ENV=production",
        "SECRET_TOKEN=hidden",
        "api-key=visible-no-more",
        "ACCESS-TOKEN=also-hidden",
        "NO_EQUALS_TOKEN",
        "PLAIN_FLAG",
    ],
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
if (process.env.MIRA_FAKE_DOCKER_MOUNT_SOURCE_MATCH === "1") {
  inspect[0].Mounts = [
    { Type: "volume", Source: "/var/lib/docker/volumes/app_data/_data", Destination: "/data", Mode: "rw", RW: true },
    { Type: "volume", Source: "/var/lib/docker/volumes/other_data/_data", Destination: "/other", Mode: "rw", RW: true }
  ];
}
if (process.env.MIRA_FAKE_DOCKER_SPARSE === "1") {
  if (command === "ps -a --format {{json .}}") {
    process.stdout.write(JSON.stringify({ ID: "sparse123456", Names: "sparse", Image: "repo/sparse:latest", Command: "sh", CreatedAt: "now", RunningFor: "", State: "exited", Status: "Exited", Ports: "", Labels: "", Mounts: "" }) + "\n");
    process.exit(0);
  }
  if (command === "stats --no-stream --format {{json .}}") {
    process.stdout.write("");
    process.exit(0);
  }
  if (args[0] === "inspect") {
    process.stdout.write(JSON.stringify([{}]));
    process.exit(0);
  }
  if (command === "image ls --format {{json .}} --no-trunc") {
    process.stdout.write(JSON.stringify({ ID: "sha256:sparse", Repository: "repo/sparse", Tag: "latest", Size: "not-a-size", CreatedAt: "" }) + "\n");
    process.exit(0);
  }
  if (command === "volume ls --format {{json .}}") {
    process.stdout.write(JSON.stringify({ Driver: "local", Labels: "", Links: "0", Mountpoint: "/volumes/sparse", Name: "sparse_data", Scope: "local", Size: "" }) + "\n");
    process.exit(0);
  }
}
if (process.env.MIRA_FAKE_DOCKER_NON_ARRAY_INSPECT === "1" && args[0] === "inspect") {
  process.stdout.write(JSON.stringify({ Id: "not-array" }));
  process.exit(0);
}
if (process.env.MIRA_FAKE_DOCKER_NUMERIC_IMAGE_SIZE === "1" && command === "image ls --format {{json .}} --no-trunc") {
  process.stdout.write(JSON.stringify({ ID: "sha256:numeric", Repository: "repo/numeric", Tag: "latest", Platform: "", Size: 1234, CreatedSince: "recent" }) + "\n");
  process.exit(0);
}
if (process.env.MIRA_FAKE_DOCKER_RM_FAIL === "1" && args[0] === "exec" && args[1] === "postgres" && args[2] === "rm") {
  process.stderr.write("rm failed\n");
  process.exit(1);
}
if (process.env.MIRA_FAKE_DOCKER_EMPTY === "1") {
  if (command === "ps -a --format {{json .}}" || command === "stats --no-stream --format {{json .}}" || command === "image ls --format {{json .}} --no-trunc" || command === "volume ls --format {{json .}}") {
    process.stdout.write("");
    process.exit(0);
  }
  if (args[0] === "inspect") {
    process.stdout.write("[]");
    process.exit(0);
  }
}
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
  if (process.env.MIRA_FAKE_DOCKER_MOUNT_SOURCE_MATCH === "1") {
    process.stdout.write(JSON.stringify({ Driver: "local", Labels: "", Links: "1", Mountpoint: "/var/lib/docker/volumes/app_data/_data", Name: "app_data", Scope: "local", Size: "42MB" }) + "\n");
    process.stdout.write(JSON.stringify({ Driver: "local", Labels: "", Links: "1", Mountpoint: "/unused", Name: "other_data", Scope: "local", Size: "1MB" }) + "\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ Driver: "local", Labels: "owner=mira,empty", Links: "1", Mountpoint: "/var/lib/docker/volumes/app_data/_data", Name: "app_data", Scope: "local", Size: "42MB" }) + "\n");
  process.exit(0);
}
if (args[0] === "logs") {
  if (args[2]?.includes(".")) {
    process.stderr.write("invalid tail\n");
    process.exit(125);
  }
  process.stdout.write("stdout log\n");
  process.stderr.write("stderr log\n");
  process.exit(0);
}
if (process.env.MIRA_FAKE_DOCKER_ACTION_FAIL === "1" && ["start", "stop", "restart"].includes(args[0])) {
  process.stderr.write("docker action unavailable\n");
  process.exit(12);
}
if (["start", "stop", "restart"].includes(args[0])) {
  process.stdout.write(args[0] + " ok\n");
  process.exit(0);
}
if (command === "image rm sha256:image123") {
  process.stdout.write("deleted image\n");
  process.exit(0);
}
if (command === "volume rm app_data") {
  process.stdout.write("deleted volume\n");
  process.exit(0);
}
if (command === "image prune -a -f") {
  process.stdout.write("deleted unused images\n");
  process.exit(0);
}
if (command === "volume prune -f") {
  process.stdout.write("deleted unused volumes\n");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "app" && args[2] === "sh" && command.includes("__MIRA_DOCKER_EXEC_PID__=")) {
  if (command.includes("&;")) {
    process.stderr.write("invalid shell separator\n");
    process.exit(22);
  }
  if (process.env.MIRA_FAKE_DOCKER_NO_SETSID === "1" && !command.includes("else sh -lc")) {
    process.stderr.write("missing no-setsid fallback\n");
    process.exit(23);
  }
  if (process.env.MIRA_FAKE_DOCKER_SPLIT_EXEC_MARKER === "1") {
    process.stdout.write("__MIRA_DOCKER_");
    setTimeout(() => {
      process.stdout.write("EXEC_PID__=4321\nexec stdout\n");
      process.stderr.write("exec stderr\n");
    }, 10);
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (process.env.MIRA_FAKE_DOCKER_COALESCED_EXEC_MARKER === "1") {
    process.stdout.write("x__MIRA_DOCKER_EXEC_PID__=4321\nexec stdout\n");
    process.exit(0);
  }
  if (process.env.MIRA_FAKE_DOCKER_DUPLICATE_EXEC_MARKER === "1") {
    process.stdout.write("__MIRA_DOCKER_EXEC_PID__=4321\n__MIRA_DOCKER_EXEC_PID__=9876\nexec stdout\n");
    process.exit(0);
  }
  if (process.env.MIRA_FAKE_DOCKER_EXEC_SIGNAL === "1") {
    process.kill(process.pid, "SIGTERM");
    return;
  }
  process.stdout.write("__MIRA_DOCKER_EXEC_PID__=4321\n");
}
if (process.env.MIRA_FAKE_DOCKER_PARTIAL_EXEC_STDOUT === "1" && args[0] === "exec" && args[1] === "app" && args[2] === "sh") {
  process.stdout.write("partial stdout");
  process.exit(0);
}
if (process.env.MIRA_FAKE_DOCKER_LONG_PARTIAL_EXEC_STDOUT === "1" && args[0] === "exec" && args[1] === "app" && args[2] === "sh") {
  process.stdout.write("x".repeat(20000));
  process.exit(0);
}
if (process.env.MIRA_FAKE_DOCKER_LONG_MARKER_PREFIX_STDOUT === "1" && args[0] === "exec" && args[1] === "app" && args[2] === "sh") {
  process.stdout.write("__MIRA_DOCKER_EXEC_PID__=" + "x".repeat(20000));
  process.exit(0);
}
if (process.env.MIRA_FAKE_DOCKER_MARKER_WITHOUT_NEWLINE === "1" && args[0] === "exec" && args[1] === "app" && args[2] === "sh") {
  process.stdout.write("__MIRA_DOCKER_EXEC_PID__=4321");
  process.exit(0);
}
if (process.env.MIRA_FAKE_DOCKER_STOP_IN_CONTAINER_FAIL === "1" && args[0] === "exec" && args[1] === "app" && args[2] === "sh" && command.includes("kill -TERM")) {
  process.stderr.write("container stop failed\n");
  process.exit(12);
}
if (args[0] === "exec" && args[1] === "app" && args[2] === "sh" && command.includes("sleep")) {
  process.stdout.write("started long exec\n");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
  return;
}
else if (args[0] === "exec" && args[1] === "app" && args[2] === "sh") {
  process.stdout.write("exec stdout\n");
  process.stderr.write("exec stderr\n");
  process.exit(0);
}
process.stderr.write("unexpected docker args: " + command);
process.exit(1);
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    const composePath = path.join(binDir, "docker-compose-doppler");
    await writeFile(
        composePath,
        String.raw`#!${process.execPath}
process.stdout.write("compose " + process.argv.slice(2).join(" ") + "\n");
`,
        "utf8"
    );
    await chmod(composePath, 0o755);
    process.env.MIRA_DOCKER_BIN = dockerPath;
    process.env.MIRA_DOCKER_COMPOSE_WRAPPER = composePath;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

function resetDockerUpdaterFixtures(): void {
    db.exec(
        "DELETE FROM docker_update_events; DELETE FROM docker_managed_services; DELETE FROM notifications WHERE source = 'docker-updater';"
    );
    const insertService = db.prepare(
        `INSERT INTO docker_managed_services (
            id, app_slug, service_name, compose_path, image_repo, compose_image_ref,
            current_tag, current_digest, latest_tag, latest_digest, policy, pin_mode,
            enabled, last_checked_at, last_status, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertService.run(
        1,
        "media",
        "app",
        "/opt/docker/apps/media/compose.yaml",
        "repo/app",
        "repo/app:1.0.0",
        "1.0.0",
        "sha256:old",
        "1.0.1",
        "sha256:new",
        "auto",
        "digest",
        1,
        "2026-05-11",
        "update_available",
        JSON.stringify({ owner: "mira" })
    );
    insertService.run(
        2,
        "media",
        "disabled",
        "/opt/docker/apps/media/compose.yaml",
        "repo/disabled",
        "repo/disabled:1",
        "1",
        null,
        "2",
        null,
        "notify",
        "tag",
        0,
        null,
        null,
        "{}"
    );
    insertService.run(
        3,
        "media",
        "current",
        "/opt/docker/apps/media/compose.yaml",
        "repo/current",
        "repo/current:1",
        "1",
        null,
        "1",
        null,
        "notify",
        "tag",
        1,
        null,
        null,
        "not-json"
    );
    db.prepare(
        `INSERT INTO docker_update_events (
            id, managed_service_id, app_slug, service_name, event_type, from_tag,
            to_tag, from_digest, to_digest, message, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        7,
        1,
        "media",
        "app",
        "updated",
        "1.0.0",
        "1.0.1",
        "sha256:old",
        "sha256:new",
        "Updated",
        "{}",
        "2026-05-11 12:00:00"
    );
    db.prepare(
        `INSERT INTO docker_update_events (
            id, managed_service_id, app_slug, service_name, event_type, from_tag,
            to_tag, from_digest, to_digest, message, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        8,
        null,
        "",
        "",
        "registration_failed",
        null,
        null,
        null,
        null,
        "Registration failed",
        "{}",
        "2026-05-11 11:00:00"
    );
}

async function startServer(): Promise<TestServer> {
    const { default: dockerRoutes, __testing } = await import("./docker.js");
    __testing.setDockerExecPidWaitTimeoutForTests(100);
    const app = express();
    dockerRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            server.off("error", onError);
            server.off("listening", onListening);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0);
    });
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
    options: { method?: string; body?: unknown; rawBody?: string } = {}
): Promise<{ status: number; body: T }> {
    const hasBody = options.body !== undefined;
    const hasRawBody = options.rawBody !== undefined;
    const requestBody = hasRawBody
        ? options.rawBody
        : hasBody
          ? JSON.stringify(options.body)
          : undefined;
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            hasBody || hasRawBody ? { "Content-Type": "application/json" } : undefined,
        body: requestBody,
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

async function withEnvValue<T>(
    key: string,
    value: string | undefined,
    callback: () => Promise<T>
): Promise<T> {
    const previous = process.env[key];
    try {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
        return await callback();
    } finally {
        if (previous === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = previous;
        }
    }
}

describe("docker routes", { concurrency: false }, () => {
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-docker-routes-"));
        await installFakeDocker(tempDir);
        process.env.MIRA_DOCKER_ROOT = tempDir;
        resetDockerUpdaterFixtures();
        server = await startServer();
    });

    after(async () => {
        await server?.close();
        const { __testing } = await import("./docker.js");
        await Promise.all(
            __testing.dockerExecJobs
                .values()
                .map((job) => job.process)
                .filter(Boolean)
                .map((child) => child as ChildProcess)
                .map((child) => stopChildProcess(child))
        );
        __testing.dockerExecJobs.clear();
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        for (const key of fakeEnvKeys) {
            const originalValue = originalFakeEnv.get(key);
            if (originalValue === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = originalValue;
            }
        }
        if (originalDockerRoot === undefined) {
            delete process.env.MIRA_DOCKER_ROOT;
        } else {
            process.env.MIRA_DOCKER_ROOT = originalDockerRoot;
        }
        if (originalDockerBin === undefined) {
            delete process.env.MIRA_DOCKER_BIN;
        } else {
            process.env.MIRA_DOCKER_BIN = originalDockerBin;
        }
        __testing.setDockerBinForTests(originalDockerBin);
        __testing.setRunDockerUpdaterServiceForTests(undefined);
        __testing.setDockerExecPidWaitTimeoutForTests();
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("covers docker parser helper edge cases", async () => {
        const { __testing } = await import(`./docker.js?helpers=${randomUUID()}`);

        assert.deepEqual(__testing.parseJsonLines(' {"a":1}\n\n'), [{ a: 1 }]);
        assert.equal(__testing.parseJsonField(), null);
        assert.equal(__testing.parseJsonField("not-json"), null);
        assert.deepEqual(__testing.parseJsonField('{"ok":true}'), { ok: true });
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "digest",
                current_digest: "sha256:a",
                latest_digest: "sha256:b",
            } as never),
            true
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "digest",
                current_digest: "sha256:a",
                latest_digest: "sha256:a",
            } as never),
            false
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "1.0.0",
                latest_tag: "1.0.1",
            } as never),
            true
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "1.0.0",
                latest_tag: "1.0.0",
            } as never),
            false
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "1.0.0",
                latest_tag: "1.0.0",
                latest_digest: "sha256:new",
            } as never),
            true
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "1.0.0",
                latest_tag: "1.0.0",
                current_digest: "sha256:old",
                latest_digest: "sha256:new",
            } as never),
            true
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "",
                latest_tag: "1.0.1",
            } as never),
            false
        );
        assert.deepEqual(__testing.parseLabels(), {});
        assert.deepEqual(__testing.parseLabels("plain, key=value ,empty="), {
            plain: "",
            key: "value",
            empty: "",
        });
        assert.deepEqual(__testing.parsePorts(), []);
        assert.deepEqual(__testing.parsePorts(" 80/tcp, ,443/tcp "), [
            "80/tcp",
            "443/tcp",
        ]);
        assert.equal(__testing.parseDockerSizeToBytes(), 0);
        assert.equal(__testing.parseDockerSizeToBytes("bad"), 0);
        assert.equal(__testing.parseDockerSizeToBytes("7 B"), 7);
        assert.equal(__testing.parseDockerSizeToBytes("2KB"), 2048);
        assert.equal(__testing.parseDockerSizeToBytes("3GB"), 3 * 1024 ** 3);
        assert.equal(__testing.parseDockerSizeToBytes("4TB"), 4 * 1024 ** 4);
        assert.equal(__testing.parseDockerSizeToBytes("5PB"), 5 * 1024 ** 5);
        assert.equal(__testing.parseDockerSizeToBytes("1.5 MB"), 1_572_864);
        assert.equal(__testing.parseDockerSizeToBytes("1XB"), 0);
        assert.equal(__testing.trimOutput("x".repeat(120_000)).length, 100_000);
        assert.equal(__testing.resolveManualUpdateServiceId("12", { serviceId: 3 }), 12);
        assert.equal(__testing.resolveManualUpdateServiceId("", { serviceId: 3 }), 3);
        assert.equal(__testing.resolveManualUpdateServiceId("0", { serviceId: 3 }), null);
        assert.equal(
            __testing.resolveManualUpdateServiceId("bad", { serviceId: 3 }),
            null
        );
        assert.equal(__testing.resolveManualUpdateServiceId("", {}), null);
        assert.deepEqual(await __testing.getContainerInspectMap([]), new Map());

        let nextCalled = false;
        const handler = __testing.asyncRoute(async () => {
            throw new Error("after headers");
        });
        await handler(
            {} as never,
            { headersSent: true } as never,
            (() => {
                nextCalled = true;
            }) as never
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(nextCalled, true);
    });

    it("loads docker route module with configured docker environment", async () => {
        const originalEnv = {
            MIRA_DOCKER_ROOT: process.env.MIRA_DOCKER_ROOT,
            MIRA_DOCKER_BIN: process.env.MIRA_DOCKER_BIN,
            MIRA_DOCKER_COMPOSE_WRAPPER: process.env.MIRA_DOCKER_COMPOSE_WRAPPER,
            MIRA_UPDATER_NODE_BIN: process.env.MIRA_UPDATER_NODE_BIN,
            MIRA_UPDATER_CWD: process.env.MIRA_UPDATER_CWD,
        };
        process.env.MIRA_DOCKER_ROOT = "/tmp/custom-docker-root";
        process.env.MIRA_DOCKER_BIN = "/tmp/custom-docker";
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER = "/tmp/custom-compose-wrapper";
        process.env.MIRA_UPDATER_NODE_BIN = "/tmp/custom-node";
        process.env.MIRA_UPDATER_CWD = "/tmp/custom-updater";

        try {
            const module = await import(`./docker.js?env=${randomUUID()}`);
            assert.equal(typeof module.default, "function");
            process.env.MIRA_DOCKER_ROOT = "";
            process.env.MIRA_DOCKER_BIN = "";
            process.env.MIRA_DOCKER_COMPOSE_WRAPPER = "";
            process.env.MIRA_UPDATER_NODE_BIN = "";
            process.env.MIRA_UPDATER_CWD = "";
            const defaultModule = await import(`./docker.js?blank=${randomUUID()}`);
            assert.equal(typeof defaultModule.default, "function");
        } finally {
            for (const [key, value] of Object.entries(originalEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    it("covers docker exec job cleanup and process edge cases", async () => {
        const { __testing } = await import("./docker.js");

        __testing.dockerExecJobs.clear();
        try {
            let cleanupKilled = false;
            for (let index = 0; index < 102; index += 1) {
                __testing.dockerExecJobs.set(`job-${index}`, {
                    id: `job-${index}`,
                    containerId: "app",
                    status: "done",
                    code: 0,
                    stdout: "",
                    stderr: "",
                    startedAt: index,
                    endedAt: Date.now(),
                    process:
                        index === 0
                            ? createMockChildProcess({
                                  killed: true,
                                  kill(signal?: NodeJS.Signals | number) {
                                      assert.equal(signal, "SIGTERM");
                                      cleanupKilled = true;
                                      return true;
                                  },
                              })
                            : undefined,
                });
            }
            __testing.dockerExecJobs.set("active-oldest", {
                id: "active-oldest",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: -1,
                endedAt: null,
                process: createMockChildProcess({
                    killed: false,
                    kill() {
                        cleanupKilled = true;
                        return true;
                    },
                }),
            });

            __testing.cleanupDockerExecJobs();
            assert.equal(__testing.dockerExecJobs.size, 100);
            assert.equal(__testing.dockerExecJobs.has("job-0"), false);
            assert.equal(__testing.dockerExecJobs.has("job-1"), false);
            assert.equal(__testing.dockerExecJobs.has("active-oldest"), true);
            assert.equal(cleanupKilled, false);

            __testing.dockerExecJobs.set("no-process", {
                id: "no-process",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
            });
            const unavailable = await requestJson<{ error: string }>(
                server,
                "/api/docker/exec/no-process/stop",
                { method: "POST", body: {} }
            );
            assert.equal(unavailable.status, 400);
            assert.equal(unavailable.body.error, "Process not available");

            let alreadyExitedKilled = false;
            __testing.dockerExecJobs.set("already-exited", {
                id: "already-exited",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
                inContainerPid: null as number | null,
                process: createMockChildProcess({
                    pid: 9_999_999,
                    killed: false,
                    kill(signal?: NodeJS.Signals | number) {
                        assert.equal(signal, "SIGTERM");
                        alreadyExitedKilled = true;
                        return true;
                    },
                }),
            });
            const alreadyExited = await requestJson<{ error: string }>(
                server,
                "/api/docker/exec/already-exited/stop",
                { method: "POST", body: {} }
            );
            assert.equal(alreadyExited.status, 500);
            assert.match(alreadyExited.body.error, /Timed out waiting/u);
            assert.equal(alreadyExitedKilled, true);

            let fallbackKilled = false;
            const processKill = mock.method(process, "kill", () => {
                throw Object.assign(new Error("operation not permitted"), {
                    code: "EPERM",
                });
            });
            __testing.dockerExecJobs.set("fallback-kill", {
                id: "fallback-kill",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
                inContainerPid: 4321,
                process: createMockChildProcess({
                    pid: 123,
                    killed: false,
                    kill(signal?: NodeJS.Signals | number) {
                        assert.equal(signal, "SIGTERM");
                        fallbackKilled = true;
                        return true;
                    },
                }),
            });
            try {
                const fallback = await requestJson<{ success: boolean }>(
                    server,
                    "/api/docker/exec/fallback-kill/stop",
                    { method: "POST", body: {} }
                );
                assert.equal(fallback.status, 200);
                assert.equal(fallback.body.success, true);
                assert.equal(fallbackKilled, true);
            } finally {
                processKill.mock.restore();
            }

            let hostCleanupAfterContainerFailure = false;
            __testing.dockerExecJobs.set("container-stop-fails", {
                id: "container-stop-fails",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
                inContainerPid: 4321,
                process: createMockChildProcess({
                    pid: 125,
                    killed: false,
                    kill(signal?: NodeJS.Signals | number) {
                        assert.equal(signal, "SIGTERM");
                        hostCleanupAfterContainerFailure = true;
                        return true;
                    },
                }),
            });
            await withEnvValue(
                "MIRA_FAKE_DOCKER_STOP_IN_CONTAINER_FAIL",
                "1",
                async () => {
                    const processKillForContainerFailure = mock.method(
                        process,
                        "kill",
                        () => {
                            throw Object.assign(new Error("operation not permitted"), {
                                code: "EPERM",
                            });
                        }
                    );
                    try {
                        const failedContainerStop = await requestJson<{ error: string }>(
                            server,
                            "/api/docker/exec/container-stop-fails/stop",
                            { method: "POST", body: {} }
                        );
                        assert.equal(failedContainerStop.status, 500);
                        assert.match(
                            failedContainerStop.body.error,
                            /container stop failed/u
                        );
                        assert.equal(hostCleanupAfterContainerFailure, true);
                    } finally {
                        processKillForContainerFailure.mock.restore();
                    }
                }
            );

            const failingFallbackProcessKill = mock.method(process, "kill", () => {
                throw Object.assign(new Error("operation not permitted"), {
                    code: "EPERM",
                });
            });
            __testing.dockerExecJobs.set("failing-fallback-kill", {
                id: "failing-fallback-kill",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
                inContainerPid: null as number | null,
                process: createMockChildProcess({
                    pid: 124,
                    killed: false,
                    kill() {
                        throw Object.assign(new Error("fallback kill failed"), {
                            code: "EPERM",
                        });
                    },
                }),
            });
            try {
                const failingFallback = await fetch(
                    `${server.baseUrl}/api/docker/exec/failing-fallback-kill/stop`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({}),
                    }
                );
                assert.equal(failingFallback.status, 500);
                assert.match(await failingFallback.text(), /fallback kill failed/);
            } finally {
                failingFallbackProcessKill.mock.restore();
            }

            let missingPidKilled = false;
            __testing.dockerExecJobs.set("missing-pid", {
                id: "missing-pid",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
                process: createMockChildProcess({
                    killed: false,
                    kill(signal?: NodeJS.Signals | number) {
                        assert.equal(signal, "SIGTERM");
                        missingPidKilled = true;
                        return true;
                    },
                }),
            });
            const missingPid = await requestJson<{ success: boolean }>(
                server,
                "/api/docker/exec/missing-pid/stop",
                { method: "POST", body: {} }
            );
            assert.equal(missingPid.status, 500);
            assert.equal(missingPidKilled, true);

            let delayedPidKilled = false;
            const delayedPidJob = {
                id: "delayed-pid",
                containerId: "app",
                status: "running" as const,
                code: null,
                stdout: "",
                stderr: "",
                inContainerPid: null as number | null,
                startedAt: Date.now(),
                endedAt: null,
                process: createMockChildProcess({
                    killed: false,
                    kill(signal?: NodeJS.Signals | number) {
                        assert.equal(signal, "SIGTERM");
                        delayedPidKilled = true;
                        return true;
                    },
                }),
            };
            __testing.dockerExecJobs.set("delayed-pid", delayedPidJob);
            setTimeout(() => {
                delayedPidJob.inContainerPid = 4321;
            }, 20);
            const delayedPid = await requestJson<{ success: boolean }>(
                server,
                "/api/docker/exec/delayed-pid/stop",
                { method: "POST", body: {} }
            );
            assert.equal(delayedPid.status, 200);
            assert.equal(delayedPidKilled, true);

            let pidOneKilled = false;
            __testing.dockerExecJobs.set("pid-one", {
                id: "pid-one",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                inContainerPid: 4321,
                startedAt: Date.now(),
                endedAt: null,
                process: createMockChildProcess({
                    pid: 1,
                    killed: false,
                    kill(signal?: NodeJS.Signals | number) {
                        assert.equal(signal, "SIGTERM");
                        pidOneKilled = true;
                        return true;
                    },
                }),
            });
            const pidOne = await requestJson<{ success: boolean }>(
                server,
                "/api/docker/exec/pid-one/stop",
                { method: "POST", body: {} }
            );
            assert.equal(pidOne.status, 200);
            assert.equal(pidOneKilled, true);

            __testing.updateDockerExecJobOutput("missing-output", "stdout", "stderr");
            __testing.completeDockerExecJob("missing-complete", {
                code: 0,
                stdout: "stdout",
                stderr: "stderr",
            });
            __testing.failDockerExecJob("missing-fail", new Error("failed"));

            __testing.dockerExecJobs.set("state-helper", {
                id: "state-helper",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
            });
            __testing.updateDockerExecJobOutput("state-helper", "partial", "warning");
            assert.equal(__testing.dockerExecJobs.get("state-helper")?.stdout, "partial");
            __testing.completeDockerExecJob("state-helper", {
                code: 0,
                stdout: "done",
                stderr: "",
            });
            assert.equal(__testing.dockerExecJobs.get("state-helper")?.status, "done");
            assert.equal(__testing.dockerExecJobs.get("state-helper")?.stdout, "done");

            __testing.dockerExecJobs.set("state-fail", {
                id: "state-fail",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "before",
                startedAt: Date.now(),
                endedAt: null,
            });
            __testing.failDockerExecJob("state-fail", new Error("after"));
            assert.equal(__testing.dockerExecJobs.get("state-fail")?.code, 1);
            assert.match(
                __testing.dockerExecJobs.get("state-fail")?.stderr || "",
                /after/u
            );

            __testing.dockerExecJobs.set("primitive-fail", {
                id: "primitive-fail",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
            });
            __testing.failDockerExecJob("primitive-fail", "plain failure");
            assert.match(
                __testing.dockerExecJobs.get("primitive-fail")?.stderr || "",
                /plain failure/u
            );

            __testing.dockerExecJobs.set("settled-fail", {
                id: "settled-fail",
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
            });
            __testing.setDockerBinForTests("/path/that/does/not/exist");
            try {
                await __testing.settleDockerExecJob("app", "echo hi", "settled-fail");
            } finally {
                __testing.setDockerBinForTests(undefined);
            }
            assert.equal(__testing.dockerExecJobs.get("settled-fail")?.code, 1);
            assert.match(
                __testing.dockerExecJobs.get("settled-fail")?.stderr || "",
                /ENOENT/u
            );

            __testing.dockerExecJobs.clear();
            const directRun = await __testing.runDockerExecCommand(
                "app",
                "echo hi",
                "missing-job"
            );
            assert.equal(directRun.code, 0);
            assert.equal(directRun.stdout, "exec stdout\n");
            await withEnvValue("MIRA_FAKE_DOCKER_NO_SETSID", "1", async () => {
                const noSetsidRun = await __testing.runDockerExecCommand(
                    "app",
                    "echo hi",
                    "missing-job"
                );
                assert.equal(noSetsidRun.code, 0);
                assert.equal(noSetsidRun.stdout, "exec stdout\n");
            });
            await withEnvValue("MIRA_FAKE_DOCKER_SPLIT_EXEC_MARKER", "1", async () => {
                __testing.dockerExecJobs.set("split-marker", {
                    id: "split-marker",
                    containerId: "app",
                    status: "running",
                    code: null,
                    stdout: "",
                    stderr: "",
                    startedAt: Date.now(),
                    endedAt: null,
                });
                const splitRun = await __testing.runDockerExecCommand(
                    "app",
                    "echo hi",
                    "split-marker"
                );
                assert.equal(
                    __testing.dockerExecJobs.get("split-marker")?.inContainerPid,
                    4321
                );
                assert.equal(splitRun.stdout, "exec stdout\n");
            });
            await withEnvValue(
                "MIRA_FAKE_DOCKER_COALESCED_EXEC_MARKER",
                "1",
                async () => {
                    __testing.dockerExecJobs.set("coalesced-marker", {
                        id: "coalesced-marker",
                        containerId: "app",
                        status: "running",
                        code: null,
                        stdout: "",
                        stderr: "",
                        startedAt: Date.now(),
                        endedAt: null,
                    });
                    const coalescedRun = await __testing.runDockerExecCommand(
                        "app",
                        "printf x; sleep 600",
                        "coalesced-marker"
                    );
                    assert.equal(
                        __testing.dockerExecJobs.get("coalesced-marker")?.inContainerPid,
                        4321
                    );
                    assert.equal(coalescedRun.stdout, "xexec stdout\n");
                }
            );
            await withEnvValue(
                "MIRA_FAKE_DOCKER_DUPLICATE_EXEC_MARKER",
                "1",
                async () => {
                    __testing.dockerExecJobs.set("duplicate-marker", {
                        id: "duplicate-marker",
                        containerId: "app",
                        status: "running",
                        code: null,
                        stdout: "",
                        stderr: "",
                        startedAt: Date.now(),
                        endedAt: null,
                    });
                    const duplicateRun = await __testing.runDockerExecCommand(
                        "app",
                        "echo hi",
                        "duplicate-marker"
                    );
                    assert.equal(
                        __testing.dockerExecJobs.get("duplicate-marker")?.inContainerPid,
                        4321
                    );
                    assert.equal(duplicateRun.stdout, "exec stdout\n");
                }
            );
            await withEnvValue("MIRA_FAKE_DOCKER_PARTIAL_EXEC_STDOUT", "1", async () => {
                let updatedStdout = "";
                const partialRun = await __testing.runDockerExecCommand(
                    "app",
                    "echo hi",
                    "missing-job",
                    (stdout) => {
                        updatedStdout = stdout;
                    }
                );
                assert.equal(partialRun.stdout, "partial stdout");
                assert.equal(updatedStdout, "partial stdout");
            });
            await withEnvValue(
                "MIRA_FAKE_DOCKER_LONG_PARTIAL_EXEC_STDOUT",
                "1",
                async () => {
                    const partialRun = await __testing.runDockerExecCommand(
                        "app",
                        "echo hi",
                        "long-partial"
                    );
                    assert.equal(partialRun.stdout.length, 20_000);
                }
            );
            await withEnvValue(
                "MIRA_FAKE_DOCKER_LONG_MARKER_PREFIX_STDOUT",
                "1",
                async () => {
                    const partialRun = await __testing.runDockerExecCommand(
                        "app",
                        "echo hi",
                        "long-marker-prefix"
                    );
                    assert.equal(partialRun.stdout.length, 20_025);
                    assert.equal(
                        partialRun.stdout.startsWith("__MIRA_DOCKER_EXEC_PID__="),
                        true
                    );
                }
            );
            await withEnvValue(
                "MIRA_FAKE_DOCKER_MARKER_WITHOUT_NEWLINE",
                "1",
                async () => {
                    __testing.dockerExecJobs.set("marker-no-newline", {
                        id: "marker-no-newline",
                        containerId: "app",
                        status: "running",
                        stdout: "",
                        stderr: "",
                        code: null,
                        startedAt: Date.now(),
                        endedAt: null,
                    });
                    const markerRun = await __testing.runDockerExecCommand(
                        "app",
                        "echo hi",
                        "marker-no-newline"
                    );
                    assert.equal(markerRun.stdout, "");
                    assert.equal(
                        __testing.dockerExecJobs.get("marker-no-newline")?.inContainerPid,
                        4321
                    );
                    __testing.dockerExecJobs.delete("marker-no-newline");
                }
            );
            await withEnvValue("MIRA_FAKE_DOCKER_EXEC_SIGNAL", "1", async () => {
                const signaledRun = await __testing.runDockerExecCommand(
                    "app",
                    "echo hi",
                    "missing-job"
                );
                assert.equal(signaledRun.code, 130);
            });
        } finally {
            __testing.dockerExecJobs.clear();
        }
    });

    it("covers docker fallback branches for inspect, image sizes, events cleanup, and exec spawn errors", async () => {
        await withEnvValue("MIRA_FAKE_DOCKER_NON_ARRAY_INSPECT", "1", async () => {
            const containers = await requestJson<{
                containers: Array<{ imageId: string; mounts: unknown[] }>;
            }>(server, "/api/docker/containers");
            assert.equal(containers.status, 200);
            assert.equal(containers.body.containers[0]?.imageId, "");

            const details = await requestJson<{ error: string }>(
                server,
                "/api/docker/containers/abc123"
            );
            assert.equal(details.status, 404);
            assert.equal(details.body.error, "Container not found");
        });

        await withEnvValue("MIRA_FAKE_DOCKER_NUMERIC_IMAGE_SIZE", "1", async () => {
            const images = await requestJson<{ images: Array<{ size: number }> }>(
                server,
                "/api/docker/images"
            );
            assert.equal(images.status, 200);
            assert.equal(images.body.images[0]?.size, 1234);
        });

        await withEnvValue("MIRA_FAKE_DOCKER_RM_FAIL", "1", async () => {
            const events = await requestJson<{ events: unknown[] }>(
                server,
                "/api/docker/updater/events"
            );
            assert.equal(events.status, 200);
            assert.equal(events.body.events.length, 2);
        });

        await withEnvValue("MIRA_FAKE_DOCKER_MOUNT_SOURCE_MATCH", "1", async () => {
            const volumes = await requestJson<{ volumes: Array<{ usedBy: string[] }> }>(
                server,
                "/api/docker/volumes"
            );
            assert.equal(volumes.status, 200);
            assert.deepEqual(
                volumes.body.volumes.map((volume) => volume.usedBy),
                [["app"], ["app"]]
            );
        });

        const { __testing } = await import("./docker.js");
        __testing.setDockerBinForTests(path.join(tempDir, "missing-docker"));
        try {
            await assert.rejects(
                () => __testing.runDockerExecCommand("app", "echo hi", "missing-docker"),
                /ENOENT/u
            );
        } finally {
            __testing.setDockerBinForTests(path.join(tempDir, "bin", "docker"));
        }
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

    it("returns sparse docker resources with safe defaults", async () => {
        await withEnvValue("MIRA_FAKE_DOCKER_SPARSE", "1", async () => {
            const containers = await requestJson<{
                containers: Array<{
                    id: string;
                    imageId: string;
                    health: string;
                    restartCount: number;
                    ports: string[];
                    mounts: unknown[];
                    stats: unknown;
                }>;
            }>(server, "/api/docker/containers");

            assert.equal(containers.status, 200);
            assert.deepEqual(containers.body.containers, [
                {
                    id: "sparse123456",
                    name: "sparse",
                    image: "repo/sparse:latest",
                    imageId: "",
                    command: "sh",
                    createdAt: "now",
                    startedAt: null,
                    finishedAt: null,
                    runningFor: "",
                    state: "exited",
                    status: "Exited",
                    health: "unknown",
                    restartCount: 0,
                    service: null,
                    project: null,
                    ports: [],
                    ipAddresses: {},
                    mounts: [],
                    stats: null,
                },
            ]);

            const details = await requestJson<{ error: string }>(
                server,
                "/api/docker/containers/sparse"
            );
            assert.equal(details.status, 404);
            assert.equal(details.body.error, "Container not found");

            const images = await requestJson<{ images: Array<{ size: number }> }>(
                server,
                "/api/docker/images"
            );
            assert.equal(images.status, 200);
            assert.equal(images.body.images[0]?.size, 0);

            const volumes = await requestJson<{
                volumes: Array<{ labels: Record<string, string>; usedBy: string[] }>;
            }>(server, "/api/docker/volumes");
            assert.equal(volumes.status, 200);
            assert.deepEqual(volumes.body.volumes[0]?.labels, {});
            assert.deepEqual(volumes.body.volumes[0]?.usedBy, []);
        });
    });

    it("handles empty docker resource lists", async () => {
        await withEnvValue("MIRA_FAKE_DOCKER_EMPTY", "1", async () => {
            const containers = await requestJson<{ containers: unknown[] }>(
                server,
                "/api/docker/containers"
            );
            assert.equal(containers.status, 200);
            assert.deepEqual(containers.body.containers, []);

            const images = await requestJson<{ images: unknown[] }>(
                server,
                "/api/docker/images"
            );
            assert.equal(images.status, 200);
            assert.deepEqual(images.body.images, []);

            const volumes = await requestJson<{ volumes: unknown[] }>(
                server,
                "/api/docker/volumes"
            );
            assert.equal(volumes.status, 200);
            assert.deepEqual(volumes.body.volumes, []);
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
            "SECRET_TOKEN=***",
            "api-key=***",
            "ACCESS-TOKEN=***",
            "NO_EQUALS_TOKEN=***",
            "PLAIN_FLAG",
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

        const logsWithDefaultTail = await requestJson<{ content: string }>(
            server,
            "/api/docker/containers/abc123/logs?tail=bad"
        );
        assert.equal(logsWithDefaultTail.status, 200);
        assert.equal(logsWithDefaultTail.body.content, "stdout log\n\nstderr log");

        const logsWithFractionalTail = await requestJson<{ content: string }>(
            server,
            "/api/docker/containers/abc123/logs?tail=10.9"
        );
        assert.equal(logsWithFractionalTail.status, 200);
        assert.equal(logsWithFractionalTail.body.content, "stdout log\n\nstderr log");

        const invalidDetails = await requestJson<{ error: string }>(
            server,
            "/api/docker/containers/-bad"
        );
        assert.equal(invalidDetails.status, 400);
        assert.equal(invalidDetails.body.error, "Invalid containerId");

        const invalidLogs = await requestJson<{ error: string }>(
            server,
            "/api/docker/containers/-bad/logs"
        );
        assert.equal(invalidLogs.status, 400);
        assert.equal(invalidLogs.body.error, "Invalid containerId");

        const missing = await requestJson<{ error: string }>(
            server,
            "/api/docker/containers/missing"
        );
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, "Container not found");
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

    it("runs container, stack, image, volume, and prune actions", async () => {
        const action = await requestJson<{ output: string }>(
            server,
            "/api/docker/containers/abc123/action",
            { method: "POST", body: { action: "restart" } }
        );
        assert.equal(action.status, 200);
        assert.equal(action.body.output, "restart sent to app");

        const stack = await requestJson<{ output: string }>(
            server,
            "/api/docker/stack/action",
            { method: "POST", body: { action: "restart", service: "app" } }
        );
        assert.equal(stack.status, 200);
        assert.equal(stack.body.output, "compose restart app");

        const deleteImage = await requestJson<{ success: boolean }>(
            server,
            "/api/docker/images/sha256:image123",
            { method: "DELETE" }
        );
        assert.equal(deleteImage.status, 200);
        assert.equal(deleteImage.body.success, true);

        const deleteVolume = await requestJson<{ success: boolean }>(
            server,
            "/api/docker/volumes/app_data",
            { method: "DELETE" }
        );
        assert.equal(deleteVolume.status, 200);
        assert.equal(deleteVolume.body.success, true);

        const invalidAction = await requestJson<{ error: string }>(
            server,
            "/api/docker/containers/-bad/action",
            { method: "POST", body: { action: "restart" } }
        );
        assert.equal(invalidAction.status, 400);
        assert.equal(invalidAction.body.error, "Invalid containerId");

        const invalidContainerAction = await requestJson<{ error: string }>(
            server,
            "/api/docker/containers/abc123/action",
            { method: "POST", body: { action: "rm" } }
        );
        assert.equal(invalidContainerAction.status, 400);
        assert.equal(invalidContainerAction.body.error, "Invalid container action");

        const nullContainerAction = await requestJson<{ error: string }>(
            server,
            "/api/docker/containers/abc123/action",
            { method: "POST", rawBody: JSON.stringify(null) }
        );
        assert.equal(nullContainerAction.status, 400);
        assert.equal(nullContainerAction.body.error, "Invalid container action");

        const invalidImage = await requestJson<{ error: string }>(
            server,
            "/api/docker/images/-bad",
            { method: "DELETE" }
        );
        assert.equal(invalidImage.status, 400);
        assert.equal(invalidImage.body.error, "Invalid imageId");

        const invalidVolume = await requestJson<{ error: string }>(
            server,
            "/api/docker/volumes/-bad",
            { method: "DELETE" }
        );
        assert.equal(invalidVolume.status, 400);
        assert.equal(invalidVolume.body.error, "Invalid volumeName");

        const pruneImages = await requestJson<{ success: boolean; output: string }>(
            server,
            "/api/docker/prune",
            { method: "POST", body: { target: "images" } }
        );
        assert.equal(pruneImages.status, 200);
        assert.equal(pruneImages.body.output, "deleted unused images\n");

        const pruneVolumes = await requestJson<{ success: boolean; output: string }>(
            server,
            "/api/docker/prune",
            { method: "POST", body: { target: "volumes" } }
        );
        assert.equal(pruneVolumes.status, 200);
        assert.equal(pruneVolumes.body.output, "deleted unused volumes\n");

        const missingContainer = await requestJson<{ error: string }>(
            server,
            "/api/docker/containers/missing/action",
            { method: "POST", body: { action: "restart" } }
        );
        assert.equal(missingContainer.status, 404);
        assert.equal(missingContainer.body.error, "Container not found");

        await withEnvValue("MIRA_FAKE_DOCKER_ACTION_FAIL", "1", async () => {
            const failedAction = await requestJson<{ error: string }>(
                server,
                "/api/docker/containers/abc123/action",
                { method: "POST", body: { action: "restart" } }
            );
            assert.equal(failedAction.status, 500);
            assert.match(failedAction.body.error, /docker action unavailable/u);
        });
    });

    it("returns updater services, events, and validates manual update state", async () => {
        const services = await requestJson<{
            services: Array<{
                id: number;
                serviceName: string;
                enabled: boolean;
                updateAvailable: boolean;
                metadata: Record<string, unknown>;
            }>;
            summary: { total: number; enabled: number; updateAvailable: number };
        }>(server, "/api/docker/updater/services");
        assert.equal(services.status, 200);
        assert.equal(services.body.summary.total, 3);
        assert.equal(services.body.summary.enabled, 2);
        assert.equal(services.body.summary.updateAvailable, 2);
        assert.deepEqual(services.body.services[0]?.metadata, { owner: "mira" });
        assert.deepEqual(services.body.services[2]?.metadata, {});

        const events = await requestJson<{
            events: Array<{ id: number; serviceName: string; toDigest: string }>;
        }>(server, "/api/docker/updater/events?limit=500");
        assert.equal(events.status, 200);
        assert.deepEqual(events.body.events, [
            {
                id: 7,
                managedServiceId: 1,
                appSlug: "media",
                serviceName: "app",
                eventType: "updated",
                fromTag: "1.0.0",
                toTag: "1.0.1",
                fromDigest: "sha256:old",
                toDigest: "sha256:new",
                message: null,
                createdAt: "2026-05-11 12:00:00",
            },
            {
                id: 8,
                managedServiceId: null,
                appSlug: "",
                serviceName: "",
                eventType: "registration_failed",
                fromTag: null,
                toTag: null,
                fromDigest: null,
                toDigest: null,
                message: null,
                createdAt: "2026-05-11 11:00:00",
            },
        ]);

        const invalid = await requestJson<{ error: string }>(
            server,
            "/api/docker/updater/services/nope/update",
            { method: "POST", body: {} }
        );
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, "Invalid service id");

        const partialNumericRoute = await requestJson<{ error: string }>(
            server,
            "/api/docker/updater/services/12oops/update",
            { method: "POST", body: {} }
        );
        assert.equal(partialNumericRoute.status, 400);
        assert.equal(partialNumericRoute.body.error, "Invalid service id");

        const missing = await requestJson<{ error: string }>(
            server,
            "/api/docker/updater/services/999/update",
            { method: "POST", body: {} }
        );
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, "Updater service not found");

        const disabled = await requestJson<{ error: string }>(
            server,
            "/api/docker/updater/services/2/update",
            { method: "POST", body: {} }
        );
        assert.equal(disabled.status, 400);
        assert.equal(disabled.body.error, "Updater service is disabled");

        const { __testing } = await import("./docker.js");
        __testing.setRunDockerUpdaterServiceForTests(async () => [
            {
                step: "manual-update-skipped:media/current",
                ok: false,
                code: "CONFLICT",
                stdout: "",
                stderr: "No update available",
            },
        ]);
        try {
            const noUpdate = await requestJson<{ error: string }>(
                server,
                "/api/docker/updater/services/3/update",
                { method: "POST", body: {} }
            );
            assert.equal(noUpdate.status, 409);
            assert.equal(noUpdate.body.error, "No update available");
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        __testing.setRunDockerUpdaterServiceForTests(async () => [
            {
                step: "poll",
                ok: false,
                code: "UNSUPPORTED_REGISTRY",
                stdout: "",
                stderr: "",
            },
        ]);
        try {
            const unsupported = await requestJson<{ error: string }>(
                server,
                "/api/docker/updater/services/1/update",
                { method: "POST", body: {} }
            );
            assert.equal(unsupported.status, 422);
            assert.equal(unsupported.body.error, "Unsupported image registry");
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        for (const [code, status, error] of [
            ["NOT_FOUND", 404, "Updater service not found"],
            ["DISABLED", 400, "Updater service is disabled"],
            ["CONFLICT", 409, "No update available"],
        ] as const) {
            __testing.setRunDockerUpdaterServiceForTests(async () => [
                {
                    step: "manual-update:media/app",
                    ok: false,
                    code,
                    stdout: "",
                    stderr: "",
                },
            ]);
            try {
                const response = await requestJson<{ error: string }>(
                    server,
                    "/api/docker/updater/services/1/update",
                    { method: "POST", body: {} }
                );
                assert.equal(response.status, status);
                assert.equal(response.body.error, error);
            } finally {
                __testing.setRunDockerUpdaterServiceForTests(undefined);
            }
        }
    });

    it("runs updater pipelines through the dashboard service", async () => {
        const { __testing } = await import("./docker.js");
        db.exec(
            "DELETE FROM scheduled_job_runs WHERE job_id = 'docker.updater'; DELETE FROM scheduled_jobs WHERE id = 'docker.updater';"
        );
        upsertScheduledJob({
            id: "docker.updater",
            name: "Docker updater",
            enabled: true,
            scheduleType: "daily",
            timeOfDay: "04:10",
            actionKey: "docker.updater",
        });
        __testing.setRunDockerUpdaterServiceForTests(async () => [
            { step: "register-services", ok: true, stdout: "registered", stderr: "" },
            { step: "poll", ok: true, stdout: "checked", stderr: "" },
            { step: "auto-update:media/app", ok: true, stdout: "updated", stderr: "" },
        ]);
        try {
            const run = await requestJson<{
                success: boolean;
                steps: Array<{ step: string; ok: boolean }>;
            }>(server, "/api/docker/updater/run", { method: "POST", body: {} });
            assert.equal(run.status, 200);
            assert.equal(run.body.success, true);
            assert.deepEqual(
                run.body.steps.map((step) => step.step),
                ["register-services", "poll", "auto-update:media/app"]
            );
            const scheduledRun = db
                .prepare(
                    `SELECT status, trigger_type, message, output_json
                     FROM scheduled_job_runs
                     WHERE job_id = 'docker.updater'
                     ORDER BY id DESC
                     LIMIT 1`
                )
                .get() as {
                message: string | null;
                output_json: string;
                status: string;
                trigger_type: string;
            };
            assert.equal(scheduledRun.status, "success");
            assert.equal(scheduledRun.trigger_type, "manual");
            assert.equal(scheduledRun.message, null);
            assert.deepEqual(
                (
                    JSON.parse(scheduledRun.output_json) as {
                        steps: Array<{ step: string }>;
                    }
                ).steps.map((step) => step.step),
                ["register-services", "poll", "auto-update:media/app"]
            );
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        __testing.setRunDockerUpdaterServiceForTests(async () => [
            { step: "register-services", ok: true, stdout: "", stderr: "" },
            { step: "poll", ok: false, stdout: "", stderr: "poll failed" },
        ]);
        try {
            const failedRun = await requestJson<{
                success: boolean;
                steps: Array<{ step: string; ok: boolean; stderr: string }>;
            }>(server, "/api/docker/updater/run", { method: "POST", body: {} });
            assert.equal(failedRun.status, 200);
            assert.equal(failedRun.body.success, false);
            assert.equal(failedRun.body.steps[1]?.stderr, "poll failed");
            const scheduledRun = db
                .prepare(
                    `SELECT status, trigger_type, message
                     FROM scheduled_job_runs
                     WHERE job_id = 'docker.updater'
                     ORDER BY id DESC
                     LIMIT 1`
                )
                .get() as {
                message: string | null;
                status: string;
                trigger_type: string;
            };
            assert.equal(scheduledRun.status, "failed");
            assert.equal(scheduledRun.trigger_type, "manual");
            assert.equal(scheduledRun.message, "poll failed");
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        __testing.setRunDockerUpdaterServiceForTests(async () => [
            { step: "register-services", ok: true, stdout: "", stderr: "" },
            { step: "poll", ok: false, stdout: "", stderr: "" },
        ]);
        try {
            const failedRun = await requestJson<{ success: boolean }>(
                server,
                "/api/docker/updater/run",
                { method: "POST", body: {} }
            );
            assert.equal(failedRun.status, 200);
            assert.equal(failedRun.body.success, false);
            const scheduledRun = db
                .prepare(
                    `SELECT status, message
                     FROM scheduled_job_runs
                     WHERE job_id = 'docker.updater'
                     ORDER BY id DESC
                     LIMIT 1`
                )
                .get() as {
                message: string | null;
                status: string;
            };
            assert.equal(scheduledRun.status, "failed");
            assert.equal(scheduledRun.message, "Docker updater failed");
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        db.exec(
            `CREATE TEMP TRIGGER fail_docker_updater_manual_run
             BEFORE INSERT ON scheduled_job_runs
             WHEN NEW.job_id = 'docker.updater'
             BEGIN
                 SELECT RAISE(ABORT, 'manual run insert denied');
             END;`
        );
        __testing.setRunDockerUpdaterServiceForTests(async () => [
            { step: "register-services", ok: true, stdout: "registered", stderr: "" },
        ]);
        try {
            const run = await requestJson<{ success: boolean }>(
                server,
                "/api/docker/updater/run",
                { method: "POST", body: {} }
            );
            assert.equal(run.status, 200);
            assert.equal(run.body.success, true);
        } finally {
            db.exec("DROP TRIGGER fail_docker_updater_manual_run;");
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        __testing.setRunDockerUpdaterServiceForTests(async () => {
            throw new Error("updater exploded");
        });
        try {
            const failedRun = await requestJson<{ error: string }>(
                server,
                "/api/docker/updater/run",
                { method: "POST", body: {} }
            );
            assert.equal(failedRun.status, 500);
            const scheduledRun = db
                .prepare(
                    `SELECT status, trigger_type, message, output_json
                     FROM scheduled_job_runs
                     WHERE job_id = 'docker.updater'
                     ORDER BY id DESC
                     LIMIT 1`
                )
                .get() as {
                message: string | null;
                output_json: string;
                status: string;
                trigger_type: string;
            };
            assert.equal(scheduledRun.status, "failed");
            assert.equal(scheduledRun.trigger_type, "manual");
            assert.equal(scheduledRun.message, "updater exploded");
            assert.deepEqual(JSON.parse(scheduledRun.output_json), {});
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
            db.exec(
                "DELETE FROM scheduled_job_runs WHERE job_id = 'docker.updater'; DELETE FROM scheduled_jobs WHERE id = 'docker.updater';"
            );
        }
    });

    it("runs manual updater through the dashboard service and maps route errors", async () => {
        resetDockerUpdaterFixtures();
        const { __testing } = await import("./docker.js");
        db.exec(
            "DELETE FROM scheduled_job_runs WHERE job_id = 'docker.updater'; DELETE FROM scheduled_jobs WHERE id = 'docker.updater';"
        );
        upsertScheduledJob({
            id: "docker.updater",
            name: "Docker updater",
            enabled: true,
            scheduleType: "daily",
            timeOfDay: "04:10",
            actionKey: "docker.updater",
        });
        __testing.setRunDockerUpdaterServiceForTests(async (serviceId?: number) => {
            db.prepare(
                `UPDATE docker_managed_services
                 SET current_tag = '1.0.1', current_digest = 'sha256:new',
                     latest_tag = '1.0.1', latest_digest = 'sha256:new',
                     last_status = 'updated'
                 WHERE id = ?`
            ).run(serviceId ?? -1);
            return [
                { step: "register-services", ok: true, stdout: "", stderr: "" },
                { step: "poll", ok: true, stdout: "", stderr: "" },
                {
                    step: `manual-update:media/app:${serviceId ?? "none"}`,
                    ok: true,
                    stdout: "updated",
                    stderr: "",
                },
            ];
        });
        try {
            const success = await requestJson<{
                service: {
                    currentDigest: string | null;
                    currentTag: string | null;
                    lastStatus: string | null;
                    updateAvailable: boolean;
                };
                success: boolean;
                result: { summary: { updated: number; failed: number } };
                stderr: string;
            }>(server, "/api/docker/updater/services/1/update", {
                method: "POST",
                body: {},
            });
            assert.equal(success.status, 200);
            assert.equal(success.body.success, true);
            assert.deepEqual(success.body.result.summary, { updated: 1, failed: 0 });
            assert.equal(success.body.service.currentTag, "1.0.1");
            assert.equal(success.body.service.currentDigest, "sha256:new");
            assert.equal(success.body.service.lastStatus, "updated");
            assert.equal(success.body.service.updateAvailable, false);
            assert.equal(success.body.stderr, "");
            const scheduledRun = db
                .prepare(
                    `SELECT status, trigger_type, message, output_json
                     FROM scheduled_job_runs
                     WHERE job_id = 'docker.updater'
                     ORDER BY id DESC
                     LIMIT 1`
                )
                .get() as {
                message: string | null;
                output_json: string;
                status: string;
                trigger_type: string;
            };
            assert.equal(scheduledRun.status, "success");
            assert.equal(scheduledRun.trigger_type, "manual");
            assert.equal(scheduledRun.message, null);
            const scheduledRunOutput = JSON.parse(scheduledRun.output_json) as {
                serviceId: number;
            };
            assert.equal(scheduledRunOutput.serviceId, 1);
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        __testing.setRunDockerUpdaterServiceForTests(async () => [
            { step: "register-services", ok: true, stdout: "", stderr: "" },
            { step: "poll", ok: true, stdout: "", stderr: "" },
            {
                step: "manual-update:media/app",
                ok: false,
                stdout: "",
                stderr: "apply failed",
            },
        ]);
        try {
            const failed = await requestJson<{
                success: boolean;
                result: { summary: { updated: number; failed: number } };
            }>(server, "/api/docker/updater/services/1/update", {
                method: "POST",
                body: {},
            });
            assert.equal(failed.status, 200);
            assert.equal(failed.body.success, false);
            assert.deepEqual(failed.body.result.summary, { updated: 0, failed: 1 });
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        __testing.setRunDockerUpdaterServiceForTests(async () => [
            { step: "register-services", ok: true, stdout: "", stderr: "" },
            { step: "poll", ok: true, stdout: "", stderr: "" },
            {
                step: "manual-update:media/app",
                ok: false,
                code: "CONFLICT",
                stdout: "",
                stderr: "No update available",
            },
        ]);
        try {
            const conflict = await requestJson<{ error: string }>(
                server,
                "/api/docker/updater/services/1/update",
                { method: "POST", body: {} }
            );
            assert.equal(conflict.status, 409);
            assert.equal(conflict.body.error, "No update available");
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
        }

        __testing.setRunDockerUpdaterServiceForTests(async () => {
            throw new Error("manual updater exploded");
        });
        try {
            const failed = await requestJson<{ error: string }>(
                server,
                "/api/docker/updater/services/1/update",
                { method: "POST", body: {} }
            );
            assert.equal(failed.status, 500);
            const scheduledRun = db
                .prepare(
                    `SELECT status, trigger_type, message, output_json
                     FROM scheduled_job_runs
                     WHERE job_id = 'docker.updater'
                     ORDER BY id DESC
                     LIMIT 1`
                )
                .get() as {
                message: string | null;
                output_json: string;
                status: string;
                trigger_type: string;
            };
            assert.equal(scheduledRun.status, "failed");
            assert.equal(scheduledRun.trigger_type, "manual");
            assert.equal(scheduledRun.message, "manual updater exploded");
            const scheduledRunOutput = JSON.parse(scheduledRun.output_json) as {
                serviceId: number;
            };
            assert.equal(scheduledRunOutput.serviceId, 1);
        } finally {
            __testing.setRunDockerUpdaterServiceForTests(undefined);
            db.exec(
                "DELETE FROM scheduled_job_runs WHERE job_id = 'docker.updater'; DELETE FROM scheduled_jobs WHERE id = 'docker.updater';"
            );
        }
    });

    it("starts and reads docker exec jobs", async () => {
        const invalid = await requestJson<{ error: string }>(
            server,
            "/api/docker/exec/start",
            { method: "POST", body: { containerId: "app" } }
        );
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, "Missing containerId or command");

        const nullPayload = await requestJson<{ error: string }>(
            server,
            "/api/docker/exec/start",
            { method: "POST", rawBody: JSON.stringify(null) }
        );
        assert.equal(nullPayload.status, 400);
        assert.equal(nullPayload.body.error, "Missing containerId or command");

        const invalidContainerId = await requestJson<{ error: string }>(
            server,
            "/api/docker/exec/start",
            { method: "POST", body: { containerId: "-bad", command: "echo hi" } }
        );
        assert.equal(invalidContainerId.status, 400);
        assert.equal(invalidContainerId.body.error, "Invalid containerId");

        const objectContainerId = await requestJson<{ error: string }>(
            server,
            "/api/docker/exec/start",
            { method: "POST", body: { containerId: { id: "app" }, command: "echo ok" } }
        );
        assert.equal(objectContainerId.status, 400);
        assert.equal(objectContainerId.body.error, "Invalid containerId");

        const objectCommand = await requestJson<{ error: string }>(
            server,
            "/api/docker/exec/start",
            { method: "POST", body: { containerId: "app", command: { run: "echo ok" } } }
        );
        assert.equal(objectCommand.status, 400);
        assert.equal(objectCommand.body.error, "Invalid command");

        const blankCommand = await requestJson<{ error: string }>(
            server,
            "/api/docker/exec/start",
            { method: "POST", body: { containerId: "app", command: " ".repeat(3) } }
        );
        assert.equal(blankCommand.status, 400);
        assert.equal(blankCommand.body.error, "Invalid command");

        const { __testing } = await import("./docker.js");
        __testing.dockerExecJobs.clear();
        try {
            for (let index = 0; index < 100; index += 1) {
                __testing.dockerExecJobs.set(`active-${index}`, {
                    id: `active-${index}`,
                    containerId: "app",
                    status: "running",
                    code: null,
                    stdout: "",
                    stderr: "",
                    startedAt: Date.now(),
                    endedAt: null,
                });
            }
            const tooMany = await requestJson<{ error: string }>(
                server,
                "/api/docker/exec/start",
                { method: "POST", body: { containerId: "app", command: "echo hi" } }
            );
            assert.equal(tooMany.status, 429);
            assert.equal(tooMany.body.error, "Too many active Docker exec jobs");
        } finally {
            __testing.dockerExecJobs.clear();
        }

        const start = await requestJson<{ jobId: string }>(
            server,
            "/api/docker/exec/start",
            { method: "POST", body: { containerId: "app", command: "echo hi" } }
        );
        assert.equal(start.status, 200);
        assert.match(start.body.jobId, /^[0-9a-f-]+$/u);

        let job = await requestJson<{
            status: string;
            code: number | null;
            stdout: string;
            stderr: string;
        }>(server, `/api/docker/exec/${start.body.jobId}`);
        for (let attempt = 0; attempt < 20 && job.body.status !== "done"; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            job = await requestJson(server, `/api/docker/exec/${start.body.jobId}`);
        }
        assert.equal(job.status, 200);
        assert.equal(job.body.status, "done");
        assert.equal(job.body.code, 0);
        assert.equal(job.body.stdout, "exec stdout\n");
        assert.equal(job.body.stderr, "exec stderr\n");
        assert.equal(
            __testing.dockerExecJobs.get(start.body.jobId)?.inContainerPid,
            4321
        );

        const stopDone = await requestJson<{ error: string }>(
            server,
            `/api/docker/exec/${start.body.jobId}/stop`,
            { method: "POST", body: {} }
        );
        assert.equal(stopDone.status, 400);
        assert.equal(stopDone.body.error, "Job is not running");

        const missing = await requestJson<{ error: string }>(
            server,
            "/api/docker/exec/missing"
        );
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, "Docker exec job not found");

        const missingStop = await requestJson<{ error: string }>(
            server,
            "/api/docker/exec/missing/stop",
            { method: "POST", body: {} }
        );
        assert.equal(missingStop.status, 404);
        assert.equal(missingStop.body.error, "Docker exec job not found");

        const longStart = await requestJson<{ jobId: string }>(
            server,
            "/api/docker/exec/start",
            { method: "POST", body: { containerId: "app", command: "sleep 60" } }
        );
        assert.equal(longStart.status, 200);
        const stopRunning = await requestJson<{ success: boolean }>(
            server,
            `/api/docker/exec/${longStart.body.jobId}/stop`,
            { method: "POST", body: {} }
        );
        assert.equal(stopRunning.status, 200);
        assert.equal(stopRunning.body.success, true);
    });
});
