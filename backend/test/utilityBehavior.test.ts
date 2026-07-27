import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { describe, expect, it, jest } from "bun:test";

import * as databaseMigrationRunnerModule from "../src/databaseMigrationRunner.ts";
import {
    isAllowedDashboardOrigin,
    readJson,
    readRequestBytes,
    resolveDashboardCookieNames,
    sessionIdFromCookie,
    text,
    withCookie,
} from "../src/http.ts";
import { errorMessage, httpStatusCode } from "../src/lib/errors.ts";
import { loadOrCreateDeviceIdentity } from "../src/lib/openclawGatewayClient.ts";
import { pipeProcessOutput, runProcess } from "../src/lib/processes.ts";
import {
    prepareSafeWriteTargetWithinRoot,
    resolveAbsoluteNonRootPath,
    safePathWithinRoot,
    sanitizeFilename,
} from "../src/lib/safePath.ts";
import {
    arrayFallback,
    environmentFallback,
    nonEmptyEnvironmentFallback,
    nullableString,
    objectFallback,
    resolveDashboardHost,
    resolveDashboardPort,
    stringFallback,
} from "../src/lib/values.ts";
import {
    isDevelopmentGatewayMethodBlocked,
    isDevelopmentGatewayProxyEventAllowed,
    isDevelopmentGatewayProxyMethodAllowed,
    isDevelopmentHostMutationBlocked,
    requiresRecentMfaForGatewayMethod,
    resetRequestPolicyForTests,
    withRequestPolicy,
} from "../src/requestPolicy.ts";
import { isAllowedMutationSource, withRequestSecurity } from "../src/requestSecurity.ts";
import { routes as appRoutes } from "../src/routes.ts";
import { compactHeartbeatData } from "../src/routes/cacheRoutes.ts";
import { isValidAgentId } from "../src/services/agents.ts";
import { listAuditEvents } from "../src/services/auditEvents.ts";
import { mapBackupJob } from "../src/services/backups.ts";
import * as jobExecutionQueueModule from "../src/services/jobExecutionQueue.ts";
import { dashboardJobProfile } from "../src/services/jobWorker.ts";
import {
    parsePullRequestPreviewStatus,
    pullRequestPreviewCandidate,
} from "../src/services/pullRequestPreviews.ts";
import {
    getResolvedRoots,
    parsePublicGithubPullRequests,
    validatePrNumber,
} from "../src/services/pullRequests.ts";

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
    it("maps credential-free public GitHub pull request metadata for dev previews", () => {
        const commitSha = "a".repeat(40);
        expect(
            parsePublicGithubPullRequests([
                {
                    base: { ref: "main" },
                    body: "Preview body",
                    created_at: "2026-07-26T10:00:00.000Z",
                    draft: false,
                    head: { ref: "mira/preview", sha: commitSha },
                    html_url: "https://github.com/rajohan/Mira-Dashboard/pull/335",
                    number: 335,
                    title: "Preview PR",
                    updated_at: "2026-07-26T11:00:00.000Z",
                    user: { login: "mira-2026" },
                },
            ])
        ).toEqual([
            expect.objectContaining({
                author: { login: "mira-2026" },
                baseRefName: "main",
                canReviewerApprove: true,
                headRefName: "mira/preview",
                headRefOid: commitSha,
                number: 335,
                previewEligible: true,
                reviewerApproved: false,
                statusCheckRollup: [],
            }),
        ]);
        expect(() => parsePublicGithubPullRequests([{ number: 335 }])).toThrow(
            "GitHub public pull request response is invalid"
        );
    });

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
            expect(resolveDashboardPort(" 4310 ")).toBe(4310);
            expect(resolveDashboardPort("0")).toBe(3100);
            expect(resolveDashboardPort("65536")).toBe(3100);
            expect(resolveDashboardPort("not-a-port")).toBe(3100);
            expect(resolveDashboardHost(" 127.0.0.1 ")).toBe("127.0.0.1");
            expect(resolveDashboardHost("")).toBe("0.0.0.0");
            expect(() => resolveDashboardHost("bad host")).toThrow(
                "MIRA_DASHBOARD_HOST must be a valid bind host"
            );
        } finally {
            if (originalValue === undefined) {
                delete process.env.MIRA_TEST_OPTIONAL_VALUE;
            } else {
                process.env.MIRA_TEST_OPTIONAL_VALUE = originalValue;
            }
        }
    });

    it("keeps dev host and Gateway controls guarded while isolated data remains mutable", () => {
        const safeEnvironment = { MIRA_DASHBOARD_DEV_SAFE_MODE: "1" };
        expect(
            isDevelopmentHostMutationBlocked(
                new Request("http://localhost/api/docker/update", {
                    method: "POST",
                }),
                safeEnvironment
            )
        ).toBe(true);
        expect(
            isDevelopmentHostMutationBlocked(
                new Request("http://localhost/api/pull-requests/335/approve", {
                    method: "POST",
                }),
                safeEnvironment
            )
        ).toBe(true);
        expect(
            isDevelopmentHostMutationBlocked(
                new Request("http://localhost/api/config", {
                    method: "PUT",
                }),
                safeEnvironment
            )
        ).toBe(true);
        expect(
            isDevelopmentHostMutationBlocked(
                new Request("http://localhost/api/cron/jobs/id/run", {
                    method: "POST",
                }),
                safeEnvironment
            )
        ).toBe(true);
        expect(
            isDevelopmentHostMutationBlocked(
                new Request("http://localhost/api/sessions/id", {
                    method: "DELETE",
                }),
                safeEnvironment
            )
        ).toBe(true);
        expect(
            isDevelopmentHostMutationBlocked(
                new Request("http://localhost/api/tasks", { method: "POST" }),
                safeEnvironment
            )
        ).toBe(false);
        expect(
            isDevelopmentHostMutationBlocked(
                new Request("http://localhost/api/docker"),
                safeEnvironment
            )
        ).toBe(false);
        expect(
            isDevelopmentHostMutationBlocked(
                new Request("http://localhost/api/docker/update", {
                    method: "POST",
                }),
                {}
            )
        ).toBe(false);
        for (const method of [
            "chat.abort",
            "chat.history",
            "chat.send",
            "config.get",
            "cron.list",
            "models.list",
            "sessions.list",
            "sessions.patch",
        ]) {
            expect(isDevelopmentGatewayMethodBlocked(method, safeEnvironment)).toBe(
                false
            );
        }
        for (const method of [
            "config.patch",
            "cron.remove",
            "sessions.compact",
            "sessions.delete",
        ]) {
            expect(isDevelopmentGatewayMethodBlocked(method, safeEnvironment)).toBe(true);
        }
        expect(isDevelopmentGatewayProxyMethodAllowed("sessions.subscribe")).toBe(true);
        expect(isDevelopmentGatewayProxyMethodAllowed("subscribe")).toBe(false);
        expect(isDevelopmentGatewayProxyMethodAllowed("config.patch")).toBe(false);
        expect(isDevelopmentGatewayProxyEventAllowed("session.message")).toBe(true);
        expect(isDevelopmentGatewayProxyEventAllowed("plugin.approval.requested")).toBe(
            false
        );
        expect(requiresRecentMfaForGatewayMethod("chat.history")).toBe(false);
        expect(requiresRecentMfaForGatewayMethod("config.get")).toBe(true);
        expect(requiresRecentMfaForGatewayMethod("cron.list")).toBe(true);
        expect(isDevelopmentGatewayMethodBlocked("config.patch", {})).toBe(false);
        expect(dashboardJobProfile({ MIRA_DASHBOARD_JOB_PROFILE: "isolated" })).toBe(
            "isolated"
        );
        expect(dashboardJobProfile({ MIRA_DASHBOARD_JOB_PROFILE: "unknown" })).toBe(
            "full"
        );
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
            expect(resolveAbsoluteNonRootPath(` ${root} `, "Test path")).toBe(root);
            for (const invalidPath of ["", "relative", "/", "bad\0path"]) {
                expect(() =>
                    resolveAbsoluteNonRootPath(invalidPath, "Test path")
                ).toThrow("Test path must be an absolute non-root path");
            }

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

    it("validates queued pull request preview status payloads", () => {
        expect(
            pullRequestPreviewCandidate({
                author: { login: "mira-2026" },
                baseRefName: "main",
                headRefOid: "a".repeat(40),
                number: 335,
                title: "Managed preview",
            } as never)
        ).toEqual({
            authorLogin: "mira-2026",
            baseRefName: "main",
            commitSha: "a".repeat(40),
            number: 335,
            title: "Managed preview",
        });

        expect(
            parsePullRequestPreviewStatus({
                backendPort: 3101,
                commitSha: "a".repeat(40),
                frontendPort: 5173,
                number: 335,
                startedAt: "2026-07-26T12:00:00.000Z",
                status: "running",
                title: "Managed preview",
                updatedAt: "2026-07-26T12:00:00.000Z",
                url: "https://dashboard.example:5173",
            })
        ).toEqual({
            backendPort: 3101,
            commitSha: "a".repeat(40),
            frontendPort: 5173,
            number: 335,
            startedAt: "2026-07-26T12:00:00.000Z",
            status: "running",
            title: "Managed preview",
            updatedAt: "2026-07-26T12:00:00.000Z",
            url: "https://dashboard.example:5173",
        });
        for (const value of [
            undefined,
            { status: "unknown" },
            { number: 0, status: "running" },
            { status: "failed", title: 42 },
        ]) {
            expect(() => parsePullRequestPreviewStatus(value)).toThrow();
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

    it("isolates configurable development cookie namespaces", () => {
        expect(resolveDashboardCookieNames({})).toEqual({
            pendingLogin: "mira_dashboard_pending_login",
            session: "mira_dashboard_session",
        });
        expect(
            resolveDashboardCookieNames({
                MIRA_DASHBOARD_COOKIE_NAMESPACE: "mira_dashboard_dev_5173",
            })
        ).toEqual({
            pendingLogin: "mira_dashboard_dev_5173_pending_login",
            session: "mira_dashboard_dev_5173_session",
        });
        for (const namespace of ["Prod", "dev-cookie", "a".repeat(49)]) {
            expect(() =>
                resolveDashboardCookieNames({
                    MIRA_DASHBOARD_COOKIE_NAMESPACE: namespace,
                })
            ).toThrow("MIRA_DASHBOARD_COOKIE_NAMESPACE");
        }
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

    it("fails readiness when worker telemetry cannot be read", async () => {
        const summarySpy = jest
            .spyOn(jobExecutionQueueModule, "getJobExecutionSummary")
            .mockImplementation(() => {
                throw new Error("queue telemetry unavailable");
            });
        const releaseSummarySpy = jest
            .spyOn(jobExecutionQueueModule, "isJobWorkerReleaseReady")
            .mockImplementation(() => {
                throw new Error("queue telemetry unavailable");
            });
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const response = await callTestRoute(
                appRoutes,
                "/api/health/ready",
                serverWithAddress("127.0.0.1")
            );

            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toMatchObject({
                checks: {
                    worker: { ready: false },
                },
                status: "notReady",
            });
            expect(warnSpy).toHaveBeenCalledWith(
                "[Health] Failed to read job worker telemetry:",
                expect.objectContaining({ message: "queue telemetry unavailable" })
            );
        } finally {
            summarySpy.mockRestore();
            releaseSummarySpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    it("logs database readiness failures without exposing them in the response", async () => {
        const databaseError = new Error("database unavailable");
        const migrationSpy = jest
            .spyOn(databaseMigrationRunnerModule, "validateDatabaseMigrationHistory")
            .mockImplementation(() => {
                throw databaseError;
            });
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
            const response = await callTestRoute(
                appRoutes,
                "/api/health/ready",
                serverWithAddress("127.0.0.1")
            );

            expect(response.status).toBe(503);
            const payload = await response.json();
            expect(payload).toMatchObject({
                checks: {
                    database: {
                        ready: false,
                    },
                },
                status: "notReady",
            });
            expect(JSON.stringify(payload)).not.toContain(databaseError.message);
            expect(warnSpy).toHaveBeenCalledWith(
                "[Health] Database readiness failed:",
                databaseError
            );
        } finally {
            migrationSpy.mockRestore();
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
                "/api/health/live": () => new Response("ok"),
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

            const health = await callTestRoute(routes, "/api/health/live", server);
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
                new Request("http://dashboard.example/api/health/live", {
                    headers: { "x-forwarded-proto": "https" },
                }),
                new Response(),
                serverWithAddress("127.0.0.1")
            );
            expect(secureOrigin.headers.get("content-security-policy")).toContain(
                "connect-src 'self' wss://dashboard.example"
            );
            const directSecureOrigin = withRequestSecurity(
                new Request("https://dashboard.example/api/health/live"),
                new Response(),
                serverWithAddress("203.0.113.10")
            );
            expect(directSecureOrigin.headers.get("content-security-policy")).toContain(
                "connect-src 'self' wss://dashboard.example"
            );

            const sameOriginMutation = await callTestRoute(
                routes,
                "/api/health/live",
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
                "/api/health/live",
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
                "/api/health/live",
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
