import { describe, expect, it, jest } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { database } from "../../src/database/connection.ts";
import * as processModule from "../../src/lib/processes.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
describe("backend backup services", () => {
    const {
        createTemporaryRoot,
        readableUtf8Stream,
        rememberEnvironment,
        startTestScheduledExecutor,
        waitFor,
        writeFailingWalgPreflightDocker,
        writeFakeDocker,
        writeFakePgrep,
    } = createServiceBehaviorHarness();
    it("returns conflict/not-found errors for clearing inactive backup jobs", async () => {
        const { clearNeedsAttentionBackupJob, mapBackupJob } =
            await import("../../src/services/backups/backupJobs.ts");
        expect(mapBackupJob()).toBeUndefined();
        expect(
            mapBackupJob({
                code: 0,
                completed: Promise.resolve(undefined as never),
                endedAt: 456,
                id: "backup-test",
                startedAt: 123,
                status: "done",
                stderr: "",
                stdout: "ok",
                type: "kopia",
            })
        ).toEqual({
            code: 0,
            endedAt: 456,
            id: "backup-test",
            startedAt: 123,
            status: "done",
            stderr: "",
            stdout: "ok",
            type: "kopia",
        });
        expect(clearNeedsAttentionBackupJob("kopia")).rejects.toMatchObject({
            statusCode: 404,
        });
        expect(clearNeedsAttentionBackupJob("walg")).rejects.toThrow(
            "WALG backup job not found"
        );
    });
    it("runs manual WAL-G backups through fake Docker and records scheduled metadata", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-docker-bin-");
        writeFakeDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const {
            clearNeedsAttentionBackupJob,
            getCurrentBackupJob,
            registerBackupScheduledJobs,
            startManualBackup,
        } = await Promise.all([
            import("../../src/services/backups/backupJobs.ts"),
            import("../../src/services/backups/scheduling.ts"),
            import("../../src/services/backups/backupProviders.ts"),
        ]).then(([module0, module1, module2]) => ({
            clearNeedsAttentionBackupJob: module0.clearNeedsAttentionBackupJob,
            getCurrentBackupJob: module0.getCurrentBackupJob,
            registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
            startManualBackup: module2.startManualBackup,
        }));
        const { getScheduledJob, runScheduledJob, upsertScheduledJob } =
            await Promise.all([
                import("../../src/services/scheduledJobs/repository.ts"),
                import("../../src/services/scheduledJobs/enqueue.ts"),
            ]).then(([module0, module1]) => ({
                getScheduledJob: module0.getScheduledJob,
                runScheduledJob: module1.runScheduledJob,
                upsertScheduledJob: module0.upsertScheduledJob,
            }));
        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            expect(getScheduledJob("backup.walg")).toMatchObject({
                actionKey: "backup.run",
                enabled: true,
                scheduleType: "daily",
                timeOfDay: "03:20",
            });
            upsertScheduledJob({
                id: "backup.invalid",
                name: "Invalid backup",
                enabled: false,
                scheduleType: "interval",
                intervalSeconds: 3600,
                actionKey: "backup.run",
                actionPayload: {
                    type: "invalid",
                },
            });
            const invalidRun = await runScheduledJob("backup.invalid");
            expect(invalidRun).toMatchObject({
                jobId: "backup.invalid",
                status: "failed",
            });
            const job = await startManualBackup("walg");
            const completed = await job.completed;
            expect(completed).toMatchObject({
                code: 0,
                status: "done",
                stdout: expect.stringContaining("backup ok"),
                type: "walg",
            });
            expect(clearNeedsAttentionBackupJob("walg")).rejects.toMatchObject({
                statusCode: 404,
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("reports WAL-G preflight failures without starting a backup job", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-preflight-bin-");
        writeFailingWalgPreflightDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await Promise.all([
                import("../../src/services/backups/backupJobs.ts"),
                import("../../src/services/backups/scheduling.ts"),
                import("../../src/services/backups/backupProviders.ts"),
            ]).then(([module0, module1, module2]) => ({
                getCurrentBackupJob: module0.getCurrentBackupJob,
                registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
                startManualBackup: module2.startManualBackup,
            }));
        try {
            registerBackupScheduledJobs();
            expect(startManualBackup("walg")).rejects.toMatchObject({
                statusCode: 503,
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("cleans backup route state when backup process spawn fails", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-spawn-fail-bin-");
        writeFakeDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const processModule = await import("../../src/lib/processes.ts");
        const spawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation(() => {
                throw new Error("spawn unavailable");
            });
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await Promise.all([
                import("../../src/services/backups/backupJobs.ts"),
                import("../../src/services/backups/scheduling.ts"),
                import("../../src/services/backups/backupProviders.ts"),
            ]).then(([module0, module1, module2]) => ({
                getCurrentBackupJob: module0.getCurrentBackupJob,
                registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
                startManualBackup: module2.startManualBackup,
            }));
        try {
            registerBackupScheduledJobs();
            expect(startManualBackup("walg")).rejects.toThrow("spawn unavailable");
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("reuses an already running WAL-G backup job instead of spawning another", async () => {
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await Promise.all([
                import("../../src/services/backups/backupJobs.ts"),
                import("../../src/services/backups/scheduling.ts"),
                import("../../src/services/backups/backupProviders.ts"),
            ]).then(([module0, module1, module2]) => ({
                getCurrentBackupJob: module0.getCurrentBackupJob,
                registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
                startManualBackup: module2.startManualBackup,
            }));
        const exit = Promise.withResolvers<number>();
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((_command, arguments_) => {
                return Promise.try(() => {
                    const joined = arguments_.join(" ");
                    if (joined.includes("pgrep -f")) {
                        return {
                            code: 1,
                            stderr: "",
                            stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                        };
                    }
                    if (joined.includes("wal-g backup-list")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "[]",
                        };
                    }
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "",
                    };
                });
            });
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: exit.promise,
                    kill: () => {},
                    pid: 789,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream("backup still running\n"),
                }) as unknown as processModule.BunProcess
        );
        try {
            registerBackupScheduledJobs();
            const first = await startManualBackup("walg");
            const second = await startManualBackup("walg");
            expect(second.id).toBe(first.id);
            expect(spawnSpy).toHaveBeenCalledTimes(1);
            exit.resolve(0);
            expect(first.completed).resolves.toMatchObject({
                code: 0,
                status: "done",
            });
            expect(getCurrentBackupJob("walg")).toMatchObject({
                id: first.id,
                status: "done",
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("trims oversized output in the worker backup primitive", async () => {
        const { getCurrentBackupJob, startManualBackup } = await Promise.all([
            import("../../src/services/backups/backupJobs.ts"),
            import("../../src/services/backups/backupProviders.ts"),
        ]).then(([module0, module1]) => ({
            getCurrentBackupJob: module0.getCurrentBackupJob,
            startManualBackup: module1.startManualBackup,
        }));
        const largeOutput = `${"x".repeat(100_200)}tail-marker\n`;
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((_command, arguments_) => {
                return Promise.try(() => {
                    const joined = arguments_.join(" ");
                    if (joined.includes("pgrep -f")) {
                        return {
                            code: 1,
                            stderr: "",
                            stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                        };
                    }
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "",
                    };
                });
            });
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(0),
                    kill: () => {},
                    pid: 123,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(largeOutput),
                }) as unknown as processModule.BunProcess
        );
        try {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
            const job = await startManualBackup("walg");
            const completed = await job.completed;
            expect(spawnSpy).toHaveBeenCalledTimes(1);
            expect(completed).toMatchObject({
                code: 0,
                status: "done",
                type: "walg",
            });
            expect(completed.stdout.length).toBeLessThanOrEqual(100_000);
            expect(completed.stdout).toEndWith("tail-marker\n");
            expect(
                database
                    .prepare(
                        "SELECT COUNT(*) AS count FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'"
                    )
                    .get()
            ).toEqual({
                count: 0,
            });
            expect(getCurrentBackupJob("walg")).toMatchObject({
                status: "done",
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("records backup process promise failures after startup", async () => {
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await Promise.all([
                import("../../src/services/backups/backupJobs.ts"),
                import("../../src/services/backups/scheduling.ts"),
                import("../../src/services/backups/backupProviders.ts"),
            ]).then(([module0, module1, module2]) => ({
                getCurrentBackupJob: module0.getCurrentBackupJob,
                registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
                startManualBackup: module2.startManualBackup,
            }));
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((_command, arguments_) => {
                return Promise.try(() => {
                    const joined = arguments_.join(" ");
                    if (joined.includes("pgrep -f")) {
                        return {
                            code: 1,
                            stderr: "",
                            stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                        };
                    }
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "",
                    };
                });
            });
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.reject(new Error("child process promise failed")),
                    kill: () => {},
                    pid: 123,
                    stderr: readableUtf8Stream("stderr before failure\n"),
                    stdout: readableUtf8Stream("stdout before failure\n"),
                }) as unknown as processModule.BunProcess
        );
        try {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
            registerBackupScheduledJobs();
            const job = await startManualBackup("walg");
            const completed = await job.completed;
            expect(spawnSpy).toHaveBeenCalledTimes(1);
            expect(completed).toMatchObject({
                code: 1,
                status: "done",
                type: "walg",
            });
            expect(completed.stdout).toContain("stdout before failure");
            expect(completed.stderr).toContain("stderr before failure");
            expect(completed.stderr).toContain("child process promise failed");
            expect(getCurrentBackupJob("walg")).toMatchObject({
                status: "done",
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("cancels queued backups before worker preflight starts", async () => {
        const { getCurrentBackupJob, registerBackupScheduledJobs } = await Promise.all([
            import("../../src/services/backups/backupJobs.ts"),
            import("../../src/services/backups/scheduling.ts"),
        ]).then(([module0, module1]) => ({
            getCurrentBackupJob: module0.getCurrentBackupJob,
            registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
        }));
        const { cancelJobExecution } =
            await import("../../src/services/jobExecutionQueue/worker.ts");
        const { enqueueScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        try {
            registerBackupScheduledJobs();
            const run = enqueueScheduledJob("backup.walg", "manual");
            cancelJobExecution(run.executionId as string);
            expect(
                database
                    .prepare(
                        "SELECT job_id AS jobId, status FROM scheduled_job_runs WHERE id = ?"
                    )
                    .get(run.id)
            ).toMatchObject({
                jobId: "backup.walg",
                status: "cancelled",
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("marks scheduled backups failed when the spawned process exits nonzero", async () => {
        const { registerBackupScheduledJobs } =
            await import("../../src/services/backups/scheduling.ts");
        const { runScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((_command, arguments_) => {
                return Promise.try(() => {
                    const joined = arguments_.join(" ");
                    if (joined.includes("pgrep -f")) {
                        return {
                            code: 1,
                            stderr: "",
                            stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                        };
                    }
                    if (joined.includes("wal-g backup-list")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "[]",
                        };
                    }
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "",
                    };
                });
            });
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(2),
                    kill: () => {},
                    pid: 456,
                    stderr: readableUtf8Stream("backup exploded\n"),
                    stdout: readableUtf8Stream("backup started\n"),
                }) as unknown as processModule.BunProcess
        );
        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("backup.walg");
            expect(run).toMatchObject({
                jobId: "backup.walg",
                status: "failed",
            });
            expect(run.message).toContain("WALG backup failed with code 2");
            expect(run.message).toContain("backup exploded");
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("runs scheduled Kopia backups through host preflight and records success", async () => {
        const { registerBackupScheduledJobs } =
            await import("../../src/services/backups/scheduling.ts");
        const { runScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((command, arguments_) => {
                return Promise.try(() => {
                    if (command === "pgrep") {
                        expect(arguments_).toEqual([
                            "-f",
                            "/opt/docker/apps/kopia/backup.sh",
                        ]);
                        return {
                            code: 1,
                            stderr: "",
                            stdout: "",
                        };
                    }
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "{}",
                    };
                });
            });
        const spawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation((command, arguments_) => {
                expect(command).toBe("bash");
                expect(arguments_).toEqual(["-lc", "/opt/docker/apps/kopia/backup.sh"]);
                return {
                    exited: Promise.resolve(0),
                    kill: () => {},
                    pid: 654,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream("kopia ok\n"),
                } as unknown as processModule.BunProcess;
            });
        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("backup.kopia");
            expect(run).toMatchObject({
                jobId: "backup.kopia",
                status: "success",
            });
            expect(run.output).toMatchObject({
                backup: {
                    code: 0,
                    status: "done",
                    stdout: "kopia ok\n",
                    type: "kopia",
                },
            });
            expect(spawnSpy).toHaveBeenCalledTimes(1);
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("terminates running WAL-G backups when a scheduled run is aborted", async () => {
        const { getCurrentBackupJob, registerBackupScheduledJobs } = await Promise.all([
            import("../../src/services/backups/backupJobs.ts"),
            import("../../src/services/backups/scheduling.ts"),
        ]).then(([module0, module1]) => ({
            getCurrentBackupJob: module0.getCurrentBackupJob,
            registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
        }));
        const { cancelJobExecution } =
            await import("../../src/services/jobExecutionQueue/worker.ts");
        const { waitForJobExecution } =
            await import("../../src/services/queuedJobExecution.ts");
        const { enqueueScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        const exit = Promise.withResolvers<number>();
        const runProcessCalls: string[] = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((command, arguments_) => {
                return Promise.try(() => {
                    const joined = `${command} ${arguments_.join(" ")}`;
                    runProcessCalls.push(joined);
                    if (joined.includes("pgrep -f")) {
                        return {
                            code: 1,
                            stderr: "",
                            stdout: "__MIRA_CONTAINER_PGREP_NO_MATCH__\n",
                        };
                    }
                    if (joined.includes("pkill")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "",
                        };
                    }
                    if (joined.includes("wal-g backup-list")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "[]",
                        };
                    }
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "",
                    };
                });
            });
        const killSignals: NodeJS.Signals[] = [];
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: exit.promise,
                    kill: (signal: NodeJS.Signals) => {
                        killSignals.push(signal);
                    },
                    pid: undefined,
                    stderr: readableUtf8Stream("backup output before abort\n"),
                    stdout: readableUtf8Stream(""),
                }) as unknown as processModule.BunProcess
        );
        try {
            registerBackupScheduledJobs();
            await startTestScheduledExecutor();
            const run = enqueueScheduledJob("backup.walg", "manual");
            await waitFor(() => spawnSpy.mock.calls.length === 1, 3000);
            cancelJobExecution(run.executionId as string);
            await waitFor(() => killSignals.includes("SIGTERM"), 3000);
            exit.resolve(143);
            const execution = await waitForJobExecution(run.executionId as string, {
                timeoutMs: 3000,
            });
            expect(execution.status).toBe("cancelled");
            expect(execution.message).toBe("Job cancelled");
            expect(killSignals).toContain("SIGTERM");
            expect(runProcessCalls).toEqual(
                expect.arrayContaining([
                    expect.stringContaining("pkill -TERM"),
                    expect.stringContaining("pgrep -f"),
                ])
            );
            expect(getCurrentBackupJob("walg")).toMatchObject({
                code: 130,
                stderr: expect.stringContaining("Backup aborted by scheduler"),
                status: "done",
            });
        } finally {
            runProcessSpy.mockRestore();
            spawnSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("records and clears WAL-G needs-attention state when container preflight detects a running process", async () => {
        const {
            clearPersistedBackupAttention,
            getCurrentBackupJob,
            getPersistedBackupJob,
            mapBackupJob,
            registerBackupScheduledJobs,
            startManualBackup,
        } = await Promise.all([
            import("../../src/services/backups/scheduling.ts"),
            import("../../src/services/backups/backupJobs.ts"),
            import("../../src/services/backups/backupProviders.ts"),
        ]).then(([module0, module1, module2]) => ({
            clearPersistedBackupAttention: module0.clearPersistedBackupAttention,
            getCurrentBackupJob: module1.getCurrentBackupJob,
            getPersistedBackupJob: module0.getPersistedBackupJob,
            mapBackupJob: module1.mapBackupJob,
            registerBackupScheduledJobs: module0.registerBackupScheduledJobs,
            startManualBackup: module2.startManualBackup,
        }));
        const { runScheduledJob, stopScheduledJobExecutor } = await Promise.all([
            import("../../src/services/scheduledJobs/enqueue.ts"),
            import("../../src/services/scheduledJobs/runtime.ts"),
        ]).then(([module0, module1]) => ({
            runScheduledJob: module0.runScheduledJob,
            stopScheduledJobExecutor: module1.stopScheduledJobExecutor,
        }));
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((_command, arguments_) => {
                return Promise.try(() => {
                    const joined = arguments_.join(" ");
                    if (joined.includes("pgrep -f")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "23456\n",
                        };
                    }
                    if (joined.includes("wal-g backup-list")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "[]",
                        };
                    }
                    throw new Error(`Unexpected backup command: ${joined}`);
                });
            });
        try {
            registerBackupScheduledJobs();
            const scheduledRun = runScheduledJob("backup.walg");
            await startTestScheduledExecutor();
            expect(scheduledRun).resolves.toMatchObject({
                output: {
                    backup: {
                        code: 130,
                        status: "needs_attention",
                        stderr: expect.stringContaining(
                            "backup process is still running"
                        ),
                        type: "walg",
                    },
                },
                status: "failed",
            });
            expect(mapBackupJob(getCurrentBackupJob("walg"))).toMatchObject({
                code: 130,
                status: "needs_attention",
                stderr: expect.stringContaining("backup process is still running"),
                type: "walg",
            });
            expect(startManualBackup("walg")).rejects.toThrow(
                "WALG backup needs attention"
            );
            expect(getPersistedBackupJob("walg")).toMatchObject({
                code: 130,
                status: "needs_attention",
                stderr: expect.stringContaining("backup process is still running"),
                type: "walg",
            });
            const clearedJob = await clearPersistedBackupAttention("walg");
            expect(clearedJob).toMatchObject({
                status: "needs_attention",
                type: "walg",
            });
            expect(getCurrentBackupJob("walg")).toBeUndefined();
            expect(getPersistedBackupJob("walg")).toBeUndefined();
        } finally {
            await stopScheduledJobExecutor();
            runProcessSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    }, 10_000);
    it("clears persisted backup attention without in-memory worker state", async () => {
        const {
            clearPersistedBackupAttention,
            getCurrentBackupJob,
            getPersistedBackupJob,
            queueManualBackup,
            registerBackupScheduledJobs,
        } = await Promise.all([
            import("../../src/services/backups/scheduling.ts"),
            import("../../src/services/backups/backupJobs.ts"),
        ]).then(([module0, module1]) => ({
            clearPersistedBackupAttention: module0.clearPersistedBackupAttention,
            getCurrentBackupJob: module1.getCurrentBackupJob,
            getPersistedBackupJob: module0.getPersistedBackupJob,
            queueManualBackup: module0.queueManualBackup,
            registerBackupScheduledJobs: module0.registerBackupScheduledJobs,
        }));
        const { enqueueScheduledJob, runScheduledJob, stopScheduledJobExecutor } =
            await Promise.all([
                import("../../src/services/scheduledJobs/enqueue.ts"),
                import("../../src/services/scheduledJobs/runtime.ts"),
            ]).then(([module0, module1]) => ({
                enqueueScheduledJob: module0.enqueueScheduledJob,
                runScheduledJob: module0.runScheduledJob,
                stopScheduledJobExecutor: module1.stopScheduledJobExecutor,
            }));
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((_command, arguments_) => {
                return Promise.try(() => {
                    const joined = arguments_.join(" ");
                    if (joined.includes("wal-g backup-list")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "[]",
                        };
                    }
                    throw new Error(`Unexpected backup command: ${joined}`);
                });
            });
        try {
            registerBackupScheduledJobs();
            const run = enqueueScheduledJob("backup.walg", "manual");
            const executionId = run.executionId;
            if (!executionId) throw new Error("Backup execution id was missing");
            const completedAt = "2026-07-22T02:00:00.000Z";
            const backup = {
                code: 130,
                endedAt: Date.parse(completedAt),
                id: Bun.randomUUIDv7(),
                startedAt: Date.parse(completedAt),
                status: "needs_attention",
                stderr: "Worker restarted before attention was cleared",
                stdout: "",
                type: "walg",
            };
            database
                .prepare(`UPDATE job_executions
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'WALG backup needs attention', output_json = ?
                     WHERE id = ?`)
                .run(
                    completedAt,
                    completedAt,
                    JSON.stringify({
                        backup,
                    }),
                    executionId
                );
            database
                .prepare(`UPDATE scheduled_job_runs
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'WALG backup needs attention', output_json = ?
                     WHERE id = ?`)
                .run(
                    completedAt,
                    completedAt,
                    JSON.stringify({
                        backup,
                    }),
                    run.id
                );
            expect(getCurrentBackupJob("walg")).toBeUndefined();
            expect(getPersistedBackupJob("walg")).toMatchObject(backup);
            expect(() => queueManualBackup("walg")).toThrow(
                "WALG backup needs attention"
            );
            const scheduledRun = runScheduledJob("backup.walg");
            await startTestScheduledExecutor();
            expect(scheduledRun).resolves.toMatchObject({
                output: {
                    backup,
                },
                status: "failed",
            });
            expect(getPersistedBackupJob("walg")).toMatchObject(backup);
            expect(clearPersistedBackupAttention("walg")).resolves.toMatchObject({
                code: backup.code,
                endedAt: backup.endedAt,
                id: backup.id,
                startedAt: backup.startedAt,
                status: backup.status,
                stdout: backup.stdout,
                type: backup.type,
            });
            expect(
                database
                    .prepare(`SELECT cancellable, status
                         FROM job_executions
                         WHERE action_key = 'backup.clear-attention'
                         ORDER BY rowid DESC
                         LIMIT 1`)
                    .get()
            ).toEqual({
                cancellable: 0,
                status: "success",
            });
            expect(getPersistedBackupJob("walg")).toBeUndefined();
        } finally {
            await stopScheduledJobExecutor();
            runProcessSpy.mockRestore();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    }, 10_000);
    it("reports recovered backup failures instead of stale running snapshots", async () => {
        const { getPersistedBackupJob, registerBackupScheduledJobs } =
            await import("../../src/services/backups/scheduling.ts");
        const {
            claimNextJobExecution,
            recoverExpiredJobExecutions,
            updateJobExecutionOutput,
        } = await import("../../src/services/jobExecutionQueue/worker.ts");
        const { enqueueScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        try {
            registerBackupScheduledJobs();
            const run = enqueueScheduledJob("backup.walg", "manual");
            const executionId = run.executionId;
            if (!executionId) throw new Error("Backup execution id was missing");
            const workerId = `backup-recovery-${Bun.randomUUIDv7()}`;
            const startedAt = new Date(Date.now() + 1000).toISOString();
            const claimed = claimNextJobExecution(workerId, 1, startedAt, 1000);
            expect(claimed?.id).toBe(executionId);
            const backup = {
                code: undefined,
                endedAt: undefined,
                id: Bun.randomUUIDv7(),
                startedAt: Date.parse(startedAt),
                status: "running",
                stderr: "",
                stdout: "backup started",
                type: "walg",
            };
            updateJobExecutionOutput(executionId, workerId, {
                backup,
            });
            const recoveredAt = new Date(Date.parse(startedAt) + 2000).toISOString();
            expect(recoverExpiredJobExecutions(recoveredAt)).toBe(1);
            expect(getPersistedBackupJob("walg")).toMatchObject({
                id: backup.id,
                endedAt: Date.parse(recoveredAt),
                status: "failed",
                stderr: "Job failed after its worker lease expired",
                stdout: backup.stdout,
                type: "walg",
            });
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("does not clear a newer persisted backup than the requested execution", async () => {
        const {
            clearPersistedBackupAttention,
            getPersistedBackupJob,
            registerBackupScheduledJobs,
        } = await import("../../src/services/backups/scheduling.ts");
        const { enqueueScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        try {
            registerBackupScheduledJobs();
            const oldRun = enqueueScheduledJob("backup.walg", "manual");
            const oldExecutionId = oldRun.executionId;
            if (!oldExecutionId) throw new Error("Old backup execution id was missing");
            const oldBackup = {
                code: 130,
                endedAt: Date.parse("2026-07-22T02:00:00.000Z"),
                id: Bun.randomUUIDv7(),
                startedAt: Date.parse("2026-07-22T02:00:00.000Z"),
                status: "needs_attention",
                stderr: "Old backup needs attention",
                stdout: "",
                type: "walg",
            };
            database
                .prepare(`UPDATE job_executions
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'Old WALG backup needs attention', output_json = ?
                     WHERE id = ?`)
                .run(
                    "2026-07-22T02:00:00.000Z",
                    "2026-07-22T02:00:00.000Z",
                    JSON.stringify({
                        backup: oldBackup,
                    }),
                    oldExecutionId
                );
            database
                .prepare(`UPDATE scheduled_job_runs
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'Old WALG backup needs attention', output_json = ?
                     WHERE id = ?`)
                .run(
                    "2026-07-22T02:00:00.000Z",
                    "2026-07-22T02:00:00.000Z",
                    JSON.stringify({
                        backup: oldBackup,
                    }),
                    oldRun.id
                );
            const clearPromise = clearPersistedBackupAttention("walg");
            const newerRun = enqueueScheduledJob("backup.walg", "manual");
            const newerExecutionId = newerRun.executionId;
            if (!newerExecutionId) {
                throw new Error("Newer backup execution id was missing");
            }
            const newerBackup = {
                ...oldBackup,
                endedAt: Date.parse("2026-07-22T03:00:00.000Z"),
                id: Bun.randomUUIDv7(),
                startedAt: Date.parse("2026-07-22T03:00:00.000Z"),
                stderr: "Newer backup needs attention",
            };
            database
                .prepare(`UPDATE job_executions
                     SET status = 'failed', queued_at = ?, started_at = ?,
                         finished_at = ?, message = 'Newer WALG backup needs attention',
                         output_json = ?
                     WHERE id = ?`)
                .run(
                    "2999-01-01T03:00:00.000Z",
                    "2999-01-01T03:00:00.000Z",
                    "2999-01-01T03:00:00.000Z",
                    JSON.stringify({
                        backup: newerBackup,
                    }),
                    newerExecutionId
                );
            database
                .prepare(`UPDATE scheduled_job_runs
                     SET status = 'failed', started_at = ?, finished_at = ?,
                         message = 'Newer WALG backup needs attention', output_json = ?
                     WHERE id = ?`)
                .run(
                    "2999-01-01T03:00:00.000Z",
                    "2999-01-01T03:00:00.000Z",
                    JSON.stringify({
                        backup: newerBackup,
                    }),
                    newerRun.id
                );
            await startTestScheduledExecutor();
            expect(clearPromise).rejects.toMatchObject({
                message: "WALG backup attention changed before clearing",
                statusCode: 409,
            });
            expect(getPersistedBackupJob("walg")).toMatchObject(newerBackup);
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("reports Kopia host pgrep failures without recording needs-attention state", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-host-pgrep-error-bin-");
        writeFakeDocker(path.join(fakeBin, "docker"));
        const fakePgrep = path.join(fakeBin, "pgrep");
        writeFileSync(
            fakePgrep,
            "#!/usr/bin/env bash\nprintf 'pgrep unavailable\\n' >&2\nexit 2\n"
        );
        chmodSync(fakePgrep, 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const { getCurrentBackupJob, registerBackupScheduledJobs, startManualBackup } =
            await Promise.all([
                import("../../src/services/backups/backupJobs.ts"),
                import("../../src/services/backups/scheduling.ts"),
                import("../../src/services/backups/backupProviders.ts"),
            ]).then(([module0, module1, module2]) => ({
                getCurrentBackupJob: module0.getCurrentBackupJob,
                registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
                startManualBackup: module2.startManualBackup,
            }));
        try {
            registerBackupScheduledJobs();
            expect(startManualBackup("kopia")).rejects.toMatchObject({
                statusCode: 503,
            });
            expect(getCurrentBackupJob("kopia")).toBeUndefined();
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
    it("records and clears Kopia needs-attention state when host preflight detects a running process", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-pgrep-bin-");
        const pgrepLog = path.join(fakeBin, "pgrep.log");
        writeFakeDocker(path.join(fakeBin, "docker"));
        writeFakePgrep(path.join(fakeBin, "pgrep"), pgrepLog);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const {
            clearNeedsAttentionBackupJob,
            getCurrentBackupJob,
            mapBackupJob,
            registerBackupScheduledJobs,
            startManualBackup,
        } = await Promise.all([
            import("../../src/services/backups/backupJobs.ts"),
            import("../../src/services/backups/scheduling.ts"),
            import("../../src/services/backups/backupProviders.ts"),
        ]).then(([module0, module1, module2]) => ({
            clearNeedsAttentionBackupJob: module0.clearNeedsAttentionBackupJob,
            getCurrentBackupJob: module0.getCurrentBackupJob,
            mapBackupJob: module0.mapBackupJob,
            registerBackupScheduledJobs: module1.registerBackupScheduledJobs,
            startManualBackup: module2.startManualBackup,
        }));
        try {
            registerBackupScheduledJobs();
            expect(startManualBackup("kopia")).rejects.toMatchObject({
                statusCode: 409,
            });
            expect(mapBackupJob(getCurrentBackupJob("kopia"))).toMatchObject({
                code: 130,
                status: "needs_attention",
                stderr: expect.stringContaining("backup process is still running"),
                type: "kopia",
            });
            expect(startManualBackup("kopia")).rejects.toThrow(
                "KOPIA backup needs attention"
            );
            const clearedJob = await clearNeedsAttentionBackupJob("kopia");
            expect(mapBackupJob(clearedJob)).toMatchObject({
                status: "needs_attention",
                type: "kopia",
            });
            expect(getCurrentBackupJob("kopia")).toBeUndefined();
            expect(readFileSync(pgrepLog, "utf8")).toContain(
                "-f /opt/docker/apps/kopia/backup.sh"
            );
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });
});
