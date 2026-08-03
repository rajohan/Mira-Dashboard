import { describe, expect, it, jest } from "bun:test";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import { database } from "../../src/database/connection.ts";
import { resolveDashboardProjectPaths } from "../../src/lib/dashboardPaths.ts";
import * as processModule from "../../src/lib/processes.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
describe("backend log rotation services", () => {
    const {
        cleanupCallbacks,
        createTemporaryRoot,
        rememberEnvironment,
        startTestScheduledExecutor,
    } = createServiceBehaviorHarness();
    it("rejects invalid log rotation policy configs before touching files", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-validation-");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        const logFile = path.join(rotationRoot, "service.log");
        writeFileSync(logFile, "do not touch\n");
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const validBase = {
            approvedRoots: [rotationRoot],
            groups: [
                {
                    name: "unit",
                    paths: [logFile],
                },
            ],
            version: 1,
        };
        const invalidCases: Array<{
            config: unknown;
            message: string | RegExp;
            name: string;
        }> = [
            {
                config: null,
                message: "Config must be an object",
                name: "non-object config",
            },
            {
                config: {
                    ...validBase,
                    defaults: null,
                },
                message: "Config defaults must be an object",
                name: "null defaults",
            },
            {
                config: {
                    ...validBase,
                    version: 2,
                },
                message: "Config version must be 1",
                name: "unsupported version",
            },
            {
                config: {
                    ...validBase,
                    groups: {},
                },
                message: "Config groups must be an array",
                name: "non-array groups",
            },
            {
                config: {
                    ...validBase,
                    approvedRoots: [],
                },
                message: "approvedRoots must include at least one entry",
                name: "empty approved roots",
            },
            {
                config: {
                    ...validBase,
                    defaults: {
                        paths: [""],
                    },
                },
                message: "defaults.paths must be an array of non-empty strings",
                name: "blank default path",
            },
            {
                config: {
                    ...validBase,
                    defaults: {
                        archiveRetentionScope: "all",
                    },
                },
                message:
                    "defaults.archiveRetentionScope must be directory, basename, or parent",
                name: "bad default retention scope",
            },
            {
                config: {
                    ...validBase,
                    defaults: {
                        strategy: "move",
                    },
                },
                message: "defaults.strategy has unsupported strategy",
                name: "bad default strategy",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        {
                            name: "",
                            paths: [logFile],
                        },
                    ],
                },
                message: "Every group needs a string name",
                name: "blank group name",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        {
                            daily: true,
                            name: "unit",
                            paths: [logFile],
                            weekly: true,
                        },
                    ],
                },
                message: "Group unit cannot set both daily and weekly rotation",
                name: "daily and weekly",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        {
                            archiveOnly: true,
                            name: "unit",
                        },
                    ],
                },
                message:
                    "Archive-only group unit needs at least one archivePaths pattern",
                name: "archive-only without archives",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        {
                            name: "unit",
                        },
                    ],
                },
                message: "Group unit needs at least one path pattern",
                name: "group without paths",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        {
                            name: "unit",
                            paths: [logFile],
                            strategy: "move",
                        },
                    ],
                },
                message: "Group unit has unsupported strategy",
                name: "bad group strategy",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        {
                            enabled: "yes",
                            name: "unit",
                            paths: [logFile],
                        },
                    ],
                },
                message: "Group unit.enabled must be a boolean",
                name: "bad boolean",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        {
                            maxSizeMb: -1,
                            name: "unit",
                            paths: [logFile],
                        },
                    ],
                },
                message: "Group unit.maxSizeMb must be a non-negative number",
                name: "bad number",
            },
            {
                config: {
                    ...validBase,
                    groups: [
                        {
                            keep: 0,
                            name: "unit",
                            paths: [logFile],
                        },
                    ],
                },
                message: "Group unit.keep must be a positive integer",
                name: "bad keep",
            },
        ];
        for (const { config, message, name } of invalidCases) {
            writeFileSync(configFile, `${JSON.stringify(config)}\n`);
            expect(
                runLogRotationService({
                    config: configFile,
                    isDryRun: true,
                }),
                name
            ).rejects.toThrow(message);
        }
        expect(readFileSync(logFile, "utf8")).toBe("do not touch\n");
    });
    it("evaluates log rotation policies in dry-run mode with isolated roots", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-test-");
        const logFile = path.join(rotationRoot, "service.log");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        writeFileSync(logFile, "line one\nline two\n");
        writeFileSync(
            configFile,
            `${JSON.stringify({
                version: 1,
                approvedRoots: [rotationRoot],
                defaults: {
                    compress: false,
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                    strategy: "copytruncate",
                },
                groups: [
                    {
                        name: "unit",
                        paths: [logFile],
                    },
                ],
            })}\n`
        );
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: true,
            verbose: true,
        });
        expect(summary).toMatchObject({
            checkedFiles: 1,
            checkedGroups: 1,
            isDryRun: true,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(summary.groups).toContainEqual(
            expect.objectContaining({
                checkedFiles: 1,
                name: "unit",
                rotatedFiles: 1,
            })
        );
        expect(
            runLogRotationService({
                config: path.join(rotationRoot, "missing.json"),
                isDryRun: true,
            })
        ).rejects.toThrow();
    });
    it("reports an active log rotation lock without touching configured log files", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-lock-test-");
        const logFile = path.join(rotationRoot, "locked.log");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        const lockFile = resolveDashboardProjectPaths().productionLogRotationLockFile;
        mkdirSync(path.dirname(lockFile), {
            recursive: true,
        });
        writeFileSync(lockFile, `${process.pid}\n`);
        cleanupCallbacks.push(() => {
            rmSync(lockFile, {
                force: true,
            });
            rmSync(`${lockFile}.reclaim`, {
                force: true,
                recursive: true,
            });
        });
        writeFileSync(logFile, "do not rotate\n");
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    compress: false,
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                    strategy: "copytruncate",
                },
                groups: [
                    {
                        name: "locked",
                        paths: [logFile],
                    },
                ],
                version: 1,
            })
        );
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: false,
        });
        expect(summary).toMatchObject({
            checkedFiles: 0,
            isDryRun: false,
            isOk: false,
            rotatedFiles: 0,
        });
        expect(summary.errors).toContainEqual({
            message: "Log rotation is already running",
        });
        expect(readFileSync(logFile, "utf8")).toBe("do not rotate\n");
    });
    it("reclaims stale log rotation locks before live rotation", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-stale-lock-");
        const logFile = path.join(rotationRoot, "stale-lock.log");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        const lockFile = resolveDashboardProjectPaths().productionLogRotationLockFile;
        mkdirSync(path.dirname(lockFile), {
            recursive: true,
        });
        writeFileSync(lockFile, "999999999\n");
        const staleTime = new Date(Date.now() - 13 * 60 * 60 * 1000);
        utimesSync(lockFile, staleTime, staleTime);
        cleanupCallbacks.push(() => {
            rmSync(lockFile, {
                force: true,
            });
            rmSync(`${lockFile}.reclaim`, {
                force: true,
                recursive: true,
            });
        });
        writeFileSync(logFile, "rotate after stale lock\n");
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    compress: false,
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                    strategy: "copytruncate",
                },
                groups: [
                    {
                        name: "stale-lock",
                        paths: [logFile],
                    },
                ],
                version: 1,
            })
        );
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: false,
        });
        expect(summary).toMatchObject({
            checkedFiles: 1,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(logFile, "utf8")).toBe("");
        expect(existsSync(lockFile)).toBe(false);
        expect(existsSync(`${lockFile}.reclaim`)).toBe(false);
    });
    it("rotates logs with rename strategy and applies archive-only retention", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-rename-test-");
        const logFile = path.join(rotationRoot, "rename.log");
        const archiveRoot = path.join(rotationRoot, "archives");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        mkdirSync(archiveRoot, {
            recursive: true,
        });
        writeFileSync(logFile, "rename me\n");
        const oldArchive = path.join(archiveRoot, "app.1.log");
        const retainedArchive = path.join(archiveRoot, "app.2.log");
        writeFileSync(oldArchive, "old archive\n");
        writeFileSync(retainedArchive, "new archive\n");
        const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        const retainedTime = new Date(Date.now() - 5 * 60 * 1000);
        utimesSync(oldArchive, oldTime, oldTime);
        utimesSync(retainedArchive, retainedTime, retainedTime);
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                },
                groups: [
                    {
                        compress: true,
                        name: "rename",
                        paths: [logFile],
                        strategy: "rename",
                    },
                    {
                        archiveOnly: true,
                        archivePaths: [path.join(archiveRoot, "*.log")],
                        archiveRetentionScope: "directory",
                        keep: 1,
                        keepDays: 1,
                        name: "archives",
                        shouldCompress: false,
                    },
                ],
                version: 1,
            })
        );
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: false,
            verbose: true,
        });
        const hasCompressionStream = "CompressionStream" in globalThis;
        expect(summary).toMatchObject({
            checkedGroups: 2,
            checkedFiles: 3,
            compressedFiles: hasCompressionStream ? 1 : 0,
            deletedArchives: 1,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(logFile, "utf8")).toBe("");
        expect(existsSync(oldArchive)).toBe(false);
        expect(existsSync(retainedArchive)).toBe(true);
        expect(readdirSync(rotationRoot).some((name) => name.endsWith(".gz"))).toBe(
            hasCompressionStream
        );
        const row = database
            .prepare(
                "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
            )
            .get() as
            | {
                  data_json?: string;
              }
            | undefined;
        const state = JSON.parse(row?.data_json ?? "{}") as {
            files?: Record<
                string,
                {
                    lastArchive?: string;
                }
            >;
            lastRun?: {
                isOk?: boolean;
            };
        };
        expect(state.lastRun?.isOk).toBe(true);
        expect(state.files?.[logFile]?.lastArchive?.endsWith(".gz")).toBe(
            hasCompressionStream
        );
    });
    it("includes configured archives when applying log rotation retention", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-archives-test-");
        const logFile = path.join(rotationRoot, "app.log");
        const archiveRoot = path.join(rotationRoot, "archives");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        mkdirSync(archiveRoot, {
            recursive: true,
        });
        writeFileSync(logFile, "rotate me\n");
        const configuredArchive = path.join(archiveRoot, "app.previous.log");
        writeFileSync(configuredArchive, "older archive\n");
        const oldTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        utimesSync(configuredArchive, oldTime, oldTime);
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    skipEmpty: false,
                },
                groups: [
                    {
                        archivePaths: [path.join(archiveRoot, "*.log")],
                        archiveRetentionScope: "directory",
                        name: "logs",
                        paths: [logFile],
                        strategy: "rename",
                    },
                ],
                version: 1,
            })
        );
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: true,
            verbose: true,
        });
        expect(summary).toMatchObject({
            checkedFiles: 1,
            deletedArchives: 0,
            isDryRun: true,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(existsSync(configuredArchive)).toBe(true);
    });
    it("copy-truncates logs, honors exclusions, and reports unsafe rotation errors", async () => {
        const rotationRoot = createTemporaryRoot("mira-log-rotation-copy-test-");
        const outsideRoot = createTemporaryRoot("mira-log-rotation-outside-");
        const logsRoot = path.join(rotationRoot, "logs");
        mkdirSync(logsRoot, {
            recursive: true,
        });
        const liveLog = path.join(logsRoot, "live.log");
        const emptyLog = path.join(logsRoot, "empty.log");
        const excludedLog = path.join(logsRoot, "excluded.log");
        const linkedSource = path.join(logsRoot, "linked-source.log");
        const outsideLog = path.join(outsideRoot, "outside.log");
        const hardlink = path.join(logsRoot, "linked-hardlink.log");
        const configFile = path.join(rotationRoot, "log-rotation.json");
        writeFileSync(liveLog, "copytruncate me\n");
        writeFileSync(emptyLog, "");
        writeFileSync(excludedLog, "leave me\n");
        writeFileSync(linkedSource, "do not rotate linked files\n");
        writeFileSync(outsideLog, "outside root\n");
        symlinkSync(liveLog, path.join(logsRoot, "live-symlink.log"));
        try {
            // Hard links are refused by the service because rotating one would mutate
            // another path with the same inode.
            Bun.spawnSync(["ln", linkedSource, hardlink]);
        } catch {
            // Some filesystems may not support hard links in tmp; the main path still
            // exercises copytruncate and exclusions.
        }
        writeFileSync(
            configFile,
            JSON.stringify({
                approvedRoots: [rotationRoot],
                defaults: {
                    compress: false,
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: true,
                    skipEmpty: true,
                    strategy: "copytruncate",
                },
                excludePaths: [excludedLog],
                groups: [
                    {
                        name: "copy",
                        paths: [
                            path.join(logsRoot, "*.log"),
                            path.join(logsRoot, "missing.log"),
                            outsideLog,
                        ],
                    },
                ],
                version: 1,
            })
        );
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const summary = await runLogRotationService({
            config: configFile,
            isDryRun: false,
            verbose: true,
        });
        expect(summary).toMatchObject({
            checkedGroups: 1,
            deletedArchives: 0,
            isDryRun: false,
            isOk: false,
            rotatedFiles: 1,
        });
        expect(readFileSync(liveLog, "utf8")).toBe("");
        expect(readFileSync(excludedLog, "utf8")).toBe("leave me\n");
        expect(summary.skippedFiles).toBeGreaterThanOrEqual(1);
        expect(summary.errors).toContainEqual(
            expect.objectContaining({
                filePath: outsideLog,
                message: expect.stringContaining("Unsafe path outside approved roots"),
            })
        );
        if (existsSync(hardlink)) {
            expect(summary.errors).toContainEqual(
                expect.objectContaining({
                    filePath: hardlink,
                    message: expect.stringContaining("Refusing multi-linked file"),
                })
            );
        }
        const stateRow = database
            .prepare(
                "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
            )
            .get() as
            | {
                  data_json?: string;
              }
            | undefined;
        const state = JSON.parse(stateRow?.data_json ?? "{}") as {
            files?: Record<
                string,
                {
                    lastArchive?: string;
                    lastSizeBytes?: number;
                }
            >;
        };
        expect(state.files?.[liveLog]).toMatchObject({
            lastArchive: expect.stringContaining("live.log."),
            lastSizeBytes: "copytruncate me\n".length,
        });
    });
    it("normalizes elevated log rotation command output and failures", async () => {
        rememberEnvironment("MIRA_DASHBOARD_DB_PATH");
        rememberEnvironment("MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE");
        const stateRoot = createTemporaryRoot("mira-elevated-log-rotation-");
        const configuredLockFile = path.join(stateRoot, "log-rotation.lock");
        const configuredDatabasePath = path.join(stateRoot, "mira-dashboard.db");
        process.env.MIRA_DASHBOARD_DB_PATH = configuredDatabasePath;
        process.env.MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE = configuredLockFile;
        const { runElevatedLogRotationService } =
            await import("../../src/services/logRotation/runtime.ts");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockResolvedValueOnce({
                code: 0,
                stderr: "sudo notice",
                stdout: 'banner before json\n{"isOk":true,"checkedFiles":2}\n',
            })
            .mockResolvedValueOnce({
                code: 0,
                stderr: "",
                stdout: "",
            })
            .mockResolvedValueOnce({
                code: 1,
                stderr: "sudo failed",
                stdout: '{"isOk":false,"error":"policy denied","stdout":"details"}\n',
            })
            .mockResolvedValueOnce({
                code: 0,
                stderr: "bad json stderr",
                stdout: "not json",
            });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());
        expect(
            runElevatedLogRotationService({
                isDryRun: true,
            })
        ).resolves.toEqual({
            result: {
                checkedFiles: 2,
                isOk: true,
            },
            stderr: "sudo notice",
        });
        const [sudoCommand, sudoArguments, sudoOptions] =
            runProcessSpy.mock.calls[0] ?? [];
        expect(sudoCommand).toBe("sudo");
        expect(sudoArguments).toContain(
            "--preserve-env=LANG,NODE_ENV,TZ,MIRA_DASHBOARD_PROJECT_ROOT,MIRA_DASHBOARD_DB_PATH,MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE"
        );
        expect(sudoOptions?.env).toMatchObject({
            MIRA_DASHBOARD_DB_PATH: configuredDatabasePath,
            MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE: configuredLockFile,
        });
        expect(
            runElevatedLogRotationService({
                isDryRun: false,
            })
        ).resolves.toMatchObject({
            result: {
                error: "Elevated log rotation returned empty JSON output",
                isOk: false,
            },
            stderr: "Elevated log rotation returned empty JSON output",
        });
        expect(
            runElevatedLogRotationService({
                isDryRun: false,
            })
        ).resolves.toEqual({
            result: {
                error: "policy denied",
                isOk: false,
                stdout: "details",
            },
            stderr: "sudo failed",
        });
        expect(
            runElevatedLogRotationService({
                isDryRun: false,
            })
        ).resolves.toMatchObject({
            result: {
                error: "Failed to parse elevated log rotation JSON",
                isOk: false,
                stdout: "not json",
            },
            stderr: expect.stringContaining("bad json stderr"),
        });
    });
    it("uses the configured lock for non-elevated log rotation", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE");
        const stateRoot = createTemporaryRoot("mira-log-rotation-lock-");
        const configuredLockFile = path.join(stateRoot, "custom.lock");
        const configPath = path.join(stateRoot, "log-rotation.json");
        writeFileSync(configPath, '{"groups":[],"version":1}\n');
        writeFileSync(configuredLockFile, `${process.pid}\n`);
        process.env.MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE = configuredLockFile;
        const { runLogRotationService } =
            await import("../../src/services/logRotation/core.ts");
        const summary = await runLogRotationService({
            config: configPath,
            isDryRun: false,
        });
        expect(summary).toMatchObject({
            errors: [
                {
                    message: "Log rotation is already running",
                },
            ],
            isOk: false,
        });
        expect(readFileSync(configuredLockFile, "utf8")).toBe(`${process.pid}\n`);
    });
    it("records scheduled log-rotation failures in cache state", async () => {
        const { registerLogRotationScheduledJobs } =
            await import("../../src/services/logRotation/scheduler.ts");
        const { runScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        const runProcessSpy = jest.spyOn(processModule, "runProcess").mockResolvedValue({
            code: 1,
            stderr: "sudo denied",
            stdout: JSON.stringify({
                errors: [
                    {
                        message: "policy denied",
                    },
                ],
                groups: [
                    {
                        name: "docker",
                    },
                ],
                isOk: false,
                warnings: [
                    {
                        message: "warn",
                    },
                ],
            }),
        });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());
        try {
            registerLogRotationScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("ops.log-rotation");
            expect(run.status).toBe("failed");
            expect(run.message).toContain("sudo denied");
            expect(run.output).toMatchObject({
                logRotation: {
                    result: {
                        isOk: false,
                    },
                    stderr: "sudo denied",
                },
            });
            const row = database
                .prepare(
                    "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
                )
                .get() as
                | {
                      data_json?: string;
                  }
                | undefined;
            const state = JSON.parse(row?.data_json ?? "{}") as {
                lastRun?: {
                    isDryRun?: boolean;
                    isOk?: boolean;
                    stderr?: string;
                };
            };
            expect(state.lastRun).toMatchObject({
                isDryRun: false,
                isOk: false,
                stderr: "sudo denied",
            });
        } finally {
            database
                .prepare(
                    "DELETE FROM scheduled_job_runs WHERE job_id = 'ops.log-rotation'"
                )
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'ops.log-rotation'")
                .run();
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'log_rotation.state'")
                .run();
        }
    });
    it("records structured scheduled log-rotation failures when sudo exits cleanly", async () => {
        const { registerLogRotationScheduledJobs } =
            await import("../../src/services/logRotation/scheduler.ts");
        const { runScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        const runProcessSpy = jest.spyOn(processModule, "runProcess").mockResolvedValue({
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
                errors: [
                    {
                        message: "policy rejected group",
                    },
                ],
                groups: [
                    {
                        name: "docker",
                    },
                ],
                isOk: false,
                stdout: "x".repeat(100_050),
                warnings: [
                    {
                        message: "matched no files",
                    },
                ],
            }),
        });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());
        try {
            registerLogRotationScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("ops.log-rotation");
            expect(run.status).toBe("failed");
            expect(run.message).toContain("Log rotation failed");
            expect(run.message).toContain("policy rejected group");
            expect(run.message).toContain("matched no files");
            expect(run.message).toContain("docker");
            expect(run.output).toMatchObject({
                logRotation: {
                    result: {
                        errors: [
                            {
                                message: "policy rejected group",
                            },
                        ],
                        isOk: false,
                    },
                },
            });
            expect(
                (
                    run.output.logRotation as {
                        result: {
                            stdout?: string;
                        };
                    }
                ).result.stdout
            ).toHaveLength(100_000);
            const row = database
                .prepare(
                    "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
                )
                .get() as
                | {
                      data_json?: string;
                  }
                | undefined;
            const state = JSON.parse(row?.data_json ?? "{}") as {
                lastRun?: {
                    isOk?: boolean;
                    stdout?: string;
                };
            };
            expect(state.lastRun).toMatchObject({
                isOk: false,
            });
            expect(state.lastRun?.stdout).toHaveLength(100_000);
        } finally {
            database
                .prepare(
                    "DELETE FROM scheduled_job_runs WHERE job_id = 'ops.log-rotation'"
                )
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'ops.log-rotation'")
                .run();
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'log_rotation.state'")
                .run();
        }
    });
    it("records successful scheduled log-rotation runs", async () => {
        const { registerLogRotationScheduledJobs } =
            await import("../../src/services/logRotation/scheduler.ts");
        const { runScheduledJob } =
            await import("../../src/services/scheduledJobs/enqueue.ts");
        const runProcessSpy = jest.spyOn(processModule, "runProcess").mockResolvedValue({
            code: 0,
            stderr: "sudo notice",
            stdout: JSON.stringify({
                checkedGroups: 1,
                isDryRun: false,
                isOk: true,
                rotatedFiles: 0,
            }),
        });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());
        try {
            registerLogRotationScheduledJobs();
            await startTestScheduledExecutor();
            const run = await runScheduledJob("ops.log-rotation");
            expect(run.status).toBe("success");
            expect(run.cancellable).toBe(false);
            expect(run.message).toBeUndefined();
            expect(run.output).toMatchObject({
                logRotation: {
                    result: {
                        checkedGroups: 1,
                        isOk: true,
                    },
                    stderr: "sudo notice",
                },
            });
        } finally {
            database
                .prepare(
                    "DELETE FROM scheduled_job_runs WHERE job_id = 'ops.log-rotation'"
                )
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'ops.log-rotation'")
                .run();
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'log_rotation.state'")
                .run();
        }
    });
});
