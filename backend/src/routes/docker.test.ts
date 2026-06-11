import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import express from "express";

let db: (typeof import("../db.js"))["db"];

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

function dockerNotifications() {
    const rows = db
        .prepare(
            `SELECT title, type, dedupe_key, metadata_json, is_read
             FROM notifications
             WHERE source IN ('docker', 'docker-updater')
             ORDER BY dedupe_key`
        )
        .all() as Array<{
        dedupe_key: string;
        is_read: number;
        metadata_json: string;
        title: string;
        type: string;
    }>;
    return rows.map((row) => ({ ...row }));
}

function dockerNotificationRows() {
    return db
        .prepare(
            `SELECT id, title, type, dedupe_key, metadata_json, is_read
             FROM notifications
             WHERE source IN ('docker', 'docker-updater')
             ORDER BY dedupe_key`
        )
        .all() as Array<{
        dedupe_key: string;
        id: number;
        is_read: number;
        metadata_json: string;
        title: string;
        type: string;
    }>;
}

const originalPath = process.env.PATH;
const originalDockerRoot = process.env.MIRA_DOCKER_ROOT;
const originalDockerAppsRoot = process.env.MIRA_DOCKER_APPS_ROOT;
const originalDockerBin = process.env.MIRA_DOCKER_BIN;
const originalComposeWrapper = process.env.MIRA_DOCKER_COMPOSE_WRAPPER;
const originalUpdaterSkipRegistry = process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY;
const originalDashboardDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
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
    "MIRA_FAKE_DOCKER_SPARSE_EVENTS",
    "MIRA_FAKE_DOCKER_COMPOSE_FAIL",
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
        "DATABASE_URL=postgres://secret",
        "PATH=/usr/local/bin",
        "TZ=Europe/Oslo",
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
  process.stdout.write("__MIRA_DOCKER_EXEC_PID__=4321\nstarted long exec\n");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
  return;
}
else if (args[0] === "exec" && args[1] === "app" && args[2] === "sh") {
  process.stdout.write("exec stdout\n");
  process.stderr.write("exec stderr\n");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "postgres" && args[2] === "psql") {
  const sql = args.join(" ");
  if (sql.includes("docker_managed_services")) {
    const header = "id\tapp_slug\tservice_name\tcompose_image_ref\timage_repo\tcurrent_tag\tcurrent_digest\tlatest_tag\tlatest_digest\tpolicy\tpin_mode\tenabled\tlast_checked_at\tlast_updated_at\tlast_status\tmetadata\n";
    const rows = [
      "1\tmedia\tapp\trepo/app:1.0.0\trepo/app\t1.0.0\tsha256:old\t1.0.1\tsha256:new\tauto\tdigest\ttrue\t2026-05-11\t\t\t{\"owner\":\"mira\"}",
      "2\tmedia\tdisabled\trepo/disabled:1\trepo/disabled\t1\t\t2\t\tnotify\ttag\tfalse\t\t\t\t{}",
      "3\tmedia\tcurrent\trepo/current:1\trepo/current\t1\t\t1\t\tnotify\ttag\ttrue\t\t\t\t{}"
    ];
    const whereMatch = sql.match(/WHERE id = (\d+)/);
    if (whereMatch) {
      const row = rows.find((entry) => entry.startsWith(whereMatch[1] + "\t"));
      process.stdout.write(header + (row ? row + "\n" : ""));
    } else {
      process.stdout.write(header + rows.join("\n") + "\n");
    }
    process.exit(0);
  }
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "postgres" && args[2] === "cat") {
  if (process.env.MIRA_FAKE_DOCKER_SPARSE_EVENTS === "1") {
    process.stdout.write("8\t1\tmedia\n");
    process.exit(0);
  }
  process.stdout.write("7\t1\tmedia\tapp\tupdated\t1.0.0\t1.0.1\tsha256:old\tsha256:new\t2026-05-11 12:00:00\n");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "postgres" && args[2] === "rm") {
  process.exit(0);
}
if (args[0] === "compose") {
  if (process.env.MIRA_FAKE_DOCKER_COMPOSE_FAIL === "1") {
    process.stderr.write("compose failed\n");
    process.exit(12);
  }
  process.stdout.write("compose " + args.slice(1).join(" ") + "\n");
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
if (process.env.MIRA_FAKE_DOCKER_COMPOSE_FAIL === "1") {
  process.stderr.write("compose failed\n");
  process.exit(12);
}
process.stdout.write("compose " + process.argv.slice(2).join(" ") + "\n");
`,
        "utf8"
    );
    await chmod(composePath, 0o755);
    process.env.MIRA_DOCKER_BIN = dockerPath;
    process.env.MIRA_DOCKER_COMPOSE_WRAPPER = composePath;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

async function startServer(updaterCwd: string): Promise<TestServer> {
    const { default: dockerRoutes, __testing } = await import("./docker.js");
    const { default: notificationsRoutes } = await import("./notifications.js");
    void updaterCwd;
    __testing.setDockerExecPidWaitTimeoutForTests(100);
    const app = express();
    dockerRoutes(app);
    notificationsRoutes(app);
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
        close: () =>
            new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            ),
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

async function withDockerUpdaterFetch<T>(callback: () => Promise<T>): Promise<T> {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof Request
                  ? input.url
                  : input.toString();
        if (!url.includes("hub.docker.com") && !url.includes("ghcr.io")) {
            return previousFetch(input, init);
        }
        return {
            ok: true,
            headers: new Headers(),
            json: async () =>
                url.endsWith("/tags/1.0.1")
                    ? {
                          images: [
                              {
                                  architecture:
                                      process.arch === "arm64" ? "arm64" : "amd64",
                                  digest: "sha256:new",
                                  os: "linux",
                              },
                          ],
                      }
                    : { results: [{ name: "1.0.1" }] },
        } as Response;
    }) as typeof fetch;
    try {
        return await callback();
    } finally {
        globalThis.fetch = previousFetch;
    }
}

async function seedDockerUpdaterState(tempDir: string): Promise<void> {
    const composeDir = path.join(tempDir, "apps", "media");
    await mkdir(composeDir, { recursive: true });
    const composePath = path.join(composeDir, "compose.yaml");
    await writeFile(
        composePath,
        [
            "services:",
            "  app:",
            "    image: repo/app:1.0.0@sha256:old",
            "    labels:",
            '      mira.updater.autoUpdate: "true"',
            '      mira.updater.tagPattern: "1.0.1"',
            "  disabled:",
            "    image: repo/disabled:1",
            "  current:",
            "    image: repo/current:1",
            "",
        ].join("\n"),
        "utf8"
    );

    db.exec(
        "DELETE FROM docker_update_events; DELETE FROM docker_managed_services; DELETE FROM notifications WHERE source IN ('docker', 'docker-updater');"
    );
    db.prepare(
        `INSERT INTO docker_managed_services (
            id, app_slug, service_name, compose_path, image_repo, compose_image_ref,
            compose_image_field, current_tag, current_digest, latest_tag, latest_digest,
            policy, pin_mode, tag_match_type, tag_match_pattern, enabled,
            metadata_json, last_checked_at, last_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', ?, ?, ?, ?, ?)`
    ).run(
        1,
        "media",
        "app",
        composePath,
        "repo/app",
        "repo/app:1.0.0@sha256:old",
        "services.app.image",
        "1.0.0",
        "sha256:old",
        "1.0.1",
        "sha256:new",
        "auto",
        "digest",
        "1.0.1",
        1,
        '{"owner":"mira"}',
        "2026-05-11",
        "update_available"
    );
    db.prepare(
        `INSERT INTO docker_managed_services (
            id, app_slug, service_name, compose_path, image_repo, compose_image_ref,
            compose_image_field, current_tag, current_digest, latest_tag, latest_digest,
            policy, pin_mode, tag_match_type, tag_match_pattern, enabled,
            metadata_json, last_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', ?, ?, ?, ?)`
    ).run(
        2,
        "media",
        "disabled",
        composePath,
        "repo/disabled",
        "repo/disabled:1",
        "services.disabled.image",
        "1",
        null,
        "2",
        null,
        "notify",
        "tag",
        "1",
        0,
        "{}",
        null
    );
    db.prepare(
        `INSERT INTO docker_managed_services (
            id, app_slug, service_name, compose_path, image_repo, compose_image_ref,
            compose_image_field, current_tag, current_digest, latest_tag, latest_digest,
            policy, pin_mode, tag_match_type, tag_match_pattern, enabled,
            metadata_json, last_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', ?, ?, ?, ?)`
    ).run(
        3,
        "media",
        "current",
        composePath,
        "repo/current",
        "repo/current:1",
        "services.current.image",
        "1",
        "sha256:old-current",
        "1",
        "sha256:new-current",
        "notify",
        "tag",
        "1",
        1,
        "{}",
        null
    );
    db.prepare(
        `INSERT INTO docker_update_events (
            id, managed_service_id, event_type, from_tag, to_tag, from_digest,
            to_digest, message, details_json, app_slug, service_name, created_at
        ) VALUES (7, 1, 'updated', '1.0.0', '1.0.1', 'sha256:old', 'sha256:new', NULL, '{}', 'media', 'app', ?)`
    ).run("2026-05-11 12:00:00");
}

describe("docker routes", { concurrency: false }, () => {
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-docker-routes-"));
        process.env.MIRA_DASHBOARD_DB_PATH = path.join(tempDir, "docker.sqlite");
        ({ db } = await import("../db.js"));
        await installFakeDocker(tempDir);
        process.env.MIRA_DOCKER_ROOT = tempDir;
        process.env.MIRA_DOCKER_APPS_ROOT = path.join(tempDir, "apps");
        process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY = "1";
        await seedDockerUpdaterState(tempDir);
        server = await startServer(tempDir);
    });

    after(async () => {
        const { __testing } = await import("./docker.js");
        let closeError: unknown;
        try {
            await server?.close();
        } catch (error) {
            closeError = error;
        } finally {
            await Promise.all(
                [...__testing.dockerExecJobs.values()]
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
            if (originalDockerAppsRoot === undefined) {
                delete process.env.MIRA_DOCKER_APPS_ROOT;
            } else {
                process.env.MIRA_DOCKER_APPS_ROOT = originalDockerAppsRoot;
            }
            if (originalDockerBin === undefined) {
                delete process.env.MIRA_DOCKER_BIN;
            } else {
                process.env.MIRA_DOCKER_BIN = originalDockerBin;
            }
            if (originalComposeWrapper === undefined) {
                delete process.env.MIRA_DOCKER_COMPOSE_WRAPPER;
            } else {
                process.env.MIRA_DOCKER_COMPOSE_WRAPPER = originalComposeWrapper;
            }
            if (originalUpdaterSkipRegistry === undefined) {
                delete process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY;
            } else {
                process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY =
                    originalUpdaterSkipRegistry;
            }
            if (db) {
                db.exec(
                    "DELETE FROM docker_update_events; DELETE FROM docker_managed_services; DELETE FROM notifications WHERE source IN ('docker', 'docker-updater');"
                );
                db.close();
            }
            if (originalDashboardDbPath === undefined) {
                delete process.env.MIRA_DASHBOARD_DB_PATH;
            } else {
                process.env.MIRA_DASHBOARD_DB_PATH = originalDashboardDbPath;
            }
            __testing.setDockerBinForTests(originalDockerBin);
            __testing.setDockerExecPidWaitTimeoutForTests();
            if (tempDir) {
                await rm(tempDir, { recursive: true, force: true });
            }
        }
        if (closeError) throw closeError;
    });

    it("covers docker parser helper edge cases", async () => {
        const { __testing } = await import(`./docker.js?helpers=${randomUUID()}`);

        const routeError = new Error("not a JSON parser error");
        let forwardedError: unknown;
        __testing.invalidStackActionJsonHandler(
            routeError,
            {} as never,
            {} as never,
            (error: unknown) => {
                forwardedError = error;
            }
        );
        assert.equal(forwardedError, routeError);

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
                current_digest: null,
                latest_digest: "sha256:b",
            } as never),
            true
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "1.0.0",
                latest_tag: null,
                current_digest: "sha256:a",
                latest_digest: "sha256:b",
            } as never),
            true
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "1.0.0",
                latest_tag: "1.0.0",
                current_digest: "sha256:a",
                latest_digest: "sha256:b",
            } as never),
            true
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "1.0.0",
                latest_tag: "1.0.0",
                current_digest: "sha256:a",
                latest_digest: "sha256:a",
            } as never),
            false
        );
        assert.equal(
            __testing.hasUpdaterCandidate({
                pin_mode: "tag",
                current_tag: "",
                latest_tag: "1.0.1",
            } as never),
            true
        );
        assert.deepEqual(__testing.extractTrailingJson('noise\n{"ok":true}'), {
            ok: true,
        });
        assert.deepEqual(__testing.extractTrailingJson('{"ok":true}'), { ok: true });
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
        assert.equal(__testing.manualUpdaterFailureCode(), "APPLY_FAILED");
        assert.equal(__testing.manualUpdaterFailureCode("CONFLICT"), "CONFLICT");
        assert.equal(__testing.manualUpdaterFailureStatus("NOT_FOUND"), 404);
        assert.equal(__testing.manualUpdaterFailureStatus("DISABLED"), 400);
        assert.equal(__testing.manualUpdaterFailureStatus("CONFLICT"), 409);
        assert.equal(__testing.manualUpdaterFailureStatus("UNSUPPORTED_REGISTRY"), 422);
        assert.equal(__testing.manualUpdaterFailureStatus("APPLY_FAILED"), 500);
        assert.equal(
            __testing.firstFailedStepCode([
                { step: "ok", ok: true, stdout: "", stderr: "" },
                {
                    step: "failed",
                    ok: false,
                    code: "CONFLICT",
                    stdout: "",
                    stderr: "No update available",
                },
            ]),
            "CONFLICT"
        );
        assert.equal(
            __testing.firstFailedStepCode([
                { step: "first", ok: false, stdout: "", stderr: "apply failed" },
                {
                    step: "second",
                    ok: false,
                    code: "CONFLICT",
                    stdout: "",
                    stderr: "No update available",
                },
            ]),
            undefined
        );
        assert.equal(__testing.resolveManualUpdateServiceId("12", { serviceId: 3 }), 12);
        assert.equal(__testing.resolveManualUpdateServiceId("", { serviceId: 3 }), 3);
        assert.equal(__testing.resolveManualUpdateServiceId("0", { serviceId: 3 }), null);
        assert.equal(
            __testing.resolveManualUpdateServiceId("bad", { serviceId: 3 }),
            null
        );
        assert.equal(__testing.resolveManualUpdateServiceId("", {}), null);
        assert.deepEqual(await __testing.getContainerInspectMap([]), new Map());
        assert.deepEqual(await __testing.runManualUpdaterForService(987_654), {
            success: false,
            code: "NOT_FOUND",
            output: {},
            stderr: "Docker updater service not found",
            steps: [
                {
                    step: "manual-update",
                    ok: false,
                    code: "NOT_FOUND",
                    stdout: "",
                    stderr: "Docker updater service not found",
                },
            ],
        });
        assert.deepEqual(
            await __testing.runManualUpdaterForService({
                id: 2,
                appSlug: "media",
                serviceName: "disabled",
                imageRepo: "repo/disabled",
                composeImageRef: "repo/disabled:1",
                currentTag: "1",
                currentDigest: null,
                latestTag: "2",
                latestDigest: null,
                policy: "notify",
                pinMode: "tag",
                enabled: false,
                lastCheckedAt: null,
                lastUpdatedAt: null,
                lastStatus: null,
                updateAvailable: true,
                metadata: {},
            }),
            {
                success: false,
                code: "DISABLED",
                output: {},
                stderr: "Docker updater service is disabled",
                steps: [
                    {
                        step: "manual-update",
                        ok: false,
                        code: "DISABLED",
                        stdout: "",
                        stderr: "Docker updater service is disabled",
                    },
                ],
            }
        );
        try {
            __testing.setDockerUpdaterServiceRunnerForTests(async () => [
                {
                    step: "manual-update:media/app",
                    ok: false,
                    code: "CONFLICT",
                    stdout: "",
                    stderr: "No update available",
                },
            ]);
            assert.deepEqual(
                await __testing.runManualUpdaterForService({
                    id: 3,
                    appSlug: "media",
                    serviceName: "app",
                    imageRepo: "repo/app",
                    composeImageRef: "repo/app:1",
                    currentTag: "1",
                    currentDigest: null,
                    latestTag: "2",
                    latestDigest: null,
                    policy: "notify",
                    pinMode: "tag",
                    enabled: true,
                    lastCheckedAt: null,
                    lastUpdatedAt: null,
                    lastStatus: null,
                    updateAvailable: true,
                    metadata: {},
                }),
                {
                    success: false,
                    code: "CONFLICT",
                    output: {},
                    stderr: "No update available",
                    steps: [
                        {
                            step: "manual-update:media/app",
                            ok: false,
                            code: "CONFLICT",
                            stdout: "",
                            stderr: "No update available",
                        },
                    ],
                }
            );
        } finally {
            __testing.setDockerUpdaterServiceRunnerForTests();
        }
        try {
            __testing.setDockerUpdaterServiceRunnerForTests(async () => [
                {
                    step: "manual-update:media/app",
                    ok: true,
                    stdout: "updated",
                    stderr: "",
                },
            ]);
            assert.deepEqual(
                await __testing.runManualUpdaterForService({
                    id: 4,
                    appSlug: "media",
                    serviceName: "app",
                    imageRepo: "repo/app",
                    composeImageRef: "repo/app:1",
                    currentTag: "1",
                    currentDigest: null,
                    latestTag: "2",
                    latestDigest: null,
                    policy: "notify",
                    pinMode: "tag",
                    enabled: true,
                    lastCheckedAt: null,
                    lastUpdatedAt: null,
                    lastStatus: null,
                    updateAvailable: true,
                    metadata: {},
                }),
                {
                    success: true,
                    code: "OK",
                    output: {
                        serviceId: 4,
                        summary: { updated: 1, failed: 0 },
                        updated: [4],
                        failed: [],
                    },
                    stderr: "",
                    summary: { updated: 1, failed: 0 },
                    updated: [4],
                    failed: [],
                    steps: [
                        {
                            step: "manual-update:media/app",
                            ok: true,
                            stdout: "updated",
                            stderr: "",
                        },
                    ],
                }
            );
        } finally {
            __testing.setDockerUpdaterServiceRunnerForTests();
        }

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
        };
        process.env.MIRA_DOCKER_ROOT = "/tmp/custom-docker-root";
        process.env.MIRA_DOCKER_BIN = "/tmp/custom-docker";
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER = "/tmp/custom-compose-wrapper";

        try {
            const module = await import(`./docker.js?env=${randomUUID()}`);
            assert.equal(typeof module.default, "function");
            process.env.MIRA_DOCKER_ROOT = "";
            process.env.MIRA_DOCKER_BIN = "";
            process.env.MIRA_DOCKER_COMPOSE_WRAPPER = "";
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
            assert.equal(events.body.events.length, 1);
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
            "***",
            "***",
            "DATABASE_URL=***",
            "PATH=/usr/local/bin",
            "TZ=Europe/Oslo",
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

        const stackWithoutService = await requestJson<{ output: string }>(
            server,
            "/api/docker/stack/action",
            { method: "POST", body: { action: "restart" } }
        );
        assert.equal(stackWithoutService.status, 200);
        assert.equal(stackWithoutService.body.output, "compose restart");

        const invalidStackAction = await requestJson<{ error: string }>(
            server,
            "/api/docker/stack/action",
            { method: "POST", body: { action: "up" } }
        );
        assert.equal(invalidStackAction.status, 400);
        assert.equal(invalidStackAction.body.error, "Invalid stack action");

        const invalidStackService = await requestJson<{ error: string }>(
            server,
            "/api/docker/stack/action",
            { method: "POST", body: { action: "restart", service: "-bad" } }
        );
        assert.equal(invalidStackService.status, 400);
        assert.equal(invalidStackService.body.error, "Invalid stack action");

        for (const service of [".api", "_api"]) {
            const invalidLeadingCharacter = await requestJson<{ error: string }>(
                server,
                "/api/docker/stack/action",
                { method: "POST", body: { action: "restart", service } }
            );
            assert.equal(invalidLeadingCharacter.status, 400);
            assert.equal(invalidLeadingCharacter.body.error, "Invalid stack action");
        }

        const invalidWhitespaceStackService = await requestJson<{ error: string }>(
            server,
            "/api/docker/stack/action",
            { method: "POST", body: { action: "restart", service: "bad name" } }
        );
        assert.equal(invalidWhitespaceStackService.status, 400);
        assert.equal(invalidWhitespaceStackService.body.error, "Invalid stack action");

        const missingStackPayload = await requestJson<{ error: string }>(
            server,
            "/api/docker/stack/action",
            { method: "POST" }
        );
        assert.equal(missingStackPayload.status, 400);
        assert.equal(missingStackPayload.body.error, "Invalid stack action");

        const primitiveStackPayload = await requestJson<{ error: string }>(
            server,
            "/api/docker/stack/action",
            { method: "POST", rawBody: "null" }
        );
        assert.equal(primitiveStackPayload.status, 400);
        assert.equal(primitiveStackPayload.body.error, "Invalid stack action");

        const malformedStackPayload = await requestJson<{ error: string }>(
            server,
            "/api/docker/stack/action",
            { method: "POST", rawBody: "{" }
        );
        assert.equal(malformedStackPayload.status, 400);
        assert.equal(malformedStackPayload.body.error, "Invalid stack action");

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
        const markStackAsFailed = db.prepare(
            "UPDATE docker_managed_services SET last_status = 'registry_check_failed' WHERE id = 3"
        );
        markStackAsFailed.run();
        db.prepare(
            "UPDATE docker_managed_services SET last_status = 'unsupported_registry' WHERE id = 2"
        ).run();
        db.prepare(
            "UPDATE docker_managed_services SET last_status = NULL WHERE id = 1"
        ).run();
        const services = await requestJson<{
            services: Array<{
                id: number;
                serviceName: string;
                enabled: boolean;
                updateAvailable: boolean;
                metadata: Record<string, unknown>;
            }>;
            summary: {
                total: number;
                enabled: number;
                updateAvailable: number;
                failed: number;
            };
        }>(server, "/api/docker/updater/services");
        assert.equal(services.status, 200);
        assert.equal(services.body.summary.total, 3);
        assert.equal(services.body.summary.enabled, 2);
        assert.equal(services.body.summary.updateAvailable, 3);
        assert.equal(services.body.summary.failed, 2);
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
        ]);
        db.prepare("DELETE FROM docker_managed_services WHERE id = 1").run();
        db.exec("PRAGMA foreign_keys = OFF");
        try {
            db.prepare(
                `INSERT INTO docker_update_events (
                    id, managed_service_id, event_type, from_tag, to_tag,
                    from_digest, to_digest, message, created_at
                ) VALUES (99, 1, 'orphaned', '1.0.1', '1.0.2',
                    'sha256:new', 'sha256:newer', 'removed service', '2026-05-11 13:00:00')`
            ).run();
        } finally {
            db.exec("PRAGMA foreign_keys = ON");
        }
        const orphanEvents = await requestJson<{
            events: Array<{ appSlug: string; id: number; serviceName: string }>;
        }>(server, "/api/docker/updater/events?limit=500");
        assert.equal(orphanEvents.status, 200);
        assert.deepEqual(orphanEvents.body.events[0], {
            id: 99,
            managedServiceId: 1,
            appSlug: "",
            serviceName: "",
            eventType: "orphaned",
            fromTag: "1.0.1",
            toTag: "1.0.2",
            fromDigest: "sha256:new",
            toDigest: "sha256:newer",
            message: null,
            createdAt: "2026-05-11 13:00:00",
        });
        await seedDockerUpdaterState(tempDir);

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

        const noUpdate = await requestJson<{
            result: { summary: { failed: number; updated: number } };
            success: boolean;
        }>(server, "/api/docker/updater/services/3/update", { method: "POST", body: {} });
        assert.equal(noUpdate.status, 200);
        assert.equal(noUpdate.body.success, true);
        assert.deepEqual(noUpdate.body.result.summary, { updated: 0, failed: 0 });
    });

    it("runs updater pipelines and reports step failures", async () => {
        await seedDockerUpdaterState(tempDir);
        db.prepare(
            "DELETE FROM notifications WHERE source IN ('docker', 'docker-updater')"
        ).run();

        const run = await withDockerUpdaterFetch(() =>
            withEnvValue("MIRA_DOCKER_UPDATER_SKIP_REGISTRY", undefined, () =>
                requestJson<{
                    success: boolean;
                    steps: Array<{ step: string; ok: boolean; stderr: string }>;
                }>(server, "/api/docker/updater/run", {
                    method: "POST",
                    body: {},
                })
            )
        );
        assert.equal(run.status, 200);
        assert.equal(run.body.success, true);
        assert.equal(
            run.body.steps.some((step) => step.step === "auto-update:media/app"),
            true
        );
        assert.equal(
            run.body.steps.every((step) => step.ok),
            true
        );
        assert.deepEqual(dockerNotifications(), [
            {
                dedupe_key: "docker:updater:updated:1:repo/app:1.0.1@sha256:new",
                is_read: 0,
                metadata_json: "{}",
                title: "Docker service updated",
                type: "info",
            },
        ]);

        await seedDockerUpdaterState(tempDir);
        await withEnvValue("MIRA_FAKE_DOCKER_COMPOSE_FAIL", "1", async () => {
            const failedRun = await withDockerUpdaterFetch(() =>
                withEnvValue("MIRA_DOCKER_UPDATER_SKIP_REGISTRY", undefined, () =>
                    requestJson<{
                        success: boolean;
                        steps: Array<{ step: string; ok: boolean; stderr: string }>;
                    }>(server, "/api/docker/updater/run", { method: "POST", body: {} })
                )
            );
            assert.equal(failedRun.status, 200);
            assert.equal(failedRun.body.success, false);
            const failedAutoStep = failedRun.body.steps.find(
                (step) => step.step === "auto-update:media/app"
            );
            assert.equal(failedAutoStep?.ok, false);
            assert.match(failedAutoStep?.stderr ?? "", /compose failed/u);
            const failedNotification = dockerNotificationRows().find((notification) =>
                notification.dedupe_key.includes(":auto-failed:")
            );
            assert.ok(failedNotification);
            assert.equal(failedNotification.is_read, 0);
            const failureMetadata = JSON.parse(failedNotification.metadata_json) as {
                architecture?: string;
                digest?: string;
                os?: string;
            };
            assert.deepEqual(
                {
                    architecture: failureMetadata.architecture,
                    digest: failureMetadata.digest,
                    os: failureMetadata.os,
                },
                {
                    architecture: process.arch === "arm64" ? "arm64" : "amd64",
                    digest: "sha256:new",
                    os: "linux",
                }
            );
            const markedRead = await requestJson<{ ok: boolean }>(
                server,
                `/api/notifications/${failedNotification.id}/read`,
                { method: "POST" }
            );
            assert.equal(markedRead.status, 200);
            assert.equal(markedRead.body.ok, true);
            const failedAgain = await withDockerUpdaterFetch(() =>
                withEnvValue("MIRA_DOCKER_UPDATER_SKIP_REGISTRY", undefined, () =>
                    requestJson<{ success: boolean }>(server, "/api/docker/updater/run", {
                        method: "POST",
                        body: {},
                    })
                )
            );
            assert.equal(failedAgain.status, 200);
            assert.equal(failedAgain.body.success, false);
            const reopenedNotification = dockerNotificationRows().find(
                (notification) => notification.id === failedNotification.id
            );
            assert.ok(reopenedNotification);
            assert.equal(reopenedNotification.is_read, 0);
        });
    });

    it("runs manual updater notification steps and keeps partial failure details", async () => {
        await seedDockerUpdaterState(tempDir);
        const success = await withDockerUpdaterFetch(() =>
            withEnvValue("MIRA_DOCKER_UPDATER_SKIP_REGISTRY", undefined, () =>
                requestJson<{
                    success: boolean;
                    result: { serviceId: number };
                    service: { currentTag: string | null; lastStatus: string | null };
                    stderr: string;
                }>(server, "/api/docker/updater/services/1/update", {
                    method: "POST",
                    body: {},
                })
            )
        );
        assert.equal(success.status, 200);
        assert.equal(success.body.success, true);
        assert.deepEqual(success.body.result, {
            serviceId: 1,
            summary: { updated: 1, failed: 0 },
            updated: [1],
            failed: [],
        });
        assert.equal(success.body.service.currentTag, "1.0.1");
        assert.equal(success.body.service.lastStatus, "updated");
        assert.equal(success.body.stderr, "");

        await seedDockerUpdaterState(tempDir);
        db.exec(`
            CREATE TEMP TRIGGER delete_updated_manual_service_after_event
            AFTER INSERT ON docker_update_events
            WHEN NEW.managed_service_id = 1 AND NEW.event_type = 'manual_update_succeeded'
            BEGIN
                DELETE FROM docker_managed_services WHERE id = NEW.managed_service_id;
            END;
        `);
        try {
            const refreshedAfterSuccess = await withDockerUpdaterFetch(() =>
                withEnvValue("MIRA_DOCKER_UPDATER_SKIP_REGISTRY", undefined, () =>
                    requestJson<{
                        success: boolean;
                        service: {
                            id: number;
                            currentTag: string | null;
                            lastStatus: string | null;
                        } | null;
                    }>(server, "/api/docker/updater/services/1/update", {
                        method: "POST",
                        body: {},
                    })
                )
            );
            assert.equal(refreshedAfterSuccess.status, 200);
            assert.equal(refreshedAfterSuccess.body.success, true);
            assert.equal(refreshedAfterSuccess.body.service?.id, 1);
            assert.equal(refreshedAfterSuccess.body.service?.currentTag, "1.0.0");
            assert.equal(
                refreshedAfterSuccess.body.service?.lastStatus,
                "update_available"
            );
        } finally {
            db.exec("DROP TRIGGER IF EXISTS delete_updated_manual_service_after_event");
        }

        await seedDockerUpdaterState(tempDir);
        const { __testing } = await import("./docker.js");
        try {
            __testing.setDockerUpdaterServiceRunnerForTests(async () => {
                db.prepare("DELETE FROM docker_managed_services WHERE id = 1").run();
                return [
                    {
                        step: "manual-update:media/app",
                        ok: false,
                        code: "CONFLICT",
                        stdout: "",
                        stderr: "No update available",
                    },
                ];
            });
            const fallbackFailure = await requestJson<{
                error: string;
                success: boolean;
                service: unknown;
                stderr: string;
            }>(server, "/api/docker/updater/services/1/update", {
                method: "POST",
                body: {},
            });
            assert.equal(fallbackFailure.status, 409);
            assert.equal(fallbackFailure.body.success, false);
            assert.equal(fallbackFailure.body.error, "No update available");
            assert.equal(fallbackFailure.body.service, null);
            assert.equal(fallbackFailure.body.stderr, "No update available");
        } finally {
            __testing.setDockerUpdaterServiceRunnerForTests();
        }

        await seedDockerUpdaterState(tempDir);
        try {
            __testing.setDockerUpdaterServiceRunnerForTests(async () => {
                db.prepare("DELETE FROM docker_managed_services WHERE id = 1").run();
                return [
                    {
                        step: "manual-update:media/app",
                        ok: false,
                        code: "NOT_FOUND",
                        stdout: "",
                        stderr: "Service not found",
                    },
                ];
            });
            const missingFailure = await requestJson<{
                error: string;
                success: boolean;
                service: unknown;
                stderr: string;
            }>(server, "/api/docker/updater/services/1/update", {
                method: "POST",
                body: {},
            });
            assert.equal(missingFailure.status, 404);
            assert.equal(missingFailure.body.success, false);
            assert.equal(missingFailure.body.error, "Service not found");
            assert.equal(missingFailure.body.service, null);
            assert.equal(missingFailure.body.stderr, "Service not found");
        } finally {
            __testing.setDockerUpdaterServiceRunnerForTests();
        }

        await seedDockerUpdaterState(tempDir);
        const previousFetch = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url =
                input instanceof Request
                    ? input.url
                    : input instanceof URL
                      ? input.toString()
                      : input;
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/tags/1.0.0")
                        ? {
                              images: [
                                  {
                                      architecture:
                                          process.arch === "arm64" ? "arm64" : "amd64",
                                      digest: "sha256:old",
                                      os: "linux",
                                  },
                              ],
                          }
                        : { results: [{ name: "1.0.0" }] },
            } as Response;
        }) as typeof fetch;
        try {
            await withEnvValue(
                "MIRA_DOCKER_UPDATER_SKIP_REGISTRY",
                undefined,
                async () => {
                    const { __testing } = await import(
                        `./docker.js?manual-skip=${randomUUID()}`
                    );
                    const skipped = await __testing.runManualUpdaterForService(1);
                    assert.equal(skipped.success, true);
                    assert.deepEqual(skipped.output, {
                        serviceId: 1,
                        summary: { updated: 0, failed: 0 },
                        updated: [],
                        failed: [],
                    });
                    const skippedSteps = skipped.steps as Array<{ step: string }>;
                    assert.equal(
                        skippedSteps.some((step) =>
                            step.step.startsWith("manual-update-skipped:")
                        ),
                        true
                    );
                }
            );
        } finally {
            globalThis.fetch = previousFetch;
        }

        await seedDockerUpdaterState(tempDir);
        await withDockerUpdaterFetch(async () => {
            await withEnvValue(
                "MIRA_DOCKER_UPDATER_SKIP_REGISTRY",
                undefined,
                async () => {
                    await withEnvValue("MIRA_FAKE_DOCKER_COMPOSE_FAIL", "1", async () => {
                        const manualFailure = await requestJson<{
                            error: string;
                            success: boolean;
                            result: Record<string, unknown>;
                            service: { lastStatus: string | null };
                            stderr: string;
                            steps: Array<{ ok: boolean; step: string; stderr: string }>;
                        }>(server, "/api/docker/updater/services/1/update", {
                            method: "POST",
                            body: {},
                        });
                        assert.equal(manualFailure.status, 500);
                        assert.equal(manualFailure.body.success, false);
                        assert.equal(
                            manualFailure.body.service.lastStatus,
                            "manual_update_failed"
                        );
                        assert.deepEqual(manualFailure.body.result, {});
                        assert.match(manualFailure.body.error, /compose failed/u);
                        assert.match(manualFailure.body.stderr, /compose failed/u);
                        assert.equal(
                            manualFailure.body.steps.some(
                                (step) =>
                                    !step.ok &&
                                    step.step.startsWith("manual-update:") &&
                                    /compose failed/u.test(step.stderr)
                            ),
                            true
                        );
                    });
                }
            );
        });
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
            { method: "POST", body: { containerId: "app", command: "   " } }
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
