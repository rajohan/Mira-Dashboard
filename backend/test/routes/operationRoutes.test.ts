import { afterEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { database } from "../../src/database/connection.ts";
import { apiErrorExpectation } from "../support/apiErrorExpectation.ts";
import { startTestScheduledJobExecutor } from "../support/scheduledJobExecutor.ts";
const cleanupCallbacks: Array<() => Promise<void> | void> = [];
function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}
function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() =>
        rmSync(root, {
            force: true,
            recursive: true,
        })
    );
    return root;
}
function writeExecutable(filePath: string, content: string): void {
    writeFileSync(filePath, content);
    chmodSync(filePath, 0o755);
}
function writeFakeBackupDocker(binaryPath: string): void {
    writeExecutable(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pgrep -f"* ]]; then
  printf '%s\n' "__MIRA_CONTAINER_PGREP_NO_MATCH__"
  exit 1
fi
if [[ "$*" == "exec kopia kopia snapshot list --all --json-verbose --json" ]]; then
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  cat <<JSON
[
  {"id":"snap-docker","source":{"path":"/source/docker"},"stats":{"fileCount":2,"totalSize":200,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]},
  {"id":"snap-openclaw","source":{"path":"/source/openclaw"},"stats":{"fileCount":3,"totalSize":300,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]},
  {"id":"snap-projects","source":{"path":"/source/projects"},"stats":{"fileCount":4,"totalSize":400,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]}
]
JSON
  exit 0
fi
if [[ "$*" == "exec walg wal-g backup-list --detail --json" ]]; then
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  cat <<JSON
[
  {"backup_name":"base_0001","finish_time":"$now","start_time":"$now","wal_file_name":"000000010000000000000001","storage_name":"default"}
]
JSON
  exit 0
fi
if [[ "$*" == "exec walg /bin/sh /usr/local/bin/backup-push.sh" ]]; then
  printf '%s\n' "backup ok"
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 2
`
    );
}
function writeFakeDockerCli(binaryPath: string): void {
    writeExecutable(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  'ps -a --format {{json .}}')
    printf '%s\n' '{"ID":"abc123def456","Names":"demo","Image":"repo/app:1.0","Command":"run","CreatedAt":"2026-06-25 00:00:00 +0000 UTC","Labels":"com.docker.compose.project=stack,com.docker.compose.service=web","Mounts":"data","Networks":"bridge","Ports":"80/tcp","RunningFor":"1 hour","State":"running","Status":"Up 1 hour"}'
    ;;
  'stats --no-stream --format {{json .}}')
    printf '%s\n' '{"ID":"abc123def456","CPUPerc":"1.00%","MemPerc":"2.00%","MemUsage":"10MiB / 1GiB","NetIO":"1kB / 2kB","BlockIO":"3kB / 4kB","PIDs":"5"}'
    ;;
  'inspect abc123def456'|'inspect abc123def456 abc123def456')
    if [[ "$MIRA_TEST_DOCKER_INSPECT_FAILURE" == "1" ]]; then
      echo 'container disappeared before inspect' >&2
      exit 1
    fi
    cat <<'JSON'
[{"Id":"abc123def4567890","Created":"2026-06-25T00:00:00Z","Image":"sha256:image123","RestartCount":2,"Config":{"Env":["PUBLIC=value","API_TOKEN=secret","URL=https://user:pass@example.test"],"Labels":{"com.docker.compose.project":"stack","com.docker.compose.service":"web","secret.url":"https://user:pass@example.test"}},"Mounts":[{"Type":"volume","Name":"data","Source":"/var/lib/docker/volumes/data","Destination":"/data","Mode":"rw","RW":true}],"NetworkSettings":{"Networks":{"bridge":{"Gateway":"172.17.0.1","IPAddress":"172.17.0.2","MacAddress":"aa:bb"}}},"State":{"StartedAt":"2026-06-25T00:00:01Z","FinishedAt":"","Health":{"Status":"healthy"}}}]
JSON
    ;;
  'image ls --format {{json .}} --no-trunc')
    printf '%s\n' '{"ID":"sha256:image123","Repository":"repo/app","Tag":"1.0","Size":"12.5MB","CreatedAt":"2026-06-25","Platform":"linux/amd64"}'
    ;;
  'volume ls --format {{json .}}')
    printf '%s\n' '{"Name":"data","Driver":"local","Mountpoint":"/tmp/data","Scope":"local","Labels":"owner=test","Size":"1MB"}'
    ;;
  'logs --tail 50 abc123def456'|'logs --tail 200 abc123def456'|'logs --tail 5000 abc123def456')
    printf '%s\n' 'container log line'
    ;;
  'logs --tail 200 missing')
    echo 'no such container' >&2
    exit 1
    ;;
  exec\ -e\ MIRA_DASHBOARD_EXEC_COMMAND=*\ abc123def4567890\ sh\ -lc*)
    printf '%s\n' '__MIRA_DOCKER_EXEC_PID_fake:123' 'exec output'
    ;;
  'start abc123def4567890'|'stop abc123def4567890'|'restart abc123def4567890'|'start abc123def456'|'stop abc123def456'|'restart abc123def456'|'image rm image123'|'volume rm data'|'image prune -a -f'|'volume prune -f')
    printf '%s\n' "ok: $args"
    ;;
  *)
    echo "unexpected docker args: $args" >&2
    exit 2
    ;;
esac
`
    );
}
function requestWithParameters<T extends string>(
    route: string,
    parameters: Record<T, string>,
    init?: RequestInit
): Request & {
    params: Record<T, string>;
} {
    return Object.assign(new Request(`https://test.local${route}`, init), {
        params: parameters,
    });
}
function jsonRequest(route: string, body: unknown): Request {
    return new Request(`https://test.local${route}`, {
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
    });
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
}
async function startTestScheduledExecutor(): Promise<void> {
    const { stopScheduledJobExecutor } =
        await import("../../src/services/scheduledJobs/runtime.ts");
    startTestScheduledJobExecutor();
    cleanupCallbacks.push(stopScheduledJobExecutor);
}
afterEach(async () => {
    while (cleanupCallbacks.length > 0) await cleanupCallbacks.pop()?.();
    database
        .prepare(
            "DELETE FROM task_updates WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database
        .prepare(
            "DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database.prepare("DELETE FROM tasks WHERE title LIKE 'Coverage %'").run();
    database
        .prepare(
            "DELETE FROM openclaw_cron_job_metadata WHERE job_id LIKE 'coverage-%' OR job_id = 'item-cron'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM notifications WHERE dedupe_key LIKE 'quota:%' OR dedupe_key LIKE 'openclaw:%'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM quota_alert_state WHERE provider IN ('openrouter', 'elevenlabs', 'synthetic', 'openai')"
        )
        .run();
    database.prepare("DELETE FROM openclaw_alert_state WHERE id = 1").run();
    database
        .prepare(
            "DELETE FROM scheduled_job_runs WHERE job_id LIKE 'cache.%' OR job_id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM scheduled_jobs WHERE id LIKE 'cache.%' OR id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM cache_entries WHERE key IN ('quotas.summary', 'system.host', 'system.openclaw', 'git.workspace', 'backup.kopia.status', 'backup.walg.status', 'log_rotation.state', 'weather.spydeberg')"
        )
        .run();
    database.prepare("DELETE FROM cache_entries WHERE key LIKE 'moltbook.%'").run();
    database
        .prepare(
            "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'coverage-%')"
        )
        .run();
    database.prepare("DELETE FROM auth_rate_limit_buckets").run();
    database.prepare("DELETE FROM users WHERE username LIKE 'coverage-%'").run();
});
describe("backend operation routes", () => {
    it("starts manual WAL-G backups through the backup route using fake Docker", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-route-docker-bin-");
        writeFakeBackupDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const { backupRoutes } = await import("../../src/routes/backupRoutes.ts");
        const { registerBackupScheduledJobs } =
            await import("../../src/services/backups/scheduling.ts");
        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            const response = backupRoutes["/api/backups/walg/run"].POST();
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                isOk?: boolean;
                job?: {
                    id?: string;
                    status?: string;
                    type?: string;
                };
            };
            expect(body).toMatchObject({
                isOk: true,
                job: {
                    status: "running",
                    type: "walg",
                },
            });
            let statusBody: Record<string, unknown> = {};
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                statusBody = await responseJson(backupRoutes["/api/backups/walg"].GET());
                if (
                    (
                        statusBody.job as
                            | {
                                  status?: string;
                              }
                            | undefined
                    )?.status === "done"
                )
                    break;
                await Bun.sleep(25);
            }
            expect(statusBody).toMatchObject({
                job: {
                    code: 0,
                    status: "done",
                    stdout: expect.stringContaining("backup ok"),
                    type: "walg",
                },
            });
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("serves Docker inventory and safe mutations through a fake Docker CLI", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DOCKER_COMPOSE_WRAPPER");
        rememberEnvironment("MIRA_TEST_DOCKER_INSPECT_FAILURE");
        rememberEnvironment("MIRA_DOCKER_ROOT");
        const fakeBin = createTemporaryRoot("mira-docker-route-bin-");
        const dockerRoot = createTemporaryRoot("mira-docker-route-root-");
        writeFakeDockerCli(path.join(fakeBin, "docker"));
        writeExecutable(
            path.join(fakeBin, "compose"),
            "#!/usr/bin/env bash\nprintf 'compose:%s\\n' \"$*\"\n"
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER = path.join(fakeBin, "compose");
        process.env.MIRA_DOCKER_ROOT = dockerRoot;
        const { dockerRoutes } = await import("../../src/routes/dockerRoutes.ts");
        const { registerDockerExecutionActions } =
            await import("../../src/services/dockerActions.ts");
        registerDockerExecutionActions();
        await startTestScheduledExecutor();
        const executionBaseline = database
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS rowId FROM job_executions")
            .get() as {
            rowId: number;
        };
        cleanupCallbacks.push(() => {
            database
                .prepare(`DELETE FROM job_executions
                     WHERE rowid > ?
                       AND action_key IN (
                           'docker.stack.action',
                           'docker.container.action',
                           'docker.image.delete',
                           'docker.prune.images',
                           'docker.prune.volumes',
                           'docker.volume.delete'
                       )`)
                .run(executionBaseline.rowId);
        });
        process.env.MIRA_TEST_DOCKER_INSPECT_FAILURE = "1";
        const containerStats = await dockerRoutes["/api/docker/containers/stats"].GET();
        expect(containerStats.json()).resolves.toMatchObject({
            stats: [
                {
                    cpu: "1.00%",
                    id: "abc123def456",
                    memory: "10MiB / 1GiB",
                },
            ],
        });
        process.env.MIRA_TEST_DOCKER_INSPECT_FAILURE = "0";
        const containers = await dockerRoutes["/api/docker/containers"].GET(
            new Request("https://test.local/api/docker/containers")
        );
        const containerEtag = containers.headers.get("etag");
        expect(containers.json()).resolves.toMatchObject({
            containers: [
                {
                    health: "healthy",
                    id: "abc123def456",
                    name: "demo",
                    project: "stack",
                    service: "web",
                    stats: {
                        cpu: "1.00%",
                    },
                },
            ],
            mode: "live",
        });
        expect(containerEtag).toBeTruthy();
        const revalidatedContainers = await dockerRoutes["/api/docker/containers"].GET(
            new Request("https://test.local/api/docker/containers", {
                headers: {
                    "If-None-Match": containerEtag!,
                },
            })
        );
        expect(revalidatedContainers.status).toBe(304);
        const details = await dockerRoutes["/api/docker/containers/:containerId"].GET(
            requestWithParameters("/api/docker/containers/demo", {
                containerId: "demo",
            })
        );
        expect(details.json()).resolves.toMatchObject({
            env: ["PUBLIC=value", "API_TOKEN=***", "URL=***"],
            id: "abc123def456",
            labels: {
                "com.docker.compose.project": "stack",
                "secret.url": "***",
            },
            networks: [
                {
                    ipAddress: "172.17.0.2",
                    name: "bridge",
                },
            ],
        });
        const invalidDetails = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(
            requestWithParameters("/api/docker/containers/-bad", {
                containerId: "-bad",
            })
        );
        expect(invalidDetails.status).toBe(400);
        expect(invalidDetails.json()).resolves.toEqual(
            apiErrorExpectation("Invalid containerId")
        );
        const missingDetails = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(
            requestWithParameters("/api/docker/containers/unknown", {
                containerId: "unknown",
            })
        );
        expect(missingDetails.status).toBe(404);
        expect(missingDetails.json()).resolves.toEqual(
            apiErrorExpectation("Container not found")
        );
        const logs = await dockerRoutes["/api/docker/containers/:containerId/logs"].GET(
            requestWithParameters("/api/docker/containers/abc123def456/logs?tail=10", {
                containerId: "abc123def456",
            })
        );
        expect(logs.json()).resolves.toEqual({
            content: "container log line",
        });
        expect(
            dockerRoutes["/api/docker/containers/:containerId/logs"].GET(
                requestWithParameters("/api/docker/containers/missing/logs?tail=abc", {
                    containerId: "missing",
                })
            )
        ).rejects.toThrow("docker logs failed with exit code 1: no such container");
        const restart = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/demo/action",
                {
                    containerId: "demo",
                },
                {
                    body: JSON.stringify({
                        action: "restart",
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                }
            )
        );
        expect(restart.json()).resolves.toEqual({
            output: "restart sent to demo",
        });
        const invalidContainerAction = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/demo/action",
                {
                    containerId: "demo",
                },
                {
                    body: JSON.stringify({
                        action: "pause",
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                }
            )
        );
        expect(invalidContainerAction.status).toBe(400);
        expect(invalidContainerAction.json()).resolves.toEqual(
            apiErrorExpectation(expect.stringContaining("body.action"), "invalid_request")
        );
        const images = await dockerRoutes["/api/docker/images"].GET();
        expect(images.json()).resolves.toMatchObject({
            images: [
                {
                    id: "sha256:image123",
                    inUseBy: ["demo"],
                    repository: "repo/app",
                    size: 13_107_200,
                    tag: "1.0",
                },
            ],
        });
        const removeImage = await dockerRoutes["/api/docker/images/:imageId"].DELETE(
            requestWithParameters("/api/docker/images/image123", {
                imageId: "image123",
            })
        );
        expect(removeImage.json()).resolves.toEqual({
            isSuccess: true,
        });
        const invalidRemoveImage = await dockerRoutes[
            "/api/docker/images/:imageId"
        ].DELETE(
            requestWithParameters("/api/docker/images/-bad", {
                imageId: "-bad",
            })
        );
        expect(invalidRemoveImage.status).toBe(400);
        const volumes = await dockerRoutes["/api/docker/volumes"].GET();
        expect(volumes.json()).resolves.toMatchObject({
            volumes: [
                {
                    name: "data",
                    size: "1MB",
                    usedBy: ["demo"],
                },
            ],
        });
        const removeVolume = await dockerRoutes["/api/docker/volumes/:volumeName"].DELETE(
            requestWithParameters("/api/docker/volumes/data", {
                volumeName: "data",
            })
        );
        expect(removeVolume.json()).resolves.toEqual({
            isSuccess: true,
        });
        const invalidRemoveVolume = await dockerRoutes[
            "/api/docker/volumes/:volumeName"
        ].DELETE(
            requestWithParameters("/api/docker/volumes/-bad", {
                volumeName: "-bad",
            })
        );
        expect(invalidRemoveVolume.status).toBe(400);
        const pruneImages = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", {
                target: "images",
            })
        );
        expect(pruneImages.json()).resolves.toMatchObject({
            isSuccess: true,
            output: expect.stringContaining("image prune"),
        });
        const pruneVolumes = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", {
                target: "volumes",
            })
        );
        expect(pruneVolumes.json()).resolves.toMatchObject({
            isSuccess: true,
            output: expect.stringContaining("volume prune"),
        });
        const invalidPrune = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", {
                target: "containers",
            })
        );
        expect(invalidPrune.status).toBe(400);
        expect(invalidPrune.json()).resolves.toEqual(
            apiErrorExpectation(expect.stringContaining("body.target"), "invalid_request")
        );
        const malformedPrune = await dockerRoutes["/api/docker/prune"].POST(
            new Request("https://test.local/api/docker/prune", {
                body: "{",
                headers: {
                    "Content-Type": "application/json",
                },
                method: "POST",
            })
        );
        expect(malformedPrune.status).toBe(400);
        expect(malformedPrune.json()).resolves.toEqual(
            apiErrorExpectation("Invalid JSON")
        );
        const stackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", {
                action: "stop",
            })
        );
        expect(stackAction.json()).resolves.toEqual({
            output: "compose:stop",
        });
        const stackServiceAction = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", {
                action: "restart",
                service: "web",
            })
        );
        expect(stackServiceAction.json()).resolves.toEqual({
            output: "compose:restart web",
        });
        const mutationExecutions = database
            .prepare(`SELECT action_key AS actionKey, cancellable, status
                 FROM job_executions
                 WHERE rowid > ?
                   AND action_key IN (
                       'docker.stack.action',
                       'docker.container.action',
                       'docker.image.delete',
                       'docker.prune.images',
                       'docker.prune.volumes',
                       'docker.volume.delete'
                   )
                 ORDER BY rowid`)
            .all(executionBaseline.rowId) as Array<{
            actionKey: string;
            cancellable: number;
            status: string;
        }>;
        expect(mutationExecutions.map((execution) => execution.actionKey)).toEqual([
            "docker.container.action",
            "docker.image.delete",
            "docker.volume.delete",
            "docker.prune.images",
            "docker.prune.volumes",
            "docker.stack.action",
            "docker.stack.action",
        ]);
        expect(
            mutationExecutions.every(
                (execution) =>
                    execution.cancellable === 0 && execution.status === "success"
            )
        ).toBe(true);
        const invalidStackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", {
                action: "reload",
            })
        );
        expect(invalidStackAction.status).toBe(400);
        const invalidStackService = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", {
                action: "start",
                service: "-bad",
            })
        );
        expect(invalidStackService.status).toBe(400);
        const malformedStackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            new Request("https://test.local/api/docker/stack/action", {
                body: "{",
                headers: {
                    "Content-Type": "application/json",
                },
                method: "POST",
            })
        );
        expect(malformedStackAction.status).toBe(400);
        const malformedExecStart = await dockerRoutes["/api/docker/exec/start"].POST(
            new Request("https://test.local/api/docker/exec/start", {
                body: "{",
                headers: {
                    "Content-Type": "application/json",
                },
                method: "POST",
            })
        );
        expect(malformedExecStart.status).toBe(400);
        const invalidExecStart = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", {
                command: "",
                containerId: "demo",
            })
        );
        expect(invalidExecStart.status).toBe(400);
        const missingExecContainer = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", {
                command: "printf ok",
                containerId: "missing",
            })
        );
        expect(missingExecContainer.status).toBe(404);
        const missingAction = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/unknown/action",
                {
                    containerId: "unknown",
                },
                {
                    body: JSON.stringify({
                        action: "start",
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                }
            )
        );
        expect(missingAction.status).toBe(404);
        expect(missingAction.json()).resolves.toEqual(
            apiErrorExpectation("Container not found")
        );
        const execStart = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", {
                command: "printf ok",
                containerId: "demo",
            })
        );
        const { jobId } = (await execStart.json()) as {
            jobId: string;
        };
        expect(jobId).toEqual(expect.any(String));
        expect(
            database
                .prepare(
                    "SELECT resource_class AS resourceClass, timeout_ms AS timeoutMs FROM job_executions WHERE id = ?"
                )
                .get(jobId)
        ).toEqual({
            resourceClass: "exclusive",
            timeoutMs: 7 * 60 * 60 * 1000,
        });
        let execStatus = dockerRoutes["/api/docker/exec/:jobId"].GET(
            requestWithParameters(`/api/docker/exec/${jobId}`, {
                jobId,
            })
        );
        let execData = (await execStatus.json()) as {
            status: string;
            stdout: string;
        };
        const execDeadline = Date.now() + 15_000;
        while (execData.status !== "done" && Date.now() < execDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            execStatus = dockerRoutes["/api/docker/exec/:jobId"].GET(
                requestWithParameters(`/api/docker/exec/${jobId}`, {
                    jobId,
                })
            );
            execData = (await execStatus.json()) as {
                status: string;
                stdout: string;
            };
        }
        expect(execData.status).toBe("done");
        expect(execData).toMatchObject({
            status: "done",
            stdout: expect.stringContaining("exec output"),
        });
        const stopCompletedExec = dockerRoutes["/api/docker/exec/:jobId/stop"].POST(
            requestWithParameters(`/api/docker/exec/${jobId}/stop`, {
                jobId,
            })
        );
        expect(stopCompletedExec.status).toBe(400);
        expect(stopCompletedExec.json()).resolves.toEqual(
            apiErrorExpectation("Job is not running")
        );
    }, 20_000);
    it("returns strict ops log-rotation status cache state", async () => {
        const { opsRoutes } = await import("../../src/routes/opsRoutes.ts");
        const state = {
            lastRun: {
                checkedFiles: 3,
                checkedGroups: 2,
                compressedFiles: 1,
                deletedArchives: 4,
                errors: [
                    {
                        message: "rotation failed",
                        result: {
                            code: "LOCKED",
                        },
                        stderr: "stderr details",
                    },
                ],
                finishedAt: "2026-06-25T00:01:00.000Z",
                groups: [
                    {
                        checkedFiles: 3,
                        compressedFiles: 1,
                        deletedArchives: 4,
                        name: "openclaw",
                        rotatedFiles: 5,
                        skippedFiles: 6,
                    },
                ],
                isDryRun: true,
                isOk: false,
                rotatedFiles: 5,
                skippedFiles: 6,
                startedAt: "2026-06-25T00:00:00.000Z",
                warnings: ["warn"],
            },
        };
        database
            .prepare(
                "INSERT INTO cache_entries (key, data_json, source, updated_at, last_attempt_at, expires_at, status, consecutive_failures, metadata_json) VALUES (?, ?, 'test', ?, ?, ?, 'fresh', 0, '{}') ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, source = excluded.source, status = excluded.status, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, expires_at = excluded.expires_at"
            )
            .run(
                "log_rotation.state",
                JSON.stringify(state),
                Date.now(),
                Date.now(),
                Date.now() + 60_000
            );
        const status = opsRoutes["/api/ops/log-rotation/status"].GET();
        expect(status.json()).resolves.toMatchObject({
            isSuccess: true,
            lastRun: {
                checkedFiles: 3,
                checkedGroups: 2,
                compressedFiles: 1,
                deletedArchives: 4,
                errors: [
                    {
                        message: "rotation failed",
                        result: {
                            code: "LOCKED",
                        },
                        stderr: "stderr details",
                    },
                ],
                isDryRun: true,
                isOk: false,
                rotatedFiles: 5,
                skippedFiles: 6,
                warnings: ["warn"],
            },
        });
        database
            .prepare(
                "UPDATE cache_entries SET data_json = ? WHERE key = 'log_rotation.state'"
            )
            .run("{not-json");
        const malformed = opsRoutes["/api/ops/log-rotation/status"].GET();
        expect(malformed.json()).resolves.toEqual({
            isSuccess: true,
            lastRun: undefined,
        });
        database
            .prepare(
                "UPDATE cache_entries SET data_json = ? WHERE key = 'log_rotation.state'"
            )
            .run(
                JSON.stringify({
                    lastRun: {},
                })
            );
        const invalidLastRun = opsRoutes["/api/ops/log-rotation/status"].GET();
        expect(invalidLastRun.json()).resolves.toEqual({
            isSuccess: true,
            lastRun: undefined,
        });
    });
    it("exec service validation and error normalization branches", async () => {
        const {
            execErrorResponse,
            getExecJob,
            registerExecExecutionActions,
            runExecOnce,
            startExecJob,
            stopExecJob,
        } = await import("../../src/services/execJobs.ts");
        expect(runExecOnce()).rejects.toThrow("request body must be a JSON object");
        expect(
            runExecOnce({
                command: "",
            })
        ).rejects.toThrow("command must be a non-empty string");
        expect(
            runExecOnce({
                command: "x".repeat(4097),
                shell: true,
            })
        ).rejects.toThrow("command exceeds maximum length");
        expect(
            runExecOnce({
                command: "echo\nnope",
                shell: true,
            })
        ).rejects.toThrow("command contains disallowed control characters");
        expect(
            runExecOnce({
                command: "echo",
                shell: "yes",
            })
        ).rejects.toThrow("shell must be a boolean");
        expect(
            runExecOnce({
                args: ["hi"],
                command: "echo",
                shell: true,
            })
        ).rejects.toThrow("args cannot be combined with shell mode");
        expect(
            runExecOnce({
                command: "echo",
                shell: true,
            })
        ).rejects.toThrow("shell mode is only available");
        expect(
            runExecOnce({
                command: "echo",
            })
        ).rejects.toThrow("args are required");
        expect(
            runExecOnce({
                args: "hi",
                command: "bash",
            })
        ).rejects.toThrow("args must be an array");
        expect(
            runExecOnce({
                args: ["hi"],
                command: "./echo",
            })
        ).rejects.toThrow("command must be an approved executable name");
        expect(
            runExecOnce({
                args: ["hi"],
                command: "echo",
            })
        ).rejects.toThrow("command executable is not approved");
        expect(
            runExecOnce({
                args: ["-lc", "echo hi"],
                command: "bash",
            })
        ).rejects.toThrow("bash argv execution requires job tracking");
        expect(() =>
            startExecJob({
                args: ["-c", "echo hi"],
                command: "bash",
            })
        ).toThrow("bash args must be exactly");
        expect(() =>
            startExecJob({
                args: ["-lc", "x".repeat(4097)],
                command: "bash",
            })
        ).toThrow("command exceeds maximum length");
        expect(() =>
            startExecJob({
                args: ["-lc", "echo\nnope"],
                command: "bash",
            })
        ).toThrow("command contains disallowed control characters");
        expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: "relative",
                shell: true,
            })
        ).rejects.toThrow("cwd must be an absolute path");
        const missingCwd = path.join(tmpdir(), "missing-mira-dashboard-exec-cwd");
        expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: missingCwd,
                shell: true,
            })
        ).rejects.toThrow("cwd does not exist");
        registerExecExecutionActions();
        await startTestScheduledExecutor();
        const result = await runExecOnce({
            command: "__mira_dashboard_shell_smoke_test__",
            cwd: process.cwd(),
            shell: true,
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("__mira_dashboard_shell_smoke_test__");
        const teapotError = Object.assign(new Error("nope"), {
            statusCode: 418,
        });
        expect(execErrorResponse(teapotError)).toEqual({
            code: "exec_request_failed",
            message: "nope",
            status: 418,
        });
        expect(execErrorResponse(null)).toEqual({
            code: "exec_internal_error",
            message: "internal server error",
            status: 500,
        });
        expect(() => getExecJob("missing")).toThrow("Exec job not found");
        expect(() => stopExecJob("missing")).toThrow("Exec job not found");
        expect(() =>
            startExecJob({
                command: "",
            })
        ).toThrow("command must be a non-empty string");
        const started = startExecJob({
            command: "__mira_dashboard_shell_smoke_test__",
            cwd: process.cwd(),
            shell: true,
        });
        expect(typeof started.jobId).toBe("string");
        const deadline = Date.now() + 5000;
        let completed = getExecJob(started.jobId);
        while (completed.status === "running" && Date.now() < deadline) {
            await Bun.sleep(10);
            completed = getExecJob(started.jobId);
        }
        expect(completed.status).toBe("done");
        expect(completed.code).not.toBe(0);
        expect(completed.stderr).toContain("__mira_dashboard_shell_smoke_test__");
        expect(() => stopExecJob(started.jobId)).toThrow("Job is not running");
    });
    it("log rotation config validation and dry-run summaries", async () => {
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const { writeCacheSuccess } =
            await import("../../src/services/cacheEntryWriter.ts");
        const root = createTemporaryRoot("mira-log-rotation-");
        const logFile = path.join(root, "service.log");
        const excludedFile = path.join(root, "excluded.log");
        writeFileSync(logFile, "line 1\nline 2\n");
        writeFileSync(excludedFile, "skip me\n");
        const validConfig = path.join(root, "log-rotation.json");
        writeFileSync(
            validConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: {
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                },
                groups: [
                    {
                        name: "app",
                        paths: [path.join(root, "*.log")],
                        excludePaths: [excludedFile],
                        strategy: "copytruncate",
                    },
                    {
                        enabled: false,
                        name: "disabled",
                        paths: [logFile],
                    },
                ],
            })
        );
        const summary = await runLogRotationService({
            config: validConfig,
            group: "app",
            isDryRun: true,
            verbose: true,
        });
        expect(summary.isOk).toBe(true);
        expect(summary.checkedGroups).toBe(1);
        expect(summary.checkedFiles).toBe(1);
        expect(summary.rotatedFiles).toBe(1);
        expect(summary.skippedFiles).toBe(0);
        const badVersionConfig = path.join(root, "bad-version.json");
        writeFileSync(
            badVersionConfig,
            JSON.stringify({
                version: 2,
                groups: [
                    {
                        name: "app",
                        paths: [logFile],
                    },
                ],
            })
        );
        expect(
            runLogRotationService({
                config: badVersionConfig,
                isDryRun: true,
            })
        ).rejects.toThrow("Config version must be 1");
        const missingPathsConfig = path.join(root, "missing-paths.json");
        writeFileSync(
            missingPathsConfig,
            JSON.stringify({
                version: 1,
                groups: [
                    {
                        name: "app",
                    },
                ],
            })
        );
        expect(
            runLogRotationService({
                config: missingPathsConfig,
                isDryRun: true,
            })
        ).rejects.toThrow("Group app needs at least one path pattern");
        const conflictingCadenceConfig = path.join(root, "conflicting-cadence.json");
        writeFileSync(
            conflictingCadenceConfig,
            JSON.stringify({
                version: 1,
                groups: [
                    {
                        daily: true,
                        name: "app",
                        paths: [logFile],
                        weekly: true,
                    },
                ],
            })
        );
        expect(
            runLogRotationService({
                config: conflictingCadenceConfig,
                isDryRun: true,
            })
        ).rejects.toThrow("cannot set both daily and weekly");
        const invalidPolicyConfigs = [
            {
                config: {
                    version: 1,
                    approvedRoots: [],
                    groups: [
                        {
                            name: "app",
                            paths: [logFile],
                        },
                    ],
                },
                message: "approvedRoots must include at least one entry",
                name: "empty-approved-roots.json",
            },
            {
                config: {
                    version: 1,
                    groups: [
                        {
                            enabled: "yes",
                            name: "app",
                            paths: [logFile],
                        },
                    ],
                },
                message: "Group app.enabled must be a boolean",
                name: "invalid-enabled.json",
            },
            {
                config: {
                    version: 1,
                    groups: [
                        {
                            keep: 0,
                            name: "app",
                            paths: [logFile],
                        },
                    ],
                },
                message: "Group app.keep must be a positive integer",
                name: "invalid-keep.json",
            },
            {
                config: {
                    version: 1,
                    groups: [
                        {
                            archiveOnly: true,
                            archiveRetentionScope: "global",
                            archivePaths: [path.join(root, "*.archive")],
                            name: "archives",
                        },
                    ],
                },
                message:
                    "Group archives archiveRetentionScope must be directory, basename, or parent",
                name: "invalid-archive-scope.json",
            },
            {
                config: {
                    version: 1,
                    groups: [
                        {
                            archiveOnly: true,
                            name: "archives",
                        },
                    ],
                },
                message:
                    "Archive-only group archives needs at least one archivePaths pattern",
                name: "archive-only-missing-paths.json",
            },
        ];
        for (const invalid of invalidPolicyConfigs) {
            const filePath = path.join(root, invalid.name);
            writeFileSync(filePath, JSON.stringify(invalid.config));
            expect(
                runLogRotationService({
                    config: filePath,
                    isDryRun: true,
                })
            ).rejects.toThrow(invalid.message);
        }
        const emptyLogFile = path.join(root, "empty.log");
        const dailyLogFile = path.join(root, "daily.log");
        writeFileSync(emptyLogFile, "");
        writeFileSync(dailyLogFile, "already rotated today\n");
        writeCacheSuccess({
            data: {
                version: 1,
                files: {
                    [dailyLogFile]: {
                        lastRotatedAt: new Date().toISOString(),
                    },
                },
            },
            key: "log_rotation.state",
            metadata: {},
            source: "test",
            ttl: 1,
            ttlUnit: "hours",
        });
        const skipConfig = path.join(root, "skip-log-rotation.json");
        writeFileSync(
            skipConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: {
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    shouldCompress: false,
                    strategy: "copytruncate",
                },
                groups: [
                    {
                        name: "empty",
                        paths: [emptyLogFile],
                        skipEmpty: true,
                    },
                    {
                        daily: true,
                        maxSizeMb: 100,
                        name: "daily",
                        paths: [dailyLogFile],
                    },
                ],
            })
        );
        const skipSummary = await runLogRotationService({
            config: skipConfig,
            isDryRun: true,
        });
        expect(skipSummary).toMatchObject({
            checkedFiles: 2,
            isOk: true,
            rotatedFiles: 0,
            skippedFiles: 2,
        });
        const liveLogFile = path.join(root, "live.log");
        writeFileSync(liveLogFile, "rotated bytes\n");
        const liveConfig = path.join(root, "live-log-rotation.json");
        writeFileSync(
            liveConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: {
                    compress: false,
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    shouldCompress: false,
                    skipEmpty: false,
                    strategy: "copytruncate",
                },
                groups: [
                    {
                        name: "live",
                        paths: [liveLogFile],
                    },
                ],
            })
        );
        const liveSummary = await runLogRotationService({
            config: liveConfig,
            group: "live",
            isDryRun: false,
        });
        expect(liveSummary).toMatchObject({
            checkedFiles: 1,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(liveLogFile, "utf8")).toBe("");
        const archiveName = readdirSync(root).find((entry) =>
            entry.startsWith("live.log.202")
        );
        expect(archiveName).toBeDefined();
        const archivePath = path.join(root, archiveName ?? "");
        expect(existsSync(archivePath)).toBe(true);
        expect(readFileSync(archivePath, "utf8")).toBe("rotated bytes\n");
        const renameLogFile = path.join(root, "rename.log");
        writeFileSync(renameLogFile, "rename bytes\n");
        const renameConfig = path.join(root, "rename-log-rotation.json");
        writeFileSync(
            renameConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: {
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    shouldCompress: true,
                    skipEmpty: false,
                    strategy: "rename",
                },
                groups: [
                    {
                        name: "rename",
                        paths: [renameLogFile],
                    },
                ],
            })
        );
        const renameSummary = await runLogRotationService({
            config: renameConfig,
            group: "rename",
            isDryRun: false,
        });
        const hasCompressionStream = "CompressionStream" in globalThis;
        expect(renameSummary).toMatchObject({
            compressedFiles: hasCompressionStream ? 1 : 0,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(renameLogFile, "utf8")).toBe("");
        const compressedRenameArchive = readdirSync(root).find((entry) =>
            entry.startsWith("rename.log.202")
        );
        expect(compressedRenameArchive).toBeDefined();
        if (hasCompressionStream) {
            expect(compressedRenameArchive?.endsWith(".gz")).toBe(true);
            const compressedRenameArchiveBytes = readFileSync(
                path.join(root, compressedRenameArchive ?? "")
            );
            expect(gunzipSync(compressedRenameArchiveBytes).toString("utf8")).toBe(
                "rename bytes\n"
            );
        } else {
            expect(compressedRenameArchive?.endsWith(".gz")).toBe(false);
            expect(
                readFileSync(path.join(root, compressedRenameArchive ?? ""), "utf8")
            ).toBe("rename bytes\n");
        }
        const archiveOnlyOld = path.join(root, "old.archive");
        const archiveOnlyNew = path.join(root, "new.archive");
        writeFileSync(archiveOnlyOld, "old archive\n");
        writeFileSync(archiveOnlyNew, "new archive\n");
        const oldDate = new Date(Date.now() - 60_000);
        const newDate = new Date();
        utimesSync(archiveOnlyOld, oldDate, oldDate);
        utimesSync(archiveOnlyNew, newDate, newDate);
        const archiveOnlyConfig = path.join(root, "archive-only-log-rotation.json");
        writeFileSync(
            archiveOnlyConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                groups: [
                    {
                        archiveOnly: true,
                        archivePaths: [path.join(root, "*.archive")],
                        keep: 1,
                        name: "archives",
                        shouldCompress: true,
                    },
                ],
            })
        );
        const archiveOnlySummary = await runLogRotationService({
            config: archiveOnlyConfig,
            isDryRun: true,
        });
        expect(archiveOnlySummary).toMatchObject({
            checkedFiles: 2,
            compressedFiles: 1,
            deletedArchives: 1,
            isDryRun: true,
            isOk: true,
        });
        expect(archiveOnlySummary.warnings).toEqual([]);
        expect(existsSync(archiveOnlyOld)).toBe(true);
        expect(existsSync(archiveOnlyNew)).toBe(true);
        const archiveOnlyLiveSummary = await runLogRotationService({
            config: archiveOnlyConfig,
            isDryRun: false,
        });
        expect(archiveOnlyLiveSummary).toMatchObject({
            checkedFiles: 2,
            compressedFiles: hasCompressionStream ? 1 : 0,
            deletedArchives: 1,
            isDryRun: false,
            isOk: true,
        });
        if (!hasCompressionStream) {
            const compressionWarning = expect.objectContaining({
                message: expect.stringContaining("Compression failed"),
            });
            expect(archiveOnlyLiveSummary.warnings).toEqual(
                expect.arrayContaining([compressionWarning])
            );
        }
        expect(existsSync(archiveOnlyOld)).toBe(false);
        if (hasCompressionStream) {
            expect(existsSync(archiveOnlyNew)).toBe(false);
            expect(
                gunzipSync(readFileSync(`${archiveOnlyNew}.gz`)).toString("utf8")
            ).toBe("new archive\n");
        } else {
            expect(existsSync(archiveOnlyNew)).toBe(true);
            expect(readFileSync(archiveOnlyNew, "utf8")).toBe("new archive\n");
        }
    });
});
