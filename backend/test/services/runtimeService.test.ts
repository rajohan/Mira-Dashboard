import { describe, expect, it, jest } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { database } from "../../src/database/connection.ts";
import * as processModule from "../../src/lib/processes.ts";
import { CONFIG_REDACTION_SENTINEL } from "../../src/services/configRedaction.ts";
import { apiErrorExpectation } from "../support/apiErrorExpectation.ts";
import { startTestScheduledJobExecutor } from "../support/scheduledJobExecutor.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
describe("backend runtime services", () => {
    const {
        cleanupCallbacks,
        createTemporaryRoot,
        rememberEnvironment,
        startTestScheduledExecutor,
        waitFor,
        writeFakeOpenClaw,
    } = createServiceBehaviorHarness();
    it("validates scheduled job action and schedule boundaries", async () => {
        const {
            calculateNextRunAt,
            listScheduledJobRuns,
            registerScheduledJobAction,
            updateScheduledJob,
            upsertScheduledJob,
        } = await Promise.all([
            import("../../src/services/scheduledJobs/schedule.ts"),
            import("../../src/services/scheduledJobs/repository.ts"),
            import("../../src/services/scheduledJobs/actionRegistry.ts"),
        ]).then(([module0, module1, module2]) => ({
            calculateNextRunAt: module0.calculateNextRunAt,
            listScheduledJobRuns: module1.listScheduledJobRuns,
            registerScheduledJobAction: module2.registerScheduledJobAction,
            updateScheduledJob: module1.updateScheduledJob,
            upsertScheduledJob: module1.upsertScheduledJob,
        }));
        const jobId = `test-job-validation-${Bun.randomUUIDv7()}`;
        try {
            expect(() => registerScheduledJobAction("Bad.Action", () => {})).toThrow(
                "Job action key is invalid"
            );
            expect(() =>
                registerScheduledJobAction("test.timeout", () => {}, {
                    timeoutMs: 0,
                })
            ).toThrow(
                "Scheduled job action timeout must be an integer between 1 and 2147483647"
            );
            expect(() =>
                upsertScheduledJob({
                    actionKey: "test.validation",
                    enabled: true,
                    id: jobId,
                    intervalSeconds: 30,
                    name: "Coverage validation job",
                    scheduleType: "interval",
                })
            ).toThrow("Interval must be at least 60 seconds");
            expect(() =>
                calculateNextRunAt({
                    cronExpression: "61 * * * *",
                    enabled: true,
                    intervalSeconds: 3600,
                    scheduleType: "cron",
                    timeOfDay: undefined,
                })
            ).toThrow("Cron jobs require a valid cronExpression");
            const job = upsertScheduledJob({
                actionKey: "test.validation",
                enabled: true,
                id: jobId,
                intervalSeconds: 3600,
                name: "Coverage validation job",
                scheduleType: "daily",
                timeOfDay: "23:59",
            });
            expect(job.nextRunAt).toEqual(expect.any(String));
            expect(
                updateScheduledJob("missing-job", {
                    enabled: false,
                })
            ).toBeUndefined();
            expect(() =>
                updateScheduledJob(jobId, {
                    cronExpression: "not cron",
                    scheduleType: "cron",
                })
            ).toThrow("Cron jobs require a valid cronExpression");
            expect(listScheduledJobRuns(jobId, -20)).toEqual([]);
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id = ?")
                .run(jobId);
            database.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(jobId);
        }
    });
    it("serves OpenClaw config, skill, backup, and restart route contracts with fakes", async () => {
        rememberEnvironment("HOME");
        rememberEnvironment("OPENCLAW_BIN");
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("OPENCLAW_PACKAGE_ROOT");
        const routeRoot = createTemporaryRoot("mira-openclaw-config-routes-");
        const homeRoot = path.join(routeRoot, "home");
        const openclawHome = path.join(routeRoot, "openclaw-home");
        const packageRoot = path.join(routeRoot, "package-root");
        const fakeBin = path.join(routeRoot, "openclaw");
        mkdirSync(path.join(openclawHome, "workspace", "skills", "workspaceSkill"), {
            recursive: true,
        });
        mkdirSync(path.join(packageRoot, "skills", "builtinSkill"), {
            recursive: true,
        });
        mkdirSync(path.join(openclawHome, "workspace", "skills", "linkedSkill"), {
            recursive: true,
        });
        mkdirSync(path.join(openclawHome, "workspace", "skills", "oversizedSkill"), {
            recursive: true,
        });
        mkdirSync(
            path.join(packageRoot, "dist", "extensions", "demo", "skills", "extraSkill"),
            {
                recursive: true,
            }
        );
        writeFileSync(
            path.join(openclawHome, "workspace", "skills", "workspaceSkill", "SKILL.md"),
            "---\ndescription: Workspace skill\n---\n"
        );
        writeFileSync(
            path.join(packageRoot, "skills", "builtinSkill", "SKILL.md"),
            "# Builtin skill\n"
        );
        const secretFile = path.join(routeRoot, "secret.txt");
        writeFileSync(secretFile, "description: must not be disclosed\n");
        symlinkSync(
            secretFile,
            path.join(openclawHome, "workspace", "skills", "linkedSkill", "SKILL.md")
        );
        writeFileSync(
            path.join(openclawHome, "workspace", "skills", "oversizedSkill", "SKILL.md"),
            `description: ${"x".repeat(256 * 1024)}\n`
        );
        writeFileSync(
            path.join(
                packageRoot,
                "dist",
                "extensions",
                "demo",
                "skills",
                "extraSkill",
                "SKILL.md"
            ),
            "Extra skill body\n"
        );
        writeFakeOpenClaw(fakeBin);
        process.env.HOME = homeRoot;
        process.env.OPENCLAW_BIN = fakeBin;
        process.env.OPENCLAW_HOME = openclawHome;
        process.env.OPENCLAW_PACKAGE_ROOT = packageRoot;
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalRequest = gateway.request;
        const patchCalls: unknown[] = [];
        cleanupCallbacks.push(() => {
            gateway.request = originalRequest;
        });
        gateway.request = (method, parameters) => {
            return Promise.try(() => {
                if (method === "config.get") {
                    return {
                        hash: "hash-1",
                        parsed: {
                            skills: {
                                entries: {
                                    configuredOnly: {
                                        description: "Configured only",
                                        enabled: true,
                                    },
                                    workspaceSkill: {
                                        enabled: false,
                                    },
                                },
                            },
                            theme: "dark",
                        },
                    };
                }
                if (method === "config.patch") {
                    patchCalls.push(parameters);
                    return {
                        hash: "hash-2",
                    };
                }
                throw new Error(`unexpected gateway method: ${method}`);
            });
        };
        const { openclawConfigRoutes } =
            await import("../../src/routes/openclawConfigRoutes.ts");
        const configResponse = await openclawConfigRoutes["/api/config"].GET();
        expect(configResponse.json()).resolves.toMatchObject({
            __hash: "hash-1",
            theme: "dark",
        });
        const validConfigPut = await openclawConfigRoutes["/api/config"].PUT(
            new Request("https://dashboard.test/api/config", {
                body: JSON.stringify({
                    __hash: "hash-1",
                    theme: "light",
                }),
                method: "PUT",
            })
        );
        expect(validConfigPut.status).toBe(200);
        expect(patchCalls.at(-1)).toMatchObject({
            baseHash: "hash-1",
            raw: JSON.stringify({
                theme: "light",
            }),
        });
        const skillsResponse = await openclawConfigRoutes["/api/skills"].GET();
        const skillsBody = (await skillsResponse.json()) as {
            skills: Array<{
                description?: string;
                enabled: boolean;
                name: string;
                source: string;
            }>;
        };
        expect(skillsBody.skills).toContainEqual(
            expect.objectContaining({
                description: "Workspace skill",
                enabled: false,
                name: "workspaceSkill",
                source: "workspace",
            })
        );
        expect(skillsBody.skills.map((skill) => skill.name)).not.toContain("linkedSkill");
        expect(skillsBody.skills.map((skill) => skill.name)).not.toContain(
            "oversizedSkill"
        );
        expect(skillsBody.skills).toContainEqual(
            expect.objectContaining({
                enabled: true,
                name: "builtinSkill",
                source: "builtin",
            })
        );
        expect(skillsBody.skills).toContainEqual(
            expect.objectContaining({
                enabled: true,
                name: "extraSkill",
                source: "extra",
            })
        );
        expect(skillsBody.skills).toContainEqual(
            expect.objectContaining({
                description: "Configured only",
                enabled: true,
                name: "configuredOnly",
                source: "extra",
            })
        );
        const invalidSkillRequest = Object.assign(
            new Request("https://dashboard.test/api/skills/__proto__", {
                body: JSON.stringify({
                    __hash: "hash-1",
                    enabled: true,
                }),
                method: "POST",
            }),
            {
                params: {
                    name: "__proto__",
                },
            }
        );
        const invalidSkillResponse =
            await openclawConfigRoutes["/api/skills/:name"].POST(invalidSkillRequest);
        expect(invalidSkillResponse.status).toBe(400);
        const validSkillRequest = Object.assign(
            new Request("https://dashboard.test/api/skills/workspaceSkill", {
                body: JSON.stringify({
                    __hash: "hash-1",
                    enabled: true,
                }),
                method: "POST",
            }),
            {
                params: {
                    name: "workspaceSkill",
                },
            }
        );
        const validSkillResponse =
            await openclawConfigRoutes["/api/skills/:name"].POST(validSkillRequest);
        expect(validSkillResponse.status).toBe(200);
        expect(patchCalls.at(-1)).toMatchObject({
            baseHash: "hash-1",
            raw: JSON.stringify({
                skills: {
                    entries: {
                        workspaceSkill: {
                            enabled: true,
                        },
                    },
                },
            }),
        });
        const backupResponse = await openclawConfigRoutes["/api/backup"].POST();
        expect(backupResponse.json()).resolves.toMatchObject({
            config: expect.objectContaining({
                theme: "dark",
            }),
            hash: "hash-1",
        });
        const { registerOpenClawExecutionActions } =
            await import("../../src/services/openclawActions.ts");
        registerOpenClawExecutionActions();
        cleanupCallbacks.push(() => {
            database
                .prepare(
                    "DELETE FROM job_executions WHERE action_key = 'openclaw.gateway.restart'"
                )
                .run();
        });
        await startTestScheduledExecutor();
        const restartResponse = await openclawConfigRoutes["/api/restart"].POST(
            new Request("https://test.local/api/restart", {
                method: "POST",
            })
        );
        expect(restartResponse.status).toBe(200);
        expect(restartResponse.json()).resolves.toEqual({
            isOk: true,
        });
        expect(
            database
                .prepare(`SELECT cancellable, status
                     FROM job_executions
                     WHERE action_key = 'openclaw.gateway.restart'
                     ORDER BY rowid DESC
                     LIMIT 1`)
                .get()
        ).toEqual({
            cancellable: 0,
            status: "success",
        });
        gateway.request = (method) =>
            Promise.try(() => {
                if (method === "config.get") {
                    return {
                        hash: "hash-empty",
                        parsed: {},
                    };
                }
                if (method === "config.patch") {
                    return {
                        hash: "hash-updated",
                    };
                }
                throw new Error(`unexpected gateway method: ${method}`);
            });
        const missingStoredSecret = await openclawConfigRoutes["/api/config"].PUT(
            new Request("https://dashboard.test/api/config", {
                body: JSON.stringify({
                    __hash: "hash-empty",
                    apiToken: CONFIG_REDACTION_SENTINEL,
                }),
                method: "PUT",
            })
        );
        expect(missingStoredSecret.status).toBe(400);
        gateway.request = () =>
            Promise.try(() => {
                throw new Error("Gateway config unavailable");
            });
        const failedConfigRead = await openclawConfigRoutes["/api/config"].GET();
        const failedSkillsRead = await openclawConfigRoutes["/api/skills"].GET();
        const failedBackup = await openclawConfigRoutes["/api/backup"].POST();
        expect(failedConfigRead.status).toBe(500);
        expect(failedSkillsRead.status).toBe(500);
        expect(failedBackup.status).toBe(500);
        const failedConfigUpdate = await openclawConfigRoutes["/api/config"].PUT(
            new Request("https://dashboard.test/api/config", {
                body: JSON.stringify({
                    __hash: "hash-1",
                    theme: "failure",
                }),
                method: "PUT",
            })
        );
        expect(failedConfigUpdate.status).toBe(500);
        gateway.request = (method) =>
            Promise.try(() => {
                if (method === "config.patch") {
                    throw new Error("Gateway config patch unavailable");
                }
                return {
                    hash: "hash-1",
                    parsed: {},
                };
            });
        const failedSkillRequest = new Request(
            "https://dashboard.test/api/skills/workspaceSkill",
            {
                body: JSON.stringify({
                    __hash: "hash-1",
                    enabled: true,
                }),
                method: "POST",
            }
        );
        const failedSkillUpdate = await openclawConfigRoutes["/api/skills/:name"].POST(
            Object.assign(failedSkillRequest, {
                params: {
                    name: "workspaceSkill",
                },
            })
        );
        expect(failedSkillUpdate.status).toBe(500);
        const failingBin = path.join(routeRoot, "openclaw-failing");
        writeFileSync(
            failingBin,
            "#!/usr/bin/env bash\necho restart failed >&2\nexit 1\n"
        );
        chmodSync(failingBin, 0o755);
        process.env.OPENCLAW_BIN = failingBin;
        const failedRestart = await openclawConfigRoutes["/api/restart"].POST(
            new Request("https://test.local/api/restart", {
                method: "POST",
            })
        );
        expect(failedRestart.status).toBe(500);
    });
    it("normalizes cron and session route contracts through a patched gateway", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const routeRoot = createTemporaryRoot("mira-gateway-route-contracts-");
        process.env.OPENCLAW_HOME = path.join(routeRoot, "openclaw-home");
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = path.join(
            routeRoot,
            "dashboard-openclaw-home"
        );
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalRequest = gateway.request;
        const originalGetSessions = gateway.getSessions;
        const originalAbortSessionRun = gateway.abortSessionRun;
        const originalSendSessionMessage = gateway.sendSessionMessage;
        const originalDeleteSession = gateway.deleteSession;
        const gatewayCalls: Array<{
            method: string;
            parameters: Record<string, unknown>;
        }> = [];
        cleanupCallbacks.push(() => {
            gateway.request = originalRequest;
            gateway.getSessions = originalGetSessions;
            gateway.abortSessionRun = originalAbortSessionRun;
            gateway.sendSessionMessage = originalSendSessionMessage;
            gateway.deleteSession = originalDeleteSession;
        });
        gateway.request = (method, parameters) => {
            return Promise.try(() => {
                gatewayCalls.push({
                    method,
                    parameters,
                });
                if (method === "cron.list") {
                    return {
                        jobs: [
                            {
                                enabled: true,
                                id: "heartbeat",
                                name: "Heartbeat",
                            },
                        ],
                    };
                }
                if (method === "cron.remove" || method === "cron.run") {
                    return {
                        method,
                        parameters,
                    };
                }
                if (method === "cron.update") {
                    return {
                        isOk: true,
                    };
                }
                throw new Error(`unexpected gateway method: ${method}`);
            });
        };
        gateway.getSessions = () => [
            {
                agentType: "codex",
                channel: "webchat",
                createdAt: "2026-06-24T10:00:00.000Z",
                displayLabel: "Main",
                displayName: "Main",
                hookName: "",
                id: "agent:main:main",
                key: "agent:main:main",
                label: "Main",
                maxTokens: 200,
                model: "codex",
                tokenCount: 100,
                type: "agent",
                updatedAt: Date.now(),
            },
            {
                agentType: "codex",
                channel: "webchat",
                createdAt: "2026-06-24T09:00:00.000Z",
                displayLabel: "Researcher",
                displayName: "Researcher",
                hookName: "",
                id: "agent:researcher:1",
                key: "agent:researcher:1",
                label: "Researcher",
                maxTokens: 100,
                model: "glm",
                tokenCount: 25,
                type: "agent",
                updatedAt: 0,
            },
        ];
        gateway.abortSessionRun = (sessionKey) => {
            return Promise.try(() => {
                gatewayCalls.push({
                    method: "chat.abort",
                    parameters: {
                        sessionKey,
                    },
                });
            });
        };
        gateway.sendSessionMessage = (sessionKey, message) => {
            return Promise.try(() => {
                gatewayCalls.push({
                    method: "chat.send",
                    parameters: {
                        message,
                        sessionKey,
                    },
                });
            });
        };
        gateway.deleteSession = (sessionKey) => {
            return Promise.try(() => {
                gatewayCalls.push({
                    method: "sessions.delete",
                    parameters: {
                        sessionKey,
                    },
                });
                return {
                    deleted: sessionKey,
                };
            });
        };
        const [{ cronRoutes }, { sessionRoutes }] = await Promise.all([
            import("../../src/routes/cronRoutes.ts"),
            import("../../src/routes/sessionRoutes.ts"),
        ]);
        const cronList = await cronRoutes["/api/cron/jobs"].GET();
        expect(cronList.json()).resolves.toEqual({
            jobs: [
                {
                    enabled: true,
                    id: "heartbeat",
                    name: "Heartbeat",
                },
            ],
        });
        expect(gatewayCalls).toContainEqual({
            method: "cron.list",
            parameters: {
                includeDisabled: true,
            },
        });
        const cronDeleteRequest = {
            params: {
                id: "heartbeat",
            },
        } as Request & {
            params: {
                id: string;
            };
        };
        const cronDelete =
            await cronRoutes["/api/cron/jobs/:id/delete"].POST(cronDeleteRequest);
        expect(cronDelete.json()).resolves.toMatchObject({
            isOk: true,
        });
        expect(gatewayCalls).toContainEqual({
            method: "cron.remove",
            parameters: {
                jobId: "heartbeat",
            },
        });
        const badToggleRequest = new Request(
            "https://dashboard.test/api/cron/jobs/heartbeat/toggle",
            {
                body: JSON.stringify({
                    enabled: "yes",
                }),
                method: "POST",
            }
        );
        const badToggle = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            Object.assign(badToggleRequest, {
                params: {
                    id: "heartbeat",
                },
            })
        );
        expect(badToggle.status).toBe(400);
        expect(badToggle.json()).resolves.toEqual(
            apiErrorExpectation(
                expect.stringContaining("body.enabled"),
                "invalid_request"
            )
        );
        const validToggleRequest = new Request(
            "https://dashboard.test/api/cron/jobs/heartbeat/toggle",
            {
                body: JSON.stringify({
                    enabled: false,
                }),
                method: "POST",
            }
        );
        const validToggle = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            Object.assign(validToggleRequest, {
                params: {
                    id: "heartbeat",
                },
            })
        );
        expect(validToggle.json()).resolves.toEqual({
            isOk: true,
        });
        expect(gatewayCalls).toContainEqual({
            method: "cron.update",
            parameters: {
                jobId: "heartbeat",
                patch: {
                    enabled: false,
                },
            },
        });
        const badUpdateRequest = new Request(
            "https://dashboard.test/api/cron/jobs/heartbeat/update",
            {
                body: JSON.stringify({
                    patch: [],
                }),
                method: "POST",
            }
        );
        const badUpdate = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            Object.assign(badUpdateRequest, {
                params: {
                    id: "heartbeat",
                },
            })
        );
        expect(badUpdate.status).toBe(400);
        expect(badUpdate.json()).resolves.toEqual(
            apiErrorExpectation("body.patch: must be an object", "invalid_request")
        );
        const validUpdateRequest = new Request(
            "https://dashboard.test/api/cron/jobs/heartbeat/update",
            {
                body: JSON.stringify({
                    patch: {
                        name: "Heartbeat every minute",
                        schedule: "*/1 * * * *",
                    },
                }),
                method: "POST",
            }
        );
        const validUpdate = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            Object.assign(validUpdateRequest, {
                params: {
                    id: "heartbeat",
                },
            })
        );
        expect(validUpdate.status).toBe(200);
        expect(validUpdate.json()).resolves.toEqual({
            isOk: true,
        });
        expect(gatewayCalls).toContainEqual({
            method: "cron.update",
            parameters: {
                jobId: "heartbeat",
                patch: {
                    name: "Heartbeat every minute",
                    schedule: "*/1 * * * *",
                },
            },
        });
        const sessionListRequest = new Request(
            "https://dashboard.test/api/sessions/list?model=codex"
        );
        const sessionList = sessionRoutes["/api/sessions/list"].GET(sessionListRequest);
        expect(sessionList.json()).resolves.toMatchObject({
            sessions: [
                expect.objectContaining({
                    key: "agent:main:main",
                }),
            ],
        });
        const stats = sessionRoutes["/api/sessions/stats"].GET();
        expect(stats.json()).resolves.toMatchObject({
            activeInLastHour: 1,
            byModel: {
                codex: 1,
                glm: 1,
            },
            total: 2,
            totalTokens: 125,
        });
        const compactRequest = new Request("https://dashboard.test/api/sessions/action", {
            body: JSON.stringify({
                action: "compact",
            }),
            method: "POST",
        });
        const compact = await sessionRoutes["/api/sessions/:id/action"].POST(
            Object.assign(compactRequest, {
                params: {
                    id: "agent:main:main",
                },
            })
        );
        expect(compact.json()).resolves.toEqual({
            action: "compact",
            isSuccess: true,
        });
        const unsupportedRequest = new Request(
            "https://dashboard.test/api/sessions/action",
            {
                body: JSON.stringify({
                    action: "sleep",
                }),
                method: "POST",
            }
        );
        const unsupported = await sessionRoutes["/api/sessions/:id/action"].POST(
            Object.assign(unsupportedRequest, {
                params: {
                    id: "agent:main:main",
                },
            })
        );
        expect(unsupported.status).toBe(400);
        expect(unsupported.json()).resolves.toEqual(
            apiErrorExpectation(expect.stringContaining("body.action"), "invalid_request")
        );
        const invalidSessionActionRequest = new Request(
            "https://dashboard.test/api/sessions/action",
            {
                body: JSON.stringify({
                    action: "reset",
                }),
                method: "POST",
            }
        );
        const invalidSessionAction = await sessionRoutes["/api/sessions/:id/action"].POST(
            Object.assign(invalidSessionActionRequest, {
                params: {
                    id: " ",
                },
            })
        );
        expect(invalidSessionAction.status).toBe(400);
        const invalidSessionDelete = await sessionRoutes["/api/sessions/:id"].DELETE({
            params: {
                id: " ",
            },
        } as Request & {
            params: {
                id: string;
            };
        });
        expect(invalidSessionDelete.status).toBe(400);
        const deleteRequest = {
            params: {
                id: "agent:main:main",
            },
        } as Request & {
            params: {
                id: string;
            };
        };
        const deleted = await sessionRoutes["/api/sessions/:id"].DELETE(deleteRequest);
        expect(deleted.json()).resolves.toEqual({
            isSuccess: true,
            result: {
                deleted: "agent:main:main",
            },
        });
        expect(gatewayCalls).toContainEqual({
            method: "chat.send",
            parameters: {
                message: "/compact",
                sessionKey: "agent:main:main",
            },
        });
        gateway.sendSessionMessage = () =>
            Promise.reject(new Error("Gateway session action unavailable"));
        const failedSessionActionRequest = new Request(
            "https://dashboard.test/api/sessions/action",
            {
                body: JSON.stringify({
                    action: "reset",
                }),
                method: "POST",
            }
        );
        const failedSessionAction = await sessionRoutes["/api/sessions/:id/action"].POST(
            Object.assign(failedSessionActionRequest, {
                params: {
                    id: "agent:main:main",
                },
            })
        );
        expect(failedSessionAction.status).toBe(500);
    });
    it("validates Docker route input and maps updater rows without running Docker", async () => {
        const { dockerRoutes } = await import("../../src/routes/dockerRoutes.ts");
        const invalidContainerRequest = Object.assign(
            new Request("https://dashboard.test/api/docker/containers/--bad"),
            {
                params: {
                    containerId: "--bad",
                },
            }
        );
        const invalidImageRequest = Object.assign(
            new Request("https://dashboard.test/api/docker/images/--bad", {
                method: "DELETE",
            }),
            {
                params: {
                    imageId: "--bad",
                },
            }
        );
        const invalidVolumeRequest = Object.assign(
            new Request("https://dashboard.test/api/docker/volumes/--bad", {
                method: "DELETE",
            }),
            {
                params: {
                    volumeName: "--bad",
                },
            }
        );
        const invalidServiceRequest = Object.assign(
            new Request(
                "https://dashboard.test/api/docker/updater/services/nope/update",
                {
                    method: "POST",
                }
            ),
            {
                params: {
                    serviceId: "nope",
                },
            }
        );
        const invalidContainerResponse = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(invalidContainerRequest);
        expect(invalidContainerResponse.json()).resolves.toEqual(
            apiErrorExpectation("Invalid containerId")
        );
        expect(
            await dockerRoutes["/api/docker/images/:imageId"].DELETE(invalidImageRequest)
        ).toMatchObject({
            status: 400,
        });
        expect(
            await dockerRoutes["/api/docker/volumes/:volumeName"].DELETE(
                invalidVolumeRequest
            )
        ).toMatchObject({
            status: 400,
        });
        expect(
            await dockerRoutes["/api/docker/updater/services/:serviceId/update"].POST(
                invalidServiceRequest
            )
        ).toMatchObject({
            status: 400,
        });
        const missingExec = dockerRoutes["/api/docker/exec/:jobId"].GET(
            Object.assign(new Request("https://dashboard.test/api/docker/exec/missing"), {
                params: {
                    jobId: "missing",
                },
            })
        );
        expect(missingExec.status).toBe(404);
        const dockerRunSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((_command, arguments_) => {
                return Promise.try(() => {
                    const joined = arguments_.join(" ");
                    if (joined.includes("ps -a")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: `${JSON.stringify({
                                Command: "sleep 100",
                                CreatedAt: "2026-06-26 01:00:00 +0000 UTC",
                                ID: "abc123",
                                Image: "unit/web:latest",
                                Labels: "",
                                Mounts: "",
                                Names: "unit-web",
                                Networks: "bridge",
                                Ports: "",
                                RunningFor: "1 minute",
                                State: "running",
                                Status: "Up 1 minute",
                            })}\n`,
                        };
                    }
                    if (joined.includes("stats --no-stream")) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: `${JSON.stringify({
                                BlockIO: "0B / 0B",
                                CPUPerc: "0.00%",
                                ID: "abc123",
                                MemPerc: "0.00%",
                                MemUsage: "1MiB / 1GiB",
                                NetIO: "0B / 0B",
                                PIDs: "1",
                            })}\n`,
                        };
                    }
                    if (arguments_[0] === "inspect") {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: JSON.stringify([
                                {
                                    Config: {
                                        Env: ["API_TOKEN=secret", "PLAIN=value"],
                                        Labels: {
                                            "com.docker.compose.service": "web",
                                        },
                                    },
                                    Created: "2026-06-26T01:00:00.000Z",
                                    Id: "abc123full",
                                    Image: "sha256:image",
                                    Mounts: [],
                                    NetworkSettings: {
                                        Networks: {},
                                    },
                                    RestartCount: 0,
                                    State: {
                                        StartedAt: "2026-06-26T01:00:00.000Z",
                                    },
                                },
                            ]),
                        };
                    }
                    return {
                        code: 1,
                        stderr: `unexpected docker ${joined}`,
                        stdout: "",
                    };
                });
            });
        const dockerSpawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation(() => {
                throw new Error("docker exec spawn failed");
            });
        try {
            const { registerDockerExecutionActions } =
                await import("../../src/services/dockerActions.ts");
            registerDockerExecutionActions();
            await startTestScheduledExecutor();
            const execStart = await dockerRoutes["/api/docker/exec/start"].POST(
                new Request("https://dashboard.test/api/docker/exec/start", {
                    body: JSON.stringify({
                        command: "echo hello",
                        containerId: "unit-web",
                    }),
                    method: "POST",
                })
            );
            const execStartBody = (await execStart.json()) as {
                jobId: string;
            };
            await waitFor(() => {
                const row = database
                    .prepare("SELECT status FROM job_executions WHERE id = ?")
                    .get(execStartBody.jobId) as
                    | {
                          status?: string;
                      }
                    | undefined;
                return row?.status === "failed";
            }, 3000);
            const failedExec = dockerRoutes["/api/docker/exec/:jobId"].GET(
                Object.assign(
                    new Request(
                        `https://dashboard.test/api/docker/exec/${execStartBody.jobId}`
                    ),
                    {
                        params: {
                            jobId: execStartBody.jobId,
                        },
                    }
                )
            );
            expect(failedExec.json()).resolves.toMatchObject({
                code: 1,
                containerId: "abc123",
                stderr: "docker exec spawn failed",
                status: "done",
            });
            const stopFinished = dockerRoutes["/api/docker/exec/:jobId/stop"].POST(
                Object.assign(
                    new Request(
                        `https://dashboard.test/api/docker/exec/${execStartBody.jobId}/stop`,
                        {
                            method: "POST",
                        }
                    ),
                    {
                        params: {
                            jobId: execStartBody.jobId,
                        },
                    }
                )
            );
            expect(stopFinished.status).toBe(400);
            expect(stopFinished.json()).resolves.toEqual(
                apiErrorExpectation("Job is not running")
            );
        } finally {
            dockerRunSpy.mockRestore();
            dockerSpawnSpy.mockRestore();
        }
        const invalidPrune = await dockerRoutes["/api/docker/prune"].POST(
            new Request("https://dashboard.test/api/docker/prune", {
                body: JSON.stringify({
                    target: "everything",
                }),
                method: "POST",
            })
        );
        expect(invalidPrune.status).toBe(400);
        const invalidStackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            new Request("https://dashboard.test/api/docker/stack/action", {
                body: JSON.stringify({
                    action: "remove",
                }),
                method: "POST",
            })
        );
        expect(invalidStackAction.status).toBe(400);
        const appSlug = `unit-route-${Bun.randomUUIDv7()}`;
        try {
            const service = database
                .prepare(`INSERT INTO docker_managed_services (
                        app_slug, service_name, compose_path, image_repo,
                        compose_image_ref, current_tag, current_digest, latest_tag,
                        latest_digest, policy, pin_mode, enabled, metadata_json,
                        last_checked_at, last_updated_at, last_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    RETURNING id`)
                .get(
                    appSlug,
                    "web",
                    "/tmp/compose.yaml",
                    "example.com/unit/web",
                    "example.com/unit/web:1.0.0",
                    "1.0.0",
                    "sha256:old",
                    "1.1.0",
                    "sha256:new",
                    "notify",
                    "tag",
                    0,
                    JSON.stringify({
                        source: "test",
                    }),
                    "2026-06-24T10:00:00.000Z",
                    "2026-06-24T11:00:00.000Z",
                    "disabled"
                ) as {
                id: number;
            };
            database
                .prepare(`INSERT INTO docker_update_events (
                        managed_service_id, app_slug, service_name, event_type,
                        from_tag, to_tag, from_digest, to_digest, message,
                        details_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(
                    service.id,
                    appSlug,
                    "web",
                    "update_available",
                    "1.0.0",
                    "1.1.0",
                    "sha256:old",
                    "sha256:new",
                    "ready",
                    "{}",
                    "2026-06-24T12:00:00.000Z"
                );
            const servicesResponse = dockerRoutes["/api/docker/updater/services"].GET();
            const servicesBody = (await servicesResponse.json()) as {
                services: Array<{
                    appSlug: string;
                    enabled: boolean;
                    metadata: Record<string, unknown>;
                    updateAvailable: boolean;
                }>;
                summary: {
                    enabled: number;
                    total: number;
                    updateAvailable: number;
                };
            };
            expect(servicesBody.services).toContainEqual(
                expect.objectContaining({
                    appSlug,
                    enabled: false,
                    metadata: {
                        source: "test",
                    },
                    updateAvailable: true,
                })
            );
            expect(servicesBody.summary.total).toBeGreaterThanOrEqual(1);
            expect(servicesBody.summary.updateAvailable).toBeGreaterThanOrEqual(1);
            const eventsResponse = dockerRoutes["/api/docker/updater/events"].GET(
                new Request("https://dashboard.test/api/docker/updater/events?limit=1")
            );
            const eventsBody = (await eventsResponse.json()) as {
                events: Array<{
                    appSlug: string;
                    managedServiceId?: number;
                }>;
            };
            expect(eventsBody.events).toContainEqual(
                expect.objectContaining({
                    appSlug,
                    managedServiceId: service.id,
                })
            );
            const disabledServiceRequest = Object.assign(
                new Request(
                    `https://dashboard.test/api/docker/updater/services/${service.id}/update`,
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        serviceId: String(service.id),
                    },
                }
            );
            const disabledServiceResponse =
                await dockerRoutes["/api/docker/updater/services/:serviceId/update"].POST(
                    disabledServiceRequest
                );
            expect(disabledServiceResponse.status).toBe(400);
            expect(disabledServiceResponse.json()).resolves.toEqual(
                apiErrorExpectation("Updater service is disabled")
            );
            rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
            const appsRoot = createTemporaryRoot("mira-docker-route-unsupported-");
            const appRoot = path.join(appsRoot, appSlug);
            mkdirSync(appRoot, {
                recursive: true,
            });
            writeFileSync(
                path.join(appRoot, "compose.yaml"),
                [
                    "services:",
                    "  api:",
                    "    image: example.com/unit/api:1.0.0",
                    "    labels:",
                    "      mira.updater.enabled: 'true'",
                    "",
                ].join("\n")
            );
            process.env.MIRA_DOCKER_APPS_ROOT = appsRoot;
            const { registerDockerUpdaterScheduledJobs, registerDockerUpdaterServices } =
                await Promise.all([
                    import("../../src/services/dockerUpdater/scheduler.ts"),
                    import("../../src/services/dockerUpdater/composeDiscovery.ts"),
                ]).then(([module0, module1]) => ({
                    registerDockerUpdaterScheduledJobs:
                        module0.registerDockerUpdaterScheduledJobs,
                    registerDockerUpdaterServices: module1.registerDockerUpdaterServices,
                }));
            registerDockerUpdaterScheduledJobs();
            expect(registerDockerUpdaterServices()).toMatchObject({
                isOk: true,
            });
            const unsupportedService = database
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE app_slug = ? AND service_name = 'api'"
                )
                .get(appSlug) as {
                id: number;
            };
            const unsupportedRequest = Object.assign(
                new Request(
                    `https://dashboard.test/api/docker/updater/services/${unsupportedService.id}/update`,
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        serviceId: String(unsupportedService.id),
                    },
                }
            );
            const unsupportedResponse =
                await dockerRoutes["/api/docker/updater/services/:serviceId/update"].POST(
                    unsupportedRequest
                );
            expect(unsupportedResponse.status).toBe(422);
            expect(unsupportedResponse.json()).resolves.toEqual(
                apiErrorExpectation("Unsupported image registry", "unsupported_registry")
            );
        } finally {
            database
                .prepare("DELETE FROM docker_update_events WHERE app_slug = ?")
                .run(appSlug);
            database
                .prepare("DELETE FROM docker_managed_services WHERE app_slug = ?")
                .run(appSlug);
        }
    });
    it("persists, updates, runs, and prunes scheduled jobs", async () => {
        const actionKey = `test-action-${Bun.randomUUIDv7()}`;
        const keepId = `test-job-keep-${Bun.randomUUIDv7()}`;
        const pruneId = `test-job-prune-${Bun.randomUUIDv7()}`;
        const scheduledDueId = `test-job-scheduled-due-${Bun.randomUUIDv7()}`;
        const scheduledFutureId = `test-job-scheduled-future-${Bun.randomUUIDv7()}`;
        const scheduledDisabledId = `test-job-scheduled-disabled-${Bun.randomUUIDv7()}`;
        const {
            calculateNextRunAt,
            enqueueScheduledJob,
            getScheduledJob,
            isScheduledJobValidationError,
            listScheduledJobs,
            listScheduledJobRuns,
            registerScheduledJobAction,
            removeScheduledJobsNotInAction,
            runScheduledJob,
            stopScheduledJobExecutor,
            updateScheduledJob,
            upsertScheduledJob,
        } = await Promise.all([
            import("../../src/services/scheduledJobs/schedule.ts"),
            import("../../src/services/scheduledJobs/enqueue.ts"),
            import("../../src/services/scheduledJobs/repository.ts"),
            import("../../src/services/scheduledJobs/errors.ts"),
            import("../../src/services/scheduledJobs/actionRegistry.ts"),
            import("../../src/services/scheduledJobs/runtime.ts"),
        ]).then(([module0, module1, module2, module3, module4, module5]) => ({
            calculateNextRunAt: module0.calculateNextRunAt,
            enqueueScheduledJob: module1.enqueueScheduledJob,
            getScheduledJob: module2.getScheduledJob,
            isScheduledJobValidationError: module3.isScheduledJobValidationError,
            listScheduledJobs: module2.listScheduledJobs,
            listScheduledJobRuns: module2.listScheduledJobRuns,
            registerScheduledJobAction: module4.registerScheduledJobAction,
            removeScheduledJobsNotInAction: module2.removeScheduledJobsNotInAction,
            runScheduledJob: module1.runScheduledJob,
            stopScheduledJobExecutor: module5.stopScheduledJobExecutor,
            updateScheduledJob: module2.updateScheduledJob,
            upsertScheduledJob: module2.upsertScheduledJob,
        }));
        const { cancelJobExecution } =
            await import("../../src/services/jobExecutionQueue/worker.ts");
        try {
            startTestScheduledJobExecutor();
            expect(
                calculateNextRunAt(
                    {
                        enabled: true,
                        intervalSeconds: 90,
                        scheduleType: "interval",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:00:00.000Z")
                )
            ).toBe("2026-06-24T10:01:30.000Z");
            expect(
                calculateNextRunAt(
                    {
                        enabled: false,
                        intervalSeconds: 90,
                        scheduleType: "interval",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:00:00.000Z")
                )
            ).toBeUndefined();
            expect(
                calculateNextRunAt(
                    {
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "daily",
                        timeOfDay: "12:30",
                    },
                    new Date("2026-06-24T10:00:00.000Z")
                )
            ).toBe("2026-06-24T12:30:00.000Z");
            expect(
                calculateNextRunAt(
                    {
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "daily",
                        timeOfDay: "09:30",
                    },
                    new Date("2026-06-24T10:00:00.000Z")
                )
            ).toBe("2026-06-25T09:30:00.000Z");
            expect(
                calculateNextRunAt(
                    {
                        cronExpression: "*/15 * * * *",
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "cron",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:07:30.000Z")
                )
            ).toBe("2026-06-24T10:15:00.000Z");
            expect(
                calculateNextRunAt(
                    {
                        cronExpression: "0 9 * * 7",
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "cron",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:07:30.000Z")
                )
            ).toBe("2026-06-28T09:00:00.000Z");
            expect(() =>
                calculateNextRunAt(
                    {
                        cronExpression: "bad cron",
                        enabled: true,
                        intervalSeconds: 60,
                        scheduleType: "cron",
                        timeOfDay: undefined,
                    },
                    new Date("2026-06-24T10:07:30.000Z")
                )
            ).toThrow("Cron jobs require a valid cronExpression");
            expect(() =>
                upsertScheduledJob({
                    actionKey,
                    enabled: true,
                    id: "x",
                    intervalSeconds: 1,
                    name: "Invalid job",
                    scheduleType: "interval",
                })
            ).toThrow("Job id is invalid");
            expect(() =>
                upsertScheduledJob({
                    actionKey,
                    enabled: true,
                    id: `test-job-invalid-daily-${Bun.randomUUIDv7()}`,
                    intervalSeconds: 120,
                    name: "Invalid daily job",
                    scheduleType: "daily",
                    timeOfDay: "25:00",
                })
            ).toThrow("Daily jobs require HH:MM timeOfDay");
            expect(() =>
                registerScheduledJobAction(
                    `bad-timeout-${Bun.randomUUIDv7()}`,
                    () => ({}),
                    {
                        timeoutMs: 0,
                    }
                )
            ).toThrow(
                "Scheduled job action timeout must be an integer between 1 and 2147483647"
            );
            registerScheduledJobAction(actionKey, (job) => ({
                jobId: job.id,
                payloadValue: job.actionPayload.value,
            }));
            const keepJob = upsertScheduledJob({
                actionKey,
                actionPayload: {
                    value: 42,
                },
                enabled: true,
                id: keepId,
                intervalSeconds: 120,
                name: "Keep job",
                scheduleType: "interval",
            });
            upsertScheduledJob({
                actionKey,
                id: pruneId,
                intervalSeconds: 120,
                name: "Prune job",
                scheduleType: "interval",
            });
            expect(keepJob.nextRunAt).toBeTruthy();
            expect(getScheduledJob(keepId)).toMatchObject({
                actionPayload: {
                    value: 42,
                },
                enabled: true,
                id: keepId,
            });
            expect(
                updateScheduledJob(keepId, {
                    enabled: false,
                })
            ).toMatchObject({
                enabled: false,
                nextRunAt: undefined,
            });
            const manualRun = enqueueScheduledJob(keepId);
            expect(() => enqueueScheduledJob(keepId)).toThrow(
                "Scheduled job is already queued or running"
            );
            cancelJobExecution(manualRun.executionId as string);
            const result = await runScheduledJob(keepId);
            expect(result).toMatchObject({
                jobId: keepId,
                output: {
                    jobId: keepId,
                    payloadValue: 42,
                },
                status: "success",
                triggerType: "manual",
            });
            expect(listScheduledJobRuns(keepId, 2)).toHaveLength(2);
            upsertScheduledJob({
                actionKey,
                actionPayload: {
                    value: "scheduled",
                },
                enabled: true,
                id: scheduledDueId,
                intervalSeconds: 120,
                name: "Scheduled due job",
                scheduleType: "interval",
            });
            database
                .prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?")
                .run("2026-01-01T00:00:00.000Z", scheduledDueId);
            const scheduledRun = await runScheduledJob(scheduledDueId, "schedule");
            expect(scheduledRun).toMatchObject({
                jobId: scheduledDueId,
                output: {
                    jobId: scheduledDueId,
                    payloadValue: "scheduled",
                },
                status: "success",
                triggerType: "schedule",
            });
            expect(getScheduledJob(scheduledDueId)?.nextRunAt).not.toBe(
                "2026-01-01T00:00:00.000Z"
            );
            upsertScheduledJob({
                actionKey,
                actionPayload: {
                    value: "future",
                },
                enabled: true,
                id: scheduledFutureId,
                intervalSeconds: 120,
                name: "Scheduled future job",
                scheduleType: "interval",
            });
            expect(runScheduledJob(scheduledFutureId, "schedule")).rejects.toMatchObject({
                statusCode: 409,
            });
            upsertScheduledJob({
                actionKey,
                actionPayload: {
                    value: "disabled",
                },
                enabled: false,
                id: scheduledDisabledId,
                intervalSeconds: 120,
                name: "Scheduled disabled job",
                scheduleType: "interval",
            });
            expect(
                runScheduledJob(scheduledDisabledId, "schedule")
            ).rejects.toMatchObject({
                statusCode: 409,
            });
            database
                .prepare("UPDATE scheduled_job_runs SET output_json = ? WHERE job_id = ?")
                .run("not json", keepId);
            expect(listScheduledJobRuns(keepId, 0)).toHaveLength(2);
            expect(listScheduledJobRuns(keepId, 1)).toHaveLength(1);
            expect(getScheduledJob(keepId)?.lastRun?.output).toEqual({});
            expect(
                listScheduledJobs().find((job) => job.id === keepId)?.lastRun?.output
            ).toEqual({});
            removeScheduledJobsNotInAction(actionKey, [keepId]);
            expect(getScheduledJob(keepId)).toBeDefined();
            expect(getScheduledJob(pruneId)).toBeUndefined();
            expect(getScheduledJob(scheduledDueId)).toBeUndefined();
            const missingActionId = `test-job-missing-action-${Bun.randomUUIDv7()}`;
            upsertScheduledJob({
                actionKey: `missing-action-${Bun.randomUUIDv7()}`,
                id: missingActionId,
                intervalSeconds: 120,
                name: "Missing action",
                scheduleType: "interval",
            });
            try {
                await runScheduledJob(missingActionId);
                throw new Error("Expected missing action to fail");
            } catch (error) {
                expect(isScheduledJobValidationError(error)).toBe(true);
                expect(error).toHaveProperty(
                    "message",
                    expect.stringContaining("No scheduled job action registered")
                );
            }
            const timeoutActionKey = `test-timeout-action-${Bun.randomUUIDv7()}`;
            const timeoutJobId = `test-job-timeout-${Bun.randomUUIDv7()}`;
            let isTimeoutHandlerSettled = false;
            registerScheduledJobAction(
                timeoutActionKey,
                async () => {
                    try {
                        await Bun.sleep(50);
                        return {
                            late: true,
                        };
                    } finally {
                        isTimeoutHandlerSettled = true;
                    }
                },
                {
                    timeoutMs: 1,
                }
            );
            upsertScheduledJob({
                actionKey: timeoutActionKey,
                id: timeoutJobId,
                intervalSeconds: 120,
                name: "Timeout job",
                scheduleType: "interval",
            });
            expect(runScheduledJob(timeoutJobId)).resolves.toMatchObject({
                jobId: timeoutJobId,
                message: "Scheduled job timed out",
                output: {},
                status: "failed",
            });
            expect(isTimeoutHandlerSettled).toBe(true);
            const abortActionKey = `test-abort-action-${Bun.randomUUIDv7()}`;
            const abortJobId = `test-job-abort-${Bun.randomUUIDv7()}`;
            registerScheduledJobAction(abortActionKey, () => ({
                reached: true,
            }));
            upsertScheduledJob({
                actionKey: abortActionKey,
                id: abortJobId,
                intervalSeconds: 120,
                name: "Abort job",
                scheduleType: "interval",
            });
            const controller = new AbortController();
            controller.abort();
            expect(
                runScheduledJob(abortJobId, "manual", controller.signal)
            ).rejects.toHaveProperty("name", "AbortError");
        } finally {
            await stopScheduledJobExecutor();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'test-job-%'")
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'test-job-%'")
                .run();
        }
    });
});
