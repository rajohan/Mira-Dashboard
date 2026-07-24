import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { describe, expect, it, jest } from "bun:test";

import {
    isAllowedDashboardOrigin,
    readJson,
    readRequestBytes,
    sessionIdFromCookie,
    text,
    withCookie,
} from "../src/http.ts";
import { errorMessage, httpStatusCode } from "../src/lib/errors.ts";
import { loadOrCreateDeviceIdentity } from "../src/lib/openclawGatewayClient.ts";
import { pipeProcessOutput, runProcess } from "../src/lib/processes.ts";
import {
    prepareSafeWriteTargetWithinRoot,
    safePathWithinRoot,
    sanitizeFilename,
} from "../src/lib/safePath.ts";
import {
    arrayFallback,
    environmentFallback,
    nonEmptyEnvironmentFallback,
    nullableString,
    objectFallback,
    stringFallback,
} from "../src/lib/values.ts";
import { resetRequestPolicyForTests, withRequestPolicy } from "../src/requestPolicy.ts";
import { isAllowedMutationSource, withRequestSecurity } from "../src/requestSecurity.ts";
import { routes as appRoutes } from "../src/routes.ts";
import { compactHeartbeatData } from "../src/routes/cacheRoutes.ts";
import { isValidAgentId } from "../src/services/agents.ts";
import { listAuditEvents } from "../src/services/auditEvents.ts";
import { mapBackupJob } from "../src/services/backups.ts";
import * as jobExecutionQueueModule from "../src/services/jobExecutionQueue.ts";
import { getResolvedRoots, validatePrNumber } from "../src/services/pullRequests.ts";

function serverWithAddress(address: string): Server<unknown> {
    return {
        requestIP: () => ({ address, family: "IPv4", port: 12_345 }),
    } as unknown as Server<unknown>;
}

function canonicalPath(value: string): string {
    return path.join(realpathSync(path.dirname(value)), path.basename(value));
}

async function callTestRoute(
    routes: Record<string, unknown>,
    path: string,
    server: Server<unknown>,
    init?: RequestInit
): Promise<Response> {
    const entry = routes[path];
    const handler =
        typeof entry === "function"
            ? entry
            : typeof entry === "object" && entry !== null && "GET" in entry
              ? entry.GET
              : undefined;
    if (typeof handler !== "function") {
        throw new TypeError(`Missing test route: ${path}`);
    }
    return handler(new Request(`http://localhost${path}`, init), server);
}

describe("backend service utilities", () => {
    it("compacts every heartbeat cache payload without dropping health failures", () => {
        const kopia = compactHeartbeatData("backup.kopia.status", {
            checkedAt: "checked",
            isOk: false,
            latest: [
                {
                    endTime: "ended",
                    errorCount: 1,
                    ignoredErrorCount: 2,
                    path: "/source",
                    snapshots: ["omitted"],
                },
            ],
            stale: ["/source"],
        });
        expect(kopia).toEqual({
            checkedAt: "checked",
            isOk: false,
            latest: [
                {
                    endTime: "ended",
                    errorCount: 1,
                    ignoredErrorCount: 2,
                    path: "/source",
                },
            ],
            stale: ["/source"],
        });

        expect(
            compactHeartbeatData("backup.walg.status", {
                backupCount: 1,
                backups: ["omitted"],
                checkedAt: "checked",
                isOk: false,
                latest: { backupName: "latest" },
                latestAgeHours: 25,
                stale: true,
            })
        ).toEqual({
            backupCount: 1,
            checkedAt: "checked",
            isOk: false,
            latest: { backupName: "latest" },
            latestAgeHours: 25,
            stale: true,
        });

        expect(
            compactHeartbeatData("database.summary", {
                checkedAt: "checked",
                databases: [
                    {
                        cache_hit_ratio: "91",
                        datname: "mira",
                        numbackends: "2",
                        query: "omitted",
                        size_bytes: "100",
                    },
                ],
                overview: {
                    totalBackends: 2,
                    maintenance: {
                        status: "review",
                        estimatedReclaimableBytes: 6_442_450_944,
                    },
                },
                sqlite: {
                    attention: ["SQLite storage permissions are not secure"],
                    backup: {
                        count: 2,
                        current: true,
                        latest: { createdAt: "backup-time", kind: "scheduled" },
                        latestAgeHours: 1,
                        reviewAgeHours: 48,
                    },
                    databaseBytes: 200,
                    freeBytes: 50,
                    freePercent: 25,
                    journalMode: "wal",
                    lastMaintenance: { status: "failed" },
                    migrations: { applied: 4, current: true, latest: 4 },
                    permissions: { database: "0600", secure: false },
                    status: "review",
                    storageBytes: 250,
                    walBytes: 40,
                },
                topQueries: ["omitted"],
            })
        ).toEqual({
            attention: {
                needsReview: true,
                sources: ["postgresql", "dashboard-sqlite"],
            },
            checkedAt: "checked",
            databases: [
                {
                    cacheHitRatio: "91",
                    connections: "2",
                    name: "mira",
                    sizeBytes: "100",
                },
            ],
            maintenance: {
                status: "review",
                estimatedReclaimableBytes: 6_442_450_944,
            },
            overview: {
                totalBackends: 2,
                maintenance: {
                    status: "review",
                    estimatedReclaimableBytes: 6_442_450_944,
                },
            },
            sqlite: {
                attention: ["SQLite storage permissions are not secure"],
                backup: {
                    count: 2,
                    current: true,
                    latest: { createdAt: "backup-time", kind: "scheduled" },
                    latestAgeHours: 1,
                    reviewAgeHours: 48,
                },
                databaseBytes: 200,
                freeBytes: 50,
                freePercent: 25,
                journalMode: "wal",
                lastMaintenance: { status: "failed" },
                migrations: { applied: 4, current: true, latest: 4 },
                permissions: { secure: false },
                status: "review",
                storageBytes: 250,
                walBytes: 40,
            },
        });

        expect(
            compactHeartbeatData("docker.summary", {
                checkedAt: "checked",
                containers: [
                    {
                        command: "omitted",
                        health: "unhealthy",
                        name: "app",
                        restartCount: 3,
                        state: "running",
                        status: "Up",
                    },
                ],
                images: ["omitted"],
                updaterSummary: { failed: 1 },
            })
        ).toEqual({
            checkedAt: "checked",
            containers: [
                {
                    health: "unhealthy",
                    name: "app",
                    restartCount: 3,
                    state: "running",
                    status: "Up",
                },
            ],
            updaterSummary: { failed: 1 },
        });

        expect(
            compactHeartbeatData("log_rotation.state", {
                files: { omitted: true },
                lastRun: {
                    errors: ["failed"],
                    finishedAt: "finished",
                    groups: ["omitted"],
                    isOk: false,
                    skippedFiles: 1,
                    warnings: ["warning"],
                },
            })
        ).toEqual({
            lastRun: {
                errors: ["failed"],
                finishedAt: "finished",
                isOk: false,
                skippedFiles: 1,
                warnings: ["warning"],
            },
        });

        expect(
            compactHeartbeatData("system.openclaw", {
                checkedAt: "checked",
                doctorError: "doctor failed",
                doctorWarningCount: 0,
                doctorWarnings: [],
                gateway: { reachable: false, status: "error" },
                gatewayService: { active: false, loaded: true },
                heartbeat: { ok: false },
                nodeService: { active: false, loaded: false },
                security: {
                    findings: [
                        {
                            checkId: "audit.failed",
                            detail: "omitted",
                            severity: "warn",
                            title: "Audit failed",
                        },
                    ],
                    isOk: false,
                    summary: { warn: 1 },
                },
                securityError: "security failed",
                taskAudit: { errors: 1 },
                tasks: { failed: 1 },
                updateStatusError: "update failed",
                version: { current: "1.0.0" },
            })
        ).toEqual({
            checkedAt: "checked",
            doctorError: "doctor failed",
            doctorWarningCount: 0,
            doctorWarnings: [],
            gateway: { reachable: false, status: "error" },
            gatewayService: { active: false, loaded: true },
            heartbeat: { ok: false },
            nodeService: { active: false, loaded: false },
            security: {
                findings: [
                    {
                        checkId: "audit.failed",
                        severity: "warn",
                        title: "Audit failed",
                    },
                ],
                isOk: false,
                summary: { warn: 1 },
            },
            securityError: "security failed",
            taskAudit: { errors: 1 },
            tasks: { failed: 1 },
            updateStatusError: "update failed",
            version: { current: "1.0.0" },
        });

        for (const key of [
            "git.workspace",
            "moltbook.home",
            "quotas.summary",
            "system.host",
            "weather.spydeberg",
        ]) {
            expect(compactHeartbeatData(key, { direct: key })).toEqual({ direct: key });
        }
        expect(compactHeartbeatData("moltbook.feed.hot", { posts: [] })).toBeNull();
        expect(compactHeartbeatData("unknown", "invalid")).toBeNull();
    });

    it("validates agent ids before they can become filesystem path segments", () => {
        expect(isValidAgentId("mira-2026")).toBe(true);
        expect(isValidAgentId("agent.main_1")).toBe(true);
        expect(isValidAgentId("")).toBe(false);
        expect(isValidAgentId(".")).toBe(false);
        expect(isValidAgentId("..")).toBe(false);
        expect(isValidAgentId("../escape")).toBe(false);
        expect(isValidAgentId("x".repeat(65))).toBe(false);
    });

    it("parses cache JSON and tabular command output defensively", async () => {
        const originalDatabasePath = process.env.MIRA_DASHBOARD_DB_PATH;
        const root = mkdtempSync(path.join(tmpdir(), "mira-cache-store-test-"));
        try {
            process.env.MIRA_DASHBOARD_DB_PATH = path.join(root, "dashboard.db");
            const { parseJsonField, parseTable } =
                await import("../src/lib/cacheStore.ts");
            expect(parseJsonField<{ ok: boolean }>('{"ok":true}')).toEqual({
                ok: true,
            });
            expect(parseJsonField("")).toBeUndefined();
            expect(parseJsonField("{")).toBeUndefined();

            expect(
                parseTable<{ name: string; status: string }>(
                    "name\tstatus\nmira\tonline\nraymond\t\n\n"
                )
            ).toEqual([
                { name: "mira", status: "online" },
                { name: "raymond", status: "" },
            ]);
            expect(parseTable("")).toEqual([]);
        } finally {
            if (originalDatabasePath === undefined) {
                delete process.env.MIRA_DASHBOARD_DB_PATH;
            } else {
                process.env.MIRA_DASHBOARD_DB_PATH = originalDatabasePath;
            }
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("maps undefined bindings to SQLite null while preserving concrete values", async () => {
        const { sqlNullable } = await import("../src/database.ts");
        expect(sqlNullable("value")).toBe("value");
        expect(sqlNullable(0)).toBe(0);
        expect(sqlNullable(undefined)).toBeNull();
    });

    it("normalizes optional backend values for API responses and environment defaults", () => {
        const originalValue = process.env.MIRA_TEST_OPTIONAL_VALUE;
        try {
            delete process.env.MIRA_TEST_OPTIONAL_VALUE;
            expect(environmentFallback("MIRA_TEST_OPTIONAL_VALUE", "fallback")).toBe(
                "fallback"
            );
            expect(
                nonEmptyEnvironmentFallback("MIRA_TEST_OPTIONAL_VALUE", "fallback")
            ).toBe("fallback");

            process.env.MIRA_TEST_OPTIONAL_VALUE = "  configured  ";
            expect(environmentFallback("MIRA_TEST_OPTIONAL_VALUE", "fallback")).toBe(
                "  configured  "
            );
            expect(
                nonEmptyEnvironmentFallback("MIRA_TEST_OPTIONAL_VALUE", "fallback")
            ).toBe("configured");

            expect(stringFallback(undefined, "fallback")).toBe("fallback");
            expect(stringFallback(42)).toBe("42");
            expect(nullableString("")).toBeUndefined();
            expect(nullableString("mira")).toBe("mira");
            expect(objectFallback({ ok: true })).toEqual({ ok: true });
            expect(objectFallback()).toEqual({});
            expect(
                objectFallback<Record<string, unknown>>("not-object" as never)
            ).toEqual({});
            expect(arrayFallback(["a"])).toEqual(["a"]);
            expect(arrayFallback("not-array", ["fallback"])).toEqual(["fallback"]);
        } finally {
            if (originalValue === undefined) {
                delete process.env.MIRA_TEST_OPTIONAL_VALUE;
            } else {
                process.env.MIRA_TEST_OPTIONAL_VALUE = originalValue;
            }
        }
    });

    it("maps operational errors without leaking unknown values", () => {
        const blankError = new Error(" ".repeat(3));
        expect(errorMessage(new Error("  failed  "), "fallback")).toBe("failed");
        expect(errorMessage(blankError, "fallback")).toBe("fallback");
        expect(errorMessage("raw secret-ish value", "fallback")).toBe("fallback");
        const notFoundError = Object.assign(new Error("missing"), { statusCode: 404 });
        const invalidStatusError = Object.assign(new Error("bad"), { statusCode: 399 });
        expect(httpStatusCode(notFoundError)).toBe(404);
        expect(httpStatusCode(invalidStatusError)).toBe(500);
        expect(httpStatusCode(undefined)).toBe(500);
    });

    it("keeps filesystem helpers inside their configured root", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-safe-path-"));
        const outside = mkdtempSync(path.join(tmpdir(), "mira-safe-path-outside-"));
        try {
            writeFileSync(path.join(root, "inside.txt"), "ok");
            writeFileSync(path.join(root, "file-parent"), "not a directory");
            symlinkSync(outside, path.join(root, "outside-link"));

            expect(canonicalPath(safePathWithinRoot("inside.txt", root)!)).toBe(
                canonicalPath(path.join(root, "inside.txt"))
            );
            expect(safePathWithinRoot("", root)).toBeUndefined();
            expect(safePathWithinRoot("inside.txt", "/")).toBeUndefined();
            expect(safePathWithinRoot("../escape.txt", root)).toBeUndefined();
            expect(safePathWithinRoot("outside-link/escape.txt", root)).toBeUndefined();
            expect(safePathWithinRoot("bad\0name", root)).toBeUndefined();

            const writeTarget = path.join(root, "nested", "report.txt");
            expect(
                path.resolve(prepareSafeWriteTargetWithinRoot(writeTarget, root)!)
            ).toBe(path.resolve(writeTarget));
            const missingRoot = path.join(root, "missing-root", "child");
            const missingRootTarget = path.join(missingRoot, "nested", "report.txt");
            expect(
                canonicalPath(
                    prepareSafeWriteTargetWithinRoot(missingRootTarget, missingRoot)!
                )
            ).toBe(canonicalPath(missingRootTarget));
            expect(
                prepareSafeWriteTargetWithinRoot(path.join(root, "bad\0name"), root)
            ).toBeUndefined();
            expect(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "file-parent", "child.txt"),
                    root
                )
            ).toBeUndefined();
            expect(prepareSafeWriteTargetWithinRoot(writeTarget, "/")).toBeUndefined();
            expect(
                prepareSafeWriteTargetWithinRoot(path.join(outside, "report.txt"), root)
            ).toBeUndefined();

            expect(sanitizeFilename(" report/../name?.txt ")).toBe("name?.txt ");
            expect(() => sanitizeFilename("..")).toThrow("Invalid filename");
            expect(() => sanitizeFilename("bad\0name")).toThrow("Invalid filename");
        } finally {
            rmSync(root, { force: true, recursive: true });
            rmSync(outside, { force: true, recursive: true });
        }
    });

    it("validates pull request numbers and configured Dashboard roots", () => {
        const originalRoot = process.env.MIRA_DASHBOARD_ROOT;
        const originalWorktreeRoot = process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
        process.env.MIRA_DASHBOARD_ROOT = "/tmp/dashboard-root";
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = "/tmp/dashboard-worktrees";
        try {
            expect(validatePrNumber("189")).toBe(189);
            expect(() => validatePrNumber("0")).toThrow("Invalid pull request number");
            expect(() => validatePrNumber("1.5")).toThrow("Invalid pull request number");
            expect(() => validatePrNumber("abc")).toThrow("Invalid pull request number");
            expect(getResolvedRoots()).toEqual({
                dashboardRoot: "/tmp/dashboard-root",
                dashboardWorktreeRoot: "/tmp/dashboard-worktrees",
            });

            process.env.MIRA_DASHBOARD_ROOT = "/";
            expect(() => getResolvedRoots()).toThrow(
                "MIRA_DASHBOARD_ROOT must be an absolute non-root path"
            );
        } finally {
            if (originalRoot === undefined) {
                delete process.env.MIRA_DASHBOARD_ROOT;
            } else {
                process.env.MIRA_DASHBOARD_ROOT = originalRoot;
            }
            if (originalWorktreeRoot === undefined) {
                delete process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
            } else {
                process.env.MIRA_DASHBOARD_WORKTREE_ROOT = originalWorktreeRoot;
            }
        }
    });

    it("serializes backup jobs without exposing live process handles", () => {
        expect(mapBackupJob(undefined)).toBeUndefined();
        const completed = Promise.resolve(undefined);
        expect(
            mapBackupJob({
                id: "backup-1",
                type: "kopia",
                status: "needs_attention",
                code: 130,
                stdout: "stdout",
                stderr: "stderr",
                startedAt: 1,
                endedAt: 2,
                completed,
                process: { pid: 123 },
            } as never)
        ).toEqual({
            id: "backup-1",
            type: "kopia",
            status: "needs_attention",
            code: 130,
            stdout: "stdout",
            stderr: "stderr",
            startedAt: 1,
            endedAt: 2,
        });
    });

    it("persists and repairs OpenClaw Gateway device identity files", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-device-identity-"));
        const identityPath = path.join(root, "nested", "identity.json");
        try {
            const created = loadOrCreateDeviceIdentity(identityPath);
            expect(created.deviceId).toMatch(/^[a-f0-9]{64}$/u);
            expect(created.publicKeyPem).toContain("PUBLIC KEY");
            expect(created.privateKeyPem).toContain("PRIVATE KEY");

            const loaded = loadOrCreateDeviceIdentity(identityPath);
            expect(loaded).toEqual(created);

            writeFileSync(identityPath, JSON.stringify({ broken: true }));
            const repaired = loadOrCreateDeviceIdentity(identityPath);
            expect(repaired.deviceId).toMatch(/^[a-f0-9]{64}$/u);
            expect(repaired.deviceId).not.toBe(created.deviceId);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("runs and limits local processes through the shared process helpers", async () => {
        await expect(
            runProcess(process.execPath, ["--eval", "console.log('hello');"])
        ).resolves.toEqual({ code: 0, stdout: "hello\n", stderr: "" });

        await expect(
            runProcess(process.execPath, ["--eval", "console.log('too much');"], {
                maxBuffer: 4,
            })
        ).rejects.toThrow("Process output exceeded maxBuffer");

        const timedOut = await runProcess(
            process.execPath,
            ["--eval", "setTimeout(() => {}, 1000);"],
            { timeoutMs: 1 }
        );
        expect(timedOut).toMatchObject({ stderr: "", stdout: "" });
        expect(timedOut.code).not.toBe(0);

        const chunks: string[] = [];
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("one"));
                controller.enqueue(new TextEncoder().encode("two"));
                controller.close();
            },
        });
        await pipeProcessOutput(stream, (chunk) => {
            chunks.push(chunk);
        });
        expect(chunks.join("")).toBe("onetwo");
        await expect(pipeProcessOutput(undefined, () => {})).resolves.toBeUndefined();
    });

    it("parses valid JSON request bodies", async () => {
        const validJsonBody = JSON.stringify({ ok: true });
        await expect(
            readJson<{ ok: boolean }>(
                new Request("http://localhost/api", {
                    body: validJsonBody,
                    method: "POST",
                })
            )
        ).resolves.toEqual({ ok: true });
    });

    it("rejects invalid JSON request bodies", async () => {
        await expect(
            readJson(new Request("http://localhost/api", { body: "{", method: "POST" }))
        ).rejects.toThrow("Invalid JSON");
    });

    it("enforces request body size limits", async () => {
        await expect(
            readRequestBytes(
                new Request("http://localhost/api", {
                    body: "too large",
                    headers: { "content-length": "9" },
                    method: "POST",
                }),
                4
            )
        ).rejects.toThrow("Request body too large");
    });

    it("adds cookies to text responses", () => {
        const response = withCookie(text("hello", { status: 201 }), "a=b");
        expect(response.status).toBe(201);
        expect(response.headers.get("set-cookie")).toBe("a=b");
    });

    it("extracts dashboard session cookies safely", () => {
        expect(sessionIdFromCookie(new Request("http://localhost/api"))).toBeUndefined();
        expect(
            sessionIdFromCookie(
                new Request("http://localhost/api", {
                    headers: { cookie: "other=1; mira_dashboard_session=session%201" },
                })
            )
        ).toBe("session 1");
        expect(
            sessionIdFromCookie(
                new Request("http://localhost/api", {
                    headers: { cookie: "mira_dashboard_session=%E0%A4%A" },
                })
            )
        ).toBeUndefined();
    });

    it("validates allowed dashboard origins", () => {
        expect(isAllowedDashboardOrigin(new Request("http://localhost:3100/api"))).toBe(
            true
        );
        expect(
            isAllowedDashboardOrigin(
                new Request("http://localhost:3100/api", {
                    headers: { origin: "http://localhost:3100" },
                })
            )
        ).toBe(true);
        expect(
            isAllowedDashboardOrigin(
                new Request("https://mira.lan:3100/api", {
                    headers: { origin: "https://mira.lan:3100" },
                })
            )
        ).toBe(true);
        expect(
            isAllowedDashboardOrigin(
                new Request("https://mira.lan:3100/api", {
                    // eslint-disable-next-line unicorn/prefer-https -- Verifies that a cross-scheme origin is rejected.
                    headers: { origin: "http://mira.lan:3100" },
                })
            )
        ).toBe(false);
        expect(
            isAllowedDashboardOrigin(
                new Request("http://localhost:3100/api", {
                    headers: { origin: "not a url" },
                })
            )
        ).toBe(false);
    });

    it("allows exact same-origin mutations on non-loopback hosts", () => {
        expect(
            isAllowedMutationSource(
                new Request("https://mira.lan:3100/api/tasks", {
                    headers: {
                        origin: "https://mira.lan:3100",
                        "sec-fetch-site": "same-origin",
                    },
                    method: "POST",
                })
            )
        ).toBe(true);
        expect(
            isAllowedMutationSource(
                new Request("https://mira.lan:3100/api/tasks", {
                    headers: {
                        // eslint-disable-next-line unicorn/prefer-https -- Verifies that a cross-scheme origin is rejected.
                        origin: "http://mira.lan:3100",
                        "sec-fetch-site": "same-origin",
                    },
                    method: "POST",
                })
            )
        ).toBe(false);
    });

    it("uses fake server request addresses in tests", () => {
        expect(serverWithAddress("127.0.0.1").requestIP(new Request("http://x"))).toEqual(
            { address: "127.0.0.1", family: "IPv4", port: 12_345 }
        );
    });

    it("keeps health available when worker telemetry cannot be read", async () => {
        const summarySpy = jest
            .spyOn(jobExecutionQueueModule, "getJobExecutionSummary")
            .mockImplementation(() => {
                throw new Error("queue telemetry unavailable");
            });
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const response = await callTestRoute(
                appRoutes,
                "/api/health",
                serverWithAddress("127.0.0.1")
            );

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
                status: "isOk",
                workerOnline: false,
            });
            expect(warnSpy).toHaveBeenCalledWith(
                "[Health] Failed to read job worker telemetry:",
                expect.objectContaining({ message: "queue telemetry unavailable" })
            );
        } finally {
            summarySpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    it("fails closed cleanly when the attempted mutation audit cannot be stored", async () => {
        const handler = jest.fn(() => new Response("must not run"));
        const persistenceError = new Error("audit storage unavailable");
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const routes = withRequestPolicy(
            { "/api/tasks": handler },
            {
                authenticateAutomation: () => ({
                    kind: "authenticated",
                    principal: {
                        id: "audit-failure-test",
                        scopes: new Set(["tasks:write"]),
                    },
                }),
                persistAuditEvent: () => {
                    throw persistenceError;
                },
            }
        );

        const response = await callTestRoute(
            routes,
            "/api/tasks",
            serverWithAddress("127.0.0.1"),
            { method: "POST" }
        );

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
            error: "Audit trail unavailable",
        });
        expect(handler).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("attempted persistence failed"),
            persistenceError
        );
    });

    it("applies request policy auth, rate limit, and handler error behavior", async () => {
        resetRequestPolicyForTests();
        try {
            const routeEntries: Record<
                string,
                (request: Request, server: Server<unknown>) => Response
            > = {
                "/api/health": () => new Response("ok"),
                "/api/private": () => new Response("private"),
                "/api/auth/login": () => new Response("login"),
                "/syntax": () => {
                    throw new SyntaxError("bad json");
                },
                "/generic-error": () => {
                    throw new Error("boom");
                },
                "/status-error": () => {
                    throw Object.assign(new Error("Job capacity is full"), {
                        statusCode: 409,
                    });
                },
            };
            const routes = withRequestPolicy(routeEntries);
            const server = serverWithAddress("203.0.113.10");

            const health = await callTestRoute(routes, "/api/health", server);
            expect(health.status).toBe(200);
            expect(health.headers.get("ratelimit-policy")).toBe("600;w=60");
            expect(health.headers.get("x-request-id")).toMatch(
                /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u
            );
            expect(health.headers.get("content-security-policy")).toContain(
                "frame-ancestors 'none'"
            );
            expect(health.headers.get("content-security-policy")).toContain(
                "connect-src 'self' ws://localhost"
            );
            expect(health.headers.get("permissions-policy")).toContain(
                "microphone=(self)"
            );
            expect(health.headers.get("referrer-policy")).toBe("no-referrer");
            expect(health.headers.get("x-content-type-options")).toBe("nosniff");
            expect(health.headers.get("x-frame-options")).toBe("DENY");

            const secureOrigin = withRequestSecurity(
                // eslint-disable-next-line unicorn/prefer-https -- Simulates TLS termination at a trusted proxy.
                new Request("http://dashboard.example/api/health", {
                    headers: { "x-forwarded-proto": "https" },
                }),
                new Response(),
                serverWithAddress("127.0.0.1")
            );
            expect(secureOrigin.headers.get("content-security-policy")).toContain(
                "connect-src 'self' wss://dashboard.example"
            );
            const directSecureOrigin = withRequestSecurity(
                new Request("https://dashboard.example/api/health"),
                new Response(),
                serverWithAddress("203.0.113.10")
            );
            expect(directSecureOrigin.headers.get("content-security-policy")).toContain(
                "connect-src 'self' wss://dashboard.example"
            );

            const sameOriginMutation = await callTestRoute(
                routes,
                "/api/health",
                server,
                {
                    headers: {
                        origin: "http://localhost",
                        "sec-fetch-site": "same-origin",
                    },
                    method: "POST",
                }
            );
            expect(sameOriginMutation.status).toBe(401);
            await expect(sameOriginMutation.json()).resolves.toEqual({
                error: "Unauthorized",
            });

            const publicSameOriginMutation = await callTestRoute(
                routes,
                "/api/auth/login",
                server,
                {
                    headers: {
                        origin: "http://localhost",
                        "sec-fetch-site": "same-origin",
                    },
                    method: "POST",
                }
            );
            expect(publicSameOriginMutation.status).toBe(200);
            const sameOriginRequestId =
                publicSameOriginMutation.headers.get("x-request-id") || "";
            expect(
                listAuditEvents(200)
                    .events.filter(
                        (event) =>
                            event.requestId === sameOriginRequestId &&
                            event.action === "http.request"
                    )
                    .map((event) => event.outcome)
            ).toEqual(["accepted", "attempted"]);

            const crossOriginMutation = await callTestRoute(
                routes,
                "/api/health",
                server,
                {
                    headers: {
                        origin: "https://evil.example",
                        "sec-fetch-site": "cross-site",
                    },
                    method: "POST",
                }
            );
            expect(crossOriginMutation.status).toBe(403);
            await expect(crossOriginMutation.json()).resolves.toEqual({
                error: "Forbidden request origin",
            });
            const crossOriginRequestId =
                crossOriginMutation.headers.get("x-request-id") || "";
            expect(
                listAuditEvents(200)
                    .events.filter(
                        (event) =>
                            event.requestId === crossOriginRequestId &&
                            event.action === "http.request"
                    )
                    .map((event) => event.outcome)
            ).toEqual([]);

            const missingOriginCrossSiteMutation = await callTestRoute(
                routes,
                "/api/health",
                server,
                {
                    headers: { "sec-fetch-site": "same-site" },
                    method: "POST",
                }
            );
            expect(missingOriginCrossSiteMutation.status).toBe(403);

            const privateResponse = await callTestRoute(routes, "/api/private", server);
            expect(privateResponse.status).toBe(401);
            await expect(privateResponse.json()).resolves.toEqual({
                error: "Unauthorized",
            });

            const syntaxResponse = await callTestRoute(routes, "/syntax", server);
            expect(syntaxResponse.status).toBe(400);
            await expect(syntaxResponse.json()).resolves.toEqual({
                error: "Invalid JSON",
            });

            const statusResponse = await callTestRoute(routes, "/status-error", server);
            expect(statusResponse.status).toBe(409);
            await expect(statusResponse.json()).resolves.toEqual({
                error: "Job capacity is full",
            });

            resetRequestPolicyForTests();
            const authRequest = new Request("http://localhost/api/auth/login", {
                method: "POST",
            });
            const authLogin = routes["/api/auth/login"];
            if (!authLogin) {
                throw new Error("Missing auth login test route");
            }
            for (let index = 0; index < 20; index += 1) {
                const response = await authLogin(authRequest, server);
                expect(response.status).toBe(200);
            }
            const limited = await authLogin(authRequest, server);
            expect(limited.status).toBe(429);
            expect(limited.headers.get("retry-after")).toBeDefined();

            resetRequestPolicyForTests();
            const originalConsoleError = console.error;
            try {
                Object.defineProperty(console, "error", {
                    configurable: true,
                    value: () => {},
                });
                const generic = await callTestRoute(routes, "/generic-error", server);
                expect(generic.status).toBe(500);
                await expect(generic.json()).resolves.toEqual({
                    error: "Internal server error",
                });
            } finally {
                Object.defineProperty(console, "error", {
                    configurable: true,
                    value: originalConsoleError,
                });
            }
        } finally {
            resetRequestPolicyForTests();
        }
    });
});
