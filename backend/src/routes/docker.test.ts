import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const originalUpdaterNodeBin = process.env.MIRA_UPDATER_NODE_BIN;
const originalUpdaterCwd = process.env.MIRA_UPDATER_CWD;
let fakeUpdaterNodeBin: string;

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
if (args[0] === "exec" && args[1] === "app" && args[2] === "sh" && command.includes("sleep")) {
  process.stdout.write("started long exec\n");
  setInterval(() => {}, 1000);
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
      "3\tmedia\tcurrent\trepo/current:1\trepo/current\t1\t\t1\t\tnotify\ttag\ttrue\t\t\t\tnot-json"
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
process.stderr.write("unexpected docker args: " + command);
process.exit(1);
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    const nodePath = path.join(binDir, "node");
    await writeFile(
        nodePath,
        String.raw`#!${process.execPath}
const script = process.argv[2] || "";
const scriptName = script.split(/[\\/]/u).at(-1);
const stepByScript = {
  "docker-register-services.mjs": "register",
  "docker-registry-poll.mjs": "poll",
  "docker-auto-update.mjs": process.argv.includes("--mode") ? "manual-update" : "auto-update",
  "docker-notify-updates.mjs": "notify",
  "docker-send-discord-newversion.mjs": "discord"
};
const step = stepByScript[scriptName] || "unknown";
if (process.env.MIRA_FAKE_UPDATER_FAIL_STEP === step) {
  if (process.env.MIRA_FAKE_UPDATER_MALFORMED_STDOUT_STEP === step) {
    process.stdout.write("not-json\n");
  } else if (process.env.MIRA_FAKE_UPDATER_BLANK_STDOUT_STEP !== step) {
    process.stdout.write(JSON.stringify({ step, ok: false }) + "\n");
  }
  process.stderr.write(step + " failed\n");
  process.exit(1);
}
if (process.env.MIRA_FAKE_UPDATER_MALFORMED_STDOUT_STEP === step) {
  process.stdout.write("not-json\n");
  process.exit(0);
}
if (process.env.MIRA_FAKE_UPDATER_BLANK_STDOUT_STEP !== step) {
  process.stdout.write("log before json\n" + JSON.stringify({ step, ok: true }) + "\n");
}
process.stderr.write(process.env.MIRA_FAKE_UPDATER_STDERR || "");
`,
        "utf8"
    );
    await chmod(nodePath, 0o755);
    fakeUpdaterNodeBin = nodePath;
    process.env.MIRA_UPDATER_NODE_BIN = nodePath;
    process.env.MIRA_UPDATER_CWD = tempDir;
    const composePath = path.join(binDir, "docker-compose-doppler");
    await writeFile(
        composePath,
        String.raw`#!${process.execPath}
process.stdout.write("compose " + process.argv.slice(2).join(" ") + "\n");
`,
        "utf8"
    );
    await chmod(composePath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

async function startServer(updaterCwd: string): Promise<TestServer> {
    const { default: dockerRoutes, __testing } = await import("./docker.js");
    __testing.setUpdaterNodeBinForTests(fakeUpdaterNodeBin);
    __testing.setUpdaterCwdForTests(updaterCwd);
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

async function withFakeUpdaterFailStep<T>(
    value: string | undefined,
    callback: () => Promise<T>
): Promise<T> {
    const previous = process.env.MIRA_FAKE_UPDATER_FAIL_STEP;
    try {
        if (value === undefined) {
            delete process.env.MIRA_FAKE_UPDATER_FAIL_STEP;
        } else {
            process.env.MIRA_FAKE_UPDATER_FAIL_STEP = value;
        }
        return await callback();
    } finally {
        if (previous === undefined) {
            delete process.env.MIRA_FAKE_UPDATER_FAIL_STEP;
        } else {
            process.env.MIRA_FAKE_UPDATER_FAIL_STEP = previous;
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
        server = await startServer(tempDir);
    });

    after(async () => {
        await server.close();
        const { __testing } = await import("./docker.js");
        await Promise.all(
            [...__testing.dockerExecJobs.values()]
                .map((job) => job.process)
                .filter(Boolean)
                .map((child) => child as ChildProcess)
                .map((child) => stopChildProcess(child))
        );
        __testing.dockerExecJobs.clear();
        process.env.PATH = originalPath;
        delete process.env.MIRA_FAKE_UPDATER_FAIL_STEP;
        delete process.env.MIRA_FAKE_UPDATER_BLANK_STDOUT_STEP;
        delete process.env.MIRA_FAKE_UPDATER_MALFORMED_STDOUT_STEP;
        delete process.env.MIRA_FAKE_UPDATER_STDERR;
        delete process.env.MIRA_FAKE_DOCKER_EMPTY;
        delete process.env.MIRA_FAKE_DOCKER_SPARSE;
        delete process.env.MIRA_FAKE_DOCKER_NON_ARRAY_INSPECT;
        delete process.env.MIRA_FAKE_DOCKER_NUMERIC_IMAGE_SIZE;
        delete process.env.MIRA_FAKE_DOCKER_RM_FAIL;
        delete process.env.MIRA_FAKE_DOCKER_MOUNT_SOURCE_MATCH;
        delete process.env.MIRA_FAKE_DOCKER_SPARSE_EVENTS;
        if (originalDockerRoot === undefined) {
            delete process.env.MIRA_DOCKER_ROOT;
        } else {
            process.env.MIRA_DOCKER_ROOT = originalDockerRoot;
        }
        if (originalUpdaterNodeBin === undefined) {
            delete process.env.MIRA_UPDATER_NODE_BIN;
        } else {
            process.env.MIRA_UPDATER_NODE_BIN = originalUpdaterNodeBin;
        }
        __testing.setUpdaterNodeBinForTests(originalUpdaterNodeBin);
        if (originalUpdaterCwd === undefined) {
            delete process.env.MIRA_UPDATER_CWD;
        } else {
            process.env.MIRA_UPDATER_CWD = originalUpdaterCwd;
        }
        __testing.setUpdaterCwdForTests(originalUpdaterCwd);
        await rm(tempDir, { recursive: true, force: true });
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
                current_tag: "",
                latest_tag: "1.0.1",
            } as never),
            false
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
        assert.deepEqual(await __testing.getContainerInspectMap([]), new Map());
        __testing.setUpdaterNodeBinForTests("node");
        assert.equal(
            __testing.buildPostgresUri(),
            "postgresql://postgres:postgres@postgres:5432/n8n"
        );

        const originalEnv = {
            DATABASE_USERNAME: process.env.DATABASE_USERNAME,
            DATABASE_PASSWORD: process.env.DATABASE_PASSWORD,
            DATABASE_HOST: process.env.DATABASE_HOST,
            DATABASE_PORT: process.env.DATABASE_PORT,
        };
        process.env.DATABASE_USERNAME = "user@name";
        process.env.DATABASE_PASSWORD = "p:a/ss#";
        process.env.DATABASE_HOST = "db";
        process.env.DATABASE_PORT = "6543";
        try {
            assert.equal(
                __testing.buildPostgresUri("custom"),
                "postgresql://user%40name:p%3Aa%2Fss%23@db:6543/custom"
            );
            process.env.DATABASE_USERNAME = "";
            process.env.DATABASE_PASSWORD = "";
            process.env.DATABASE_HOST = "";
            process.env.DATABASE_PORT = "";
            assert.equal(
                __testing.buildPostgresUri(),
                "postgresql://postgres:postgres@postgres:5432/n8n"
            );
        } finally {
            for (const [key, value] of Object.entries(originalEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
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
        let cleanupKilled = false;
        for (let index = 0; index < 102; index += 1) {
            __testing.dockerExecJobs.set(`job-${index}`, {
                id: `job-${index}`,
                containerId: "app",
                status: "running",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: index,
                endedAt: null,
                process:
                    index === 0
                        ? ({
                              killed: false,
                              kill(signal: string) {
                                  assert.equal(signal, "SIGTERM");
                                  cleanupKilled = true;
                              },
                          } as never)
                        : undefined,
            });
        }

        __testing.cleanupDockerExecJobs();
        assert.equal(__testing.dockerExecJobs.size, 100);
        assert.equal(__testing.dockerExecJobs.has("job-0"), false);
        assert.equal(__testing.dockerExecJobs.has("job-1"), false);
        assert.equal(cleanupKilled, true);

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

        let fallbackKilled = false;
        __testing.dockerExecJobs.set("fallback-kill", {
            id: "fallback-kill",
            containerId: "app",
            status: "running",
            code: null,
            stdout: "",
            stderr: "",
            startedAt: Date.now(),
            endedAt: null,
            process: {
                pid: 9_999_999,
                killed: false,
                kill(signal: string) {
                    assert.equal(signal, "SIGTERM");
                    fallbackKilled = true;
                },
            } as never,
        });
        const fallback = await requestJson<{ success: boolean }>(
            server,
            "/api/docker/exec/fallback-kill/stop",
            { method: "POST", body: {} }
        );
        assert.equal(fallback.status, 200);
        assert.equal(fallback.body.success, true);
        assert.equal(fallbackKilled, true);

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
        assert.match(__testing.dockerExecJobs.get("state-fail")?.stderr || "", /after/u);

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
    });

    it("covers docker fallback branches for inspect, image sizes, events cleanup, and exec spawn errors", async () => {
        process.env.MIRA_FAKE_DOCKER_NON_ARRAY_INSPECT = "1";
        try {
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
        } finally {
            delete process.env.MIRA_FAKE_DOCKER_NON_ARRAY_INSPECT;
        }

        process.env.MIRA_FAKE_DOCKER_NUMERIC_IMAGE_SIZE = "1";
        try {
            const images = await requestJson<{ images: Array<{ size: number }> }>(
                server,
                "/api/docker/images"
            );
            assert.equal(images.status, 200);
            assert.equal(images.body.images[0]?.size, 1234);
        } finally {
            delete process.env.MIRA_FAKE_DOCKER_NUMERIC_IMAGE_SIZE;
        }

        process.env.MIRA_FAKE_DOCKER_RM_FAIL = "1";
        try {
            const events = await requestJson<{ events: unknown[] }>(
                server,
                "/api/docker/updater/events"
            );
            assert.equal(events.status, 200);
            assert.equal(events.body.events.length, 1);
        } finally {
            delete process.env.MIRA_FAKE_DOCKER_RM_FAIL;
        }

        process.env.MIRA_FAKE_DOCKER_MOUNT_SOURCE_MATCH = "1";
        try {
            const volumes = await requestJson<{ volumes: Array<{ usedBy: string[] }> }>(
                server,
                "/api/docker/volumes"
            );
            assert.equal(volumes.status, 200);
            assert.deepEqual(
                volumes.body.volumes.map((volume) => volume.usedBy),
                [["app"], ["app"]]
            );
        } finally {
            delete process.env.MIRA_FAKE_DOCKER_MOUNT_SOURCE_MATCH;
        }

        const { __testing } = await import("./docker.js");
        __testing.setDockerBinForTests(path.join(tempDir, "missing-docker"));
        try {
            await assert.rejects(
                () => __testing.runDockerExecCommand("app", "echo hi", "missing-docker"),
                /ENOENT/u
            );
        } finally {
            __testing.setDockerBinForTests("docker");
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
        process.env.MIRA_FAKE_DOCKER_SPARSE = "1";
        try {
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
        } finally {
            delete process.env.MIRA_FAKE_DOCKER_SPARSE;
        }
    });

    it("handles empty docker resource lists", async () => {
        process.env.MIRA_FAKE_DOCKER_EMPTY = "1";
        try {
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
        } finally {
            delete process.env.MIRA_FAKE_DOCKER_EMPTY;
        }
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

        const logsWithDefaultTail = await requestJson<{ content: string }>(
            server,
            "/api/docker/containers/abc123/logs?tail=bad"
        );
        assert.equal(logsWithDefaultTail.status, 200);
        assert.equal(logsWithDefaultTail.body.content, "stdout log\n\nstderr log");

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
        assert.equal(missingContainer.status, 500);
        assert.equal(missingContainer.body.error, "Container not found");
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
        ]);

        process.env.MIRA_FAKE_DOCKER_SPARSE_EVENTS = "1";
        try {
            const sparseEvents = await requestJson<{
                events: Array<{
                    id: number;
                    serviceName: string;
                    message: string | null;
                }>;
            }>(server, "/api/docker/updater/events");
            assert.equal(sparseEvents.status, 200);
            assert.deepEqual(sparseEvents.body.events, [
                {
                    id: 8,
                    managedServiceId: 1,
                    appSlug: "media",
                    serviceName: "",
                    eventType: "",
                    fromTag: null,
                    toTag: null,
                    fromDigest: null,
                    toDigest: null,
                    message: null,
                    createdAt: "",
                },
            ]);
        } finally {
            delete process.env.MIRA_FAKE_DOCKER_SPARSE_EVENTS;
        }

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

        const noUpdate = await requestJson<{ error: string }>(
            server,
            "/api/docker/updater/services/3/update",
            { method: "POST", body: {} }
        );
        assert.equal(noUpdate.status, 400);
        assert.equal(noUpdate.body.error, "No update available for this service");
    });

    it("runs updater pipelines and reports step failures", async () => {
        await withFakeUpdaterFailStep(undefined, async () => {
            const run = await requestJson<{
                success: boolean;
                steps: Array<{ step: string; ok: boolean }>;
            }>(server, "/api/docker/updater/run", { method: "POST", body: {} });
            assert.equal(run.status, 200);
            assert.equal(run.body.success, true);
            assert.deepEqual(
                run.body.steps.map((step) => step.step),
                ["register", "poll", "auto-update", "notify", "discord"]
            );
        });

        await withFakeUpdaterFailStep("poll", async () => {
            const failedRun = await requestJson<{
                success: boolean;
                steps: Array<{ step: string; ok: boolean; stderr: string }>;
            }>(server, "/api/docker/updater/run", { method: "POST", body: {} });
            assert.equal(failedRun.status, 200);
            assert.equal(failedRun.body.success, false);
            assert.deepEqual(
                failedRun.body.steps.map((step) => step.step),
                ["register", "poll"]
            );
            assert.equal(failedRun.body.steps[1]?.stderr, "poll failed\n");
        });

        for (const step of ["register", "auto-update", "notify"]) {
            await withFakeUpdaterFailStep(step, async () => {
                const stepFailure = await requestJson<{
                    success: boolean;
                    steps: Array<{ step: string; ok: boolean }>;
                }>(server, "/api/docker/updater/run", { method: "POST", body: {} });
                assert.equal(stepFailure.status, 200);
                assert.equal(stepFailure.body.success, false);
                assert.equal(stepFailure.body.steps.at(-1)?.step, step);
            });
        }
    });

    it("runs manual updater notification steps and keeps partial failure details", async () => {
        await withFakeUpdaterFailStep(undefined, async () => {
            const success = await requestJson<{
                success: boolean;
                result: { step: string; ok: boolean };
                stderr: string;
            }>(server, "/api/docker/updater/services/1/update", {
                method: "POST",
                body: {},
            });
            assert.equal(success.status, 200);
            assert.equal(success.body.success, true);
            assert.deepEqual(success.body.result, { step: "manual-update", ok: true });
        });

        await withFakeUpdaterFailStep("notify", async () => {
            const notifyFailure = await requestJson<{
                success: boolean;
                result: { step: string; ok: boolean };
                stderr: string;
            }>(server, "/api/docker/updater/services/1/update", {
                method: "POST",
                body: {},
            });
            assert.equal(notifyFailure.status, 200);
            assert.equal(notifyFailure.body.success, false);
            assert.deepEqual(notifyFailure.body.result, {
                step: "manual-update",
                ok: true,
            });
            assert.equal(notifyFailure.body.stderr, "notify failed\n");
        });

        await withFakeUpdaterFailStep("manual-update", async () => {
            const manualFailure = await requestJson<{
                success: boolean;
                result: { step: string; ok: boolean };
                stderr: string;
            }>(server, "/api/docker/updater/services/1/update", {
                method: "POST",
                body: {},
            });
            assert.equal(manualFailure.status, 200);
            assert.equal(manualFailure.body.success, false);
            assert.deepEqual(manualFailure.body.result, {
                step: "manual-update",
                ok: false,
            });
            assert.equal(manualFailure.body.stderr, "manual-update failed\n");
        });

        process.env.MIRA_FAKE_UPDATER_BLANK_STDOUT_STEP = "manual-update";
        try {
            await withFakeUpdaterFailStep(undefined, async () => {
                const blankSuccess = await requestJson<{
                    success: boolean;
                    result: Record<string, never>;
                }>(server, "/api/docker/updater/services/1/update", {
                    method: "POST",
                    body: {},
                });
                assert.equal(blankSuccess.status, 200);
                assert.deepEqual(blankSuccess.body.result, {});
            });

            await withFakeUpdaterFailStep("manual-update", async () => {
                const blankManualFailure = await requestJson<{
                    success: boolean;
                    result: Record<string, never>;
                    stderr: string;
                }>(server, "/api/docker/updater/services/1/update", {
                    method: "POST",
                    body: {},
                });
                assert.equal(blankManualFailure.status, 200);
                assert.equal(blankManualFailure.body.success, false);
                assert.deepEqual(blankManualFailure.body.result, {});
                assert.equal(blankManualFailure.body.stderr, "manual-update failed\n");
            });

            await withFakeUpdaterFailStep("notify", async () => {
                const blankNotifyFailure = await requestJson<{
                    success: boolean;
                    result: Record<string, never>;
                    stderr: string;
                }>(server, "/api/docker/updater/services/1/update", {
                    method: "POST",
                    body: {},
                });
                assert.equal(blankNotifyFailure.status, 200);
                assert.equal(blankNotifyFailure.body.success, false);
                assert.deepEqual(blankNotifyFailure.body.result, {});
                assert.equal(blankNotifyFailure.body.stderr, "notify failed\n");
            });
        } finally {
            delete process.env.MIRA_FAKE_UPDATER_BLANK_STDOUT_STEP;
        }

        process.env.MIRA_FAKE_UPDATER_MALFORMED_STDOUT_STEP = "manual-update";
        try {
            const malformedSuccess = await requestJson<{
                success: boolean;
                result: Record<string, never>;
            }>(server, "/api/docker/updater/services/1/update", {
                method: "POST",
                body: {},
            });
            assert.equal(malformedSuccess.status, 200);
            assert.deepEqual(malformedSuccess.body.result, {});

            await withFakeUpdaterFailStep("manual-update", async () => {
                const malformedManualFailure = await requestJson<{
                    success: boolean;
                    result: Record<string, never>;
                    stderr: string;
                }>(server, "/api/docker/updater/services/1/update", {
                    method: "POST",
                    body: {},
                });
                assert.equal(malformedManualFailure.status, 200);
                assert.equal(malformedManualFailure.body.success, false);
                assert.deepEqual(malformedManualFailure.body.result, {});
                assert.equal(
                    malformedManualFailure.body.stderr,
                    "manual-update failed\n"
                );
            });
        } finally {
            delete process.env.MIRA_FAKE_UPDATER_MALFORMED_STDOUT_STEP;
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
